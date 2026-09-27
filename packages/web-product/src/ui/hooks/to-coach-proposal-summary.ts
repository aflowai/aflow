import type { ActionCenterItem } from './use-action-center-types.js';
import type { CoachProposalSummary } from './use-coach-surface.js';

const PROPOSAL_ITEM_ID_PREFIX = 'proposal:';

export function toCoachProposalSummary(item: ActionCenterItem): CoachProposalSummary {
  const ext = item.extension;
  if (ext?.kind !== 'coach_proposal') {
    // Precondition: caller filters to ratification + platform_issue
    // items from `coachProposalSource`. Hitting this means a caller
    // wired a non-Coach item through this mapper — a real bug, not
    // a runtime data problem. Throwing surfaces it immediately
    // instead of producing a card with empty / wrong fields.
    throw new Error(`toCoachProposalSummary: missing coach_proposal extension on ${item.id}`);
  }

  // AC item ids carry the `proposal:` prefix from coachProposalSource
  // so the aggregator can route get/resolve. CoachProposalSummary.id
  // is the raw proposal id (the StagedChange.id) — strip the prefix.
  const rawId = item.id.startsWith(PROPOSAL_ITEM_ID_PREFIX)
    ? item.id.slice(PROPOSAL_ITEM_ID_PREFIX.length)
    : item.id;

  // resolutionRoute lives on the proposal origin discriminator.
  // Defensive narrow — AC items from coachProposalSource always
  // have origin.type === 'proposal'; ratification kind items from
  // other sources shouldn't reach here per the caller filter.
  const resolutionRoute =
    item.origin.type === 'proposal' ? item.origin.resolutionRoute : 'tenant_ratification';

  return {
    id: rawId,
    kind: ext.proposalKind,
    // AC only surfaces OPEN items (Phase 3 design). The hook's old
    // `proposals` list also filtered to `status === 'proposed'`
    // (see use-coach-surface.ts), so hard-coding 'proposed' here
    // matches the existing behaviour.
    status: 'proposed',
    // Phase B review (P2): use the raw operator-facing line from the
    // extension. The AC item's top-level `summary` is inbox-flavoured
    // (e.g. `"text (confidence: X)"` for ratifications, or a
    // platform-issue sentinel for platform_issue items) — both
    // duplicate or replace what `<ProposalCard>` would render via
    // its own confidence badge and section label.
    summary: ext.proposalSummary,
    rationale: ext.rationale,
    confidence: ext.confidence,
    targetWorkflowSlug: ext.targetWorkflowSlug,
    opCount: ext.opCount,
    opKinds: ext.opKinds,
    authorityLevel: ext.authorityLevel,
    resolutionRoute,
    proposedAt: item.requestedAt,
    // `CoachProposalSummary.expiresAt` is a required string;
    // `ActionCenterItem.expiresAt` is optional. Empty string is the
    // existing-shape convention for "no expiration set" — matches
    // the pre-7A.3 code path that passed `sc.expiresAt` verbatim
    // (StagedChange.expiresAt was also optional pre-Plan-148).
    expiresAt: item.expiresAt ?? '',
    resolvedAt: item.resolvedAt ?? null,
    resolvedBy: item.resolvedBy ?? null,
    hasReflectionEvidence: ext.hasReflectionEvidence,
    ...(ext.lastRatificationError ? { lastRatificationError: ext.lastRatificationError } : {}),
    ...(ext.rebaseState ? { rebaseState: ext.rebaseState } : {}),
    ...(ext.staleSummary ? { staleSummary: ext.staleSummary } : {}),
    // Phase B review (P1): pre-mapper, the runtime `/proposals`
    // response carried `validationsSummary` straight through to
    // `<ProposalCard>`. The mapper constructs a fresh object, so the
    ...(ext.validationsSummary ? { validationsSummary: ext.validationsSummary } : {}),
    ...(ext.applyPreviewStatus ? { applyPreviewStatus: ext.applyPreviewStatus } : {}),
  };
}
