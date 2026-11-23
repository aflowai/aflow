import {
  effectiveSpaceWritePolicy,
  requiresWriteApproval,
  type HostMergePosture,
  type SpaceAutonomy,
  type SpaceWriteApprovalPolicy,
} from '@aflow/schemas';

/**
 * What a folder's merge posture does, as the operator reads it on the machine
 * page. Under `when-green` the space's autonomy decides whether a `comment`
 * verdict merges. Whether the merge asks first is the medium-tier write
 * approval: the stored write policy composes first, and the autonomy sets only
 * the default (Plan 345).
 */
export function mergePostureLine(
  posture: HostMergePosture,
  autonomy: SpaceAutonomy,
  writePolicy: SpaceWriteApprovalPolicy | null,
): string {
  if (posture === 'never') return 'Its pull requests are yours to merge.';
  const verdicts =
    autonomy === 'full'
      ? 'The publication needs review approve or comment, or overrideCheck: operator with pushDecision: ask.'
      : 'The publication needs review approve, or overrideCheck: operator with pushDecision: ask. A comment verdict leaves the merge to you, as this space’s autonomy is ratify.';
  const asks = requiresWriteApproval('medium', effectiveSpaceWritePolicy(writePolicy, autonomy));
  const overridden = writePolicy?.requireApprovalByTier?.medium !== undefined;
  const why = overridden
    ? 'as this space’s write policy sets the medium tier'
    : `the default for the medium tier under ${autonomy}`;
  const ask = asks
    ? `It asks you before each merge, ${why}.`
    : `It merges without asking you, ${why}.`;
  return `The PR Shepherd merges by squash when required checks pass and no one requests changes. ${ask} ${verdicts}`;
}
