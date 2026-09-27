import { describe, it, expect } from 'vitest';
import type { ActionCenterItem, CoachProposalExtension } from '@aflow/web-product/ui';
import { toCoachProposalSummary } from './to-coach-proposal-summary.js';

const BASE_COACH_EXTENSION: CoachProposalExtension = {
  kind: 'coach_proposal',
  proposalKind: 'workflow_refinement',
  proposalSummary: 'tighten the goal on task-a',
  rationale: 'observed N runs miss the eval target',
  confidence: 'medium',
  opCount: 1,
  opKinds: ['task.goal'],
  authorityLevel: 'stage_for_review',
  targetWorkflowSlug: 'my-skill',
  hasReflectionEvidence: false,
};

/**
 * Build a `coach_proposal` extension. The `ActionCenterItem.extension` field
 * is a discriminated union now, so spreading `item.extension` loses the
 * `coach_proposal` narrowing — this typed builder keeps the discriminant.
 */
function coachExt(overrides: Partial<CoachProposalExtension> = {}): CoachProposalExtension {
  return { ...BASE_COACH_EXTENSION, ...overrides };
}

function acItem(overrides: Partial<ActionCenterItem> = {}): ActionCenterItem {
  return {
    id: 'proposal:11111111-1111-1111-1111-111111111111',
    spaceId: '00000000-0000-0000-0000-000000000001',
    kind: 'ratification',
    origin: {
      type: 'proposal',
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalRevision: 0,
      resolutionRoute: 'tenant_ratification',
    },
    title: 'tighten the goal',
    summary: 'tighten the goal on task-a',
    requestedAt: '2026-05-24T10:00:00.000Z',
    expiresAt: '2026-06-24T10:00:00.000Z',
    requestedBy: { kind: 'coach', label: 'Coach' },
    priority: 'normal',
    relatesTo: [],
    allowedActions: ['ratify', 'reject'],
    audience: 'anyone',
    status: 'open',
    extension: coachExt(),
    ...overrides,
  };
}

describe('toCoachProposalSummary — Plan 156 §7A.3 Phase B', () => {
  it('strips the `proposal:` prefix from the AC item id', () => {
    const out = toCoachProposalSummary(acItem());
    expect(out.id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('uses extension.proposalKind for `kind` (NOT the AC item kind)', () => {
    // The most load-bearing assertion in this file: `<ProposalCard>`'s
    // KIND_LABEL lookup reads `proposal.kind` and expects the
    // StagedChange kind, not the AC kind. The whole point of the
    // extension is to keep this distinction.
    const out = toCoachProposalSummary(
      acItem({ extension: coachExt({ proposalKind: 'skill_compose' }) }),
    );
    expect(out.kind).toBe('skill_compose');
    // The AC item's `kind` field stays at 'ratification' — the
    // mapper does not propagate it.
    expect(out.kind).not.toBe('ratification');
  });

  it('hard-codes status to `proposed` (AC only surfaces open items)', () => {
    const out = toCoachProposalSummary(acItem());
    expect(out.status).toBe('proposed');
  });

  it('uses extension.proposalSummary for `summary` (NOT the AC envelope summary)', () => {
    // Phase B review (P2): AC's `item.summary` is the inbox-flavoured
    // description (e.g. `"text (confidence: X)"` for ratifications,
    // or a generic platform-issue sentinel for platform_issue items).
    // The Coach card wants the raw operator-facing line that the
    // extension carries — see `CoachProposalExtension.proposalSummary`.
    const out = toCoachProposalSummary(
      acItem({
        summary: 'INBOX COPY — not what the card should show',
        extension: coachExt({ proposalSummary: 'the operator-facing line' }),
      }),
    );
    expect(out.summary).toBe('the operator-facing line');
    expect(out.summary).not.toContain('INBOX COPY');
  });

  it('propagates rationale / confidence / opCount / opKinds / authorityLevel / targetWorkflowSlug / hasReflectionEvidence from the extension', () => {
    const out = toCoachProposalSummary(
      acItem({
        extension: coachExt({
          rationale: 'reason text',
          confidence: 'high',
          opCount: 3,
          opKinds: ['task.goal', 'task.context', 'tasks.order'],
          authorityLevel: 'require_operator',
          targetWorkflowSlug: 'other-skill',
          hasReflectionEvidence: true,
        }),
      }),
    );
    expect(out.rationale).toBe('reason text');
    expect(out.confidence).toBe('high');
    expect(out.opCount).toBe(3);
    expect(out.opKinds).toEqual(['task.goal', 'task.context', 'tasks.order']);
    expect(out.authorityLevel).toBe('require_operator');
    expect(out.targetWorkflowSlug).toBe('other-skill');
    expect(out.hasReflectionEvidence).toBe(true);
  });

  it('reads resolutionRoute from the proposal origin discriminator', () => {
    const platformItem = acItem({
      kind: 'platform_issue',
      origin: {
        type: 'proposal',
        proposalId: '22222222-2222-2222-2222-222222222222',
        proposalRevision: 0,
        resolutionRoute: 'platform_issue',
      },
      extension: coachExt({ proposalKind: 'platform_issue' }),
    });
    expect(toCoachProposalSummary(platformItem).resolutionRoute).toBe('platform_issue');
  });

  it('maps requestedAt → proposedAt; resolvedAt / resolvedBy null when absent', () => {
    const out = toCoachProposalSummary(acItem());
    expect(out.proposedAt).toBe('2026-05-24T10:00:00.000Z');
    expect(out.resolvedAt).toBeNull();
    expect(out.resolvedBy).toBeNull();
  });

  it('coerces missing expiresAt to empty string (CoachProposalSummary.expiresAt is required)', () => {
    const item = acItem();
    delete (item as { expiresAt?: string }).expiresAt;
    const out = toCoachProposalSummary(item);
    expect(out.expiresAt).toBe('');
  });

  it('passes lastRatificationError verbatim with op + at (the AC-resolutionError-drops case)', () => {
    const err = {
      reason: 'precondition_missing' as const,
      op: 'task.goal',
      detail: 'pinned subtree changed',
      at: '2026-05-24T11:00:00.000Z',
    };
    const out = toCoachProposalSummary(
      acItem({ extension: coachExt({ lastRatificationError: err }) }),
    );
    expect(out.lastRatificationError).toEqual(err);
  });

  it('omits lastRatificationError / rebaseState / staleSummary / validationsSummary when extension lacks them', () => {
    const out = toCoachProposalSummary(acItem());
    expect(out.lastRatificationError).toBeUndefined();
    expect(out.rebaseState).toBeUndefined();
    expect(out.staleSummary).toBeUndefined();
    expect(out.validationsSummary).toBeUndefined();
  });

  it('propagates validationsSummary so Plan 148 unsafe/warning badges survive the mapper', () => {
    // Phase B review (P1): pre-Phase-B the runtime `/proposals`
    // response carried `validationsSummary` straight to
    // `<ProposalCard>`. The mapper constructs a fresh object, so
    // without this round-trip the badges silently vanish from
    // Coach panel cards. (AC panel cards already get it via the
    // extension-driven `<ActionCenterPanel>` `ProposalCardSummary`
    // construction; this test pins the same field for the
    // mapper-driven path.)
    const validations = { overallSafe: false, warningCount: 3 };
    const out = toCoachProposalSummary(
      acItem({ extension: coachExt({ validationsSummary: validations }) }),
    );
    expect(out.validationsSummary).toEqual(validations);
  });

  it('passes rebaseState + staleSummary through when stale', () => {
    const out = toCoachProposalSummary(
      acItem({
        extension: coachExt({
          rebaseState: 'stale',
          staleSummary: { conflictCount: 2, firstOpKind: 'task.goal' },
        }),
      }),
    );
    expect(out.rebaseState).toBe('stale');
    expect(out.staleSummary).toEqual({ conflictCount: 2, firstOpKind: 'task.goal' });
  });

  it('throws on an item without a coach_proposal extension (caller filter bug)', () => {
    const noExt = acItem();
    delete (noExt as { extension?: unknown }).extension;
    expect(() => toCoachProposalSummary(noExt)).toThrow(/missing coach_proposal extension/);
  });
});
