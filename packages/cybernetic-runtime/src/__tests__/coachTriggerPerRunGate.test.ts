import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { AgentCondition, RunnerReflection, SkillDiagnostic } from '@aflow/schemas';
import { EntityDirectivesSchema } from '@aflow/schemas';
import { shouldActivateCoach } from '../coachTrigger.js';

const dbStub = {} as unknown as PostgresJsDatabase;
const redisStub = {} as unknown as Redis;

function directives(overrides?: { enabled?: boolean; coachAutoReviewPerRun?: boolean }) {
  const parsed = EntityDirectivesSchema.parse({
    version: 1,
    responsibility: 'Test workspace.',
  });
  if (overrides?.enabled !== undefined) parsed.learningPolicy.enabled = overrides.enabled;
  if (overrides?.coachAutoReviewPerRun !== undefined) {
    parsed.learningPolicy.coachAutoReviewPerRun = overrides.coachAutoReviewPerRun;
  }
  return parsed;
}

function condition(overrides: Partial<AgentCondition>): AgentCondition {
  return {
    progress: 'advancing',
    complexity: 'routine',
    disposition: 'steady',
    trace: { stepCount: 2, failedStepCount: 0 },
    ...overrides,
  };
}

function strugglingReflection(runId: string): RunnerReflection {
  return {
    taskId: 'analyze',
    runId,
    source: 'submit_output',
    condition: condition({ disposition: 'struggling' }),
    emittedAt: new Date().toISOString(),
  } as RunnerReflection;
}

function diag(partial?: Partial<SkillDiagnostic>): SkillDiagnostic {
  return {
    code: 'op_input_missing_required',
    dimension: 'op_input',
    severity: 'error',
    taskId: 'record',
    field: 'learnings',
    operationId: 'workflow.learn',
    detail: 'workflow.learn requires `learnings` and no producer fills it',
    ...partial,
  };
}

describe('Plan 237 P2 — coachAutoReviewPerRun default (off)', () => {
  it('defaults coachAutoReviewPerRun to false on a parsed learning policy', () => {
    expect(directives().learningPolicy.coachAutoReviewPerRun).toBe(false);
    // The true master switch stays on by default and is a separate axis.
    expect(directives().learningPolicy.enabled).toBe(true);
  });

  it('does NOT activate a per-run signal (bootstrap) when per-run is off', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 1, // inside the default bootstrap window — would fire eval_signal if per-run were on
      directives: directives(),
      db: dbStub,
      redis: redisStub,
    });
    expect(gate).toBeNull();
  });

  it('does NOT activate a per-run signal (agent/trajectory) when per-run is off', async () => {
    const runId = randomUUID();
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId,
      totalRuns: 12, // past bootstrap
      directives: directives(),
      reflections: [strugglingReflection(runId)],
      trajectory: { direction: 'maximize', series: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4] },
      db: dbStub,
      redis: redisStub,
    });
    expect(gate).toBeNull();
  });

  it('a validity_signal STILL activates when per-run is off (validity-repair stays on)', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 12,
      directives: directives(),
      validity: {
        diagnostics: [diag()],
        openRepairProposal: false,
        pendingRepairActivation: false,
      },
      db: dbStub,
      redis: redisStub,
    });
    expect(gate?.source).toBe('validity_signal');
  });

  it('the validity check is evaluated BEFORE the per-run gate (validity fires inside bootstrap too)', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 1, // bootstrap window: if per-run gate ran first the branch would return null before validity
      directives: directives(),
      validity: {
        diagnostics: [diag()],
        openRepairProposal: false,
        pendingRepairActivation: false,
      },
      db: dbStub,
      redis: redisStub,
    });
    // A per-run-first ordering would null this out (per-run is off); validity-first keeps it firing.
    expect(gate?.source).toBe('validity_signal');
  });
});

describe('Plan 237 P2 — per-run sources activate when the knob is on', () => {
  it('activates a bootstrap eval_signal when per-run is enabled', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 1,
      directives: directives({ coachAutoReviewPerRun: true }),
      db: dbStub,
      redis: redisStub,
    });
    expect(gate?.source).toBe('eval_signal');
    expect(gate?.reason).toContain('bootstrap');
  });

  it('activates an agent_signal when per-run is enabled', async () => {
    const runId = randomUUID();
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId,
      totalRuns: 12,
      directives: directives({ coachAutoReviewPerRun: true }),
      reflections: [strugglingReflection(runId)],
      db: dbStub,
      redis: redisStub,
    });
    expect(gate?.source).toBe('agent_signal');
  });
});

describe('Plan 237 P2 — the master switch still disables everything', () => {
  it('enabled=false disables per-run sources even with the per-run knob on', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 1,
      directives: directives({ enabled: false, coachAutoReviewPerRun: true }),
      db: dbStub,
      redis: redisStub,
    });
    expect(gate).toBeNull();
  });

  it('enabled=false still disables validity-repair (master switch precedes validity)', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 12,
      directives: directives({ enabled: false, coachAutoReviewPerRun: true }),
      validity: {
        diagnostics: [diag()],
        openRepairProposal: false,
        pendingRepairActivation: false,
      },
      db: dbStub,
      redis: redisStub,
    });
    expect(gate).toBeNull();
  });
});
