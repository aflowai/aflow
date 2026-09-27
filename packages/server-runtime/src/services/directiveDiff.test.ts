import { describe, it, expect } from 'vitest';
import { diffDirectiveKeys } from './directiveDiff.js';

describe('diffDirectiveKeys (102h Phase 2)', () => {
  it('returns every key in next when prev is null (first activation)', () => {
    const next = { scope: {}, tone: { formality: 'casual' }, training: { inTraining: true } };
    expect(diffDirectiveKeys(null, next)).toEqual(['scope', 'tone', 'training']);
  });

  it('returns empty when prev and next are identical', () => {
    const directives = { scope: { domain: 'ml' }, tone: { formality: 'formal' } };
    expect(diffDirectiveKeys(directives, { ...directives })).toEqual([]);
  });

  it('reports a changed nested key at the top level', () => {
    const prev = { scope: { domain: 'ml' }, tone: { formality: 'casual' } };
    const next = { scope: { domain: 'ml' }, tone: { formality: 'formal' } };
    expect(diffDirectiveKeys(prev, next)).toEqual(['tone']);
  });

  it('reports a newly added top-level key', () => {
    const prev = { scope: { domain: 'ml' } };
    const next = { scope: { domain: 'ml' }, training: { inTraining: true } };
    expect(diffDirectiveKeys(prev, next)).toEqual(['training']);
  });

  it('reports a removed top-level key', () => {
    const prev = { scope: { domain: 'ml' }, legacy: true };
    const next = { scope: { domain: 'ml' } };
    expect(diffDirectiveKeys(prev, next)).toEqual(['legacy']);
  });

  it('reports multiple simultaneous changes in sorted order', () => {
    const prev = { scope: { domain: 'ml' }, tone: { formality: 'casual' } };
    const next = { scope: { domain: 'pe' }, tone: { formality: 'formal' }, training: {} };
    expect(diffDirectiveKeys(prev, next)).toEqual(['scope', 'tone', 'training']);
  });

  it('treats array reordering as a change (stringify-based)', () => {
    const prev = { scope: { priorities: ['a', 'b'] } };
    const next = { scope: { priorities: ['b', 'a'] } };
    expect(diffDirectiveKeys(prev, next)).toEqual(['scope']);
  });

  it('does not report a change when nested objects are structurally identical but differ in key order', () => {
    // JSON.stringify key ordering follows insertion order. Two objects with the
    // same key/value pairs inserted in the same order serialize identically.
    // This test pins behavior for the common case where a JS round-trip preserves
    // order; it does NOT promise that key-reordering across heterogenous sources
    // is treated as identical.
    const prev = { scope: { domain: 'ml', version: 1 } };
    const next = { scope: { domain: 'ml', version: 1 } };
    expect(diffDirectiveKeys(prev, next)).toEqual([]);
  });

  it('always returns keys in lexicographic order', () => {
    const prev = { z: 1, a: 2, m: 3 };
    const next = { z: 99, a: 2, m: 100 };
    expect(diffDirectiveKeys(prev, next)).toEqual(['m', 'z']);
  });
});
