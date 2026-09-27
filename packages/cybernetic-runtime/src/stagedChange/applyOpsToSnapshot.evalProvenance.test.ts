import { describe, it, expect } from 'vitest';
import { applyOpsToSnapshot } from './applyOpsToSnapshot.js';
import type { CyberneticEvalSuite, EvalCriterion, StagedChangeOp } from '@aflow/schemas';

const SLUG = 'wf';

function suite(goalCriteria: EvalCriterion[]): CyberneticEvalSuite {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'coach',
    goalCriteria,
    trajectoryCriteria: [],
    taskCriteria: {},
    weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
  } as CyberneticEvalSuite;
}

function crit(name: string, source?: 'coach' | 'operator'): EvalCriterion {
  return {
    type: 'contains',
    name,
    inField: 'output',
    pattern: 'check',
    ...(source ? { source } : {}),
  } as never;
}

function run(
  start: EvalCriterion[],
  op: StagedChangeOp,
  source: 'coach' | 'operator',
): ReturnType<typeof applyOpsToSnapshot> {
  return applyOpsToSnapshot({
    workflow: null,
    evalSuites: new Map([[SLUG, suite(start)]]),
    ops: [op],
    targetSlug: SLUG,
    source,
  });
}

const addOp = (name: string, criterionExtra: Record<string, unknown> = {}): StagedChangeOp =>
  ({
    op: 'eval.criterion.add',
    skillSlug: SLUG,
    targetScope: 'goal',
    criterion: { type: 'contains', name, inField: 'output', pattern: 'check', ...criterionExtra },
    rationale: 'r',
  }) as never;

const updateOpWithPatch = (name: string, patch: Record<string, unknown>): StagedChangeOp =>
  ({
    op: 'eval.criterion.update',
    skillSlug: SLUG,
    criterionId: name,
    patch,
    rationale: 'r',
  }) as never;

const updateOp = (name: string): StagedChangeOp =>
  ({
    op: 'eval.criterion.update',
    skillSlug: SLUG,
    criterionId: name,
    patch: { pattern: 'changed' },
    rationale: 'r',
  }) as never;

const removeOp = (name: string): StagedChangeOp =>
  ({ op: 'eval.criterion.remove', skillSlug: SLUG, criterionId: name, rationale: 'r' }) as never;

function goalCriteria(r: ReturnType<typeof applyOpsToSnapshot>): EvalCriterion[] {
  if (!r.ok) throw new Error(`expected ok, got ${r.failureCode}`);
  const s = r.candidateEvalSuites.get(SLUG);
  if (!s) throw new Error('suite missing');
  return s.goalCriteria;
}

describe('eval criterion provenance + ownership', () => {
  it('stamps source=operator on an operator add', () => {
    const r = run([], addOp('c1'), 'operator');
    expect(goalCriteria(r).find((c) => c.name === 'c1')?.source).toBe('operator');
  });

  it('leaves coach adds unstamped (absent ⇒ coach)', () => {
    const r = run([], addOp('c1'), 'coach');
    expect(goalCriteria(r).find((c) => c.name === 'c1')?.source).toBeUndefined();
  });

  it('refuses a coach update of an operator-authored criterion', () => {
    const r = run([crit('owned', 'operator')], updateOp('owned'), 'coach');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('eval_operator_owned');
  });

  it('refuses a coach remove of an operator-authored criterion', () => {
    const r = run([crit('owned', 'operator')], removeOp('owned'), 'coach');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failureCode).toBe('eval_operator_owned');
  });

  it('lets the operator remove a coach-authored criterion', () => {
    const r = run([crit('coachCrit')], removeOp('coachCrit'), 'operator');
    expect(r.ok).toBe(true);
    expect(goalCriteria(r).some((c) => c.name === 'coachCrit')).toBe(false);
  });

  it('lets the coach update its own criterion (no regression)', () => {
    const r = run([crit('coachCrit')], updateOp('coachCrit'), 'coach');
    expect(r.ok).toBe(true);
  });

  // -- Spoofing: `source` is apply-owned, never trusted from the op payload --

  it('ignores a payload source:operator on a coach add (stays coach)', () => {
    const r = run([], addOp('c1', { source: 'operator' }), 'coach');
    expect(goalCriteria(r).find((c) => c.name === 'c1')?.source).toBeUndefined();
  });

  it('strips source from a coach update patch (cannot self-elevate)', () => {
    const r = run(
      [crit('coachCrit')],
      updateOpWithPatch('coachCrit', { source: 'operator' }),
      'coach',
    );
    expect(r.ok).toBe(true);
    expect(goalCriteria(r).find((c) => c.name === 'coachCrit')?.source).toBeUndefined();
  });

  it('transfers ownership when the operator updates a coach criterion', () => {
    const r = run([crit('coachCrit')], updateOp('coachCrit'), 'operator');
    expect(r.ok).toBe(true);
    expect(goalCriteria(r).find((c) => c.name === 'coachCrit')?.source).toBe('operator');
  });
});
