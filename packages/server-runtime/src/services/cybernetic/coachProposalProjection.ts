import type { CoachProposalExtension, StagedChange } from '@aflow/schemas';
import {
  isProposalReadinessSafe,
  proposalReadinessWarningCount,
  proposalReadinessBlockerCount,
} from '@aflow/cybernetic-runtime';
import { provenanceOf, type ProposalConversation } from './proposalProvenance.js';

export function deriveCoachProposalProjection(
  sc: StagedChange,
  conversation: ProposalConversation | null = null,
): CoachProposalExtension {
  return {
    kind: 'coach_proposal',
    proposalKind: sc.kind,
    // The raw operator-facing line the Coach authored. The AC item's
    // top-level `summary` field gets a different (inbox-flavoured)
    // string for non-Coach surfaces; the panel rendering
    // `<ProposalCard>` needs this raw text.
    proposalSummary: sc.proposal.summary,
    provenance: provenanceOf(sc, conversation),
    rationale: sc.proposal.rationale,
    confidence: sc.proposal.confidence,
    opCount: sc.proposal.ops.length,
    opKinds: sc.proposal.ops.map((op) => op.op),
    authorityLevel: sc.authorityLevel,
    targetWorkflowSlug: sc.targetWorkflowSlug ?? null,
    hasReflectionEvidence: (sc.evidence.reflectionRefs?.length ?? 0) > 0,
    ...(sc.lastRatificationError ? { lastRatificationError: sc.lastRatificationError } : {}),
    ...(sc.rebaseState ? { rebaseState: sc.rebaseState } : {}),
    ...(sc.rebaseState === 'stale' && sc.staleDetails
      ? {
          staleSummary: {
            conflictCount: sc.staleDetails.conflicts.length,
            firstOpKind: sc.staleDetails.conflicts[0]?.opKind ?? null,
          },
        }
      : {}),
    ...(sc.proposal.validations
      ? {
          validationsSummary: {
            overallSafe: isProposalReadinessSafe(sc.proposal.validations),
            warningCount: proposalReadinessWarningCount(sc.proposal.validations),
            blockerCount: proposalReadinessBlockerCount(sc.proposal.validations),
          },
        }
      : {}),
    ...(sc.evidence.applyPreview
      ? {
          applyPreviewStatus: {
            result: sc.evidence.applyPreview.result,
            previewedAt: sc.evidence.applyPreview.previewedAt,
            workflowRevisionAtPreview: sc.evidence.applyPreview.workflowRevisionAtPreview,
          },
        }
      : {}),
  };
}
