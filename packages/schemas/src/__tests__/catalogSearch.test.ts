/**
 * Ranking regression tests for catalog search (BM25 + segment coverage reranking).
 *
 * These are pure-function tests on searchCatalog() — no infra needed.
 * They guard against scoring regressions as the search logic evolves.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { searchCatalog, resetSearchIndex } from '../catalog/search.js';

// Reset index before each test to ensure clean state
beforeEach(() => {
  resetSearchIndex();
});

describe('catalog search ranking', () => {
  it('should rank memory.store.put top for "save data"', () => {
    const results = searchCatalog({ query: 'save data' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.operationId).toBe('memory.store.put');
  });

  it('should rank compute.sandbox.exec top for "sandbox exec code"', () => {
    const results = searchCatalog({ query: 'sandbox exec code' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.operationId).toBe('compute.sandbox.exec');
  });

  it('should rank memory.store.delete above memory.store.list for "delete memory"', () => {
    const results = searchCatalog({ query: 'delete memory' });
    expect(results.length).toBeGreaterThan(1);
    const deleteIdx = results.findIndex((r) => r.operationId === 'memory.store.delete');
    const listIdx = results.findIndex((r) => r.operationId === 'memory.store.list');
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    if (listIdx >= 0) {
      expect(deleteIdx).toBeLessThan(listIdx);
    }
  });

  it('should not crash on common-verb-only queries', () => {
    const results = searchCatalog({ query: 'list' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('should not crash on single-token queries', () => {
    const results = searchCatalog({ query: 'memory' });
    expect(results.length).toBeGreaterThan(0);
    // All results should be in the memory step type or mention memory
    expect(results[0]!.operationId).toMatch(/^memory\./);
  });

  it('should respect structural filters alongside query', () => {
    const results = searchCatalog({ query: 'list', stepTypes: ['memory'] });
    for (const r of results) {
      expect(r.operationId).toMatch(/^memory\./);
    }
  });

  it('should return lean results without inputSchema', () => {
    const results = searchCatalog({ query: 'save data' });
    expect(results.length).toBeGreaterThan(0);
    // Results should NOT have inputSchema (removed in Phase 3)
    for (const r of results) {
      expect(r).not.toHaveProperty('inputSchema');
      expect(r).not.toHaveProperty('exampleInput');
    }
  });

  it('should respect maxResults', () => {
    const results = searchCatalog({ query: 'data', maxResults: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should work with operationId-style dot queries', () => {
    const results = searchCatalog({ query: 'memory.store' });
    expect(results.length).toBeGreaterThan(0);
    // Top results should be memory.store.* operations
    expect(results[0]!.operationId).toMatch(/^memory\.store\./);
  });
});

describe('segment coverage reranking', () => {
  it('should boost multi-segment matches over single-segment matches', () => {
    // "memory put" should strongly prefer memory.store.put (rare segment
    // "memory" + verb segment "put") over ops matching only one segment
    const results = searchCatalog({ query: 'memory put' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.operationId).toBe('memory.store.put');
  });

  it('should handle underscore-compound operation IDs', () => {
    // Operations with underscores in their IDs should have segments properly tokenized
    // e.g., agent.manage.get_definition_schema should be findable by "definition schema"
    const results = searchCatalog({ query: 'definition schema' });
    expect(results.length).toBeGreaterThan(0);
    // Should find agent.manage.get_definition_schema or similar
    const hasDefinitionOp = results.some((r) => r.operationId.includes('definition'));
    expect(hasDefinitionOp).toBe(true);
  });
});

describe('searchCatalog — workflow steps', () => {
  it('keeps step-only operations out of a tool search', () => {
    const results = searchCatalog({ query: 'route triage decide classify', maxResults: 10 });
    expect(results.map((r) => r.operationId)).not.toContain('ai.decision.decide');
  });

  it('returns step-only operations to an author, marked stepOnly', () => {
    const results = searchCatalog({
      query: 'route triage decide classify',
      maxResults: 10,
      workflowSteps: true,
    });
    const decide = results.find((r) => r.operationId === 'ai.decision.decide');
    expect(decide?.stepOnly).toBe(true);
  });
});
