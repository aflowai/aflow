/**
 * Proposal coherence: when a Coach session files a
 * platform_issue for a failure, an earlier still-`proposed` workflow
 * refinement that approximated a fix for the SAME failing task is superseded —
 * leaving it open confuses the operator with a change that cannot work.
 *
 * Pure, structural matching only (no semantics): same targetSlug + a shared
 * cited taskId between the refinement's evidence and the platform_issue's.
 * Consumed by the `learner.review.finalize` cross-checks, which teach the
 * Coach to withdraw via `learner.propose.withdraw`.
 */

export interface CoherenceProposalView {
  id: string;
  kind: string;
  status: string;
  targetSlug: string;
  citedTaskIds: string[];
}

export interface SupersededRefinement {
  refinementId: string;
  platformIssueId: string;
  targetSlug: string;
  sharedTaskIds: string[];
}

export function findSupersededRefinements(
  proposals: readonly CoherenceProposalView[],
): SupersededRefinement[] {
  const platformIssues = proposals.filter((p) => p.kind === 'platform_issue');
  const openRefinements = proposals.filter(
    (p) => p.kind === 'workflow_refinement' && p.status === 'proposed',
  );
  if (platformIssues.length === 0 || openRefinements.length === 0) return [];

  const out: SupersededRefinement[] = [];
  for (const refinement of openRefinements) {
    if (!refinement.targetSlug) continue;
    const refTasks = new Set(refinement.citedTaskIds);
    if (refTasks.size === 0) continue;
    for (const issue of platformIssues) {
      if (issue.targetSlug !== refinement.targetSlug) continue;
      const shared = issue.citedTaskIds.filter((t) => refTasks.has(t));
      if (shared.length > 0) {
        out.push({
          refinementId: refinement.id,
          platformIssueId: issue.id,
          targetSlug: refinement.targetSlug,
          sharedTaskIds: [...new Set(shared)],
        });
        break;
      }
    }
  }
  return out;
}
