import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ORCH_BOOT = resolve(here, '..', 'index.ts');
const AI_EXECUTOR_BOOT = resolve(here, '..', '..', '..', 'aflow-executor-ai', 'src', 'index.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Plan 168 — orchestrator wiring', () => {
  const boot = read(ORCH_BOOT);

  it('does not import the singleton getBlockingRedisConnection helper', () => {
    // The singleton is now restricted to single-blocking-loop callers
    // (memory executor pattern). The orchestrator runs four blocking
    // loops in the same process; sharing one socket is exactly the bug.
    expect(
      /\bgetBlockingRedisConnection\b/.test(boot),
      'orchestrator should not import getBlockingRedisConnection — use createBlockingRedisConnection per consumer',
    ).toBe(false);
  });

  it('mints a dedicated blocking connection for each consumer loop', () => {
    // Every consumer that issues XREADGROUP BLOCK / XREAD BLOCK gets its
    // own socket. Sharing two would queue commands behind the longer
    // BLOCK budget. Each connection name shows up in `CLIENT LIST` so we
    // can attribute load and verify isolation at runtime.
    const expectedSuffixes = [
      'result-blocking',
      'control-blocking',
      'harness-advance-blocking',
      'workflow-progress-blocking',
    ];
    for (const suffix of expectedSuffixes) {
      // Multi-line template literal allowed inside the createBlockingRedisConnection() call.
      const re = new RegExp(`createBlockingRedisConnection\\([\\s\\S]*?${suffix}\\b`);
      expect(
        re.test(boot),
        `orchestrator should call createBlockingRedisConnection with suffix '${suffix}'`,
      ).toBe(true);
    }
  });

  it('shuts down every per-consumer blocking connection explicitly', () => {
    // `closeRedisConnection()` only handles the singleton regular Redis;
    // per-consumer blocking sockets are not registered there, so the
    // boot file must quit them itself or they leak on shutdown.
    const expected = [
      'resultBlockingRedis',
      'controlBlockingRedis',
      'harnessAdvanceBlockingRedis',
      'workflowProgressBlockingRedis',
    ];
    for (const name of expected) {
      const re = new RegExp(`quitRedisWithTimeout\\(${name}\\)`);
      expect(re.test(boot), `orchestrator shutdown should quit ${name}`).toBe(true);
    }
  });

  it('passes distinct blocking connections to each consumer (not the same object)', () => {
    // Source-level sanity: the call sites should reference different
    // identifiers in their blockingRedis slots. We grep for the pattern
    // `blockingRedis: <ident>` and assert at least 4 distinct names.
    const matches = [...boot.matchAll(/blockingRedis:\s*([A-Za-z_][A-Za-z0-9_]*)/g)];
    const distinct = new Set(matches.map((m) => m[1]));
    expect(
      distinct.size,
      `expected ≥4 distinct blockingRedis bindings, got ${[...distinct].join(', ')}`,
    ).toBeGreaterThanOrEqual(4);
  });

  it('workflow-task progress consumer receives a dedicated blockingRedis', () => {
    // The Phase 2 fix moved the XREAD BLOCK off the main `redis` handle.
    // Make sure the call site still passes the dedicated connection.
    expect(
      /startWorkflowTaskProgressConsumer\([\s\S]*?blockingRedis:\s*workflowProgressBlockingRedis/m.test(
        boot,
      ),
      'workflowTaskProgressConsumer must receive workflowProgressBlockingRedis',
    ).toBe(true);
  });
});

describe('Plan 168 — AI executor MemoryEmbedder wiring', () => {
  const boot = read(AI_EXECUTOR_BOOT);

  it('mints a dedicated blocking connection for the memory embedder', () => {
    // The MemoryEmbedder issues XREADGROUP BLOCK 5000 — sharing the main
    // `redis` handle was the §1.2.2 bug.
    expect(
      /createBlockingRedisConnection\(\s*[`'"]ai-memory-embedder-/.test(boot),
      'AI executor should mint a per-process ai-memory-embedder-<pid> blocking connection',
    ).toBe(true);
  });

  it('constructs MemoryEmbedder with blockingRedis (not just redis)', () => {
    // Grep the MemoryEmbedder construction site and confirm the
    // blockingRedis field is wired.
    const ctorMatch = /new\s+MemoryEmbedder\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(boot);
    expect(ctorMatch, 'expected a `new MemoryEmbedder({...})` call site').not.toBeNull();
    const ctorBody = ctorMatch![1] ?? '';
    expect(
      /\bblockingRedis\s*:/.test(ctorBody),
      'MemoryEmbedder must be constructed with a `blockingRedis` dep',
    ).toBe(true);
  });

  it('quits the memory embedder blocking connection during shutdown', () => {
    expect(
      /quitRedisWithTimeout\(memoryEmbedderBlockingRedis\)/.test(boot),
      'AI executor shutdown should quit memoryEmbedderBlockingRedis',
    ).toBe(true);
  });
});
