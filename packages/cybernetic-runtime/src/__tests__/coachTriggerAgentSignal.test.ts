import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { AgentCondition, EntityEventEnvelope, RunnerReflection } from '@aflow/schemas';
import { checkAgentSignalCoachActivation } from '../coachTriggerAgentSignal.js';
import { reflectionsFromEntityEvents } from '../reflectionCapture.js';
import { shouldActivateCoach } from '../coachTrigger.js';

function condition(overrides: Partial<AgentCondition>): AgentCondition {
  return {
    progress: 'advancing',
    complexity: 'routine',
    disposition: 'steady',
    trace: { stepCount: 2, failedStepCount: 0 },
    ...overrides,
  };
}

function reflection(taskId: string, cond: AgentCondition | undefined, runId: string) {
  return {
    taskId,
    runId,
    source: 'submit_output',
    ...(cond ? { condition: cond } : {}),
    emittedAt: new Date().toISOString(),
  } as RunnerReflection;
}

describe('checkAgentSignalCoachActivation (pure)', () => {
  const runId = randomUUID();

  it('fires on struggling disposition', () => {
    const activation = checkAgentSignalCoachActivation({
      reflections: [reflection('analyze', condition({ disposition: 'struggling' }), runId)],
    });
    expect(activation).not.toBeNull();
    expect(activation?.source).toBe('agent_signal');
    expect(activation?.reason).toContain('disposition=struggling');
  });

  it('does NOT fire on steady disposition', () => {
    expect(
      checkAgentSignalCoachActivation({
        reflections: [reflection('a', condition({ disposition: 'steady' }), runId)],
      }),
    ).toBeNull();
  });

  it('does NOT fire on condition-less reflections', () => {
    expect(
      checkAgentSignalCoachActivation({
        reflections: [reflection('c', undefined, runId)],
      }),
    ).toBeNull();
  });
});

describe('§5.4 replay — activation decision reproducible from the entity-event stream', () => {
  const runId = randomUUID();
  const spaceId = randomUUID();

  function reflectionEvent(r: RunnerReflection): EntityEventEnvelope {
    return {
      eventId: randomUUID(),
      eventType: 'entity.runner.reflection',
      spaceId,
      tenantId: 't',
      timestamp: Date.now(),
      workflowRunId: r.runId,
      payload: { reflection: r, taskId: r.taskId, attempt: 1, source: r.source },
      summary: 'reflection',
    };
  }

  // The gate only touches db/redis for the 'sampled' policy branch, which
  // the default ('codified_only') never reaches — dummies keep the decision
  // function pure over its loaded inputs.
  const gateParams = {
    tenantId: 't',
    spaceId,
    workflowSlug: 'replay-skill',
    runId,
    totalRuns: 12,
    db: {} as unknown as PostgresJsDatabase,
    redis: {} as unknown as Redis,
  };

  it('re-derives fire + source identically across replays of the same stream', async () => {
    const events = [
      reflectionEvent(reflection('prepare', condition({ disposition: 'steady' }), runId)),
      reflectionEvent(
        reflection(
          'analyze',
          condition({ progress: 'stalled', complexity: 'routine', disposition: 'struggling' }),
          runId,
        ),
      ),
    ];

    const decisions = [];
    for (let i = 0; i < 2; i++) {
      const reflections = reflectionsFromEntityEvents(events, runId);
      decisions.push(await shouldActivateCoach({ ...gateParams, reflections }));
    }
    expect(decisions[0]).toEqual(decisions[1]);
    expect(decisions[0]?.source).toBe('agent_signal');
    expect(decisions[0]?.reason).toContain('task "analyze"');
    expect(decisions[0]?.reason).toContain('disposition=struggling');
  });

  it('re-derives no-fire identically for an all-steady stream', async () => {
    const events = [
      reflectionEvent(reflection('prepare', condition({ disposition: 'steady' }), runId)),
      reflectionEvent(
        reflection('analyze', condition({ complexity: 'involved', disposition: 'steady' }), runId),
      ),
    ];
    const reflections = reflectionsFromEntityEvents(events, runId);
    const first = await shouldActivateCoach({ ...gateParams, reflections });
    const second = await shouldActivateCoach({ ...gateParams, reflections });
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
