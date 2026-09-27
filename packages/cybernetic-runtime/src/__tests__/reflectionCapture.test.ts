import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import type { EntityEventEnvelope, RunnerReflection } from '@aflow/schemas';
import {
  markReflectionExpected,
  recordReflectionCaptured,
  readReflectionCompleteness,
  resolveReflectionEvidenceSnapshot,
  reflectionsFromEntityEvents,
} from '../reflectionCapture.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

const FAST_BARRIER = { barrierTimeoutMs: 50, barrierPollMs: 5 };

describe('reflection completeness markers', () => {
  it('counts expected vs captured per run', async () => {
    const redis = makeRedis();
    const runId = randomUUID();
    await markReflectionExpected(redis, TENANT, runId);
    await markReflectionExpected(redis, TENANT, runId);
    await recordReflectionCaptured(redis, TENANT, runId);
    expect(await readReflectionCompleteness(redis, TENANT, runId)).toEqual({
      expected: 2,
      captured: 1,
    });
  });
});

describe('finalize barrier (resolveReflectionEvidenceSnapshot)', () => {
  it("returns 'none' immediately when no capture was ever expected", async () => {
    const redis = makeRedis();
    const runId = randomUUID();
    const start = Date.now();
    const completeness = await resolveReflectionEvidenceSnapshot(redis, {
      tenantId: TENANT,
      runId,
      barrierTimeoutMs: 5_000,
      barrierPollMs: 50,
    });
    expect(completeness).toBe('none');
    // No 5s wait for op-only / legacy runs.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("resolves 'complete' when every expected capture landed", async () => {
    const redis = makeRedis();
    const runId = randomUUID();
    await markReflectionExpected(redis, TENANT, runId);
    await recordReflectionCaptured(redis, TENANT, runId);
    expect(
      await resolveReflectionEvidenceSnapshot(redis, { tenantId: TENANT, runId, ...FAST_BARRIER }),
    ).toBe('complete');
  });

  it("times out to 'partial' when some captures are missing", async () => {
    const redis = makeRedis();
    const runId = randomUUID();
    await markReflectionExpected(redis, TENANT, runId);
    await markReflectionExpected(redis, TENANT, runId);
    await recordReflectionCaptured(redis, TENANT, runId);
    expect(
      await resolveReflectionEvidenceSnapshot(redis, { tenantId: TENANT, runId, ...FAST_BARRIER }),
    ).toBe('partial');
  });

  it('waits for an in-flight capture inside the timeout', async () => {
    const redis = makeRedis();
    const runId = randomUUID();
    await markReflectionExpected(redis, TENANT, runId);
    const resolveP = resolveReflectionEvidenceSnapshot(redis, {
      tenantId: TENANT,
      runId,
      barrierTimeoutMs: 2_000,
      barrierPollMs: 5,
    });
    setTimeout(() => {
      void recordReflectionCaptured(redis, TENANT, runId);
    }, 20);
    expect(await resolveP).toBe('complete');
  });

  it('is idempotent: the recorded snapshot wins over a late capture (same snapshot, never two reads)', async () => {
    const redis = makeRedis();
    const runId = randomUUID();
    await markReflectionExpected(redis, TENANT, runId);
    // First resolve times out → 'none' recorded.
    expect(
      await resolveReflectionEvidenceSnapshot(redis, { tenantId: TENANT, runId, ...FAST_BARRIER }),
    ).toBe('none');
    // The late reflection lands AFTER the snapshot was taken…
    await recordReflectionCaptured(redis, TENANT, runId);
    // …and a redelivered resolve still reports the recorded snapshot — the
    // late reflection is picked up at the next boundary review, not by
    // re-deciding this run.
    expect(
      await resolveReflectionEvidenceSnapshot(redis, { tenantId: TENANT, runId, ...FAST_BARRIER }),
    ).toBe('none');
  });
});

describe('reflectionsFromEntityEvents (§5.4 replay helper)', () => {
  function reflectionEvent(
    runId: string,
    reflection: RunnerReflection,
    overrides?: Partial<EntityEventEnvelope>,
  ): EntityEventEnvelope {
    return {
      eventId: randomUUID(),
      eventType: 'entity.runner.reflection',
      spaceId: randomUUID(),
      tenantId: TENANT,
      timestamp: Date.now(),
      workflowRunId: runId,
      payload: { reflection, taskId: reflection.taskId, attempt: 1, source: reflection.source },
      summary: 'reflection',
      ...overrides,
    };
  }

  const runId = randomUUID();
  const reflection: RunnerReflection = {
    taskId: 'analyze',
    runId,
    source: 'submit_output',
    condition: {
      progress: 'advancing',
      complexity: 'routine',
      disposition: 'steady',
      trace: { stepCount: 3, failedStepCount: 0 },
    },
    emittedAt: new Date().toISOString(),
  };

  it('re-derives the same reflections from the same event stream (deterministic)', () => {
    const events: EntityEventEnvelope[] = [
      reflectionEvent(runId, reflection),
      // Different run — filtered out.
      reflectionEvent(randomUUID(), { ...reflection, runId: randomUUID() }),
      // Unrelated event type — filtered out.
      reflectionEvent(runId, reflection, { eventType: 'entity.runner.completed' }),
      // Malformed payload — dropped, never throws.
      {
        eventId: randomUUID(),
        eventType: 'entity.runner.reflection',
        spaceId: randomUUID(),
        tenantId: TENANT,
        timestamp: Date.now(),
        workflowRunId: runId,
        payload: { reflection: { nonsense: true } },
        summary: 'corrupt',
      },
    ];
    const first = reflectionsFromEntityEvents(events, runId);
    const second = reflectionsFromEntityEvents(events, runId);
    expect(first).toEqual([reflection]);
    expect(second).toEqual(first);
  });
});
