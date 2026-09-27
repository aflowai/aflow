/**
 * Branch-name validity and allow-pattern matching for the coding lane (Plan 219
 * §2.2 / §2.4 / §0.3). The SINGLE authority shared by the lane run/push handlers
 * (which gate a branch before any git op) and the operator REST route (which, at
 * binding creation, refuses any allowed pattern that would admit the default
 * branch). A guard test forbids a second copy — the lane must never be grantable
 * push to the default branch via a binding the route accepted under a different
 * matcher than the one the push handler enforces.
 */

/**
 * A conservative git branch-name allowlist, stricter than git's own rules on
 * purpose: it rejects anything that could inject a refspec (`:`, whitespace, `*`),
 * `..`, `//`, a leading `-`, and empty/edge segments. This keeps the single-branch
 * push guarantee independent of git's refspec parser rather than leaning on it.
 */
export function isValidBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.includes('..') || branch.includes('//')) return false;
  if (branch.endsWith('.lock')) return false;
  return true;
}

/**
 * Whether an allowed-push-branch pattern is well-formed: either a plain branch name
 * or a `prefix/*` / `prefix*` glob whose prefix is itself a valid branch name. The
 * single trailing `*` (optionally after a `/`) is stripped, then the remaining
 * prefix is run through `isValidBranchName`. Whitespace, `..`, and `//` are rejected
 * outright so a pattern can never smuggle a range/refspec the matcher would expand.
 */
export function isValidPushBranchPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 255) return false;
  if (/\s/.test(pattern) || pattern.includes('..') || pattern.includes('//')) return false;
  let prefix = pattern;
  if (prefix.endsWith('/*')) prefix = prefix.slice(0, -2);
  else if (prefix.endsWith('*')) prefix = prefix.slice(0, -1);
  if (prefix.length === 0) return false;
  return isValidBranchName(prefix);
}

/**
 * Whether `branch` is opted in by any pattern. A pattern is either an exact branch
 * name or a `prefix/*`-style glob (`*` matches the rest of the path). With no
 * patterns configured, nothing is allowed — the binding has not opted any branch
 * in, so the lane must not write.
 *
 * Both sides are normalized (`.trim().toLowerCase()`) before comparing: git hosts
 * are case-insensitive on branch names, so an allowlist of `['Main']` (or a stray
 * trailing space) must not let `main` — the protected default branch — slip through
 * the default-branch rejection the route layers on top of this matcher.
 */
export function branchMatchesAllowed(branch: string, patterns: readonly string[]): boolean {
  const normalizedBranch = branch.trim().toLowerCase();
  for (const pattern of patterns) {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (normalizedPattern === normalizedBranch) return true;
    const star = normalizedPattern.indexOf('*');
    if (star >= 0) {
      const prefix = normalizedPattern.slice(0, star);
      const suffix = normalizedPattern.slice(star + 1);
      if (
        normalizedBranch.startsWith(prefix) &&
        normalizedBranch.endsWith(suffix) &&
        normalizedBranch.length >= prefix.length + suffix.length
      ) {
        return true;
      }
    }
  }
  return false;
}
