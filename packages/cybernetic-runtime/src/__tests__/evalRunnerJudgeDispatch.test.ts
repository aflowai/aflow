/**
 * Production-suite judge dispatch (D8 applied to the online plane): the
 * judge model resolves criterion-override → space judge role, the
 * judge≠subject rule is enforced against the run's model context (runner
 * default + per-task overrides — the production analogue of the batch
 * manifest), an unresolvable subject is a TYPED skip, and a resolved
 * dispatch actually executes over the injected BYOK client.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { AIClient } from '@aflow/ai-client';
import type { JudgeCriterion } from '@aflow/schemas';
import { NON_SCORABLE_CRITERION_TYPES } from '@aflow/schemas';
import { evaluateJudgeCriterion, resolveProductionJudgeDispatch } from '../evalRunner.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const MODEL_DEFAULTS = { default: 'default-model', runner: 'runner-model', judge: 'judge-model' };

describe('resolveProductionJudgeDispatch', () => {
  it('resolves the space judge model when it differs from every subject model', () => {
    const resolution = resolveProductionJudgeDispatch({
      criterionModel: undefined,
      modelDefaults: MODEL_DEFAULTS,
      workflowTasks: [{ taskId: 't1', model: 'task-model' }],
    });
    expect(resolution).toEqual({ ok: true, model: 'judge-model' });
  });

  it('REFUSES when the judge model equals the runner default', () => {
    const resolution = resolveProductionJudgeDispatch({
      criterionModel: undefined,
      modelDefaults: { default: 'default-model', runner: 'shared-model', judge: 'shared-model' },
      workflowTasks: [],
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.kind).toBe('judge_model_equals_subject');
  });

  it('REFUSES a criterion override that equals a per-task model override', () => {
    const resolution = resolveProductionJudgeDispatch({
      criterionModel: 'task-model',
      modelDefaults: MODEL_DEFAULTS,
      workflowTasks: [{ taskId: 't1', model: 'task-model' }],
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.kind).toBe('judge_model_equals_subject');
  });

  it('an unresolvable subject (no workflow tasks) is a TYPED skip, never an unchecked judge', () => {
    const resolution = resolveProductionJudgeDispatch({
      criterionModel: undefined,
      modelDefaults: MODEL_DEFAULTS,
      workflowTasks: undefined,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.kind).toBe('subject_unresolvable');
    expect(resolution.message).toContain('judge≠subject');
  });
});

describe('evaluateJudgeCriterion with a resolved model + BYOK client', () => {
  const criterion: JudgeCriterion = {
    type: 'judge',
    name: 'clarity',
    rubric: [{ criterion: 'clear output', scale: 'binary', description: 'desc' }],
  };

  it('executes over the injected client at the RESOLVED model, not the default', async () => {
    const calls: Array<{ model: string }> = [];
    const client = {
      generateJson: (req: { model: string }) => {
        calls.push({ model: req.model });
        return Promise.resolve({
          data: {
            entries: [{ criterion: 'clear output', rationale: 'clear enough', verdict: 'pass' }],
          },
          cost: { totalCost: 0.001 },
        });
      },
    } as unknown as AIClient;

    const result = await evaluateJudgeCriterion(criterion, {
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      taskResults: [],
      client,
      model: 'judge-model',
    });
    expect(calls).toEqual([{ model: 'judge-model' }]);
    expect(result.criterionResult).toMatchObject({
      criterionType: 'judge',
      passed: true,
      score: 1,
    });
    expect(result.v2AdvisoryOnly).toBe(true);
  });

  it('still types a missing client as judge_error (no silent env-key fallback)', async () => {
    const result = await evaluateJudgeCriterion(criterion, {
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      taskResults: [],
      model: 'judge-model',
    });
    expect(result.criterionResult.criterionType).toBe('judge_error');
  });
});

describe('non-scorable criterion types', () => {
  it('judge_skipped and judge_error are both excluded from every scoring aggregation', () => {
    expect(NON_SCORABLE_CRITERION_TYPES.has('judge_error')).toBe(true);
    expect(NON_SCORABLE_CRITERION_TYPES.has('judge_skipped')).toBe(true);
    expect(NON_SCORABLE_CRITERION_TYPES.has('judge')).toBe(false);
  });
});
