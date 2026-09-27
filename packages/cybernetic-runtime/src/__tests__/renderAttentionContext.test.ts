import { describe, expect, it } from 'vitest';
import { renderAttentionContext, type HelmsmanAttentionContext } from '../attentionBuilder.js';

/**
 * Plan 233 — surfaced items must carry their ids in the rendered attention block,
 * so Helmsman can act on them directly (proposal.get / human.action_center.focus /
 * workflow.run.*) instead of a proposal.list promote round-trip. The founding gap:
 * the renderer computed ids but never emitted them, and still told Helmsman to
 * "call proposal.ratify" after that op was removed from its ceiling.
 */
const PROPOSAL_ID = '53fafd07-b16e-4bb4-826a-c32576e8a8c9';
const RUN_ID = 'run-9c1f0a2b';
const ANOMALY_ID = 'anomaly-4d2e';

function baseContext(): HelmsmanAttentionContext {
  return {
    activeWorkflowRuns: [],
    pendingProposals: 0,
    pendingPlatformIssues: 0,
    pendingAnomalies: 0,
    pendingPatternFlags: 0,
  };
}

describe('renderAttentionContext — surfaced items carry ids (Plan 233)', () => {
  it('renders the proposal id so Helmsman can act without proposal.list', () => {
    const text = renderAttentionContext({
      ...baseContext(),
      pendingProposals: 1,
      pendingProposalDetails: [
        {
          id: PROPOSAL_ID,
          kind: 'workflow_refinement',
          summary: 'Make the execute goal prescriptive',
          confidence: 'high',
          proposedAt: '2026-07-03T11:17:15.469Z',
          resolutionRoute: 'tenant_ratification',
          authorityLevel: 'require_operator',
        },
      ],
    });
    expect(text).toContain(PROPOSAL_ID);
    // The instruction points at the operator-resolution path, NOT the removed op.
    expect(text).toContain('human.action_center.focus');
    expect(text).not.toContain('proposal.ratify');
  });

  it('renders the runId for active workflow runs', () => {
    const text = renderAttentionContext({
      ...baseContext(),
      activeWorkflowRuns: [
        {
          slug: 'kaggle-competition-optimizer',
          runId: RUN_ID,
          status: 'running',
          liveness: 'executing',
          startedAt: '2026-07-03T11:00:00.000Z',
          tasksSummary: '2/5 tasks',
        },
      ],
    });
    expect(text).toContain(RUN_ID);
  });

  it('renders the anomaly id', () => {
    const text = renderAttentionContext({
      ...baseContext(),
      pendingAnomalies: 1,
      pendingAnomalyDetails: [
        {
          id: ANOMALY_ID,
          kind: 'drift',
          severity: 'high',
          summary: 'Eval pass rate dropped',
          reportedAt: '2026-07-03T10:00:00.000Z',
        },
      ],
    });
    expect(text).toContain(ANOMALY_ID);
  });
});
