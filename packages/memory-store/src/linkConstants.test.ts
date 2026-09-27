import { describe, it, expect } from 'vitest';
import {
  MAX_LINKS_PER_DOC,
  LINK_CONTEXT_CHARS,
  LINK_TARGET_MAX_BYTES,
  LINK_SCAN_BYTES,
  FRONTMATTER_SCAN_BYTES,
  MAX_PROPERTY_KEYS,
  MAX_PROPERTY_VALUE_CHARS,
  MAX_PROPERTY_ARRAY_ITEMS,
  MAX_PROPERTIES_BYTES,
  INDEX_ENTRY_HOOK_CHARS,
  INDEX_NOTE_MAX_ENTRIES,
  LINKABLE_DOC_TYPES,
  isLinkableDocType,
} from './linkConstants.js';

describe('linkConstants', () => {
  it('pins the documented numeric caps', () => {
    expect(MAX_LINKS_PER_DOC).toBe(200);
    expect(LINK_CONTEXT_CHARS).toBe(240);
    expect(LINK_TARGET_MAX_BYTES).toBe(1024);
    expect(LINK_SCAN_BYTES).toBe(1024 * 1024);
    expect(FRONTMATTER_SCAN_BYTES).toBe(16384);
    expect(MAX_PROPERTY_KEYS).toBe(32);
    expect(MAX_PROPERTY_VALUE_CHARS).toBe(512);
    expect(MAX_PROPERTY_ARRAY_ITEMS).toBe(32);
    expect(MAX_PROPERTIES_BYTES).toBe(8192);
    expect(INDEX_ENTRY_HOOK_CHARS).toBe(160);
    expect(INDEX_NOTE_MAX_ENTRIES).toBe(50);
  });

  it('enumerates the linkable doc types', () => {
    expect([...LINKABLE_DOC_TYPES].sort()).toEqual(
      ['markdown', 'objective', 'plan', 'prompt', 'report', 'text'].sort(),
    );
  });
});

describe('isLinkableDocType', () => {
  it('returns true for every linkable doc type', () => {
    for (const t of LINKABLE_DOC_TYPES) {
      expect(isLinkableDocType(t)).toBe(true);
    }
  });

  it('returns false for non-linkable doc types', () => {
    expect(isLinkableDocType('json')).toBe(false);
    expect(isLinkableDocType('dataset')).toBe(false);
    expect(isLinkableDocType('image')).toBe(false);
    expect(isLinkableDocType('code')).toBe(false);
    expect(isLinkableDocType('')).toBe(false);
  });
});
