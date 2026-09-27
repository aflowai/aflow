import { describe, it, expect } from 'vitest';
import { extractVirtualPathToolCallIds } from '../extractVirtualPathToolCallIds.js';

describe('extractVirtualPathToolCallIds', () => {
  it('extracts toolCallId from a simple string', () => {
    const ids = extractVirtualPathToolCallIds(
      '/run/outputs/fecaed39-31f9-4c6c-90af-67af6f4cc94e/media/0/data',
    );
    expect(ids).toEqual(new Set(['fecaed39-31f9-4c6c-90af-67af6f4cc94e']));
  });

  it('extracts from nested object', () => {
    const ids = extractVirtualPathToolCallIds({
      imageRef: '/run/outputs/abc123/media/0/data',
      other: 'no path here',
    });
    expect(ids).toEqual(new Set(['abc123']));
  });

  it('extracts from stringified JSON (child output as string)', () => {
    const ids = extractVirtualPathToolCallIds(
      '{"imageRef": "/run/outputs/abc-def-123/media/0/data"}',
    );
    expect(ids).toEqual(new Set(['abc-def-123']));
  });

  it('extracts multiple unique ids', () => {
    const ids = extractVirtualPathToolCallIds({
      image1: '/run/outputs/id-1/media/0/data',
      image2: '/run/outputs/id-2/files/output.png',
      duplicate: '/run/outputs/id-1/data',
    });
    expect(ids).toEqual(new Set(['id-1', 'id-2']));
  });

  it('extracts from arrays', () => {
    const ids = extractVirtualPathToolCallIds([
      '/run/outputs/arr-1/data',
      { nested: '/run/outputs/arr-2/body' },
    ]);
    expect(ids).toEqual(new Set(['arr-1', 'arr-2']));
  });

  it('returns empty set for no matches', () => {
    expect(extractVirtualPathToolCallIds('no virtual paths')).toEqual(new Set());
    expect(extractVirtualPathToolCallIds({ key: 42 })).toEqual(new Set());
    expect(extractVirtualPathToolCallIds(null)).toEqual(new Set());
    expect(extractVirtualPathToolCallIds(undefined)).toEqual(new Set());
  });

  it('handles path without field pointer', () => {
    const ids = extractVirtualPathToolCallIds('/run/outputs/tool-call-id');
    expect(ids).toEqual(new Set(['tool-call-id']));
  });
});
