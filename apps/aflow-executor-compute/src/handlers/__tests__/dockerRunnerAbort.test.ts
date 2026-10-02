import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * An external abort (the step's withTimeout deadline, an orchestrator interrupt,
 * or a watchdog reap) must kill the sandbox container so `docker run` exits and
 * the executor's concurrency slot is released — instead of the job staying
 * parked until the container's own timeout. These tests assert DockerRunner
 * issues `docker kill` on abort and still resolves.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(readonly args: string[]) {
    super();
  }
}

const spawnCalls: string[][] = [];
let children: FakeChild[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    const child = new FakeChild(args);
    children.push(child);
    // `docker image inspect` → image exists locally (exit 0), so no pull.
    if (args[0] === 'image' && args[1] === 'inspect') {
      queueMicrotask(() => child.emit('close', 0));
    }
    return child;
  },
}));

// Stub filesystem I/O so the runner's pre-spawn mkdir/chmod work is instant and
// deterministic. Without this, real temp-dir I/O contends the libuv threadpool
// under parallel CI load and can lag past the polling budget below, so `docker
// run` "never spawns" — a timing flake unrelated to the abort logic under test.
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ''),
  stat: vi.fn(async () => ({ isFile: () => false, isDirectory: () => false, size: 0 })),
}));

const { DockerRunner } = await import('../containerRunner.js');

const SPAWN_DEADLINE_MS = 10_000;
const SPAWN_POLL_MS = 10;
// Above the deadline, so the workspace's 5 s test timeout cannot cut the wait
// short and hide which spawns it saw.
const SPAWN_TEST_TIMEOUT_MS = SPAWN_DEADLINE_MS + 5_000;

async function waitForChild(pred: (c: FakeChild) => boolean): Promise<FakeChild> {
  const startedAt = Date.now();
  for (;;) {
    const found = children.find(pred);
    if (found) return found;
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= SPAWN_DEADLINE_MS) {
      const seen = spawnCalls.map((args) => `docker ${args.join(' ')}`);
      throw new Error(
        `No matching spawn after ${waitedMs} ms. Spawns seen: ${seen.length > 0 ? seen.join('; ') : 'none'}.`,
      );
    }
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
  }
}

const baseReq = {
  image: 'img',
  command: ['echo', 'hi'],
  networkMode: 'none',
  memory: '128m',
  cpus: '1',
  timeoutSeconds: 60,
};

describe('DockerRunner external abort', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    children = [];
  });

  it('kills the container when the signal aborts mid-run and still resolves', async () => {
    const runner = new DockerRunner();
    const controller = new AbortController();
    const p = runner.run({ ...baseReq, signal: controller.signal });

    const runChild = await waitForChild((c) => c.args[0] === 'run');
    controller.abort();
    // The kill makes `docker run` exit; simulate that close.
    runChild.emit('close', 137);

    const res = await p;
    expect(spawnCalls.some((a) => a[0] === 'kill')).toBe(true);
    expect(res.exitCode).toBe(137);
    expect(res.stderr).toContain('aborted');
  });

  it('kills immediately when the signal is already aborted', async () => {
    const runner = new DockerRunner();
    const controller = new AbortController();
    controller.abort();
    const p = runner.run({ ...baseReq, signal: controller.signal });

    const runChild = await waitForChild((c) => c.args[0] === 'run');
    runChild.emit('close', 137);

    await p;
    expect(spawnCalls.some((a) => a[0] === 'kill')).toBe(true);
  });

  it('does not issue a kill when no abort occurs', async () => {
    const runner = new DockerRunner();
    const p = runner.run({ ...baseReq });

    const runChild = await waitForChild((c) => c.args[0] === 'run');
    runChild.emit('close', 0);

    const res = await p;
    expect(spawnCalls.some((a) => a[0] === 'kill')).toBe(false);
    expect(res.exitCode).toBe(0);
  });
});
