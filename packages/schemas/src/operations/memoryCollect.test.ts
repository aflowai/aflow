import { describe, expect, it } from 'vitest';
import {
  collectMemoryDocuments,
  collectMemoryDocumentsSync,
  MEMORY_COLLECT_SCAN_LIMIT,
  MemoryCollectInputSchema,
  type MemoryCollectRead,
} from './memoryCollect.js';

const DOCS: Record<string, unknown> = {
  '/resolved/a.json': { resolvedTradingDay: '2026-07-14', outcome: 'falsified' },
  '/resolved/b.json': { resolvedTradingDay: '2026-07-10', outcome: 'confirmed' },
  '/resolved/c.json': { resolvedTradingDay: '2026-07-14', outcome: 'confirmed' },
  '/journal/2026-07-09.md': '# 09',
  '/journal/2026-07-10.md': '# 10',
  '/journal/2026-07-13.md': '# 13',
  '/journal/2026-07-14.md': '# 14',
  '/journal-old/2026-07-01.md': '# old',
};

function store(docs: Record<string, unknown> = DOCS, unreadable = new Set<string>()) {
  return {
    list: (prefix: string, max: number) =>
      Object.keys(docs)
        .filter((path) => path.startsWith(prefix.replace(/\/$/, '')))
        .sort()
        .slice(0, max),
    read: (path: string): MemoryCollectRead => {
      if (unreadable.has(path)) return { ok: false, reason: 'The payload has expired.' };
      if (!(path in docs)) return { ok: false, reason: 'No document at this path.' };
      const content = docs[path];
      return { ok: true, docType: typeof content === 'string' ? 'markdown' : 'json', content };
    },
  };
}

const collect = (sources: unknown[], extra: Record<string, unknown> = {}, s = store()) =>
  collectMemoryDocumentsSync(MemoryCollectInputSchema.parse({ sources, ...extra }), s);

describe('memory.store.collect selection', () => {
  it('filters on top-level JSON fields', () => {
    const out = collect([
      { key: 'resolutions', pathPrefix: '/resolved/', where: { resolvedTradingDay: '2026-07-14' } },
    ]);
    expect((out.docs['resolutions'] as Array<{ path: string }>).map((d) => d.path)).toEqual([
      '/resolved/a.json',
      '/resolved/c.json',
    ]);
    expect(out.found).toEqual({ resolutions: 2 });
  });

  it('reads the latest documents before a path, compared as text under the prefix', () => {
    const out = collect([
      {
        key: 'journal',
        pathPrefix: '/journal/',
        before: '/journal/2026-07-14',
        order: 'desc',
        limit: 2,
      },
    ]);
    expect(out.docs['journal']).toEqual([
      { path: '/journal/2026-07-13.md', docType: 'markdown', content: '# 13' },
      { path: '/journal/2026-07-10.md', docType: 'markdown', content: '# 10' },
    ]);
  });

  it('marks an absent or unreadable document missing, and counts it nowhere', () => {
    const out = collect(
      [
        { key: 'snapshot', path: '/snapshots/none.json' },
        { key: 'journal', pathPrefix: '/journal/' },
      ],
      {},
      store(DOCS, new Set(['/journal/2026-07-10.md'])),
    );
    expect(out.docs['snapshot']).toEqual({
      path: '/snapshots/none.json',
      missing: true,
      reason: 'No document at this path.',
    });
    expect(out.found).toEqual({ snapshot: 0, journal: 3 });
    expect(out.missing).toEqual(['/snapshots/none.json', '/journal/2026-07-10.md']);
  });

  it('marks a document past the read budget missing, and a filtered one spends none', () => {
    const out = collect(
      [
        {
          key: 'resolutions',
          pathPrefix: '/resolved/',
          where: { resolvedTradingDay: '2026-07-10' },
        },
        { key: 'journal', pathPrefix: '/journal/2026-07-1' },
      ],
      { maxTotalChars: 65 },
    );
    expect(out.found).toEqual({ resolutions: 1, journal: 2 });
    expect(out.missing).toEqual(['/journal/2026-07-14.md']);
    const budgeted = collect([{ key: 'journal', pathPrefix: '/journal/' }], { maxTotalChars: 9 });
    expect(budgeted.found).toEqual({ journal: 2 });
    expect(budgeted.missing).toEqual(['/journal/2026-07-13.md', '/journal/2026-07-14.md']);
  });

  it('names a prefix holding more documents than one read scans', () => {
    const many = Object.fromEntries(
      Array.from({ length: MEMORY_COLLECT_SCAN_LIMIT + 5 }, (_, i) => [
        `/many/${String(i).padStart(5, '0')}.md`,
        'x',
      ]),
    );
    const out = collect([{ key: 'many', pathPrefix: '/many/', limit: 1 }], {}, store(many));
    expect(out.incomplete).toEqual(['many']);
  });

  it('runs the same against a store that answers later', async () => {
    const sync = store();
    const input = MemoryCollectInputSchema.parse({
      sources: [{ key: 'journal', pathPrefix: '/journal/', order: 'desc', limit: 3 }],
    });
    const later = await collectMemoryDocuments(input, {
      list: async (prefix, max) => sync.list(prefix, max),
      read: async (path) => sync.read(path),
    });
    expect(later).toEqual(collectMemoryDocumentsSync(input, sync));
  });

  it('refuses a source naming both or neither of path and pathPrefix, and a filter on a path', () => {
    for (const source of [
      { key: 'a' },
      { key: 'a', path: '/x', pathPrefix: '/y' },
      { key: 'a', path: '/x', limit: 3 },
    ]) {
      expect(MemoryCollectInputSchema.safeParse({ sources: [source] }).success).toBe(false);
    }
    expect(
      MemoryCollectInputSchema.safeParse({
        sources: [
          { key: 'a', path: '/x' },
          { key: 'a', path: '/y' },
        ],
      }).success,
    ).toBe(false);
  });
});
