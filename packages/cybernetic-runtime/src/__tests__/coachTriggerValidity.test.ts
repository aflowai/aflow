import { describe, it, expect } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import type { SkillDiagnostic } from '@aflow/schemas';
import { EntityDirectivesSchema } from '@aflow/schemas';
import { shouldActivateCoach } from '../coachTrigger.js';
import {
  buildValidityRepairPromptParts,
  checkValidityCoachActivation,
  checkPendingRepairFingerprint,
  clearPendingRepairFingerprints,
  computeValidityRepairFingerprint,
  recordPendingRepairFingerprint,
  shouldClearValidityRepairState,
  shouldFireValidityTransition,
} from '../coachTriggerValidity.js';

const dbStub = {} as unknown as PostgresJsDatabase;
const redisStub = {} as unknown as Redis;

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

// ============================================================================
// Pure activation
// ============================================================================

describe('Plan 183g — checkValidityCoachActivation (pure, deterministic)', () => {
  it('fires for a non-empty diagnostic set with the codes in the reason', () => {
    const result = checkValidityCoachActivation({
      diagnostics: [diag(), diag({ code: 'missing_dep', taskId: 'analyze', field: undefined })],
      openRepairProposal: false,
      pendingRepairActivation: false,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('validity_signal');
    expect(result!.reason).toContain('2 diagnostics');
    expect(result!.reason).toContain('op_input_missing_required@record.learnings');
    expect(result!.reason).toContain('missing_dep@analyze');
  });

  it('does not fire on an empty diagnostic set (a valid skill needs no repair)', () => {
    expect(
      checkValidityCoachActivation({
        diagnostics: [],
        openRepairProposal: false,
        pendingRepairActivation: false,
      }),
    ).toBeNull();
  });

  it('suppresses while an unresolved repair proposal exists for the skill', () => {
    expect(
      checkValidityCoachActivation({
        diagnostics: [diag()],
        openRepairProposal: true,
        pendingRepairActivation: false,
      }),
    ).toBeNull();
  });

  it('suppresses while the same diagnostic set has a pending activation', () => {
    expect(
      checkValidityCoachActivation({
        diagnostics: [diag()],
        openRepairProposal: false,
        pendingRepairActivation: true,
      }),
    ).toBeNull();
  });
});

// ============================================================================
// Through the one gate
// ============================================================================

describe('Plan 183g — shouldActivateCoach validity branch', () => {
  it('fires validity_signal ahead of every run-keyed branch (even inside bootstrap)', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 1, // inside the default bootstrap window
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

  it('a suppressed validity trigger is FINAL — bootstrap must not hijack it', async () => {
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 1, // bootstrap would fire eval_signal if we fell through
      validity: {
        diagnostics: [diag()],
        openRepairProposal: true,
        pendingRepairActivation: false,
      },
      db: dbStub,
      redis: redisStub,
    });
    expect(gate).toBeNull();
  });

  it('respects the learning-policy master switch', async () => {
    const directives = EntityDirectivesSchema.parse({
      version: 1,
      responsibility: 'Test workspace.',
    });
    directives.learningPolicy.enabled = false;
    const gate = await shouldActivateCoach({
      tenantId: 't',
      spaceId: 's',
      workflowSlug: 'w',
      runId: 'anchor',
      totalRuns: 10,
      directives,
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

// ============================================================================
// Fingerprint (163's dedup extended to pending state, keyed on diagnostics)
// ============================================================================

describe('Plan 183g — computeValidityRepairFingerprint', () => {
  it('is stable and order-insensitive over the diagnostic set', () => {
    const a = diag();
    const b = diag({ code: 'missing_dep', taskId: 'analyze' });
    expect(computeValidityRepairFingerprint('w', [a, b])).toBe(
      computeValidityRepairFingerprint('w', [b, a]),
    );
  });

  it('ignores prose (detail / fixHint) — the same break recomputed is the same set', () => {
    expect(computeValidityRepairFingerprint('w', [diag({ detail: 'phrasing one' })])).toBe(
      computeValidityRepairFingerprint('w', [diag({ detail: 'phrasing two', fixHint: 'hint' })]),
    );
  });

  it('differs across codes and across skills', () => {
    const base = computeValidityRepairFingerprint('w', [diag()]);
    expect(computeValidityRepairFingerprint('w', [diag({ code: 'missing_dep' })])).not.toBe(base);
    expect(computeValidityRepairFingerprint('other-skill', [diag()])).not.toBe(base);
  });
});

// ============================================================================
// Reconciler transition (seam 2)
// ============================================================================

describe('Plan 183g — reconciler verdict transitions', () => {
  it('fires only on valid → invalid', () => {
    expect(shouldFireValidityTransition('valid', 'invalid')).toBe(true);
    expect(shouldFireValidityTransition('invalid', 'invalid')).toBe(false); // repeated reconcile
    expect(shouldFireValidityTransition('valid', 'valid')).toBe(false);
    expect(shouldFireValidityTransition(undefined, 'invalid')).toBe(false); // first projection
  });

  it('clears pending-repair state only on invalid → valid', () => {
    expect(shouldClearValidityRepairState('invalid', 'valid')).toBe(true);
    expect(shouldClearValidityRepairState('valid', 'valid')).toBe(false);
    expect(shouldClearValidityRepairState('invalid', 'invalid')).toBe(false);
    expect(shouldClearValidityRepairState(undefined, 'valid')).toBe(false);
  });
});

// ============================================================================
// Pending-repair fingerprint state (Redis)
// ============================================================================

describe('Plan 183g — pending-repair fingerprint state', () => {
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // the rejectedFingerprintWindow default

  it('record → check true; clear → check false', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const fp = computeValidityRepairFingerprint('w', [diag()]);
    expect(await checkPendingRepairFingerprint(redis, 'sp', 'w', fp, WINDOW_MS)).toBe(false);
    await recordPendingRepairFingerprint(redis, 'sp', 'w', fp, Date.now(), WINDOW_MS);
    expect(await checkPendingRepairFingerprint(redis, 'sp', 'w', fp, WINDOW_MS)).toBe(true);
    await clearPendingRepairFingerprints(redis, 'sp', 'w');
    expect(await checkPendingRepairFingerprint(redis, 'sp', 'w', fp, WINDOW_MS)).toBe(false);
  });

  it('expires entries outside the retention window', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const fp = computeValidityRepairFingerprint('w', [diag()]);
    await recordPendingRepairFingerprint(
      redis,
      'sp',
      'w',
      fp,
      Date.now() - WINDOW_MS - 1,
      WINDOW_MS,
    );
    expect(await checkPendingRepairFingerprint(redis, 'sp', 'w', fp, WINDOW_MS)).toBe(false);
  });

  it('clear is scoped to the skill — other skills keep their pending state', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const fpA = computeValidityRepairFingerprint('skill-a', [diag()]);
    const fpB = computeValidityRepairFingerprint('skill-b', [diag()]);
    await recordPendingRepairFingerprint(redis, 'sp', 'skill-a', fpA, Date.now(), WINDOW_MS);
    await recordPendingRepairFingerprint(redis, 'sp', 'skill-b', fpB, Date.now(), WINDOW_MS);
    await clearPendingRepairFingerprints(redis, 'sp', 'skill-a');
    expect(await checkPendingRepairFingerprint(redis, 'sp', 'skill-a', fpA, WINDOW_MS)).toBe(false);
    expect(await checkPendingRepairFingerprint(redis, 'sp', 'skill-b', fpB, WINDOW_MS)).toBe(true);
  });
});

// ============================================================================
// Repair prompt head (consumed by triggerCoachReview in Phase 1)
// ============================================================================

describe('Plan 183g — buildValidityRepairPromptParts', () => {
  it('carries the diagnostics as verbatim JSON (structured, never a [kind] detail join)', () => {
    const diagnostics = [diag()];
    const prompt = buildValidityRepairPromptParts({
      workflowSlug: 'w',
      diagnostics,
      reason: 'contract invalid (1 diagnostics): op_input_missing_required@record.learnings',
    }).join('\n');
    expect(prompt).toContain('"code": "op_input_missing_required"');
    expect(prompt).toContain('workflow.manage.get');
    expect(prompt).toContain('learner.propose.workflow_change');
    expect(prompt).toContain('evidence.validityDiagnostics');
    // The structured JSON block must round-trip.
    const jsonStart = prompt.indexOf('[\n');
    const jsonEnd = prompt.lastIndexOf(']');
    const parsed: unknown = JSON.parse(prompt.slice(jsonStart, jsonEnd + 1));
    expect(parsed).toEqual(diagnostics);
  });
});
