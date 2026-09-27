import { describe, it, expect } from 'vitest';
import type { StagedChange } from '@aflow/schemas';
import { deriveCoachProposalProjection } from '../coachProposalProjection.js';

function baseStagedChange(overrides: Partial<StagedChange> = {}): StagedChange {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'workflow_refinement',
    status: 'proposed',
    targetWorkflowSlug: 'my-skill',
    proposal: {
      summary: 'tighten the goal on task-a',
      rationale: 'observed N runs over-shoot the eval target',
      confidence: 'medium',
      ops: [{ op: 'task.goal', taskId: 'task-a', newGoal: 'tighter goal' } as never],
    },
    evidence: {
      sourceSessionIds: [],
    },
    authorityLevel: 'stage_for_review',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-05-24T10:00:00.000Z',
    expiresAt: '2026-06-24T10:00:00.000Z',
    ...overrides,
  } as StagedChange;
}

describe('deriveCoachProposalProjection — Plan 156 §7A.3', () => {
  it('carries proposalKind verbatim from StagedChange.kind (the <ProposalCard> label source)', () => {
    const p = deriveCoachProposalProjection(baseStagedChange({ kind: 'skill_compose' }));
    expect(p.proposalKind).toBe('skill_compose');
  });

  it('carries proposalSummary verbatim — NOT the inbox-flavoured AC item summary', () => {
    const p = deriveCoachProposalProjection(
      baseStagedChange({
        proposal: {
          ...baseStagedChange().proposal,
          summary: 'specific operator-facing line',
        },
      }),
    );
    expect(p.proposalSummary).toBe('specific operator-facing line');
  });

  it('derives opCount + opKinds from proposal.ops[]', () => {
    const sc = baseStagedChange({
      proposal: {
        ...baseStagedChange().proposal,
        ops: [
          { op: 'task.goal', taskId: 'a', newGoal: 'g' } as never,
          { op: 'task.context', taskId: 'b' } as never,
          { op: 'tasks.order' } as never,
        ],
      },
    });
    const p = deriveCoachProposalProjection(sc);
    expect(p.opCount).toBe(3);
    expect(p.opKinds).toEqual(['task.goal', 'task.context', 'tasks.order']);
  });

  it('passes rationale + confidence + authorityLevel + targetWorkflowSlug through', () => {
    const sc = baseStagedChange({
      authorityLevel: 'require_operator',
      targetWorkflowSlug: 'risky-skill',
      proposal: {
        ...baseStagedChange().proposal,
        rationale: 'specific reason',
        confidence: 'high',
      },
    });
    const p = deriveCoachProposalProjection(sc);
    expect(p.rationale).toBe('specific reason');
    expect(p.confidence).toBe('high');
    expect(p.authorityLevel).toBe('require_operator');
    expect(p.targetWorkflowSlug).toBe('risky-skill');
  });

  it('nulls targetWorkflowSlug when absent on the StagedChange', () => {
    const sc = baseStagedChange();
    delete (sc as { targetWorkflowSlug?: string }).targetWorkflowSlug;
    const p = deriveCoachProposalProjection(sc);
    expect(p.targetWorkflowSlug).toBeNull();
  });

  it('hasReflectionEvidence reflects evidence.reflectionRefs.length > 0', () => {
    const without = deriveCoachProposalProjection(baseStagedChange());
    expect(without.hasReflectionEvidence).toBe(false);

    const withRefs = deriveCoachProposalProjection(
      baseStagedChange({
        evidence: {
          sourceSessionIds: [],
          reflectionRefs: [
            {
              runId: 'r1',
              taskId: 't1',
              reflectionField: 'blockers',
              excerpt: 'short',
            },
          ],
        },
      }),
    );
    expect(withRefs.hasReflectionEvidence).toBe(true);
  });

  it('passes lastRatificationError verbatim (with op + at — the fields AC resolutionError drops)', () => {
    const err = {
      reason: 'precondition_missing' as const,
      op: 'task.goal',
      detail: 'pinned subtree changed',
      at: '2026-05-24T11:00:00.000Z',
    };
    const p = deriveCoachProposalProjection(baseStagedChange({ lastRatificationError: err }));
    expect(p.lastRatificationError).toEqual(err);
  });

  it('omits lastRatificationError when absent', () => {
    const p = deriveCoachProposalProjection(baseStagedChange());
    expect(p.lastRatificationError).toBeUndefined();
  });

  it('clean rebaseState carries through without a staleSummary', () => {
    const p = deriveCoachProposalProjection(baseStagedChange({ rebaseState: 'clean' }));
    expect(p.rebaseState).toBe('clean');
    expect(p.staleSummary).toBeUndefined();
  });

  it('stale rebaseState derives staleSummary from staleDetails.conflicts[]', () => {
    const p = deriveCoachProposalProjection(
      baseStagedChange({
        rebaseState: 'stale',
        staleDetails: {
          detectedAt: '2026-05-24T12:00:00.000Z',
          conflictingOpIndices: [0, 2],
          conflicts: [
            {
              opIndex: 0,
              opKind: 'task.goal',
              descriptor: { kind: 'task.goal', taskId: 'a' },
              pinnedHash: 'aaa',
              currentHash: 'bbb',
            } as never,
            {
              opIndex: 2,
              opKind: 'tasks.order',
              descriptor: { kind: 'tasks.order' },
              pinnedHash: 'ccc',
              currentHash: 'ddd',
            } as never,
          ],
        },
      }),
    );
    expect(p.rebaseState).toBe('stale');
    expect(p.staleSummary).toEqual({
      conflictCount: 2,
      firstOpKind: 'task.goal',
    });
  });

  it('stale without staleDetails yields no staleSummary (defensive — should not happen in production)', () => {
    const p = deriveCoachProposalProjection(baseStagedChange({ rebaseState: 'stale' }));
    expect(p.staleSummary).toBeUndefined();
  });

  it('validationsSummary sums contract advisories + soft capability warnings (Plan 190 §4.1)', () => {
    // warningCount = contract.advisories + capability.warnings; blockerCount =
    // contract.diagnostics + capability.issues. A hard capability issue makes
    // the proposal unsafe even when the contract is valid. If a future edit
    // drops one half, this test fails — the same drift surfaces on both AC and
    // /proposals because both call this mapper.
    const p = deriveCoachProposalProjection(
      baseStagedChange({
        proposal: {
          ...baseStagedChange().proposal,
          validations: {
            contract: {
              status: 'valid',
              diagnostics: [],
              advisories: [
                {
                  code: 'semantic_input_ref',
                  dimension: 'semantic',
                  severity: 'advisory',
                  detail: 'x',
                },
                {
                  code: 'semantic_input_ref',
                  dimension: 'semantic',
                  severity: 'advisory',
                  detail: 'y',
                },
              ],
              validatedAt: '2026-06-09T00:00:00.000Z',
            },
            capability: { issues: ['hard'], warnings: ['z'] },
          },
        },
      }),
    );
    expect(p.validationsSummary).toEqual({
      overallSafe: false, // a hard capability issue blocks
      warningCount: 3, // 2 advisories + 1 soft warning
      blockerCount: 1, // 1 hard capability issue
    });
  });

  it('validationsSummary is safe with zero warnings when contract is valid and no capability gaps', () => {
    const p = deriveCoachProposalProjection(
      baseStagedChange({
        proposal: {
          ...baseStagedChange().proposal,
          validations: {
            contract: {
              status: 'valid',
              diagnostics: [],
              advisories: [],
              validatedAt: '2026-06-09T00:00:00.000Z',
            },
            capability: { issues: [], warnings: [] },
          },
        },
      }),
    );
    expect(p.validationsSummary).toEqual({ overallSafe: true, warningCount: 0, blockerCount: 0 });
  });

  it('omits validationsSummary entirely when validations is absent (pre-Plan-148 proposals)', () => {
    const p = deriveCoachProposalProjection(baseStagedChange());
    expect(p.validationsSummary).toBeUndefined();
  });

  it('discriminator is always "coach_proposal"', () => {
    const p = deriveCoachProposalProjection(baseStagedChange());
    expect(p.kind).toBe('coach_proposal');
  });
});
