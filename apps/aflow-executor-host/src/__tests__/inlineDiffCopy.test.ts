/**
 * Contract: a result's inline copy of a diff is an exact prefix of it, within
 * the cap — the stored diff is what a publication takes, and the copy is only
 * for reading.
 */
import { describe, expect, it } from 'vitest';

import { INLINE_DIFF_CAP_BYTES, utf8Prefix } from '../worktree.js';

describe('the inline copy of a diff past the cap', () => {
  it('stops before a character the cap cuts through, and is an exact prefix', () => {
    // A three-byte character whose first byte is the cap's last.
    const head = 'a'.repeat(INLINE_DIFF_CAP_BYTES - 1);
    const diff = `${head}€ and the rest of the diff\n`;
    const byteCut = Buffer.from(diff, 'utf8').subarray(0, INLINE_DIFF_CAP_BYTES).toString('utf8');
    expect(byteCut).toContain('�');

    const copy = utf8Prefix(diff, INLINE_DIFF_CAP_BYTES);
    expect(copy).toBe(head);
    expect(copy).not.toContain('�');
    expect(diff.startsWith(copy)).toBe(true);
    expect(Buffer.byteLength(copy, 'utf8')).toBeLessThanOrEqual(INLINE_DIFF_CAP_BYTES);
  });

  it('keeps a character that ends exactly at the cap', () => {
    const diff = `${'a'.repeat(INLINE_DIFF_CAP_BYTES - 3)}€b`;
    expect(utf8Prefix(diff, INLINE_DIFF_CAP_BYTES)).toBe(diff.slice(0, -1));
  });

  it('leaves a diff within the cap whole', () => {
    expect(utf8Prefix('diff --git a/€ b/€\n', INLINE_DIFF_CAP_BYTES)).toBe('diff --git a/€ b/€\n');
  });
});
