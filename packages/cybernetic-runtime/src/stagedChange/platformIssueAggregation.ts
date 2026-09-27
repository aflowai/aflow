import type {
  PlatformIssueOccurrence,
  StagedChange,
  StagedChangeOp,
  TenantId,
} from '@aflow/schemas';
import { PLATFORM_ISSUE_OCCURRENCE_CAP } from '@aflow/schemas';
import type { MemoryDocRepository } from '@aflow/database';
import { PROPOSAL_PLATFORM_DIR } from './resolveProposalRoute.js';
import { tryParseStagedChangeDoc } from './tryParseStagedChangeDoc.js';

/** Structural identity of a platform-issue report. */
export interface PlatformIssueSubject {
  subjectKind: string;
  /** `subjectId` when the op names one, else the proposal's target slug. */
  identity: string;
}

/**
 * Extract the structural subject from a proposal's ops. Returns `null` when
 * the proposal carries no explicit `platform_issue` op (platform-routed via
 * target-slug ownership only) or when neither `subjectId` nor `targetSlug`
 * provide an identity — those proposals never aggregate.
 */
export function extractPlatformIssueSubject(
  ops: readonly StagedChangeOp[],
  targetSlug: string | undefined,
): PlatformIssueSubject | null {
  const issueOp = ops.find((op) => op.op === 'platform_issue');
  if (!issueOp) return null;
  const identity = issueOp.subjectId ?? targetSlug;
  if (!identity) return null;
  return { subjectKind: issueOp.subjectKind, identity };
}

export interface OpenPlatformIssueMatch {
  staged: StagedChange;
  docPath: string;
}

/**
 * Scan `/coach/platform-issues/` for an OPEN (`proposed`) document with the
 * same structural subject. First match wins (aggregation keeps the invariant
 * that at most one open doc exists per subject).
 */
export async function findOpenPlatformIssueForSubject(args: {
  docRepo: Pick<MemoryDocRepository, 'list' | 'getByPath'>;
  tenantId: TenantId;
  spaceId: string;
  subject: PlatformIssueSubject;
}): Promise<OpenPlatformIssueMatch | null> {
  const summaries = await args.docRepo.list({
    scope: { spaceId: args.spaceId },
    pathPrefix: PROPOSAL_PLATFORM_DIR,
    limit: 200,
  });
  for (const summary of summaries) {
    const full = await args.docRepo.getByPath(summary.path, args.spaceId);
    if (!full?.inlineContent) continue;
    const parsed = tryParseStagedChangeDoc(full.inlineContent, {
      tenantId: args.tenantId as string,
      spaceId: args.spaceId,
      docPath: summary.path,
      reader: 'platformIssueAggregation',
    });
    if (!parsed.ok) continue;
    const staged = parsed.staged;
    if (staged.status !== 'proposed') continue;
    const existingSubject = extractPlatformIssueSubject(
      staged.proposal.ops,
      staged.targetWorkflowSlug,
    );
    if (!existingSubject) continue;
    if (
      existingSubject.subjectKind === args.subject.subjectKind &&
      existingSubject.identity === args.subject.identity
    ) {
      return { staged, docPath: summary.path };
    }
  }
  return null;
}

/**
 * Pure append — returns a copy of `staged` with the occurrence added and the
 * list capped at `PLATFORM_ISSUE_OCCURRENCE_CAP` (oldest citations roll off;
 * the founding evidence stays on the doc's `evidence` block).
 */
export function appendPlatformIssueOccurrence(
  staged: StagedChange,
  occurrence: PlatformIssueOccurrence,
): StagedChange {
  const occurrences = [...(staged.occurrences ?? []), occurrence].slice(
    -PLATFORM_ISSUE_OCCURRENCE_CAP,
  );
  return { ...staged, occurrences };
}
