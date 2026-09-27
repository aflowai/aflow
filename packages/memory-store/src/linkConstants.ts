export const MAX_LINKS_PER_DOC = 200;
export const LINK_CONTEXT_CHARS = 240;
export const LINK_TARGET_MAX_BYTES = 1024;
export const LINK_SCAN_BYTES = 1024 * 1024;
export const FRONTMATTER_SCAN_BYTES = 16384;
export const MAX_PROPERTY_KEYS = 32;
export const MAX_PROPERTY_VALUE_CHARS = 512;
export const MAX_PROPERTY_ARRAY_ITEMS = 32;
export const MAX_PROPERTIES_BYTES = 8192;
export const INDEX_ENTRY_HOOK_CHARS = 160;
export const INDEX_NOTE_MAX_ENTRIES = 50;
/**
 * Max code units for an index-entry path. The path rides into agent context as a
 * memory coordinate, so it is a free-form channel like the hook and must be
 * bounded. A real canonical memory path is short; a target longer than this is an
 * injection attempt, not a doc reference, and its entry is dropped.
 */
export const INDEX_ENTRY_PATH_CHARS = 256;

export const LINKABLE_DOC_TYPES: ReadonlySet<string> = new Set([
  'markdown',
  'text',
  'prompt',
  'report',
  'plan',
  'objective',
]);

export function isLinkableDocType(docType: string): boolean {
  return LINKABLE_DOC_TYPES.has(docType);
}
