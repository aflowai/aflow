import { describe, it, expect } from 'vitest';
import { StagedChangeSchema } from '@aflow/schemas';

/**
 * Guard against silently invalidating StagedChange docs already at rest.
 *
 * These fixtures stand in for proposals persisted in tenant memory across the
 * shapes we have shipped — a minimal proposal, ones carrying the optional
 * `evidence.warrant` / `evidence.diagnosis` blocks, and both resolution routes.
 * A StagedChange doc is parsed on every Action Center read; a doc the current
 * schema rejects is dropped, so it vanishes from the operator surface with only
 * a warn log.
 *
 * If a schema change makes any fixture below fail, it would silently invalidate
 * that shape wherever it is stored. That is a deliberate decision, not an
 * accident: make the new field optional (with a default, if a value can be
 * assumed) so history keeps parsing, or — if the shape is genuinely being
 * retired — update the corpus in the same change to record that history is
 * being dropped on purpose. Adding a required field and leaving this test green
 * by not covering the affected shape is the failure mode this guards.
 */

function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'workflow_refinement',
    status: 'proposed',
    source: 'coach',
    authorityLevel: 'stage_for_review',
    resolutionRoute: 'tenant_ratification',
    rebaseState: 'clean',
    coachSessionId: '00000000-0000-0000-0000-000000000002',
    targetWorkflowSlug: 'wf',
    pinnedRevision: 1,
    proposal: {
      summary: 's',
      rationale: 'r',
      confidence: 'low',
      ops: [{ op: 'update_task_goal', taskId: 'a', newGoal: 'x' }],
    },
    evidence: {
      sourceSessionIds: ['00000000-0000-0000-0000-000000000003'],
    },
    proposedAt: '2026-05-25T09:00:00.000Z',
    expiresAt: '2026-06-25T09:00:00.000Z',
    ...overrides,
  };
}

const observedWarrant = {
  claim: 'Task X needs declared state var Y',
  evidenceSummary: 'Apply failed because Y is undeclared.',
  warrant: 'Promotion to an undeclared state var fails apply.',
  causeStatus: 'observed',
  expectedEffect: 'Next run succeeds at task Y.',
  metric: 'apply_success',
  evaluationWindowMs: 3_600_000,
  risk: 'None expected.',
  rollback: 'Revert the added state var.',
};

const inferredWarrant = {
  claim: 'Task X likely times out under load',
  evidenceSummary: 'Symptom: intermittent stalls; cause not directly observed.',
  warrant: 'Stalls correlate with concurrency but were not proven causal.',
  causeStatus: 'inferred',
  confirmation: 'Add a try-and-revert step that lowers concurrency and re-runs.',
  expectedEffect: 'Stalls stop when concurrency is capped.',
};

const CORPUS: Array<{ name: string; doc: Record<string, unknown> }> = [
  { name: 'minimal workflow_refinement (no warrant)', doc: baseDoc() },
  {
    name: 'workflow_refinement with observed-cause warrant',
    doc: baseDoc({ evidence: { sourceSessionIds: [], warrant: observedWarrant } }),
  },
  {
    name: 'workflow_refinement with inferred-cause warrant + confirmation',
    doc: baseDoc({ evidence: { sourceSessionIds: [], warrant: inferredWarrant } }),
  },
  {
    name: 'pattern_flag with diagnosis',
    doc: baseDoc({
      kind: 'pattern_flag',
      evidence: { sourceSessionIds: [], diagnosis: { issueCategory: 'procedure' } },
    }),
  },
  {
    name: 'platform_issue route with diagnosis + warrant',
    doc: baseDoc({
      kind: 'platform_issue',
      resolutionRoute: 'platform_issue',
      evidence: {
        sourceSessionIds: [],
        diagnosis: { issueCategory: 'platform' },
        warrant: observedWarrant,
      },
    }),
  },
  {
    name: 'proposal with applyPreview + evidence aggregate/metrics',
    doc: baseDoc({
      evidence: {
        sourceSessionIds: ['00000000-0000-0000-0000-000000000003'],
        aggregate: { totalSessionsReviewed: 4, matchingPattern: 3, timeWindow: 86_400_000 },
        metrics: { failureRate: 0.4 },
        applyPreview: {
          attempted: true,
          result: 'ok',
          previewedAt: '2026-05-25T09:05:00.000Z',
          workflowRevisionAtPreview: 2,
        },
      },
    }),
  },
];

describe('StagedChange stored-doc corpus', () => {
  for (const { name, doc } of CORPUS) {
    it(`parses: ${name}`, () => {
      const result = StagedChangeSchema.safeParse(doc);
      if (!result.success) {
        const paths = result.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        throw new Error(
          `Stored StagedChange shape "${name}" no longer parses (${paths}). A schema change ` +
            `invalidated a doc shape that exists at rest — make the new field optional/defaulted, ` +
            `or update this corpus to acknowledge dropping the shape on purpose.`,
        );
      }
      expect(result.success).toBe(true);
    });
  }
});
