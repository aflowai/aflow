import { TASK_DRAFT_PREFIX, isReservedScratchPath as isReserved } from '@aflow/schemas';

import { canonicalizePath } from './memoryPaths.js';

export { TASK_DRAFT_PREFIX, TASK_DRAFT_DIR_PATH } from '@aflow/schemas';

/**
 * The repository sees paths as callers spelled them, so it canonicalizes before
 * asking — `//run/draft/x` and `/run/./draft/x` reach the same row.
 */
export function isReservedScratchPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && isReserved(canonicalizePath(path));
}

void TASK_DRAFT_PREFIX;
