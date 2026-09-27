/**
 * Resolving a path against the ownership manifest.
 *
 * Longest match wins, so a directory rule states the norm and a file rule
 * states the exception. Kept apart from the manifest data so the guard, the
 * composition checks and any tooling all decide ownership the same way rather
 * than each re-implementing the precedence.
 */
import { OWNERSHIP_MANIFEST, type OwnershipClass, type OwnershipRule } from './ownership.js';

export interface OwnershipMatch {
  owner: OwnershipClass;
  rule: OwnershipRule;
}

/** The rule governing `path`, or undefined when nothing claims it. */
export function ownerOf(
  path: string,
  manifest: readonly OwnershipRule[] = OWNERSHIP_MANIFEST,
): OwnershipMatch | undefined {
  let best: OwnershipRule | undefined;
  for (const rule of manifest) {
    const matches = rule.path.endsWith('/') ? path.startsWith(rule.path) : path === rule.path;
    if (!matches) continue;
    if (best === undefined || rule.path.length > best.path.length) best = rule;
  }
  return best === undefined ? undefined : { owner: best.owner, rule: best };
}

/**
 * Paths a public core cut keeps.
 *
 * `development` is included: the public repository has to build and test
 * itself, and its tooling is not part of either product artifact but is part
 * of the repository. `cloud` and `delete` are what the cut drops.
 */
export function survivesCoreCut(owner: OwnershipClass): boolean {
  return (
    owner === 'core' || owner === 'local' || owner === 'optional-pack' || owner === 'development'
  );
}

/**
 * Whether this checkout has already had the core cut performed on it.
 *
 * Several guards ask a manifest rule to resolve to a real path. In the
 * monorepo every rule should; in a cut tree every `cloud` and `delete` rule
 * cannot, because the cut is what removed them — so a check that demanded it
 * unconditionally would fail the cut for having been performed.
 *
 * Asked once for the whole tree rather than per owner class. Per class, the
 * last stale rule of a class would go unreported: `delete` is a class designed
 * to shrink to zero, and when its final path went, its twelve stale siblings
 * would stop being findings in the same commit. One question does not have
 * that hole — a tree still holding any non-surviving path has not been cut,
 * and every rule in it has to land.
 */
export function cutWasPerformed(paths: Iterable<string>): boolean {
  for (const path of paths) {
    const match = ownerOf(path);
    if (match !== undefined && !survivesCoreCut(match.owner)) return false;
  }
  return true;
}
