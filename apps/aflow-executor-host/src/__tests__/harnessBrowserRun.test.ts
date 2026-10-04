/**
 * Contract: a harness run that asks for a browser is the same run as one that
 * does not, plus an MCP configuration on its command line (Plan 320 §6, "The
 * relay widens nothing").
 *
 * The sandboxed spawn alone is stood in for — it records what it was handed,
 * and on a run with a browser it speaks down the pipes as the relay would — so
 * the policy the real spawn would compile is compiled here from exactly that,
 * for a run with a browser and one without, and compared.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  type HarnessActivityLine,
  HarnessBrowserLogRecordSchema,
  type PayloadRef,
} from '@aflow/schemas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { compileSandboxPolicy, FORBIDDEN_SANDBOX_OPTIONS } from '../sandboxPolicy.js';
import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';
import { harness, profile } from './fixtures/fakeBrowser.js';
import { relayEnd } from './fixtures/relayPipes.js';

const run = promisify(execFile);
const handed: SandboxedRunInput[] = [];

/** What the stand-in harness did with its browser, per run. */
const browsed: Array<{ opened: unknown; typed: unknown }> = [];

async function useBrowser(argv: readonly string[]): Promise<void> {
  const at = argv.indexOf('--mcp-config');
  if (at === -1) return;
  const config = JSON.parse(await readFile(argv[at + 1] ?? '', 'utf8')) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  const [, , requestPath = '', responsePath = ''] = config.mcpServers['browser']?.args ?? [];
  const relay = relayEnd(requestPath, responsePath);
  try {
    relay.send({ id: 1, tool: 'open', arguments: { url: 'http://localhost:5173/' } });
    const opened = await relay.next((message) => message['id'] === 1);
    const text = (opened['result'] as { content: Array<{ text: string }> }).content[0]?.text;
    const { pageId } = JSON.parse(text ?? '{}') as { pageId: string };
    relay.send({
      id: 2,
      tool: 'act',
      arguments: { pageId, ref: 'e4', action: 'type', text: 'seven c' },
    });
    browsed.push({ opened, typed: await relay.next((message) => message['id'] === 2) });
  } finally {
    relay.close();
  }
}

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      handed.push(input);
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

const MCP_ARGS = ['--mcp-config', '{mcpConfig}', '--strict-mcp-config'];

let base: string;
let repo: string;
let policyPath: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'host-harness-browser-'));
  repo = join(base, 'project');
  await mkdir(repo, { recursive: true });
  const git = async (...args: string[]): Promise<void> => {
    await run('git', ['-C', repo, ...args]);
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), '# project\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'initial');
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
      harnesses: [
        {
          id: 'browsing',
          executable: '/bin/sh',
          args: ['-c', 'true'],
          mcpArgs: MCP_ARGS,
          allowedDomains: ['api.example.com'],
          browserLocalPorts: [5173],
        },
        { id: 'bare', executable: '/bin/sh', args: ['-c', 'true'] },
      ],
    }),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Ran {
  readonly status: string;
  readonly written: Record<string, unknown>;
  readonly activity: HarnessActivityLine[];
  readonly chromeLaunches: number;
}

async function runHarness(
  input: Record<string, unknown>,
  runId: string,
  space: { spaceId?: string } = { spaceId: 'space-test' },
): Promise<Ran> {
  const h = harness({ browsers: [profile({ id: 'default' })] });
  h.world.localHosts.add('localhost');
  const written: Record<string, unknown> = {};
  const activity: HarnessActivityLine[] = [];
  const outcome = await createHostHarnessHandler(policyPath, {
    driver: h.driver,
    storeScreenshot: () => Promise.resolve('inline:shot' as PayloadRef),
  }).execute({
    operationId: 'host.harness.run',
    tenantId: 't1',
    ...space,
    runId,
    stepExecutionId: `se-${runId}`,
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({ bindingId: 'hb', task: 'Check the page.', timeoutMs: 60_000, ...input }),
    emitLiveDelta: (_channel: string, delta: string) => {
      for (const line of delta.split('\n').filter((each) => each !== '')) {
        activity.push(JSON.parse(line) as HarnessActivityLine);
      }
      return Promise.resolve();
    },
    writePayload: (kind: string, data: unknown) => {
      written[kind] = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never);
  return { status: outcome.status, written, activity, chromeLaunches: h.launches.length };
}

/** The policy the spawn compiles, with this run's scratch directory written as one name. */
function compiledPolicy(input: SandboxedRunInput): string {
  const policy = compileSandboxPolicy(input.binding, {
    scratchDir: input.scratchDir,
    ...(input.widening !== undefined ? { widening: input.widening } : {}),
    ...(input.toolPaths !== undefined ? { toolPaths: input.toolPaths } : {}),
  });
  return JSON.stringify(policy).split(input.scratchDir).join('<scratch>');
}

describe('a harness run with a browser', () => {
  it('compiles a sandbox policy byte-identical to one without, apart from its scratch', async () => {
    handed.length = 0;
    const without = await runHarness({ harness: 'browsing' }, 'run-plain');
    const withBrowser = await runHarness(
      { harness: 'browsing', browser: { profile: 'ephemeral' } },
      'run-browser',
    );
    expect(without.status).toBe('SUCCEEDED');
    expect(withBrowser.status).toBe('SUCCEEDED');
    const [plain, browsing] = handed;
    if (plain === undefined || browsing === undefined) throw new Error('two spawns expected');

    expect(plain.scratchDir).not.toBe(browsing.scratchDir);
    expect(compiledPolicy(browsing)).toBe(compiledPolicy(plain));
    const policy = JSON.parse(compiledPolicy(browsing)) as Record<string, unknown> & {
      network: { allowedDomains: string[] };
    };
    expect(policy.network.allowedDomains).toEqual(['api.example.com']);
    for (const option of [...FORBIDDEN_SANDBOX_OPTIONS, 'allowLocalBinding']) {
      expect(JSON.stringify(policy)).not.toContain(option);
    }

    // Everything else it was handed is the same too; only the command line gained the configuration.
    const rest = (input: SandboxedRunInput): string =>
      JSON.stringify({
        env: input.env,
        trustedEnv: input.trustedEnv,
        widening: input.widening,
        toolPaths: input.toolPaths,
        inheritEnv: input.inheritEnv,
      })
        .split(input.scratchDir)
        .join('<scratch>');
    expect(rest(browsing)).toBe(rest(plain));
    const at = browsing.argv.indexOf('--mcp-config');
    const config = browsing.argv[at + 1] ?? '';
    expect(config.startsWith(browsing.scratchDir)).toBe(true);
    expect(browsing.argv.filter((arg) => arg !== config)).toEqual([
      ...plain.argv.slice(0, -1),
      '--mcp-config',
      '--strict-mcp-config',
      plain.argv.at(-1),
    ]);
  }, 60_000);

  it('reports every browser call in the feed and in a browser log on its result', async () => {
    browsed.length = 0;
    const ran = await runHarness(
      { harness: 'browsing', browser: { profile: 'ephemeral' } },
      'run-log',
    );
    expect(ran.status).toBe('SUCCEEDED');
    expect(browsed).toHaveLength(1);
    const output = ran.written['output'] as Record<string, unknown>;
    expect(output['browserLog']).toBe('inline:logs');
    const log = String(ran.written['logs']);
    expect(log).not.toContain('seven c');
    const records = log
      .trimEnd()
      .split('\n')
      .map((line) => HarnessBrowserLogRecordSchema.parse(JSON.parse(line)));
    expect(records.map((record) => [record.profile, record.action, record.outcome])).toEqual([
      ['ephemeral', 'open', 'performed'],
      ['ephemeral', 'act.type', 'performed'],
    ]);
    expect(records[1]?.typedCharacters).toBe(7);
    expect(
      ran.activity
        .filter((line) => line.kind === 'tool')
        .map((line) => line.kind === 'tool' && line.tool),
    ).toEqual(['browser.page.open', 'browser.page.act']);
  }, 60_000);

  it('is refused on a harness the machine gave no mcpArgs, naming the field and the command', async () => {
    handed.length = 0;
    const ran = await runHarness(
      { harness: 'bare', browser: { profile: 'ephemeral' } },
      'run-bare',
    );
    expect(ran.status).toBe('FAILED');
    const error = ran.written['error'] as { message: string; classification: string };
    expect(error.classification).toBe('validation');
    expect(error.message).toContain('`mcpArgs`');
    expect(error.message).toContain('aflow harness browser bare');
    expect(handed).toHaveLength(0);
  }, 60_000);

  it('is refused for a job carrying no space, as a browser step is, before any browser opens', async () => {
    handed.length = 0;
    const ran = await runHarness(
      { harness: 'browsing', browser: { profile: 'ephemeral' } },
      'run-spaceless',
      {},
    );
    expect(ran.status).toBe('FAILED');
    expect((ran.written['error'] as { message: string }).message).toContain('names no workspace');
    expect(ran.chromeLaunches).toBe(0);
    expect(handed).toHaveLength(0);
  }, 60_000);
});
