import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ExecutorLogger } from '@aflow/executor-runtime';
import type { TenantId, SessionId } from '@aflow/schemas';

/**
 * A fork bomb inside a sandbox exhausts the host's PID table while staying well
 * inside its memory and CPU caps, so `--pids-limit` is the only flag that stops
 * one. Both container call sites — the ephemeral `docker run` and the session
 * `docker create` — must carry it, and from one shared source.
 */

const RUNNER_SENTINEL = '__PHOENIX_DONE__';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = (): void => {};
  constructor(readonly args: string[]) {
    super();
  }
}

const spawnCalls: string[][] = [];
const execFileCalls: string[][] = [];
let children: FakeChild[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    const child = new FakeChild(args);
    children.push(child);
    // The session runner handshake: `docker exec … runner.py` reports ready.
    if (args[0] === 'exec') {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(RUNNER_SENTINEL)));
    }
    return child;
  },
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileCalls.push(args);
    queueMicrotask(() => cb(null, 'container-id\n', ''));
  },
}));

vi.mock('../../ensureImage.js', () => ({
  ensureImageAvailable: vi.fn(async () => undefined),
}));

const { DockerRunner, DEFAULT_SANDBOX_PIDS_LIMIT, sandboxPidsLimitArgs } =
  await import('../containerRunner.js');
const { SessionManager, makeSessionKey } = await import('../sessionManager.js');

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function silentLogger(): ExecutorLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function waitForChild(pred: (c: FakeChild) => boolean): Promise<FakeChild> {
  for (let i = 0; i < 500; i++) {
    const found = children.find(pred);
    if (found) return found;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('child not spawned in time');
}

describe('sandbox PID limit', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    execFileCalls.length = 0;
    children = [];
  });

  it('ephemeral containers are started with the shared limit', async () => {
    const runner = new DockerRunner();
    const p = runner.run({
      image: 'img',
      command: ['echo', 'hi'],
      networkMode: 'none',
      memory: '128m',
      cpus: '1',
      timeoutSeconds: 60,
    });

    const runChild = await waitForChild((c) => c.args[0] === 'run');
    runChild.emit('close', 0);
    await p;

    expect(flagValue(runChild.args, '--pids-limit')).toBe(DEFAULT_SANDBOX_PIDS_LIMIT);
  });

  it('session containers are created with the shared limit', async () => {
    const sm = new SessionManager({ log: silentLogger() });
    const key = makeSessionKey(
      'tenant-1' as TenantId,
      '00000000-0000-0000-0000-000000000001' as SessionId,
    );

    try {
      await sm.acquire(key, {
        image: 'img',
        memory: '512m',
        cpus: '1',
        idleTtlSeconds: 60,
        maxLifetimeSeconds: 600,
      });
    } finally {
      await sm.shutdownAll();
    }

    const createArgs = execFileCalls.find((a) => a[0] === 'create');
    expect(createArgs).toBeDefined();
    expect(flagValue(createArgs ?? [], '--pids-limit')).toBe(DEFAULT_SANDBOX_PIDS_LIMIT);
  });

  it('honours a valid operator override and ignores a malformed one', () => {
    expect(sandboxPidsLimitArgs({ COMPUTE_SANDBOX_PIDS_LIMIT: '128' })).toEqual([
      '--pids-limit',
      '128',
    ]);
    for (const bad of ['0', '-1', '512; rm -rf /', 'lots', '']) {
      expect(sandboxPidsLimitArgs({ COMPUTE_SANDBOX_PIDS_LIMIT: bad })).toEqual([
        '--pids-limit',
        DEFAULT_SANDBOX_PIDS_LIMIT,
      ]);
    }
    expect(sandboxPidsLimitArgs({})).toEqual(['--pids-limit', DEFAULT_SANDBOX_PIDS_LIMIT]);
  });

  it('no other handler spells the flag out itself — the ceiling has one source', async () => {
    const handlersDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const entries = await readdir(handlersDir, { withFileTypes: true });
    const spellers: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const src = await readFile(join(handlersDir, entry.name), 'utf-8');
      if (src.includes(`'--pids-limit'`)) spellers.push(entry.name);
    }
    expect(spellers).toEqual(['containerRunner.ts']);
  });
});
