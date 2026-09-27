import { describe, expect, it } from 'vitest';
import {
  detectInferredCauseDowngrade,
  kindIsWorkflowChange,
  StagedChangeSchema,
  type StagedChange,
} from '../cybernetic/stagedChange.js';

const RUN_ID = '00000000-0000-0000-0000-000000000001';

function proposal(overrides: {
  kind?: StagedChange['kind'];
  causeStatus?: 'observed' | 'inferred';
  confirmation?: string;
  source?: StagedChange['source'];
}): StagedChange {
  const now = new Date().toISOString();
  return {
    id: '11111111-1111-1111-1111-111111111111',
    kind: overrides.kind ?? 'workflow_refinement',
    source: overrides.source ?? 'coach',
    status: 'proposed',
    targetWorkflowSlug: 'kaggle-housing',
    proposal: {
      summary: 'Tighten train task',
      rationale: 'Train task timed out; reduce estimator count.',
      confidence: 'medium',
      ops: [{ op: 'update_task_goal', taskId: 'train', newGoal: 'Train with bounded depth.' }],
    },
    evidence: {
      sourceSessionIds: [RUN_ID],
      digestCitations: [{ runId: RUN_ID, taskId: 'train' }],
      diagnosis: { issueCategory: 'procedure' },
      warrant: {
        claim: 'Train task needs bounded depth',
        evidenceSummary: 'Two consecutive timeouts at default depth.',
        warrant: 'Bounded depth caps cost and avoids the timeout.',
        causeStatus: overrides.causeStatus ?? 'observed',
        ...(overrides.confirmation ? { confirmation: overrides.confirmation } : {}),
        expectedEffect: 'Next train run completes inside the budget.',
      },
    },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: now,
    expiresAt: now,
    coachSessionId: '33333333-3333-3333-3333-333333333333',
  };
}

describe('StagedChange.evidence.warrant cause-status (Plan 237 #1)', () => {
  it('parses a warrant with causeStatus and optional confirmation', () => {
    const withConfirmation = StagedChangeSchema.safeParse(
      proposal({ causeStatus: 'inferred', confirmation: 'Re-run with the reverted config.' }),
    );
    expect(withConfirmation.success).toBe(true);

    const observed = StagedChangeSchema.safeParse(proposal({ causeStatus: 'observed' }));
    expect(observed.success).toBe(true);
  });

  it('rejects a warrant missing causeStatus', () => {
    const sc = proposal({});
    delete (sc.evidence.warrant as { causeStatus?: unknown }).causeStatus;
    const result = StagedChangeSchema.safeParse(sc);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown causeStatus value', () => {
    const sc = proposal({});
    (sc.evidence.warrant as unknown as { causeStatus: string }).causeStatus = 'assumed';
    const result = StagedChangeSchema.safeParse(sc);
    expect(result.success).toBe(false);
  });
});

describe('kindIsWorkflowChange', () => {
  it('is true only for graph/goal/task edits', () => {
    expect(kindIsWorkflowChange('workflow_refinement')).toBe(true);
    expect(kindIsWorkflowChange('context_strategy')).toBe(true);
    expect(kindIsWorkflowChange('eval_criterion_change')).toBe(false);
    expect(kindIsWorkflowChange('workflow_block')).toBe(false);
    expect(kindIsWorkflowChange('platform_issue')).toBe(false);
    expect(kindIsWorkflowChange('pattern_flag')).toBe(false);
  });
});

describe('detectInferredCauseDowngrade (Plan 237 #1)', () => {
  it('downgrades an inferred-cause workflow_change with no confirmation step', () => {
    const downgrade = detectInferredCauseDowngrade(proposal({ causeStatus: 'inferred' }));
    expect(downgrade).not.toBeNull();
    expect(downgrade?.message).toContain('inferred');
    expect(downgrade?.message).toContain('observation');
    expect(downgrade?.message).toContain('confirmation');
  });

  it('passes an observed cause through as a workflow_change', () => {
    expect(detectInferredCauseDowngrade(proposal({ causeStatus: 'observed' }))).toBeNull();
  });

  it('passes an inferred cause WITH a confirmation step through as a workflow_change', () => {
    expect(
      detectInferredCauseDowngrade(
        proposal({
          causeStatus: 'inferred',
          confirmation: 'Try the change and revert if the eval regresses.',
        }),
      ),
    ).toBeNull();
  });

  it('treats a blank confirmation as no confirmation (still downgrades)', () => {
    expect(
      detectInferredCauseDowngrade(proposal({ causeStatus: 'inferred', confirmation: '   ' })),
    ).not.toBeNull();
  });

  it('does not touch non-workflow-change kinds even when the cause is inferred', () => {
    const evalChange = proposal({ kind: 'eval_criterion_change', causeStatus: 'inferred' });
    expect(detectInferredCauseDowngrade(evalChange)).toBeNull();
  });

  it('does not touch non-Coach sources', () => {
    const compose = proposal({ source: 'compose_skill', causeStatus: 'inferred' });
    expect(detectInferredCauseDowngrade(compose)).toBeNull();
  });
});
