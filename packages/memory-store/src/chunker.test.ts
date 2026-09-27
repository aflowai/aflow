import { describe, it, expect } from 'vitest';
import {
  chunkContent,
  chunkCsv,
  chunkText,
  isBinaryDocType,
  parseCsvLine,
  splitForTokenSafety,
  type ContentChunk,
} from './chunker.js';

// ============================================================================
// CSV line parser
// ============================================================================

describe('parseCsvLine', () => {
  it('parses simple unquoted CSV', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('parses quoted fields with commas', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('parses escaped quotes inside quoted fields', () => {
    expect(parseCsvLine('"say ""hello""",b')).toEqual(['say "hello"', 'b']);
  });

  it('handles empty fields', () => {
    expect(parseCsvLine(',,')).toEqual(['', '', '']);
  });

  it('handles single field', () => {
    expect(parseCsvLine('only')).toEqual(['only']);
  });
});

// ============================================================================
// isBinaryDocType
// ============================================================================

describe('isBinaryDocType', () => {
  it('returns true for image/audio/video', () => {
    expect(isBinaryDocType('image')).toBe(true);
    expect(isBinaryDocType('audio')).toBe(true);
    expect(isBinaryDocType('video')).toBe(true);
  });

  it('returns false for text-based doc types', () => {
    expect(isBinaryDocType('text')).toBe(false);
    expect(isBinaryDocType('markdown')).toBe(false);
    expect(isBinaryDocType('dataset')).toBe(false);
    expect(isBinaryDocType('json')).toBe(false);
    expect(isBinaryDocType('code')).toBe(false);
  });
});

// ============================================================================

describe('chunkCsv', () => {
  it('produces header chunk (embeddable) + row batch chunks (skipEmbedding)', () => {
    const csv = 'name,age,city\nAlice,30,Berlin\nBob,25,Munich\nCarol,42,Hamburg';
    const { chunks, meta } = chunkCsv(csv);

    // Header chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const header = chunks[0]!;
    expect(header.skipEmbedding).toBeUndefined(); // not set = embeddable
    expect(header.text).toContain('Columns: name, age, city');
    expect(header.text).toContain('Rows: 3');

    // Row batch chunk(s)
    const rowChunks = chunks.slice(1);
    for (const rc of rowChunks) {
      expect(rc.skipEmbedding).toBe(true);
    }

    // Meta
    expect(meta.columns).toEqual(['name', 'age', 'city']);
    expect(meta.rowCount).toBe(3);
    expect(meta.sampleRows.length).toBe(3);
    expect(meta.sampleRows[0]).toEqual(['Alice', '30', 'Berlin']);
  });

  it('includes sample data in header chunk text', () => {
    const csv = 'x,y\n1,2\n3,4';
    const { chunks } = chunkCsv(csv);
    const header = chunks[0]!;
    expect(header.text).toContain('Sample data:');
    expect(header.text).toContain('x=1, y=2');
  });

  it('handles empty content gracefully', () => {
    const { chunks, meta } = chunkCsv('');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(meta.rowCount).toBe(0);
  });

  it('handles header-only CSV', () => {
    const csv = 'col1,col2,col3';
    const { chunks, meta } = chunkCsv(csv);
    expect(chunks.length).toBe(1); // header only, no row batches
    expect(meta.rowCount).toBe(0);
    expect(meta.columns).toEqual(['col1', 'col2', 'col3']);
    expect(chunks[0]!.skipEmbedding).toBeUndefined();
  });

  it('batches rows into groups of CSV_ROW_BATCH_SIZE', () => {
    const lines = ['id,value'];
    for (let i = 0; i < 120; i++) {
      lines.push(`${String(i)},data_${String(i)}`);
    }
    const csv = lines.join('\n');
    const { chunks, meta } = chunkCsv(csv);

    expect(meta.rowCount).toBe(120);
    // 1 header + ceil(120/50) = 1 + 3 = 4 chunks
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.skipEmbedding).toBeUndefined();
    expect(chunks[1]!.skipEmbedding).toBe(true);
    expect(chunks[2]!.skipEmbedding).toBe(true);
    expect(chunks[3]!.skipEmbedding).toBe(true);
  });
});

// ============================================================================
// chunkContent dispatch
// ============================================================================

describe('chunkContent', () => {
  it('dispatches dataset type to CSV chunker', () => {
    const csv = 'a,b\n1,2\n3,4';
    const chunks = chunkContent(csv, 'dataset');
    // Should have header + row batch
    expect(chunks.length).toBe(2);
    const header = chunks[0]!;
    expect(header.text).toContain('Columns: a, b');
    expect(header.skipEmbedding).toBeUndefined();
    const rows = chunks[1]!;
    expect(rows.skipEmbedding).toBe(true);
  });

  it('dispatches text type to text chunker', () => {
    const chunks = chunkContent('Hello world', 'text');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe('Hello world');
    expect(chunks[0]!.skipEmbedding).toBeUndefined();
  });

  it('dispatches json type to JSON chunker', () => {
    const chunks = chunkContent('{"key": "value"}', 'json');
    expect(chunks.length).toBe(1);
  });
});

// ============================================================================

describe('splitForTokenSafety', () => {
  it('returns text as-is when within limits', () => {
    const text = 'Short text';
    const parts = splitForTokenSafety(text);
    expect(parts).toEqual(['Short text']);
  });

  it('splits oversized text into multiple parts', () => {
    // MAX_EMBED_CHARS = 21000
    const text = 'x'.repeat(50_000);
    const parts = splitForTokenSafety(text);
    expect(parts.length).toBeGreaterThan(1);

    // All parts should be within the limit
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(21_000);
    }

    // Concatenation should equal the original
    expect(parts.join('')).toBe(text);
  });

  it('prefers splitting at newlines', () => {
    // Build text with newlines near the split boundary
    const line = 'a'.repeat(100) + '\n';
    const text = line.repeat(250); // 250 * 101 = 25250 chars
    const parts = splitForTokenSafety(text);
    expect(parts.length).toBe(2);
    // First part should end with a newline (split at newline boundary)
    expect(parts[0]!.endsWith('\n')).toBe(true);
  });

  it('handles text exactly at the limit', () => {
    const text = 'y'.repeat(21_000);
    const parts = splitForTokenSafety(text);
    expect(parts).toEqual([text]);
  });
});

// ============================================================================
// Existing chunkers still work (regression)
// ============================================================================

describe('chunkText (regression)', () => {
  it('does not add skipEmbedding to text chunks', () => {
    const chunks = chunkText('Some paragraph text');
    expect(chunks[0]!.skipEmbedding).toBeUndefined();
  });
});
