/**
 * Memory paths the platform owns, defined once because several guards depend
 * on them agreeing.
 *
 * A task draft is one run attempt's private working buffer. Its privacy is
 * enforced in three places that cannot disagree without opening a hole: the
 * repository refuses to serve or trash it, the governed-path rules refuse the
 * memory ops, and the draft store addresses it. Spelling the prefix in each of
 * them is the "derive, don't mirror" failure — change one and generic reads
 * become visible, or cleanup targets a path that no longer holds the draft.
 */
export const TASK_DRAFT_DIR_PATH = '/run/draft';
export const TASK_DRAFT_PREFIX = `${TASK_DRAFT_DIR_PATH}/`;

/**
 * Whether a path addresses reserved scratch. A caller holding raw input must
 * canonicalize first: a guard that reads the spelling is one that spelling
 * walks around.
 */
export function isReservedScratchPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(TASK_DRAFT_PREFIX);
}

/**
 * Why readers refuse these paths by default rather than each remembering to.
 *
 * Keeping reserved scratch out of readers by naming every reader got the list
 * wrong three times running — the id lookup, then directory listing, then
 * `memory.store.put(content.fromPath)` and compute `inputPaths`, both of which
 * reach documents through `getByPath`. `MemoryDocRepository.getByPath` takes an
 * `allowReserved` opt-in so a new read surface is safe on the day it is written
 * rather than the day someone remembers drafts exist; the draft store, which
 * owns the prefix, is the only caller that asks.
 */
