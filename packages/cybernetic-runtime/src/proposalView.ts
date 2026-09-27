import type {
  StagedChange,
  StagedChangeKind,
  StagedChangeStatus,
  StagedChangeOp,
} from '@aflow/schemas';

// ============================================================================
// ProposalView type
// ============================================================================

export interface ProposalView {
  /** Unique proposal ID (same as StagedChange.id). */
  proposalId: string;
  /** Human-readable kind label. */
  kind: StagedChangeKind;
  /** Current status. */
  status: StagedChangeStatus;
  /** Summary of the proposed change. */
  summary: string;
  /** Why the Coach proposes this change. */
  rationale: string;
  /** Coach's confidence in this proposal. */
  confidence: 'low' | 'medium' | 'high';
  /** Target workflow slug, if any. */
  targetWorkflowSlug: string | undefined;
  /** Target task ID within the workflow, if any. */
  targetTaskId: string | undefined;
  /** Individual change operations. */
  ops: StagedChangeOp[];
  /** When proposed (ISO 8601). */
  proposedAt: string;
  /** When resolved (ISO 8601), if any. */
  resolvedAt: string | undefined;
  /** Who resolved it, if any. */
  resolvedBy: string | undefined;
  /** When it expires (ISO 8601). */
  expiresAt: string;
  /** Number of supporting sessions. */
  evidenceSessionCount: number;
  /** Reflection-origin references cited by this proposal (104e §4.1). */
  reflectionRefs?: Array<{
    runId: string;
    taskId: string;
    reflectionField: string;
    excerpt: string;
  }>;
}

// ============================================================================
// Adapter
// ============================================================================

/**
 * Convert a StagedChange to a ProposalView.
 * One-way, read-only transformation.
 */
export function toProposalView(change: StagedChange): ProposalView {
  return {
    proposalId: change.id,
    kind: change.kind,
    status: change.status,
    summary: change.proposal.summary,
    rationale: change.proposal.rationale,
    confidence: change.proposal.confidence,
    targetWorkflowSlug: change.targetWorkflowSlug,
    targetTaskId: change.targetTaskId,
    ops: change.proposal.ops,
    proposedAt: change.proposedAt,
    resolvedAt: change.resolvedAt,
    resolvedBy: change.resolvedBy,
    expiresAt: change.expiresAt,
    evidenceSessionCount: change.evidence.sourceSessionIds.length,
    ...(change.evidence.reflectionRefs ? { reflectionRefs: change.evidence.reflectionRefs } : {}),
  };
}

/**
 * Convert an array of StagedChanges to ProposalViews.
 */
export function toProposalViews(changes: StagedChange[]): ProposalView[] {
  return changes.map(toProposalView);
}
