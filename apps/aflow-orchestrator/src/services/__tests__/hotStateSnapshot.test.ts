/**
 * A parked run must stay resumable no matter which worker flushed it.
 *
 * Two workers drain the same dirty set, either can reach a run first, and
 * both mark it flushed. When only one of them wrote the durable snapshot,
 * whether a run could ever be resumed came down to which one won — and the
 * loss was silent, surfacing days later as a session that resumed into
 * nothing. That is how it was found: an eight-day-old approval resumed, then
 * died at its first agent step.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SessionHotState, StepHotState } from '@aflow/redis';

const mockGetStepState = vi.fn();
vi.mock('@aflow/redis', () => ({
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
}));

const { buildHotStateSnapshot } = await import('../hotStateSnapshot.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-0000000000aa';
const STEP = '00000000-0000-4000-8000-0000000000bb';

function state(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
    agentVersion: '1',
    status: 'PAUSED',
    createdAt: 1,
    lastUpdatedAt: 1,
    ...overrides,
  } as SessionHotState;
}

const redis = {} as Redis;

describe('buildHotStateSnapshot', () => {
  it('captures a paused run so it can come back after Redis forgets', async () => {
    mockGetStepState.mockResolvedValue({ stepExecutionId: STEP } as StepHotState);

    const snapshot = await buildHotStateSnapshot(
      redis,
      TENANT,
      state({ currentStepExecutionId: STEP }),
    );

    expect(snapshot?.runHotState.sessionId).toBe(RUN);
    // Resuming needs the step the run is parked on, not just the run.
    expect(snapshot?.stepHotStates[STEP]).toBeDefined();
  });

  it('captures a run waiting on a child, which can outlast the TTL too', async () => {
    mockGetStepState.mockResolvedValue(null);

    const snapshot = await buildHotStateSnapshot(
      redis,
      TENANT,
      state({ status: 'WAITING_ON_CHILD' }),
    );

    expect(snapshot).not.toBeNull();
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'RUNNING', 'QUEUED'] as const)(
    'writes nothing for %s — there is nothing to resume',
    async (status) => {
      expect(await buildHotStateSnapshot(redis, TENANT, state({ status }))).toBeNull();
    },
  );

  it('still captures the run when its step state is already gone', async () => {
    mockGetStepState.mockResolvedValue(null);

    const snapshot = await buildHotStateSnapshot(
      redis,
      TENANT,
      state({ currentStepExecutionId: STEP }),
    );

    expect(snapshot?.runHotState).toBeDefined();
    expect(Object.keys(snapshot?.stepHotStates ?? {})).toHaveLength(0);
  });
});

describe('worker parity', () => {
  it('persists the snapshot on insert and on conflict', async () => {
    const fs = await import('node:fs/promises');
    const sources = await Promise.all(
      ['../ProjectionWorker.ts'].map(
        async (rel) => [rel, await fs.readFile(new URL(rel, import.meta.url), 'utf8')] as const,
      ),
    );

    for (const [name, src] of sources) {
      // The worker may not build this privately — an inlined copy is how the
      // two workers that once shared this drifted apart, and the drift is
      // invisible until a run cannot be resumed weeks later.
      expect(src, `${name} must use the shared builder`).toContain('buildHotStateSnapshot(');

      // A run is upserted, so the column has to be written on both the insert
      // and the conflict update. Writing only one leaves either new rows or
      // updated rows without a snapshot.
      const writes = src.match(/^\s*hotStateSnapshot,$/gm) ?? [];
      expect(writes.length, `${name} must persist hotStateSnapshot twice`).toBe(2);
    }
  });
});
