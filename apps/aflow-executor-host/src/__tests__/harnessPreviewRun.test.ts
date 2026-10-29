/**
 * Contract: a harness run with `preview: true` has the executor — never the
 * agent — start the folder's preview in a snapshot of the run's checkout,
 * which nothing the agent writes reaches, before the browser opens (F49);
 * hands the harness its address in the inputs, opens that port to the run's
 * ephemeral browser and no other, keeps what it printed as a payload of its
 * own beside the browser log, whether the run succeeds or fails, and stops it
 * however the run ends (Plan 320 D19). A run it cannot serve is refused before
 * any checkout, naming another run only to a caller in that run's workspace.
 *
 * The sandboxed spawn and the preview's start are stood in for; the port
 * claim, the browser and the payload writes are the real ones.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { HarnessBrowserLogRecordSchema, type PayloadRef } from '@aflow/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StartedPreview, StartPreviewInput } from '../previewSupervisor.js';
import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';
import { harness, profile } from './fixtures/fakeBrowser.js';
import { relayEnd } from './fixtures/relayPipes.js';

const run = promisify(execFile);

/** A fixed port something other than a run's preview listens on. */
const PORT_IN_USE = 41_802;
const FIXED_PORT = 41_801;
/** A preview command the stand-in never sees answer. */
const NEVER_READY = 'never-ready';

const handed: SandboxedRunInput[] = [];
const started: StartPreviewInput[] = [];
/** For each preview stopped: what was on disk when it was. */
const stopped: Array<{
  port: number;
  checkoutPresent: boolean;
  agentWriteSeen: boolean;
  readmeSeen: boolean;
}> = [];

/** What the stand-in harness writes into its checkout while the preview runs. */
const AGENT_WRITE = 'agent-wrote-this.mjs';

/** The address the brief handed the harness, read back out of its task. */
function previewUrlIn(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    const match = /"previewUrl":"([^"]+)"/.exec(arg);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** What the stand-in harness does with its browser: its preview, then a harness port. */
async function useBrowser(argv: readonly string[]): Promise<void> {
  const at = argv.indexOf('--mcp-config');
  if (at === -1) return;
  const config = JSON.parse(await readFile(argv[at + 1] ?? '', 'utf8')) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  const [, , requestPath = '', responsePath = ''] = config.mcpServers['browser']?.args ?? [];
  const relay = relayEnd(requestPath, responsePath);
  try {
    const url = previewUrlIn(argv)?.replace('127.0.0.1', 'localhost');
    relay.send({ id: 1, tool: 'open', arguments: { url } });
    await relay.next((message) => message['id'] === 1);
    relay.send({ id: 2, tool: 'open', arguments: { url: 'http://localhost:5173/' } });
    await relay.next((message) => message['id'] === 2);
  } finally {
    relay.close();
  }
}

// The free port a run takes, handed out here rather than bound: where this
// runs may refuse listening on loopback, and nothing listens on it anyway.
let nextFreePort = 47_100;
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createServer: () => {
      const port = (nextFreePort += 1);
      const server = {
        once: () => server,
        listen: (_options: unknown, listening: () => void) => {
          listening();
          return server;
        },
        address: () => ({ address: '127.0.0.1', family: 'IPv4', port }),
        close: (closed: () => void) => {
          closed();
          return server;
        },
      };
      return server;
    },
  };
});

vi.mock('@aflow/lib/port-probe', () => ({
  portTaken: (port: number) => Promise.resolve(port === PORT_IN_USE),
}));

vi.mock('../previewSupervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../previewSupervisor.js')>();
  return {
    ...actual,
    startPreview: (input: StartPreviewInput): Promise<StartedPreview> => {
      started.push(input);
      if (input.preview.command.includes(NEVER_READY)) {
        return Promise.reject(
          new actual.PreviewError(
            `The preview \`${input.preview.command}\` did not answer at http://127.0.0.1:${String(input.port)}/ within 120 s. The last lines it printed:\nstill compiling\n`,
            'not_ready',
            'still compiling\n',
          ),
        );
      }
      let done = false;
      return Promise.resolve({
        port: input.port,
        previewUrl: `http://127.0.0.1:${String(input.port)}/`,
        log: () => `the preview served from ${input.cwd}\n`,
        stop: () => {
          if (done) return Promise.resolve();
          done = true;
          stopped.push({
            port: input.port,
            checkoutPresent: existsSync(input.cwd),
            agentWriteSeen: existsSync(join(input.cwd, AGENT_WRITE)),
            readmeSeen: existsSync(join(input.cwd, 'README.md')),
          });
          return Promise.resolve();
        },
      });
    },
  };
});

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      handed.push(input);
      await writeFile(join(input.cwd, AGENT_WRITE), 'process.exit(1)\n');
      if (input.argv.some((arg) => arg.includes('BREAK THE TURN'))) {
        throw new Error('the harness could not be started');
      }
      await useBrowser(input.argv);
      return {
        processId: `hr_${String(handed.length)}`,
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout: 'Looked at it.',
        stderr: '',
        truncated: false,
      };
    },
  };
});

const { createHostHarnessHandler } = await import('../handlers/harnessHandlers.js');
const { claimPreviewPort, previewPortHolder } = await import('../previewSupervisor.js');

let base: string;
let policyPath: string;

async function repository(name: string): Promise<string> {
  const repo = join(base, name);
  await mkdir(repo, { recursive: true });
  const git = async (...args: string[]): Promise<void> => {
    await run('git', ['-C', repo, ...args]);
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), `# ${name}\n`);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'initial');
  return repo;
}

function binding(id: string, root: string, preview?: Record<string, unknown>) {
  return {
    id,
    root,
    mode: 'readwrite',
    allowsExecution: true,
    singleFile: false,
    spaceId: 'space-test',
    ...(preview !== undefined ? { preview } : {}),
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'host-harness-preview-'));
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        binding('hb', await repository('site'), { command: 'yarn dev --port {port}' }),
        binding('hb-fixed', await repository('fixed'), { command: 'yarn dev', port: FIXED_PORT }),
        binding('hb-busy', await repository('busy'), { command: 'yarn dev', port: PORT_IN_USE }),
        binding('hb-none', await repository('plain')),
        binding('hb-slow', await repository('slow'), { command: `yarn ${NEVER_READY} {port}` }),
      ],
      harnesses: [
        {
          id: 'browsing',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          mcpArgs: ['--mcp-config', '{mcpConfig}', '--strict-mcp-config'],
          allowedDomains: ['api.example.com'],
          browserLocalPorts: [5173],
        },
      ],
    }),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  handed.length = 0;
  started.length = 0;
  stopped.length = 0;
});

interface Ran {
  readonly status: string;
  readonly written: Record<string, unknown>;
  readonly error?: { message: string; classification: string } | undefined;
  readonly output?: Record<string, unknown> | undefined;
}

async function runHarness(input: Record<string, unknown>, runId: string): Promise<Ran> {
  const h = harness({ browsers: [profile({ id: 'default' })] });
  h.world.localHosts.add('localhost');
  const written: Record<string, unknown> = {};
  const outcome = await createHostHarnessHandler(policyPath, {
    driver: h.driver,
    storeScreenshot: () => Promise.resolve('inline:shot' as PayloadRef),
  }).execute({
    operationId: 'host.harness.run',
    tenantId: 't1',
    spaceId: 'space-test',
    runId,
    stepExecutionId: `se-${runId}`,
    attempt: 1,
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({
        bindingId: 'hb',
        harness: 'browsing',
        task: 'Check the page.',
        timeoutMs: 60_000,
        browser: { profile: 'ephemeral' },
        preview: true,
        ...input,
      }),
    emitLiveDelta: () => Promise.resolve(),
    reportProgress: () => undefined,
    writePayload: (kind: string, data: unknown) => {
      written[kind] = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never);
  return {
    status: outcome.status,
    written,
    ...(written['error'] !== undefined ? { error: written['error'] as Ran['error'] } : {}),
    ...(written['output'] !== undefined
      ? { output: written['output'] as Record<string, unknown> }
      : {}),
  };
}

function browserLog(ran: Ran): Array<[string, string]> {
  return String(ran.written['logs'])
    .trimEnd()
    .split('\n')
    .map((line) => HarnessBrowserLogRecordSchema.parse(JSON.parse(line)))
    .map((record) => [record.origin ?? '', record.outcome]);
}

describe('a harness run with a preview', () => {
  it('starts it in a snapshot of the run’s checkout, hands the harness its address and stops it', async () => {
    const ran = await runHarness({ inputs: { range: 'main..HEAD' } }, 'run-preview');
    expect(ran.status).toBe('SUCCEEDED');

    expect(started).toHaveLength(1);
    const [preview] = started;
    if (preview === undefined) throw new Error('a preview was expected');
    expect(preview.preview.command).toBe('yarn dev --port {port}');
    expect(preview.bindingId).toBe('hb');
    expect(preview.ownerRunId).toBe('run-preview');
    // Neither the operator's folder nor the checkout the agent works in: a
    // copy of its commit, which the agent's writes never reach.
    expect(preview.cwd).not.toBe(join(base, 'site'));
    expect(preview.cwd).not.toBe(handed[0]?.cwd);
    expect(stopped[0]?.readmeSeen).toBe(true);
    expect(stopped[0]?.agentWriteSeen).toBe(false);
    expect(String(ran.output?.['patch'])).toContain(AGENT_WRITE);
    // Taken away with the run, as its checkout is.
    expect(existsSync(preview.cwd)).toBe(false);

    const url = `http://127.0.0.1:${String(preview.port)}/`;
    expect(previewUrlIn(handed[0]?.argv ?? [])).toBe(url);
    expect(handed[0]?.argv.some((arg) => arg.includes('"range":"main..HEAD"'))).toBe(true);
    expect(ran.output?.['previewUrl']).toBe(url);

    // Stopped with its checkout still there, and its port released.
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    expect(stopped.every((stop) => stop.checkoutPresent)).toBe(true);
    expect(previewPortHolder(preview.port)).toBeUndefined();
  }, 60_000);

  it('opens its port to the run’s browser in place of the harness’s declared ports', async () => {
    const ran = await runHarness({}, 'run-reach');
    expect(ran.status).toBe('SUCCEEDED');
    const port = started[0]?.port ?? 0;
    expect(browserLog(ran)).toEqual([
      [`http://localhost:${String(port)}`, 'performed'],
      ['http://localhost:5173', 'refused'],
    ]);
  }, 60_000);

  it('keeps what the preview printed beside the browser log, each under a kind of its own', async () => {
    const ran = await runHarness({}, 'run-logs');
    expect(ran.error?.message).toBeUndefined();
    expect(ran.status).toBe('SUCCEEDED');
    expect(ran.output?.['previewLog']).toBe('inline:preview_log');
    expect(ran.output?.['browserLog']).toBe('inline:logs');
    expect(String(ran.written['preview_log'])).toContain('the preview served from');
    expect(String(ran.written['logs'])).toContain('"action":"open"');
  }, 60_000);

  it('stops the preview, keeps its log and frees its port when the run fails', async () => {
    const ran = await runHarness({ task: 'BREAK THE TURN' }, 'run-broken');
    expect(ran.status).toBe('FAILED');
    expect(started).toHaveLength(1);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.checkoutPresent).toBe(true);
    expect(previewPortHolder(started[0]?.port ?? 0)).toBeUndefined();
    expect(String(ran.written['preview_log'])).toContain('the preview served from');
    const details = (ran.error as { details?: Record<string, unknown> } | undefined)?.details;
    expect(details?.['previewLog']).toBe('inline:preview_log');
  }, 60_000);
});

describe('a harness run refused its preview before any checkout', () => {
  it('is refused without a browser, as the schema says', async () => {
    const ran = await runHarness({ browser: undefined }, 'run-no-browser');
    expect(ran.status).toBe('FAILED');
    expect(ran.error?.classification).toBe('validation');
    expect(ran.error?.message).toContain('`preview: true` is given without `browser`');
    expect(handed).toHaveLength(0);
    expect(started).toHaveLength(0);
  }, 60_000);

  it('is refused on a folder that declares no preview, saying how to declare one', async () => {
    const ran = await runHarness({ bindingId: 'hb-none' }, 'run-undeclared');
    expect(ran.status).toBe('FAILED');
    expect(ran.error?.message).toContain('`hb-none` declares no preview');
    expect(ran.error?.message).toContain('aflow folder hb-none preview --command');
    expect(handed).toHaveLength(0);
  }, 60_000);

  it('is refused while another run’s preview holds the folder’s fixed port, naming that run', async () => {
    const holding = await claimPreviewPort(
      { port: FIXED_PORT },
      { runId: 'run-holder', bindingId: 'hb-fixed', tenantId: 't1', spaceId: 'space-test' },
    );
    try {
      const ran = await runHarness({ bindingId: 'hb-fixed' }, 'run-second');
      expect(ran.status).toBe('FAILED');
      expect(ran.error?.classification).toBe('validation');
      expect(ran.error?.message).toContain(
        `preview port ${String(FIXED_PORT)} is held by run run-holder`,
      );
      expect(handed).toHaveLength(0);
      expect(started).toHaveLength(0);
      expect(previewPortHolder(FIXED_PORT)?.runId).toBe('run-holder');
    } finally {
      holding.release();
    }
    const after = await runHarness({ bindingId: 'hb-fixed' }, 'run-third');
    expect(after.status).toBe('SUCCEEDED');
    expect(started[0]?.port).toBe(FIXED_PORT);
  }, 60_000);

  it('is refused without the holder’s name while another workspace’s run holds the port', async () => {
    const holding = await claimPreviewPort(
      { port: FIXED_PORT },
      { runId: 'run-elsewhere', bindingId: 'hb-other', tenantId: 't1', spaceId: 'space-other' },
    );
    try {
      const ran = await runHarness({ bindingId: 'hb-fixed' }, 'run-outsider');
      expect(ran.status).toBe('FAILED');
      expect(ran.error?.message).toContain(`preview port ${String(FIXED_PORT)} is in use`);
      expect(ran.error?.message).not.toContain('run-elsewhere');
      expect(handed).toHaveLength(0);
    } finally {
      holding.release();
    }
  }, 60_000);

  it('is refused when anything else listens on the folder’s fixed port', async () => {
    const ran = await runHarness({ bindingId: 'hb-busy' }, 'run-busy');
    expect(ran.status).toBe('FAILED');
    expect(ran.error?.message).toContain(`preview port ${String(PORT_IN_USE)} is in use`);
    expect(handed).toHaveLength(0);
    expect(previewPortHolder(PORT_IN_USE)).toBeUndefined();
  }, 60_000);

  it('fails when a preview a person asked for never answers', async () => {
    const ran = await runHarness({ bindingId: 'hb-slow' }, 'run-slow-asked');
    expect(ran.status).toBe('FAILED');
    expect(ran.error?.message).toContain('did not answer');
    expect(handed).toHaveLength(0);
  }, 60_000);
});

/** Whether the harness was handed a browser: its MCP configuration on the argv. */
function hadBrowser(): boolean {
  return handed[0]?.argv.includes('--mcp-config') ?? false;
}

/** What the harness was told of its preview, read out of its brief. */
function briefSays(text: string): boolean {
  return handed[0]?.argv.some((arg) => arg.includes(text)) ?? false;
}

describe('a harness run whose rule asked for its preview if available (D21)', () => {
  const ruled = { preview: 'if_available' };

  it('takes the preview where it can be had, as `true` does', async () => {
    const ran = await runHarness({ ...ruled }, 'run-ruled');
    expect(ran.status).toBe('SUCCEEDED');
    expect(started).toHaveLength(1);
    expect(ran.output?.['previewUrl']).toBe(`http://127.0.0.1:${String(started[0]?.port)}/`);
    expect(ran.output).not.toHaveProperty('previewUnavailable');
    expect(hadBrowser()).toBe(true);
  }, 60_000);

  it('runs on without the preview and its browser while another run holds the port', async () => {
    const holding = await claimPreviewPort(
      { port: FIXED_PORT },
      { runId: 'run-holder', bindingId: 'hb-fixed', tenantId: 't1', spaceId: 'space-test' },
    );
    try {
      const ran = await runHarness({ ...ruled, bindingId: 'hb-fixed' }, 'run-ruled-held');
      expect(ran.status).toBe('SUCCEEDED');
      expect(ran.output?.['previewUnavailable']).toContain(
        `preview port ${String(FIXED_PORT)} is held by run run-holder`,
      );
      expect(ran.output).not.toHaveProperty('previewUrl');
      expect(handed).toHaveLength(1);
      expect(started).toHaveLength(0);
      expect(hadBrowser()).toBe(false);
      expect(briefSays('"previewUnavailable"')).toBe(true);
      expect(previewPortHolder(FIXED_PORT)?.runId).toBe('run-holder');
    } finally {
      holding.release();
    }
  }, 60_000);

  it('runs on without them when anything else listens on the fixed port', async () => {
    const ran = await runHarness({ ...ruled, bindingId: 'hb-busy' }, 'run-ruled-busy');
    expect(ran.status).toBe('SUCCEEDED');
    expect(ran.output?.['previewUnavailable']).toContain(
      `preview port ${String(PORT_IN_USE)} is in use`,
    );
    expect(hadBrowser()).toBe(false);
    expect(previewPortHolder(PORT_IN_USE)).toBeUndefined();
  }, 60_000);

  it('runs on without them when the preview never answers, keeping what it printed', async () => {
    const ran = await runHarness({ ...ruled, bindingId: 'hb-slow' }, 'run-ruled-slow');
    expect(ran.status).toBe('SUCCEEDED');
    const line = String(ran.output?.['previewUnavailable']);
    expect(line).toContain('did not answer');
    expect(line).not.toContain('still compiling');
    expect(line).toContain('`previewLog`');
    expect(ran.output?.['previewLog']).toBe('inline:preview_log');
    expect(String(ran.written['preview_log'])).toContain('still compiling');
    expect(ran.output).not.toHaveProperty('previewUrl');
    expect(hadBrowser()).toBe(false);
    expect(previewPortHolder(started[0]?.port ?? 0)).toBeUndefined();
  }, 60_000);

  it('runs on without them on a folder that declares no preview', async () => {
    const ran = await runHarness({ ...ruled, bindingId: 'hb-none' }, 'run-ruled-none');
    expect(ran.status).toBe('SUCCEEDED');
    expect(ran.output?.['previewUnavailable']).toContain('`hb-none` declares no preview');
    expect(hadBrowser()).toBe(false);
  }, 60_000);
});
