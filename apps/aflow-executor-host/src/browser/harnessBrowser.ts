/**
 * A harness run's browser, from the executor's side (Plan 320 D11).
 *
 * The run's scratch directory gets the relay script, its tool list, an MCP
 * configuration naming it, and a pair of named pipes. The harness starts the
 * relay inside its sandbox; the relay passes each tool call down the request
 * pipe, and this module performs it through `performBrowserOperation` — the
 * function a browser step runs — so posture, rules, egress proxy, page
 * ownership, bounds and refusals are the operations' own. Nothing here widens
 * the sandbox: the pipes sit in a directory the run could already write.
 *
 * Every call becomes a line in the run's activity feed and a record in its
 * browser log. When the run ends, however it ends, the pipes close, the pages
 * the harness opened close, an ephemeral profile's browser stops, and every
 * file written here is removed.
 */
import { execFile } from 'node:child_process';
import { constants, openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
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

/** The directory under the run's scratch that holds everything written here. */
export const HARNESS_BROWSER_DIR = 'browser';
/** Where an ephemeral profile's Chrome keeps its directory, under the temp root. */
export const EPHEMERAL_PROFILE_SCRATCH_PREFIX = 'aflow-browser-';
/** The name the harness knows the server by; its tools reach it as `mcp__browser__<tool>`. */
export const HARNESS_BROWSER_SERVER = 'browser';

const RELAY_SOURCE = fileURLToPath(new URL('./harnessRelay.mjs', import.meta.url));
/** How long the end of a run waits for calls still in flight before it closes the pages under them. */
const IN_FLIGHT_GRACE_MS = 5_000;

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
}

export interface HarnessBrowser {
  /** The MCP configuration file the harness is handed through its profile's `mcpArgs`. */
  readonly mcpConfigPath: string;
  /** Where a relay finds its pipes and tool list; what the configuration names. */
  readonly relayArgs: readonly string[];
  /** Every call so far, in the order each ended. */
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

const READS = new Set(['snapshot', 'read', 'screenshot', 'list', 'evaluate']);

/**
 * Opens a run's browser: the profile resolved or made, the relay and its pipes
 * written. A named profile the run's space may not use is refused here, before
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
    profileId = driver.startEphemeral(scope, ephemeralDir);
  } else {
    profileId = (await driver.harnessProfile(scope, options.profile)).id;
  }

  const dir = join(options.scratchDir, HARNESS_BROWSER_DIR);
  const requestPath = join(dir, 'request.pipe');
  const responsePath = join(dir, 'response.pipe');
  const relayPath = join(dir, 'relay.mjs');
  const toolsPath = join(dir, 'tools.json');
  const mcpConfigPath = join(dir, 'mcp.json');
  const relayArgs = [relayPath, toolsPath, requestPath, responsePath];

  let requests: Socket | undefined;
  let responses: Socket | undefined;
  const removeAll = async (): Promise<void> => {
    requests?.destroy();
    responses?.destroy();
    if (ephemeral) await driver.endEphemeral(profileId);
    await rm(dir, { recursive: true, force: true });
    if (ephemeralDir !== undefined) await rm(ephemeralDir, { recursive: true, force: true });
  };

  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(RELAY_SOURCE, relayPath);
    await writeFile(toolsPath, JSON.stringify(relayToolDefinitions(ephemeral)));
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [HARNESS_BROWSER_SERVER]: { type: 'stdio', command: process.execPath, args: relayArgs },
        },
      }),
    );
    await makeFifo('mkfifo', ['-m', '600', requestPath, responsePath]);
    // Opened for reading and writing both, so neither open waits for the relay
    // and the request pipe never reads as ended between two relays.
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
    await removeAll();
    throw error;
  }

  const records: HarnessBrowserLogRecord[] = [];
  const opened = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let closed = false;

  const answer = (id: number, result: McpCallResult): void => {
    if (closed || responses.destroyed) return;
    responses.write(`${JSON.stringify({ id, result })}\n`);
  };

  const record = (
    tool: string,
    args: Record<string, unknown>,
    outcome: { ok: true; output: unknown } | { ok: false; error: AflowError },
  ): void => {
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
      action: tool === 'act' && typeof args['action'] === 'string' ? `act.${args['action']}` : tool,
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
    };
    records.push(entry);
    const where = entry.origin ?? entry.pageId;
    const said = outcome.ok ? entry.outcome : `${entry.outcome}: ${outcome.error.code}`;
    options.onActivity({
      kind: 'tool',
      at: Math.max(0, now() - options.startedAt),
      tool: `browser.page.${tool}`,
      text: `${entry.action}${where !== undefined ? ` ${where}` : ''} — ${said}`,
    });
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

  const perform = async (request: RelayRequest): Promise<McpCallResult> => {
    const { tool } = request;
    const args =
      typeof request.arguments === 'object' && request.arguments !== null
        ? (request.arguments as Record<string, unknown>)
        : {};
    const pageId = args['pageId'];
    if (typeof pageId === 'string' && !opened.has(pageId)) {
      const error = notOpenedHere(pageId);
      record(tool, args, { ok: false, error });
      return errorResult(error);
    }

    if (tool === 'evaluate') {
      const parsed = HarnessBrowserEvaluateInputSchema.safeParse(args);
      let outcome: { ok: true; output: unknown } | { ok: false; error: AflowError };
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
      record(tool, args, outcome);
      return outcome.ok ? textResult(outcome.output) : errorResult(outcome.error);
    }

    const relayed = relayTools(ephemeral).find((each) => each.name === tool);
    if (relayed?.operationId === undefined) {
      const error = validationError(`This browser has no tool \`${tool}\`.`);
      record(tool, args, { ok: false, error });
      return errorResult(error);
    }
    let image: { data: string; mimeType: string } | undefined;
    const call: BrowserCall = {
      ...scope,
      // A relayed call is sent once; the relay never resends one.
      redelivered: false,
      stepExecutionId: options.stepExecutionId,
      storeScreenshot: async (taken) => {
        image = taken;
        return await options.storeScreenshot(taken);
      },
    };
    const input = tool === 'open' ? { ...args, profileId } : args;
    const outcome = await performBrowserOperation(driver, relayed.operationId, input, call);
    if (outcome.ok && tool === 'open') {
      const openedPageId = field(outcome.output, 'pageId');
      if (typeof openedPageId === 'string') opened.add(openedPageId);
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
    record(tool, args, outcome.ok ? { ok: true, output: shown } : outcome);
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

  const serve = (line: string): void => {
    if (closed || line.trim() === '') return;
    let request: RelayRequest;
    try {
      request = JSON.parse(line) as RelayRequest;
    } catch {
      return;
    }
    if (typeof request.id !== 'number' || typeof request.tool !== 'string') return;
    const work = perform(request)
      .then((result) => {
        answer(request.id, result);
      })
      .catch((error: unknown) => {
        answer(
          request.id,
          textResult({ error: { code: 'INTERNAL', message: String(error) } }, true),
        );
      });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  createInterface({ input: requests }).on('line', serve);
  requests.on('error', () => undefined);
  responses.on('error', () => undefined);

  return {
    mcpConfigPath,
    relayArgs,
    records: () => [...records],
    close: async () => {
      if (closed) return;
      closed = true;
      requests.destroy();
      responses.destroy();
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => {
          grace = setTimeout(resolve, IN_FLIGHT_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
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
