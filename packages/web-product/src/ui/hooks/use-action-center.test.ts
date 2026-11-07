import { describe, it, expect } from 'vitest';
import type { ActionCenterItem } from './use-action-center-types.js';
import {
  attentionCount,
  coachProposalCount,
  isCoachProposal,
  partitionLanes,
} from './use-action-center-lanes.js';

function item(
  kind: ActionCenterItem['kind'],
  overrides: Partial<ActionCenterItem> = {},
): ActionCenterItem {
  return {
    id: `${kind}:fixture`,
    spaceId: '00000000-0000-0000-0000-000000000001',
    kind,
    origin: {
      type: 'step',
      runId: 'r',
      stepExecutionId: 'se',
      sessionId: 's',
      pauseVersion: 0,
      operationId: 'user.interaction.approve',
    },
    title: 't',
    summary: 's',
    requestedAt: '2026-05-24T10:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'agent' },
    priority: 'normal',
    relatesTo: [],
    allowedActions: [],
    audience: 'anyone',
    status: 'open',
    ...overrides,
  } as ActionCenterItem;
}

describe('partitionLanes — Plan 156 §7A.2 Coach lane split', () => {
  it('routes ratification items to coachProposals (NOT approvals)', () => {
    // The split is the whole point of §7A.2 — before this change a
    // ratification went into the generic Approvals lane, mixing with
    // paused-step gates and compute egress. Pin the separation.
    const lanes = partitionLanes([item('ratification', { id: 'proposal:abc' })]);
    expect(lanes.coachProposals).toHaveLength(1);
    expect(lanes.approvals).toHaveLength(0);
  });

  it('keeps human_approval items in approvals (paused-step gates, egress, etc.)', () => {
    const lanes = partitionLanes([
      item('human_approval', { id: 'step:abc' }),
      item('human_approval', { id: 'settings:egress-1' }),
    ]);
    expect(lanes.approvals).toHaveLength(2);
    expect(lanes.coachProposals).toHaveLength(0);
  });

  it('routes write_approval items into the approvals lane (Plan 253)', () => {
    const lanes = partitionLanes([item('write_approval', { id: 'step:wa-1' })]);
    expect(lanes.approvals.map((it) => it.id)).toEqual(['step:wa-1']);
    expect(lanes.coachProposals).toHaveLength(0);
    expect(lanes.connections).toHaveLength(0);
  });

  it('routes human_input to inputs, platform_issue to platformIssues', () => {
    const lanes = partitionLanes([
      item('human_input', { id: 'step:input' }),
      item('platform_issue', { id: 'proposal:platform' }),
    ]);
    expect(lanes.inputs).toHaveLength(1);
    expect(lanes.platformIssues).toHaveLength(1);
    expect(lanes.approvals).toHaveLength(0);
    expect(lanes.coachProposals).toHaveLength(0);
  });

  it('routes a plan decision to inputs, where Pending answers it (Plan 322 P3.2)', () => {
    const lanes = partitionLanes([
      item('human_input', {
        id: 'plan-decision:00000000-0000-4000-8000-0000000000d1',
        origin: {
          type: 'plan_decision',
          nodeId: '00000000-0000-4000-8000-0000000000d1',
          revision: 3,
        },
        allowedActions: ['submit', 'reassign'],
      }),
    ]);
    expect(lanes.inputs.map((it) => it.origin.type)).toEqual(['plan_decision']);
    expect(lanes.notices).toEqual([]);
  });

  it('routes a browser hand-off to inputs: a person is needed at the window', () => {
    const lanes = partitionLanes([item('browser_handoff', { id: 'browser_handoff:abc' })]);
    expect(lanes.inputs.map((it) => it.id)).toEqual(['browser_handoff:abc']);
    expect(lanes.approvals).toHaveLength(0);
  });

  it('returns six empty lanes for an empty input', () => {
    const lanes = partitionLanes([]);
    expect(lanes).toEqual({
      approvals: [],
      coachProposals: [],
      inputs: [],
      platformIssues: [],
      connections: [],
      notices: [],
    });
  });

  it('puts an armed trigger in notices, where nothing counts it as attention', () => {
    const lanes = partitionLanes([item('trigger_armed', { id: 'schedule:1' })]);

    expect(lanes.notices).toHaveLength(1);
    expect(lanes.approvals).toEqual([]);
    expect(lanes.inputs).toEqual([]);
  });

  it('preserves input order within each lane (stable partition)', () => {
    const a = item('human_approval', { id: 'step:1' });
    const b = item('ratification', { id: 'proposal:1' });
    const c = item('human_approval', { id: 'step:2' });
    const d = item('ratification', { id: 'proposal:2' });
    const lanes = partitionLanes([a, b, c, d]);
    expect(lanes.approvals.map((it) => it.id)).toEqual(['step:1', 'step:2']);
    expect(lanes.coachProposals.map((it) => it.id)).toEqual(['proposal:1', 'proposal:2']);
  });

  it('fans out a mixed list across all four lanes simultaneously', () => {
    const lanes = partitionLanes([
      item('human_approval', { id: 'step:gate' }),
      item('ratification', { id: 'proposal:coach' }),
      item('human_input', { id: 'step:ask' }),
      item('platform_issue', { id: 'proposal:platform' }),
    ]);
    expect(lanes.approvals).toHaveLength(1);
    expect(lanes.coachProposals).toHaveLength(1);
    expect(lanes.inputs).toHaveLength(1);
    expect(lanes.platformIssues).toHaveLength(1);
  });
});

function proposal(
  id: string,
  requester: ActionCenterItem['requestedBy']['kind'],
  label: string,
): ActionCenterItem {
  return item('ratification', {
    id,
    origin: {
      type: 'proposal',
      proposalId: id,
      proposalRevision: 0,
      resolutionRoute: 'tenant_ratification',
    },
    requestedBy: { kind: requester, label },
  });
}

describe('attentionCount — the bell and the Chat count', () => {
  const ownAttention = [
    item('human_approval', { id: 'step:gate' }),
    item('write_approval', { id: 'step:write' }),
    item('session_invitation', { id: 'invite:1' }),
    item('human_input', { id: 'step:ask' }),
    item('browser_handoff', { id: 'handoff:1' }),
    item('needs_oauth_consent', { id: 'consent:1' }),
    item('human_approval', {
      id: 'settings:egress-1',
      origin: { type: 'settings', recordKind: 'egress', recordId: 'e1', recordVersion: 1 },
    }),
  ];

  it('counts every item that waits on the operator when no Coach proposal is open', () => {
    expect(attentionCount(partitionLanes(ownAttention))).toBe(7);
  });

  it('leaves Coach proposals out of the count and keeps them in their lane', () => {
    const lanes = partitionLanes([
      ...ownAttention,
      proposal('proposal:coach-1', 'coach', 'Coach review'),
      proposal('proposal:coach-2', 'coach', 'Coach review'),
    ]);
    expect(attentionCount(lanes)).toBe(7);
    expect(lanes.coachProposals.map((it) => it.id)).toEqual([
      'proposal:coach-1',
      'proposal:coach-2',
    ]);
  });

  it('counts zero when only Coach proposals are open', () => {
    const lanes = partitionLanes([proposal('proposal:coach-1', 'coach', 'Coach review')]);
    expect(attentionCount(lanes)).toBe(0);
  });

  it('still counts proposals from sources other than the Coach', () => {
    const lanes = partitionLanes([
      proposal('proposal:coach-1', 'coach', 'Coach review'),
      proposal('proposal:patch-1', 'agent', 'Helmsman patch'),
      proposal('proposal:compose-1', 'workflow', 'Skill compose'),
      proposal('proposal:operator-1', 'system', 'Operator'),
    ]);
    expect(attentionCount(lanes)).toBe(3);
  });

  it('leaves notices, platform issues and Coach activity out of the count', () => {
    const lanes = partitionLanes([
      item('trigger_armed', { id: 'schedule:1' }),
      item('platform_issue', { id: 'proposal:platform' }),
      item('coach_activity', { id: 'coach-activity:1' }),
    ]);
    expect(attentionCount(lanes)).toBe(0);
  });
});

describe('coachProposalCount — the proposals the count leaves out', () => {
  it('counts open Coach proposals and no proposal from another source', () => {
    const lanes = partitionLanes([
      item('human_approval', { id: 'step:gate' }),
      proposal('proposal:coach-1', 'coach', 'Coach review'),
      proposal('proposal:coach-2', 'coach', 'Coach review'),
      proposal('proposal:patch-1', 'agent', 'Helmsman patch'),
    ]);
    expect(coachProposalCount(lanes)).toBe(2);
    expect(attentionCount(lanes)).toBe(2);
  });

  it('counts zero when no Coach proposal is open', () => {
    expect(coachProposalCount(partitionLanes([item('human_input', { id: 'step:ask' })]))).toBe(0);
  });
});

describe('isCoachProposal', () => {
  it('names a proposal the Coach requested and nothing else', () => {
    expect(isCoachProposal(proposal('proposal:c', 'coach', 'Coach review'))).toBe(true);
    expect(isCoachProposal(proposal('proposal:a', 'agent', 'Helmsman patch'))).toBe(false);
    expect(
      isCoachProposal(item('human_approval', { requestedBy: { kind: 'coach', label: 'Coach' } })),
    ).toBe(false);
  });
});
