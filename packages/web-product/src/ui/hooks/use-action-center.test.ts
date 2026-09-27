import { describe, it, expect } from 'vitest';
import type { ActionCenterItem } from './use-action-center-types.js';
import { partitionLanes } from './use-action-center-lanes.js';

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
