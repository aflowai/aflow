import { describe, it, expect } from 'vitest';
import {
  MemoryQueryInputSchema,
  MemoryFiltersSchema,
  MemoryDocStatSchema,
  MemoryQueryItemSchema,
  MemoryGetInputSchema,
  MAX_PROPERTY_FILTER_KEYS,
} from './memory.js';

describe('memory read schemas — Plan 249 P3', () => {
  describe('docType tolerance (read outputs accept out-of-enum docTypes)', () => {
    it('stat parses a platform docType outside the write enum', () => {
      const parsed = MemoryDocStatSchema.parse({
        id: '00000000-0000-0000-0000-000000000001',
        path: '/x',
        docType: 'skill_projection',
        mimeType: 'application/json',
        sizeBytes: 10,
        tags: [],
        version: 1,
        embeddingStatus: 'disabled',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(parsed.docType).toBe('skill_projection');
    });

    it('query item parses a workflow docType', () => {
      const parsed = MemoryQueryItemSchema.parse({
        path: '/w',
        id: '00000000-0000-0000-0000-000000000002',
        docType: 'workflow',
        mimeType: 'application/json',
        sizeBytes: 5,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(parsed.docType).toBe('workflow');
    });
  });

  describe('mode="links" refines', () => {
    it('rejects query set in links mode, naming the fix', () => {
      const r = MemoryQueryInputSchema.safeParse({ mode: 'links', query: 'anything' });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => /query is not used in links mode/.test(i.message))).toBe(
          true,
        );
      }
    });

    it('accepts links mode with a linkFilter.target', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'links',
        linkFilter: { target: '/notes/hub.md' },
      });
      expect(r.success).toBe(true);
    });

    it('accepts links mode with unresolvedOnly and no target', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'links',
        linkFilter: { unresolvedOnly: true },
      });
      expect(r.success).toBe(true);
    });

    it('rejects linkFilter when mode is not links, naming the field', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'list',
        linkFilter: { target: '/x' },
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(
          r.error.issues.some((i) => /linkFilter is only valid with mode="links"/.test(i.message)),
        ).toBe(true);
      }
    });
  });

  describe('filters.properties', () => {
    it('accepts a scalar, an array of scalars, and mixed keys', () => {
      const r = MemoryFiltersSchema.safeParse({
        properties: { status: 'active', priority: 3, tags: ['a', 'b'], done: false },
      });
      expect(r.success).toBe(true);
    });

    it(`rejects more than ${MAX_PROPERTY_FILTER_KEYS} keys, naming the cap`, () => {
      const properties: Record<string, string> = {};
      for (let i = 0; i <= MAX_PROPERTY_FILTER_KEYS; i++) properties[`k${String(i)}`] = 'v';
      const r = MemoryFiltersSchema.safeParse({ properties });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(
          r.error.issues.some((i) =>
            new RegExp(`At most ${String(MAX_PROPERTY_FILTER_KEYS)} property filters`).test(
              i.message,
            ),
          ),
        ).toBe(true);
      }
    });
  });

  describe('get view enum', () => {
    it('accepts view="links"', () => {
      const r = MemoryGetInputSchema.safeParse({ path: '/x', view: 'links' });
      expect(r.success).toBe(true);
    });
  });

  describe('get pinned target', () => {
    const HASH = 'a'.repeat(64);

    it('accepts a nested target with version + expectedContentHash', () => {
      const r = MemoryGetInputSchema.safeParse({
        target: { path: '/characters/ada.md', version: 3, expectedContentHash: HASH },
        view: 'content',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.target.version).toBe(3);
        expect(r.data.target.expectedContentHash).toBe(HASH);
      }
    });

    it('carries a flat pin into target instead of dropping it', () => {
      const r = MemoryGetInputSchema.safeParse({
        path: '/characters/ada.md',
        version: 3,
        expectedContentHash: HASH,
        view: 'content',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.target.path).toBe('/characters/ada.md');
        expect(r.data.target.version).toBe(3);
        expect(r.data.target.expectedContentHash).toBe(HASH);
      }
    });

    it('accepts a pin addressed by id', () => {
      const r = MemoryGetInputSchema.safeParse({
        target: { id: '11111111-1111-4111-8111-111111111111', version: 1 },
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.target.version).toBe(1);
    });

    it('leaves version and expectedContentHash absent when not pinned', () => {
      const r = MemoryGetInputSchema.safeParse({ path: '/x' });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.target.version).toBeUndefined();
        expect(r.data.target.expectedContentHash).toBeUndefined();
      }
    });

    it.each([0, -1, 1.5])('rejects version %s', (version) => {
      const r = MemoryGetInputSchema.safeParse({ path: '/x', version });
      expect(r.success).toBe(false);
    });

    it('merges a flat pin into a target that is already nested', () => {
      const r = MemoryGetInputSchema.safeParse({
        target: { path: '/characters/ada.md' },
        version: 3,
        expectedContentHash: HASH,
        view: 'content',
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.target.version).toBe(3);
        expect(r.data.target.expectedContentHash).toBe(HASH);
      }
    });

    it('rejects a pin spelled both flat and nested with different values', () => {
      const r = MemoryGetInputSchema.safeParse({
        target: { path: '/characters/ada.md', version: 2 },
        version: 3,
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => /Set it once, inside target/.test(i.message))).toBe(true);
      }
    });

    it('accepts a pin spelled both flat and nested with the same value', () => {
      const r = MemoryGetInputSchema.safeParse({
        target: { path: '/characters/ada.md', version: 2 },
        version: 2,
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.target.version).toBe(2);
    });

    it('still requires either id or path alongside a pin', () => {
      const r = MemoryGetInputSchema.safeParse({ target: { version: 2 } });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => /Either id or path/.test(i.message))).toBe(true);
      }
    });
  });

  describe('mode="search" expand.links (Plan 249 P4)', () => {
    it('accepts expand.links=1 with mode="search" and defaults direction to out', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'search',
        query: 'notes',
        expand: { links: 1 },
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.expand?.direction).toBe('out');
    });

    it('accepts an explicit direction="both"', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'search',
        query: 'notes',
        expand: { links: 1, direction: 'both' },
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.expand?.direction).toBe('both');
    });

    it('rejects expand when mode is not search, naming the fix', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'list',
        expand: { links: 1 },
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(
          r.error.issues.some((i) => /expand\.links requires mode="search"/.test(i.message)),
        ).toBe(true);
      }
    });

    it('rejects a depth other than 1 (links is literal 1)', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'search',
        query: 'notes',
        expand: { links: 2 },
      });
      expect(r.success).toBe(false);
    });

    it('budget.maxLinkedItems defaults to 10', () => {
      const r = MemoryQueryInputSchema.safeParse({
        mode: 'search',
        query: 'notes',
        budget: {},
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.budget?.maxLinkedItems).toBe(10);
    });

    it('query item parses a link-expanded via (no hit)', () => {
      const parsed = MemoryQueryItemSchema.parse({
        path: '/w',
        id: '00000000-0000-0000-0000-000000000003',
        docType: 'markdown',
        mimeType: 'text/markdown',
        sizeBytes: 5,
        updatedAt: '2026-01-01T00:00:00.000Z',
        via: { kind: 'link', direction: 'in', from: '/seed.md' },
      });
      expect(parsed.via).toEqual({ kind: 'link', direction: 'in', from: '/seed.md' });
      expect(parsed.hit).toBeUndefined();
    });
  });
});
