import { canonicalizePath } from '@aflow/database';
import { INDEX_NOTE_PATH } from './indexNote.js';

/**
 * The space's memory-map note is shared curation: multiple curators (agents,
 * operators, the backfill) edit it independently, so an update without a hash
 * would silently clobber a concurrent edit. This error is raised BEFORE the
 * write when an UPDATE to `/index.md` supplies no `expectedHash`. A first
 * create needs no hash (there is nothing to clobber).
 */
export const MEMORY_HASH_REQUIRED_MESSAGE =
  'MEMORY_HASH_REQUIRED: /index.md is shared curation — read it first and pass ' +
  'expectedHash from the stat to protect concurrent edits';

export class MemoryHashRequiredError extends Error {
  constructor() {
    super(MEMORY_HASH_REQUIRED_MESSAGE);
    this.name = 'MemoryHashRequiredError';
  }
}

/**
 * True when this write targets the memory-map note. Canonicalizes first so a
 * non-canonical spelling (`index.md`, `//index.md`, `/a/../index.md`) that the
 * doc row canonicalizes to `/index.md` cannot slip past the shared-curation
 * guard.
 */
export function isIndexNotePath(path: string): boolean {
  return canonicalizePath(path) === INDEX_NOTE_PATH;
}

/**
 * Enforce the shared-curation hash requirement for an `/index.md` update. Throws
 * {@link MemoryHashRequiredError} when the note already exists and no
 * `expectedHash` accompanies the write. A non-`/index.md` path, a first create,
 * or a supplied hash all pass through.
 */
export function assertIndexNoteHash(params: {
  path: string;
  docExists: boolean;
  expectedHash: string | undefined;
}): void {
  if (!isIndexNotePath(params.path)) return;
  if (!params.docExists) return;
  if (params.expectedHash) return;
  throw new MemoryHashRequiredError();
}
