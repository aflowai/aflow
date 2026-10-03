/**
 * A harness run's browser, from the executor's side (Plan 320 D11).
 *
 * The run's scratch directory gets the relay script and its tool list, and
 * each turn of the harness gets a pair of named pipes of its own and an MCP
 * configuration naming them. The harness starts the relay inside its sandbox;
 * the relay passes each tool call down the request pipe, and this module
 * performs it through `performBrowserOperation` — the function a browser step
 * runs — so posture, rules, egress proxy, page ownership, bounds and refusals
 * are the operations' own. Nothing here widens the sandbox: the pipes sit in a
 * directory the run could already write.
 *
 * Every call becomes a line in the run's activity feed and a record in its
 * browser log. When a turn's process ends, its pipes close and are removed, so
 * nothing one turn's relay left in them reaches the next; the browser and its
 * pages stay for the run. When the run ends, however it ends, the pages the
 * harness opened close, an ephemeral profile's browser stops, and every file
 * written here is removed. A call still in flight past a short grace is logged
 * as abandoned, and a page it opens later is closed as soon as it exists.
 *
 * A turn performs a few calls at once and the rest wait; a request line past
 * its cap closes that turn's pipes, and the feed says why.
 */
import { execFile } from 'node:child_process';
import { constants, openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validationError } from '@aflow/executor-runtime';
import {
  type AflowError,
  BROWSER_PAGE_ACT_OPERATION_ID,
  BROWSER_PAGE_CLOSE_OPERATION_ID,
  BROWSER_PAGE_LIST_OPERATION_ID,
  BROWSER_PAGE_NAVIGATE_OPERATION_ID,
  BROWSER_PAGE_OPEN_OPERATION_ID,
  BROWSER_PAGE_READ_OPERATION_ID,
  BROWSER_PAGE_SCREENSHOT_OPERATION_ID,
  BROWSER_PAGE_SNAPSHOT_OPERATION_ID,
  BrowserPageIdSchema,
  BrowserPageOpenInputSchema,
  EPHEMERAL_BROWSER_PROFILE,
  getOperation,
  type HarnessActivityLine,
  type HarnessBrowserLogRecord,
  type PayloadRef,
  toJsonSchemaSync,
} from '@aflow/schemas';
import { z } from 'zod';
import {
  browserFailure,
  type BrowserCall,
  performBrowserOperation,
} from '../handlers/browserHandler.js';
import type { BrowserDriver } from './driver.js';
import type { RunScope } from './driverTypes.js';
import { BrowserDriverError } from './errors.js';
import type { HarnessReach } from './harnessReach.js';

/** The directory under the run's scratch that holds everything written here. */
export const HARNESS_BROWSER_DIR = 'browser';
/** Where an ephemeral profile's Chrome keeps its directory, under the temp root. */
export const EPHEMERAL_PROFILE_SCRATCH_PREFIX = 'aflow-browser-';
/** The name the harness knows the server by; its tools reach it as `mcp__browser__<tool>`. */
export const HARNESS_BROWSER_SERVER = 'browser';

const RELAY_SOURCE = fileURLToPath(new URL('./harnessRelay.mjs', import.meta.url));
/** How long the end of a run waits for calls still in flight before it closes the pages under them. */
const IN_FLIGHT_GRACE_MS = 5_000;
/** Calls one turn may have performing at once; the host executor is shared, so the rest wait their turn. */
export const MAX_CALLS_IN_FLIGHT_PER_TURN = 4;
/** Calls one turn may have waiting behind those; one past it is answered at once and not kept. */
export const MAX_CALLS_WAITING_PER_TURN = 4 * MAX_CALLS_IN_FLIGHT_PER_TURN;
/**
 * The longest request line a turn's relay may send. Typed text and evaluated
 * expressions are the large arguments, and none comes near this.
 */
export const MAX_REQUEST_LINE_BYTES = 1024 * 1024;

export const HarnessBrowserEvaluateInputSchema = z.object({
  pageId: BrowserPageIdSchema,
  expression: z
    .string()
    .min(1)
    .describe(
      'A JavaScript expression run in the page; its value comes back as JSON, a promise awaited. ' +
        'For console-level debugging of a page this run opened.',
    ),
});

interface RelayTool {
  readonly name: string;
  readonly operationId?: string;
  readonly input: z.ZodType;
  readonly description: string;
}

function operationTool(name: string, operationId: string, input?: z.ZodType): RelayTool {
  const operation = getOperation(operationId);
  if (operation === undefined) throw new Error(`No operation ${operationId} is registered.`);
  return {
    name,
    operationId,
    input: input ?? operation.inputZod,
    description: operation.semanticDescription,
  };
}

/** The tools a harness is offered: the `browser.page.*` vocabulary, and `evaluate` on an ephemeral profile. */
export function relayTools(ephemeral: boolean): RelayTool[] {
  const tools = [
    // The profile is the run's, chosen when it started; the harness cannot name another.
    operationTool(
      'open',
      BROWSER_PAGE_OPEN_OPERATION_ID,
      BrowserPageOpenInputSchema.omit({ profileId: true }),
    ),
    operationTool('navigate', BROWSER_PAGE_NAVIGATE_OPERATION_ID),
    operationTool('snapshot', BROWSER_PAGE_SNAPSHOT_OPERATION_ID),
    operationTool('read', BROWSER_PAGE_READ_OPERATION_ID),
    operationTool('screenshot', BROWSER_PAGE_SCREENSHOT_OPERATION_ID),
    operationTool('act', BROWSER_PAGE_ACT_OPERATION_ID),
    operationTool('list', BROWSER_PAGE_LIST_OPERATION_ID),
    operationTool('close', BROWSER_PAGE_CLOSE_OPERATION_ID),
  ];
  if (!ephemeral) return tools;
  return [
    ...tools,
    {
      name: 'evaluate',
      input: HarnessBrowserEvaluateInputSchema,
      description:
        'Run a JavaScript expression in a page this run opened and get its value back as JSON. ' +
        'Offered on the ephemeral profile only, which holds no sign-ins.',
    },
  ];
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The tool list the relay serves, each input schema generated from its Zod schema. */
export function relayToolDefinitions(ephemeral: boolean): McpToolDefinition[] {
  return relayTools(ephemeral).map((tool) => {
    const { $schema: _draft, ...inputSchema } = toJsonSchemaSync(tool.input) as Record<
      string,
      unknown
    >;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

/** What the relay sends down the request pipe. */
interface RelayRequest {
  readonly id: number;
  readonly tool: string;
  readonly arguments?: unknown;
}

/** One relayed call from the moment it is read until its record is in the log. */
interface Call {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  logged: boolean;
}

type CallOutcome = { ok: true; output: unknown } | { ok: false; error: AflowError };

function actionOf(call: Call): string {
  return call.tool === 'act' && typeof call.args['action'] === 'string'
    ? `act.${call.args['action']}`
    : call.tool;
}

type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export interface McpCallResult {
  readonly content: McpContent[];
  readonly isError?: boolean;
}

export interface HarnessBrowserOptions {
  readonly driver: BrowserDriver;
  readonly scope: RunScope;
  /** What the run asked for: `ephemeral`, or a profile the machine declares. */
  readonly profile: string;
  /** What the harness may reach, from its profile on this machine; an ephemeral profile reaches no more. */
  readonly reach: HarnessReach;
  /** The run's scratch directory, which its sandbox may already read and write. */
  readonly scratchDir: string;
  readonly stepExecutionId: string;
  /** Keeps one screenshot as a payload of its own. */
  readonly storeScreenshot: (image: { data: string; mimeType: string }) => Promise<PayloadRef>;
  readonly onActivity: (line: HarnessActivityLine) => void;
  /** When the run started, for the feed's offsets. */
  readonly startedAt: number;
  readonly now?: () => number;
  /** Where an ephemeral profile's directory is made; the temp root unless a test says. */
  readonly ephemeralRoot?: string;
  /** How long the end of a run waits for calls in flight; `IN_FLIGHT_GRACE_MS` unless a test says. */
  readonly inFlightGraceMs?: number;
}

/** One harness turn's way to the run's browser: a pipe pair of its own and the configuration naming it. */
export interface HarnessBrowserTurn {
  /** The MCP configuration file the harness is handed through its profile's `mcpArgs`. */
  readonly mcpConfigPath: string;
  /** Where the turn's relay finds its pipes and tool list; what the configuration names. */
  readonly relayArgs: readonly string[];
  /**
   * Closes and removes the turn's pipes. A call still in flight is performed and
   * logged, but its answer goes nowhere. Safe to call twice.
   */
  close(): Promise<void>;
}

export interface HarnessBrowser {
  /** Makes the pipes for the next turn of the harness; closed when that turn's process ends. */
  openTurn(): Promise<HarnessBrowserTurn>;
  /** Every call so far, across every turn, in the order each ended. */
  records(): readonly HarnessBrowserLogRecord[];
  /** Ends the browser and removes everything written for it. Safe to call twice. */
  close(): Promise<void>;
}

const makeFifo = promisify(execFile);

function originOf(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  try {
    const url = new URL(address);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function textResult(value: unknown, isError = false): McpCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}

function errorResult(error: AflowError): McpCallResult {
  return textResult(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
    true,
  );
}

const READS = new Set(['snapshot', 'read', 'screenshot', 'list']);

/**
 * Opens a run's browser: the profile resolved or made, the relay and its tool
 * list written. A named profile the run's space may not use is refused here, before
 * the harness starts.
 */
export async function openHarnessBrowser(options: HarnessBrowserOptions): Promise<HarnessBrowser> {
  const { driver, scope } = options;
  const now = options.now ?? Date.now;
  const ephemeral = options.profile === EPHEMERAL_BROWSER_PROFILE;

  let profileId: string;
  let ephemeralDir: string | undefined;
  if (ephemeral) {
    ephemeralDir = await mkdtemp(
      join(options.ephemeralRoot ?? tmpdir(), EPHEMERAL_PROFILE_SCRATCH_PREFIX),
    );
    profileId = driver.startEphemeral(scope, ephemeralDir, options.reach);
  } else {
    profileId = (await driver.harnessProfile(scope, options.profile)).id;
  }

  const dir = join(options.scratchDir, HARNESS_BROWSER_DIR);
  const relayPath = join(dir, 'relay.mjs');
  const toolsPath = join(dir, 'tools.json');

  const turns = new Set<HarnessBrowserTurn>();
  const removeAll = async (): Promise<void> => {
    for (const turn of [...turns]) await turn.close();
    if (ephemeral) await driver.endEphemeral(profileId);
    await rm(dir, { recursive: true, force: true });
    if (ephemeralDir !== undefined) await rm(ephemeralDir, { recursive: true, force: true });
  };

  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(RELAY_SOURCE, relayPath);
    await writeFile(toolsPath, JSON.stringify(relayToolDefinitions(ephemeral)));
  } catch (error) {
    await removeAll();
    throw error;
  }

  const records: HarnessBrowserLogRecord[] = [];
  const opened = new Set<string>();
  const inFlight = new Map<Call, Promise<void>>();
  let closing = false;
  let turnCount = 0;

  const log = (call: Call, entry: HarnessBrowserLogRecord, said: string): void => {
    call.logged = true;
    records.push(entry);
    const where = entry.origin ?? entry.pageId;
    options.onActivity({
      kind: 'tool',
      at: Math.max(0, now() - options.startedAt),
      tool: `browser.page.${call.tool}`,
      text: `${entry.action}${where !== undefined ? ` ${where}` : ''} — ${said}`,
    });
  };

  // The log is read as soon as close() returns, so a call still running then
  // is written now; whatever it does later is not written again.
  const abandon = (call: Call): void => {
    if (call.logged) return;
    const pageId = call.args['pageId'];
    log(
      call,
      {
        at: new Date(now()).toISOString(),
        profile: options.profile,
        action: actionOf(call),
        ...(typeof pageId === 'string' ? { pageId } : {}),
        outcome: 'abandoned',
      },
      'abandoned',
    );
  };

  const record = (call: Call, outcome: CallOutcome, screenshot?: PayloadRef): void => {
    if (call.logged) return;
    const { tool, args } = call;
    const output = outcome.ok ? outcome.output : undefined;
    const receipt = field(output, 'receipt');
    const element = field(receipt, 'element') as HarnessBrowserLogRecord['element'] | undefined;
    const pageId = field(output, 'pageId') ?? args['pageId'];
    const origin =
      originOf(field(output, 'url')) ??
      (outcome.ok ? undefined : originOf(field(outcome.error.details, 'origin')));
    const typed =
      tool === 'act' && args['action'] === 'type' && typeof args['text'] === 'string'
        ? [...new Intl.Segmenter().segment(args['text'])].length
        : undefined;
    const reported = field(output, 'outcome');
    const entry: HarnessBrowserLogRecord = {
      at: new Date(now()).toISOString(),
      profile: options.profile,
      action: actionOf(call),
      ...(typeof pageId === 'string' ? { pageId } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(element !== undefined ? { element: { ...element } } : {}),
      ...(typed !== undefined ? { typedCharacters: typed } : {}),
      outcome: !outcome.ok
        ? outcome.error.classification === 'permission'
          ? 'refused'
          : 'failed'
        : reported === 'uncertain_outcome'
          ? 'uncertain_outcome'
          : READS.has(tool)
            ? 'read'
            : 'performed',
      ...(!outcome.ok ? { code: outcome.error.code } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
    };
    log(call, entry, outcome.ok ? entry.outcome : `${entry.outcome}: ${outcome.error.code}`);
  };

  const notOpenedHere = (pageId: string): AflowError =>
    browserFailure(
      new BrowserDriverError(
        'page_gone',
        `Page \`${pageId}\` is not one this harness opened. A harness reaches only the pages it ` +
          'opened in its own browser; list them, or open the address again.',
        { pageId },
      ),
    );

  const perform = async (call: Call): Promise<McpCallResult> => {
    const { tool, args } = call;
    const pageId = args['pageId'];
    if (typeof pageId === 'string' && !opened.has(pageId)) {
      const error = notOpenedHere(pageId);
      record(call, { ok: false, error });
      return errorResult(error);
    }

    if (tool === 'evaluate') {
      const parsed = HarnessBrowserEvaluateInputSchema.safeParse(args);
      let outcome: CallOutcome;
      if (!parsed.success) {
        outcome = { ok: false, error: validationError(parsed.error.message) };
      } else {
        try {
          outcome = {
            ok: true,
            output: await driver.evaluate(scope, parsed.data.pageId, parsed.data.expression),
          };
        } catch (error) {
          if (!(error instanceof BrowserDriverError)) throw error;
          outcome = { ok: false, error: browserFailure(error) };
        }
      }
      record(call, outcome);
      return outcome.ok ? textResult(outcome.output) : errorResult(outcome.error);
    }

    const relayed = relayTools(ephemeral).find((each) => each.name === tool);
    if (relayed?.operationId === undefined) {
      const error = validationError(`This browser has no tool \`${tool}\`.`);
      record(call, { ok: false, error });
      return errorResult(error);
    }
    let image: { data: string; mimeType: string } | undefined;
    let screenshot: PayloadRef | undefined;
    const browserCall: BrowserCall = {
      ...scope,
      // A relayed call is sent once; the relay never resends one.
      redelivered: false,
      stepExecutionId: options.stepExecutionId,
      storeScreenshot: async (taken) => {
        image = taken;
        screenshot = await options.storeScreenshot(taken);
        return screenshot;
      },
    };
    const input = tool === 'open' ? { ...args, profileId } : args;
    const outcome = await performBrowserOperation(driver, relayed.operationId, input, browserCall);
    if (outcome.ok && tool === 'open') {
      const openedPageId = field(outcome.output, 'pageId');
      if (typeof openedPageId === 'string') {
        // The end of the run closes the pages in one pass; one arriving after it would outlive the run.
        if (closing) await driver.close(scope, openedPageId).catch(() => undefined);
        else opened.add(openedPageId);
      }
    }
    if (outcome.ok && tool === 'close') opened.delete(String(args['pageId']));
    const shown =
      outcome.ok && tool === 'list'
        ? {
            pages: ((field(outcome.output, 'pages') as unknown[] | undefined) ?? []).filter(
              (page) => opened.has(String(field(page, 'pageId'))),
            ),
          }
        : outcome.ok
          ? outcome.output
          : undefined;
    record(call, outcome.ok ? { ok: true, output: shown } : outcome, screenshot);
    if (!outcome.ok) return errorResult(outcome.error);
    if (image === undefined) return textResult(shown);
    // The model reads the image itself; the reference is the platform's, not the harness's.
    const { ref: _ref, ...described } = (field(shown, 'image') ?? {}) as Record<string, unknown>;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ...(shown as object), image: described }) },
        { type: 'image', data: image.data, mimeType: image.mimeType },
      ],
    };
  };

  const openTurn = async (): Promise<HarnessBrowserTurn> => {
    if (closing) throw new Error('The run has ended, and its browser with it.');
    turnCount += 1;
    const turnDir = join(dir, `turn-${String(turnCount)}`);
    const requestPath = join(turnDir, 'request.pipe');
    const responsePath = join(turnDir, 'response.pipe');
    const mcpConfigPath = join(turnDir, 'mcp.json');
    const relayArgs = [relayPath, toolsPath, requestPath, responsePath];

    let requests: Socket | undefined;
    let responses: Socket | undefined;
    let ended = false;
    const waiting: Array<{ readonly id: number; readonly call: Call }> = [];
    const turn: HarnessBrowserTurn = {
      mcpConfigPath,
      relayArgs,
      close: async () => {
        if (ended) return;
        ended = true;
        turns.delete(turn);
        for (const { call } of waiting.splice(0)) abandon(call);
        requests?.destroy();
        responses?.destroy();
        await rm(turnDir, { recursive: true, force: true });
      },
    };
    turns.add(turn);

    try {
      await mkdir(turnDir, { mode: 0o700 });
      await writeFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [HARNESS_BROWSER_SERVER]: { type: 'stdio', command: process.execPath, args: relayArgs },
          },
        }),
      );
      await makeFifo('mkfifo', ['-m', '600', requestPath, responsePath]);
      // Opened for reading and writing both, so neither open waits for the
      // relay and the request pipe never reads as ended while the turn lasts.
      requests = new Socket({
        fd: openSync(requestPath, constants.O_RDWR | constants.O_NONBLOCK),
        readable: true,
        writable: false,
      });
      responses = new Socket({
        fd: openSync(responsePath, constants.O_RDWR | constants.O_NONBLOCK),
        readable: false,
        writable: true,
      });
    } catch (error) {
      await turn.close();
      throw error;
    }
    const replies = responses;

    const answer = (id: number, result: McpCallResult): void => {
      if (ended || replies.destroyed) return;
      replies.write(`${JSON.stringify({ id, result })}\n`);
    };

    let performing = 0;
    const startWaiting = (): void => {
      while (!ended && performing < MAX_CALLS_IN_FLIGHT_PER_TURN) {
        const next = waiting.shift();
        if (next === undefined) return;
        performing += 1;
        const work = perform(next.call)
          .then((result) => {
            answer(next.id, result);
          })
          .catch((error: unknown) => {
            answer(
              next.id,
              textResult({ error: { code: 'INTERNAL', message: String(error) } }, true),
            );
          });
        inFlight.set(next.call, work);
        void work.finally(() => {
          inFlight.delete(next.call);
          performing -= 1;
          startWaiting();
        });
      }
    };

    const serve = (line: string): void => {
      if (ended || line.trim() === '') return;
      let request: RelayRequest;
      try {
        request = JSON.parse(line) as RelayRequest;
      } catch {
        return;
      }
      if (typeof request.id !== 'number' || typeof request.tool !== 'string') return;
      if (waiting.length >= MAX_CALLS_WAITING_PER_TURN) {
        answer(
          request.id,
          textResult(
            {
              error: {
                code: 'BROWSER_TOO_MANY_CALLS',
                message:
                  `This turn already has ${String(MAX_CALLS_IN_FLIGHT_PER_TURN)} browser calls ` +
                  `running and ${String(MAX_CALLS_WAITING_PER_TURN)} waiting, so this one was ` +
                  'not taken. Send it again once some of them have answered.',
              },
            },
            true,
          ),
        );
        return;
      }
      waiting.push({
        id: request.id,
        call: {
          tool: request.tool,
          args:
            typeof request.arguments === 'object' && request.arguments !== null
              ? (request.arguments as Record<string, unknown>)
              : {},
          logged: false,
        },
      });
      startWaiting();
    };

    // The request pipe is writable from inside the sandbox, so what arrives on
    // it is bounded here rather than trusted to be the relay's.
    let partial: Buffer[] = [];
    let partialBytes = 0;
    const overflow = (): void => {
      partial = [];
      options.onActivity({
        kind: 'status',
        at: Math.max(0, now() - options.startedAt),
        text:
          `The browser closed for this turn: a request to it ran past ` +
          `${String(MAX_REQUEST_LINE_BYTES)} bytes without ending.`,
      });
      void turn.close();
    };
    requests.on('data', (chunk: Buffer) => {
      let rest = chunk;
      while (!ended) {
        const newline = rest.indexOf(0x0a);
        const segment = newline === -1 ? rest : rest.subarray(0, newline);
        if (partialBytes + segment.length > MAX_REQUEST_LINE_BYTES) {
          overflow();
          return;
        }
        if (newline === -1) {
          partial.push(segment);
          partialBytes += segment.length;
          return;
        }
        const line = Buffer.concat([...partial, segment]).toString('utf8');
        partial = [];
        partialBytes = 0;
        rest = rest.subarray(newline + 1);
        serve(line);
      }
    });
    requests.on('error', () => undefined);
    replies.on('error', () => undefined);
    return turn;
  };

  return {
    openTurn,
    records: () => [...records],
    close: async () => {
      if (closing) return;
      closing = true;
      for (const turn of [...turns]) await turn.close();
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight.values()]),
        new Promise((resolve) => {
          grace = setTimeout(resolve, options.inFlightGraceMs ?? IN_FLIGHT_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
      for (const call of inFlight.keys()) abandon(call);
      if (!ephemeral) {
        for (const pageId of opened) await driver.close(scope, pageId).catch(() => undefined);
      }
      await removeAll();
    },
  };
}

/** The browser log as it is stored: one JSON record per line. */
export function browserLogText(records: readonly HarnessBrowserLogRecord[]): string {
  return records.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}
