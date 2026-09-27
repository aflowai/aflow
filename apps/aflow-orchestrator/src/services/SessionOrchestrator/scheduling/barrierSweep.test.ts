import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import { registerBarrierWatchdog } from '@aflow/redis';
import { SNOOZE_OPERATION_ID, type SystemRole } from '@aflow/schemas';
import type { ShardManager } from '../../ShardManager.js';
import { sweepStaleBarriers, type SweepStaleBarriersDeps } from './barrierSweep.js';
import type { StepInFlightStatus } from './stepCompletionPath.js';

const TENANT = 'tenant-1';
const RUN = '00000000-0000-0000-0000-000000000001';
const STEP_EXEC = '00000000-0000-0000-0000-0000000000aa';
const AGENT = 'agent';
const MEMBER = JSON.stringify({ tenantId: TENANT, runId: RUN, agentStepId: AGENT });
const MAX_AGE = 120_000;
const PENDING_KEY = `ai.agent.pendingToolCallCount.${AGENT}`;
const RESULTS_KEY = `ai.agent.pendingToolResults.${AGENT}`;

function createFakeRedis(): {
  redis: Redis;
  store: Map<string, number>;
  failNextZrem: { value: boolean };
} {
  const store = new Map<string, number>();
  const failNextZrem = { value: false };
  const redis = {
    zadd(_key: string, ...args: Array<string | number>): Promise<number> {
      let i = 0;
      let xx = false;
      while (
        typeof args[i] === 'string' &&
        ['XX', 'NX', 'GT', 'LT', 'CH'].includes(args[i] as string)
      ) {
        if (args[i] === 'XX') xx = true;
        i++;
      }
      let added = 0;
      for (; i + 1 < args.length; i += 2) {
        const score = Number(args[i]);
        const member = String(args[i + 1]);
        const exists = store.has(member);
        if (xx && !exists) continue; // ZADD XX never resurrects a removed member
        if (!exists) added++;
        store.set(member, score);
      }
      return Promise.resolve(added);
    },
    zrem(_key: string, ...members: string[]): Promise<number> {
      if (failNextZrem.value) {
        failNextZrem.value = false;
        return Promise.resolve(0); // simulate another orchestrator already claimed it
      }
      let removed = 0;
      for (const m of members) if (store.delete(m)) removed++;
      return Promise.resolve(removed);
    },
    zrangebyscore(
      _key: string,
      min: string | number,
      max: string | number,
      ...opts: Array<string | number>
    ): Promise<string[]> {
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      let withScores = false;
      let offset = 0;
      let count = Infinity;
      for (let i = 0; i < opts.length; i++) {
        if (opts[i] === 'WITHSCORES') withScores = true;
        else if (opts[i] === 'LIMIT') {
          offset = Number(opts[i + 1]);
          count = Number(opts[i + 2]);
          i += 2;
        }
      }
      const rows = [...store.entries()]
        .filter(([, s]) => s >= lo && s <= hi)
        .sort((a, b) => a[1] - b[1])
        .slice(offset, offset + count);
      const out: string[] = [];
      for (const [member, score] of rows) {
        out.push(member);
        if (withScores) out.push(String(score));
      }
      return Promise.resolve(out);
    },
  };
  return { redis: redis as unknown as Redis, store, failNextZrem };
}

function makeState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'helmsman' as SystemRole },
    agentVersion: '1',
    status: 'PAUSED',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    runtimeState: { schemaVersion: 1, variables: {}, version: 0, updatedAtMs: 1000 },
    ...overrides,
  };
}

function withCount(state: SessionHotState, count: number, version = 0): SessionHotState {
  const rt = state.runtimeState ?? {
    schemaVersion: 1 as const,
    variables: {},
    version,
    updatedAtMs: 1000,
  };
  return {
    ...state,
    runtimeState: {
      ...rt,
      version,
      variables: { ...rt.variables, [PENDING_KEY]: { ref: { kind: 'inline', value: count } } },
    },
  };
}

function makeStepState(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: STEP_EXEC,
    tenantId: TENANT,
    sessionId: RUN,
    stepId: 'tool-step',
    stepType: 'workflow',
    operationId: 'workflow.run.start',
    attempt: 1,
    status: 'STARTED',
    scheduledAt: 1000,
    inputRef: 'inline:x',
    idempotencyKey: 'k',
    ...overrides,
  };
}

interface DepOverrides {
  redis: Redis;
  getSessionState?: SweepStaleBarriersDeps['getSessionState'];
  getStepState?: SweepStaleBarriersDeps['getStepState'];
  getStepInFlight?: SweepStaleBarriersDeps['getStepInFlight'];
  hasAvailableExecutor?: SweepStaleBarriersDeps['hasAvailableExecutor'];
  casUpdateSessionRuntimeState?: SweepStaleBarriersDeps['casUpdateSessionRuntimeState'];
  shardManager?: ShardManager | undefined;
  maxAgeMs?: number;
}

const INFLIGHT_ALIVE: StepInFlightStatus = { alive: true, deadlineAtMs: Date.now() + 60_000 };
const INFLIGHT_DEAD: StepInFlightStatus = { alive: false, deadlineAtMs: null };

function makeDeps(over: DepOverrides): {
  deps: SweepStaleBarriersDeps;
  warn: ReturnType<typeof vi.fn>;
  cas: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const cas =
    (over.casUpdateSessionRuntimeState as unknown as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue(true);
  const deps: SweepStaleBarriersDeps = {
    redis: over.redis,
    getSessionState: over.getSessionState ?? vi.fn().mockResolvedValue(null),
    getStepState: over.getStepState ?? vi.fn().mockResolvedValue(makeStepState()),
    getStepInFlight: over.getStepInFlight ?? vi.fn().mockResolvedValue(INFLIGHT_DEAD),
    hasAvailableExecutor: over.hasAvailableExecutor ?? vi.fn().mockResolvedValue(false),
    casUpdateSessionRuntimeState:
      cas as unknown as SweepStaleBarriersDeps['casUpdateSessionRuntimeState'],
    shardManager: 'shardManager' in over ? over.shardManager : undefined,
    logger: { warn },
    maxAgeMs: over.maxAgeMs ?? MAX_AGE,
  };
  return { deps, warn, cas };
}

async function seedStale(redis: Redis, ageMs = MAX_AGE + 80_000): Promise<void> {
  await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, Date.now() - ageMs);
}

/** A RUNNING session whose current step is a genuine orphan (no in-flight, old). */
function orphanState(): SessionHotState {
  return withCount(makeState({ status: 'RUNNING', currentStepExecutionId: STEP_EXEC }), 1, 7);
}
function orphanStep(): StepHotState {
  return makeStepState({ status: 'STARTED', startedAt: Date.now() - 200_000 });
}

describe('sweepStaleBarriers — §0 never recover a live completion path', () => {
  it.each(['PAUSED', 'WAITING_ON_CHILD'] as const)(
    'refreshes (never recovers) a resting %s barrier',
    async (status) => {
      const { redis, store } = createFakeRedis();
      await seedStale(redis);
      const { deps, cas } = makeDeps({
        redis,
        getSessionState: vi.fn().mockResolvedValue(withCount(makeState({ status }), 1)),
      });
      await sweepStaleBarriers(deps);
      expect(cas).not.toHaveBeenCalled();
      expect(store.has(MEMBER)).toBe(true);
      expect(store.get(MEMBER)).toBeGreaterThan(Date.now() - 5_000);
    },
  );

  it('refreshes a RUNNING barrier whose STARTED step has a live in-flight executor', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    const { deps, cas } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(orphanState()),
      getStepState: vi
        .fn()
        .mockResolvedValue(makeStepState({ status: 'STARTED', startedAt: Date.now() - 200_000 })),
      getStepInFlight: vi.fn().mockResolvedValue(INFLIGHT_ALIVE),
    });
    await sweepStaleBarriers(deps);
    expect(cas).not.toHaveBeenCalled();
    expect(store.has(MEMBER)).toBe(true);
  });

  it('refreshes (never recovers) a RUNNING long snooze — the blocker case', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    // SCHEDULED snooze, scheduled 5 min ago — well past the 120s barrier age but
    // well inside the 15-min snooze window: its timer IS the completion path.
    const { deps, cas } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(orphanState()),
      getStepState: vi.fn().mockResolvedValue(
        makeStepState({
          status: 'SCHEDULED',
          operationId: SNOOZE_OPERATION_ID,
          scheduledAt: Date.now() - 5 * 60_000,
        }),
      ),
      hasAvailableExecutor: vi.fn().mockResolvedValue(false),
    });
    await sweepStaleBarriers(deps);
    expect(cas).not.toHaveBeenCalled();
    expect(store.has(MEMBER)).toBe(true);
  });
});

describe('sweepStaleBarriers — drop / anomaly', () => {
  it('drops a barrier whose session is missing', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    const { deps, cas } = makeDeps({ redis, getSessionState: vi.fn().mockResolvedValue(null) });
    await sweepStaleBarriers(deps);
    expect(store.has(MEMBER)).toBe(false);
    expect(cas).not.toHaveBeenCalled();
  });

  it('drops a barrier whose pending count is already 0', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    const { deps } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(withCount(makeState({ status: 'RUNNING' }), 0)),
    });
    await sweepStaleBarriers(deps);
    expect(store.has(MEMBER)).toBe(false);
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'] as const)(
    'drops a terminal %s barrier',
    async (status) => {
      const { redis, store } = createFakeRedis();
      await seedStale(redis);
      const { deps, cas } = makeDeps({
        redis,
        getSessionState: vi.fn().mockResolvedValue(withCount(makeState({ status }), 1)),
      });
      await sweepStaleBarriers(deps);
      expect(store.has(MEMBER)).toBe(false);
      expect(cas).not.toHaveBeenCalled();
    },
  );

  it.each(['QUEUED', 'STALLED'] as const)(
    'warns and drops an anomalous %s barrier',
    async (status) => {
      const { redis, store } = createFakeRedis();
      await seedStale(redis);
      const { deps, warn, cas } = makeDeps({
        redis,
        getSessionState: vi.fn().mockResolvedValue(withCount(makeState({ status }), 1)),
      });
      await sweepStaleBarriers(deps);
      expect(store.has(MEMBER)).toBe(false);
      expect(cas).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('anomalous'), expect.anything());
    },
  );
});

describe('sweepStaleBarriers — recover a genuine orphan', () => {
  it('zeroes the count and appends _barrier_recovery via the version-CAS', async () => {
    const { redis } = createFakeRedis();
    await seedStale(redis);
    const cas = vi.fn().mockResolvedValue(true);
    const { deps, warn } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(orphanState()),
      getStepState: vi.fn().mockResolvedValue(orphanStep()),
      getStepInFlight: vi.fn().mockResolvedValue(INFLIGHT_DEAD),
      casUpdateSessionRuntimeState: cas,
    });
    await sweepStaleBarriers(deps);
    expect(cas).toHaveBeenCalledOnce();
    const [, tenantId, runId, expectedVersion, newRt] = cas.mock.calls[0]!;
    expect(tenantId).toBe(TENANT);
    expect(runId).toBe(RUN);
    expect(expectedVersion).toBe(7); // the version we read
    const rt = newRt as SessionHotState['runtimeState'];
    expect(rt!.version).toBe(8);
    expect((rt!.variables[PENDING_KEY] as { ref: { value: number } }).ref.value).toBe(0);
    const results = (rt!.variables[RESULTS_KEY] as { ref: { value: unknown[] } }).ref.value;
    expect(results.some((r) => (r as { name?: string }).name === '_barrier_recovery')).toBe(true);
    // A single-call recovery uses the generic message, not the multi-call one.
    expect(warn).toHaveBeenCalledWith('Releasing orphaned parallel barrier', expect.anything());
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('multi-call'), expect.anything());
  });

  it('warns distinctly when a multi-call (parallel) barrier is force-recovered', async () => {
    const { redis } = createFakeRedis();
    await seedStale(redis);
    const state = withCount(
      makeState({ status: 'RUNNING', currentStepExecutionId: STEP_EXEC }),
      3,
      7,
    );
    const { deps, warn, cas } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(state),
      getStepState: vi.fn().mockResolvedValue(orphanStep()),
    });
    await sweepStaleBarriers(deps);
    expect(cas).toHaveBeenCalledOnce(); // still recovered
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('multi-call parallel barrier'),
      expect.objectContaining({ pendingCount: 3 }),
    );
  });

  it('appends _barrier_recovery to pre-existing accumulated results (does not clobber them)', async () => {
    const { redis } = createFakeRedis();
    await seedStale(redis);
    const state = orphanState();
    state.runtimeState!.variables[RESULTS_KEY] = {
      ref: { kind: 'inline', value: [{ name: 'prior-tool', status: 'SUCCEEDED' }] },
    };
    const cas = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(state),
      getStepState: vi.fn().mockResolvedValue(orphanStep()),
      casUpdateSessionRuntimeState: cas,
    });
    await sweepStaleBarriers(deps);
    const newRt = cas.mock.calls[0]![4] as SessionHotState['runtimeState'];
    const results = (newRt!.variables[RESULTS_KEY] as { ref: { value: unknown[] } }).ref.value;
    expect(results).toHaveLength(2);
    expect((results[0] as { name: string }).name).toBe('prior-tool');
    expect((results[1] as { name: string }).name).toBe('_barrier_recovery');
  });
});

describe('sweepStaleBarriers — concurrency & sharding', () => {
  it('skips a barrier whose run is not owned by this shard (no read, no mutation)', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    const getSessionState = vi.fn().mockResolvedValue(orphanState());
    const shardManager = { ownsRun: vi.fn().mockReturnValue(false) } as unknown as ShardManager;
    const { deps, cas } = makeDeps({ redis, getSessionState, shardManager });
    await sweepStaleBarriers(deps);
    expect(getSessionState).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
    expect(store.has(MEMBER)).toBe(true); // left for the owner
  });

  it('bails without mutating when it loses the atomic claim', async () => {
    const { redis, failNextZrem } = createFakeRedis();
    await seedStale(redis);
    failNextZrem.value = true; // the claim ZREM returns 0 (another orchestrator won)
    const { deps, cas } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(orphanState()),
      getStepState: vi.fn().mockResolvedValue(orphanStep()),
    });
    await sweepStaleBarriers(deps);
    expect(cas).not.toHaveBeenCalled();
  });

  it('re-registers the watchdog when the version-CAS loses to a concurrent decrement', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    const cas = vi.fn().mockResolvedValue(false); // a concurrent legitimate write landed
    const { deps } = makeDeps({
      redis,
      getSessionState: vi.fn().mockResolvedValue(orphanState()),
      getStepState: vi.fn().mockResolvedValue(orphanStep()),
      casUpdateSessionRuntimeState: cas,
    });
    await sweepStaleBarriers(deps);
    expect(cas).toHaveBeenCalledOnce();
    // claim removed it, then the CAS failed → re-registered so a future sweep re-checks.
    expect(store.has(MEMBER)).toBe(true);
  });

  it('re-registers (not recovers) when the session is no longer an orphan after the claim', async () => {
    const { redis, store } = createFakeRedis();
    await seedStale(redis);
    // Orphan at peek, but the post-claim re-read shows it PAUSED (resolved).
    const getSessionState = vi
      .fn()
      .mockResolvedValueOnce(orphanState())
      .mockResolvedValueOnce(withCount(makeState({ status: 'PAUSED' }), 1, 7));
    const cas = vi.fn().mockResolvedValue(true);
    const { deps } = makeDeps({
      redis,
      getSessionState,
      getStepState: vi.fn().mockResolvedValue(orphanStep()),
      casUpdateSessionRuntimeState: cas,
    });
    await sweepStaleBarriers(deps);
    expect(cas).not.toHaveBeenCalled();
    expect(store.has(MEMBER)).toBe(true);
  });
});
