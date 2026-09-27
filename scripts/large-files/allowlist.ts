import minimatch from 'minimatch';

import type { AllowlistEntry, LargeFileAllowlist } from './types.js';

export function pathMatchesAllowlist(
  repoRelativePath: string,
  entries: AllowlistEntry[],
): AllowlistEntry | undefined {
  for (const entry of entries) {
    if (minimatch(repoRelativePath, entry.path, { dot: true })) {
      return entry;
    }
  }
  return undefined;
}

export function validateAllowlist(allowlist: LargeFileAllowlist): string[] {
  const errors: string[] = [];
  for (const entry of allowlist.entries) {
    if (!entry.path.trim()) {
      errors.push('allowlist entry missing path');
    }
    if (!entry.reason.trim()) {
      errors.push(`allowlist entry ${entry.path}: missing reason`);
    }
    if (!entry.owner.trim()) {
      errors.push(`allowlist entry ${entry.path}: missing owner`);
    }
    if (entry.maxLines !== undefined && entry.maxLines < 1) {
      errors.push(`allowlist entry ${entry.path}: maxLines must be positive`);
    }
  }
  return errors;
}
