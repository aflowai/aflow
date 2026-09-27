/**
 * Contract: a local MCP server is a workload, not a trusted peer.
 *
 * Exercised against a real MCP server over a real stdio transport — the point
 * is whether the boundary holds around a program speaking a protocol, so a
 * mocked client would test nothing.
 */
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHostMcpHandler } from '../handlers/mcpHandlers.js';
import { sandboxReadiness } from '../sandboxedRun.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echoMcpServer.mjs');
/** Where this server's own code and its dependencies live. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let policyPath: string;
let root: string;
let outsideFile: string;
let deniedHome: string;

interface Captured {
  output?: Record<string, unknown>;
}

function contextFor(operationId: string, input: unknown, captured: Captured): never {
  return {
    operationId,
    spaceId: 'space-test',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never;
}

function textOf(output: Record<string, unknown> | undefined): string {
  const content = output?.['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null
        ? String((block as Record<string, unknown>)['text'] ?? '')
        : '',
    )
    .join('');
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-mcp-'));
  // The refusal below is about a server whose own code sits in a denied
  // region, and home is the denied region. Reaching for the checkout's copy
  // made the test a statement about where somebody keeps their repositories:
  // run from a temp directory the server reads itself fine and the test fails
  // by succeeding. Placed under home deliberately, so the scenario is built
  // rather than inherited.
  deniedHome = await mkdtemp(join(homedir(), '.aflow-host-mcp-test-'));
  await copyFile(FIXTURE, join(deniedHome, 'echoMcpServer.mjs'));
  root = join(base, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'inside.txt'), 'inside the binding');
  outsideFile = join(base, 'outside.txt');
  await writeFile(outsideFile, 'OUTSIDE THE BINDING');

  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
        // Connected for its files only — no server may run under it.
        {
          id: 'hb_files',
          root,
          mode: 'readwrite',
          allowsExecution: false,
          singleFile: false,
          spaceId: 'space-test',
        },
        {
          id: 'hb_elsewhere',
          root,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
      mcpServers: [
        // `authPaths` covers the tree the server is installed in. Without it the
        // server cannot read its own code — home is denied as a region, and
        // this repository is under it.
        {
          id: 'echo',
          executable: process.execPath,
          args: [FIXTURE],
          bindingId: 'hb',
          authPaths: [REPO_ROOT],
        },
        // Declared for a different folder, to prove a request cannot move it.
        {
          id: 'elsewhere',
          executable: process.execPath,
          args: [FIXTURE],
          bindingId: 'hb_elsewhere',
          authPaths: [REPO_ROOT],
        },
        // Declared with no read access to its own code, to prove the refusal.
        {
          id: 'unreadable',
          executable: process.execPath,
          args: [join(deniedHome, 'echoMcpServer.mjs')],
          bindingId: 'hb',
        },
        { id: 'files_only', executable: process.execPath, args: [FIXTURE], bindingId: 'hb_files' },
      ],
    }),
  );
});

afterAll(async () => {
  if (deniedHome !== undefined) await rm(deniedHome, { recursive: true, force: true });
});

/**
 * Suites below that start a real confined process run only where this machine
 * can actually confine one. `isSupportedPlatform` is not that question: on
 * Linux it is true whether or not `bwrap`, `rg` and `socat` are installed, and
 * CI has none of them — the suite failed there reporting a dependency error as
 * though it were the command's own output.
 *
 * Only the suites that spawn are gated. The ones that refuse before spawning,
 * and the ones that are pure schema, are the coverage Linux most needs to keep.
 */

/** Wait for every process under a binding to be marked exited, or give up. */
async function settleUntilNoneRunning(
  bindingId: string,
  runId: string,
  deadlineMs = 20_000,
): Promise<unknown[]> {
  const { processesForBinding } = await import('../sandboxedRun.js');
  const started = Date.now();
  let live = processesForBinding(bindingId, runId).filter(([, entry]) => !entry.exited);
  while (live.length > 0 && Date.now() - started < deadlineMs) {
    await new Promise((r) => setTimeout(r, 50));
    live = processesForBinding(bindingId, runId).filter(([, entry]) => !entry.exited);
  }
  return live;
}

const CAN_CONFINE = sandboxReadiness().ready;

describe.runIf(CAN_CONFINE)('a local MCP server answers through the lane', () => {
  it('lists the tools it really has', async () => {
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor('host.mcp.list_tools', { bindingId: 'hb', serverId: 'echo' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    const names = (captured.output?.['tools'] as Array<{ name: string }>).map((t) => t.name);
    expect(names.sort()).toEqual(['echo', 'read_file', 'where']);
  }, 60_000);

  it('calls a tool and returns what the server said', async () => {
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor(
        'host.mcp.call',
        { bindingId: 'hb', serverId: 'echo', toolName: 'echo', arguments: { text: 'hello mesh' } },
        captured,
      ),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(textOf(captured.output)).toContain('hello mesh');
    expect(captured.output?.['isError']).toBe(false);
  }, 60_000);

  it('runs it inside the binding root', async () => {
    const captured: Captured = {};
    await createHostMcpHandler(policyPath).execute(
      contextFor(
        'host.mcp.call',
        { bindingId: 'hb', serverId: 'echo', toolName: 'where' },
        captured,
      ),
    );
    expect(textOf(captured.output)).toContain('project');
  }, 60_000);
});

describe.runIf(CAN_CONFINE)('the boundary holds around it, not the server behaving', () => {
  it('lets it read inside the binding', async () => {
    const captured: Captured = {};
    await createHostMcpHandler(policyPath).execute(
      contextFor(
        'host.mcp.call',
        {
          bindingId: 'hb',
          serverId: 'echo',
          toolName: 'read_file',
          arguments: { path: join(root, 'inside.txt') },
        },
        captured,
      ),
    );
    expect(textOf(captured.output)).toContain('inside the binding');
    expect(captured.output?.['isError']).toBe(false);
  }, 60_000);

  it('refuses a read outside it, though the server tried', async () => {
    // The fixture reads whatever it is handed. What stops it is the operating
    // system, which is the difference between a local server and a remote one
    // that is trusted to police its own side.
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor(
        'host.mcp.call',
        {
          bindingId: 'hb',
          serverId: 'echo',
          toolName: 'read_file',
          arguments: { path: '/etc/ssh/ssh_host_rsa_key' },
        },
        captured,
      ),
    );
    // The step succeeds; the server reports its own failure, which is the
    // distinction the output schema draws.
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['isError']).toBe(true);
    expect(textOf(captured.output)).not.toContain('PRIVATE KEY');
  }, 60_000);
});

describe('which server runs, and where, is the machine decision', () => {
  it('refuses a server the machine never configured', async () => {
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor('host.mcp.list_tools', { bindingId: 'hb', serverId: 'not-configured' }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('echo');
  }, 30_000);

  it('refuses to run a server in a binding it was not declared for', async () => {
    // Otherwise a request could point a server configured for one folder at
    // another, and where it runs would stop being the machine's decision.
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor('host.mcp.list_tools', { bindingId: 'hb_elsewhere', serverId: 'echo' }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('hb');
  }, 30_000);

  it('refuses a binding connected for files only', async () => {
    // A server is a program. Connecting a folder for its contents should not
    // become a way to run one.
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor(
        'host.mcp.list_tools',
        { bindingId: 'hb_files', serverId: 'files_only' },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
  }, 30_000);
});

describe.runIf(CAN_CONFINE)('a server that cannot read its own code says so', () => {
  it('names the boundary rather than leaving a missing module to be puzzled over', async () => {
    // Home is denied as a region, so a server installed under it cannot read
    // itself. The symptom is a missing module, which reads like a broken
    // install; the boundary is what actually refused, so it says so.
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor('host.mcp.list_tools', { bindingId: 'hb', serverId: 'unreadable' }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('authPaths');
  }, 30_000);
});

describe('a server declaration is what the machine typed', () => {
  it('keeps flag values out of the command line', async () => {
    // `--binding hb_project` is two tokens, and dropping only the one starting
    // with `--` left `hb_project` as an argument to the server. A server
    // launched with arguments nobody wrote is not the server that was declared.
    const { LocalMcpServerSchema } = await import('../localMcpServers.js');
    const parsed = LocalMcpServerSchema.parse({
      id: 'echo',
      executable: '/usr/bin/node',
      args: ['/srv/server.mjs'],
      bindingId: 'hb_project',
      authPaths: ['/opt/where-it-lives'],
    });
    expect(parsed.args).toEqual(['/srv/server.mjs']);
    expect(parsed.args).not.toContain('hb_project');
    expect(parsed.args).not.toContain('/opt/where-it-lives');
  });

  it('names the folder it runs in, because a sandbox comes from some binding', async () => {
    // Optional meant the caller chose, read and write, which is the decision
    // the machine's own file exists to keep.
    const { LocalMcpServerSchema } = await import('../localMcpServers.js');
    expect(LocalMcpServerSchema.safeParse({ id: 'x', executable: '/usr/bin/thing' }).success).toBe(
      false,
    );
  });

  it('grants nothing else by default — no reads, no egress', async () => {
    const { LocalMcpServerSchema } = await import('../localMcpServers.js');
    const bare = LocalMcpServerSchema.parse({
      id: 'x',
      executable: '/usr/bin/thing',
      bindingId: 'hb',
    });
    expect(bare.authPaths).toEqual([]);
    expect(bare.allowedDomains).toEqual([]);
    expect(bare.inheritEnv).toEqual([]);
  });
});

describe.runIf(CAN_CONFINE)('a local MCP server is a process this lane owns', () => {
  it('is in the registry while it runs, so withdrawal and shutdown reach it', async () => {
    // The protocol library ships a transport that spawns the server itself.
    // Using it put the server outside every registry here: withdrawal could not
    // reach it, shutdown could not kill it, the next boot could not find it,
    // and the library's own close kills only the launcher — which does not pass
    // the signal down to the workload underneath.
    const { processesForBinding } = await import('../sandboxedRun.js');
    let seen = 0;
    const watcher = setInterval(() => {
      seen = Math.max(seen, processesForBinding('hb', 'run-a').length);
    }, 20);
    try {
      const captured: Captured = {};
      await createHostMcpHandler(policyPath).execute(
        contextFor(
          'host.mcp.call',
          { bindingId: 'hb', serverId: 'echo', toolName: 'echo', arguments: { text: 'x' } },
          captured,
        ),
      );
    } finally {
      clearInterval(watcher);
    }
    expect(seen).toBeGreaterThan(0);
  }, 60_000);

  it('leaves nothing running once the call is answered', async () => {
    const { processesForBinding } = await import('../sandboxedRun.js');
    const captured: Captured = {};
    await createHostMcpHandler(policyPath).execute(
      contextFor(
        'host.mcp.call',
        { bindingId: 'hb', serverId: 'echo', toolName: 'echo', arguments: { text: 'y' } },
        captured,
      ),
    );
    // The kill is sent as the call returns, but the `close` event that marks
    // the entry exited arrives on its own schedule — asserting immediately
    // tests the scheduler rather than the teardown.
    const live = await settleUntilNoneRunning('hb', 'run-a');
    expect(live).toEqual([]);
  }, 60_000);

  it('does not ask to be retried when the declaration is what is wrong', async () => {
    // A server that will not start fails the same way next time, and every
    // attempt starts another one. These are declarations to fix, not weather.
    const captured: Captured = {};
    const result = await createHostMcpHandler(policyPath).execute(
      contextFor('host.mcp.list_tools', { bindingId: 'hb', serverId: 'unreadable' }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.retryable).toBe(false);
  }, 30_000);

  it('stops the server when the run is cancelled', async () => {
    const { processesForBinding } = await import('../sandboxedRun.js');
    const controller = new AbortController();
    const captured: Captured = {};
    const ctx = {
      operationId: 'host.mcp.call',
      spaceId: 'space-test',
      runId: 'run-cancel',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: controller.signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve({
          bindingId: 'hb',
          serverId: 'echo',
          toolName: 'echo',
          arguments: { text: 'z' },
        }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (_k: string, d: unknown) => {
        captured.output = d as Record<string, unknown>;
        return Promise.resolve('inline:out');
      },
    } as never;

    const running = createHostMcpHandler(policyPath).execute(ctx);
    setTimeout(() => {
      controller.abort();
    }, 150);
    await running;
    const live = await settleUntilNoneRunning('hb', 'run-cancel');
    expect(live).toEqual([]);
  }, 60_000);
});
