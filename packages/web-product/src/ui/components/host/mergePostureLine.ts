import type { HostMergePosture, SpaceAutonomy } from '@aflow/schemas';

/**
 * What a folder's merge posture does, as the operator reads it on the machine
 * page. Under `when-green` the space's autonomy decides two things: whether a
 * `comment` verdict merges, and whether the merge asks first (Plan 345).
 */
export function mergePostureLine(posture: HostMergePosture, autonomy: SpaceAutonomy): string {
  if (posture === 'never') return 'Its pull requests are yours to merge.';
  return autonomy === 'full'
    ? 'The PR Shepherd merges by squash without asking you, when required checks pass and no one requests changes. The publication needs review approve or comment, or overrideCheck: operator with pushDecision: ask.'
    : 'The PR Shepherd merges by squash when required checks pass and no one requests changes, and asks you before each merge. The publication needs review approve, or overrideCheck: operator with pushDecision: ask. A comment verdict leaves the merge to you, as this space’s autonomy is ratify.';
}
