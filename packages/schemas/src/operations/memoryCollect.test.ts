import { describe, expect, it } from 'vitest';
import {
  collectMemoryDocuments,
  collectMemoryDocumentsSync,
  MEMORY_COLLECT_SCAN_LIMIT,
  MemoryCollectInputSchema,
  type MemoryCollectListing,
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

/** When each document was last written, where a test names it. Every other one is old. */
const WRITTEN: Record<string, string> = {
  '/resolved/a.json': '2026-07-14T15:00:00Z',
  '/resolved/b.json': '2026-07-10T15:00:00Z',
  '/resolved/c.json': '2026-07-15T14:00:00Z',
};

function store(
  docs: Record<string, unknown> = DOCS,
  unreadable = new Set<string>(),
  written: Record<string, string> = WRITTEN,
) {
  const listings: MemoryCollectListing[] = [];
  return {
    listings,
    list: (listing: MemoryCollectListing) => {
      listings.push(listing);
      const paths = Object.keys(docs)
        .filter((path) => path.startsWith(listing.prefix))
        .filter((path) => listing.before === undefined || path < listing.before)
        .filter(
          (path) =>
            listing.updatedSince === undefined ||
            Date.parse(written[path] ?? '2000-01-01T00:00:00Z') > Date.parse(listing.updatedSince),
        )
        .sort();
      if (listing.order === 'desc') paths.reverse();
      return paths.slice(0, listing.max);
    },
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

  it('reads only documents written after updatedSince, so a where filter reads only candidates', () => {
    const s = store();
    const read: string[] = [];
    const out = collectMemoryDocumentsSync(
      MemoryCollectInputSchema.parse({
        sources: [
          {
            key: 'resolutions',
            pathPrefix: '/resolved/',
            updatedSince: '2026-07-14T00:00:00Z',
            where: { resolvedTradingDay: '2026-07-14' },
          },
        ],
      }),
      { list: s.list, read: (path) => (read.push(path), s.read(path)) },
    );
    expect((out.docs['resolutions'] as Array<{ path: string }>).map((d) => d.path)).toEqual([
      '/resolved/a.json',
      '/resolved/c.json',
    ]);
    // b.json was last written before the bound, so it is never read.
    expect(read).toEqual(['/resolved/a.json', '/resolved/c.json']);
    expect(s.listings[0]).toMatchObject({ updatedSince: '2026-07-14T00:00:00Z' });
  });

  const many = (count: number, extra: Record<string, unknown> = {}) => ({
    ...extra,
    ...Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`/many/${String(i).padStart(5, '0')}.md`, 'x']),
    ),
  });

  it('reads the latest paths of a prefix first past the scan, and scans only paths inside it', () => {
    const docs = many(MEMORY_COLLECT_SCAN_LIMIT + 500, {
      // A sibling the canonical prefix /many would also match, outside the prefix.
      ...Object.fromEntries(
        Array.from({ length: MEMORY_COLLECT_SCAN_LIMIT }, (_, i) => [
          `/many-old/${String(i)}.md`,
          'o',
        ]),
      ),
    });
    const s = store(docs);
    const out = collect(
      [{ key: 'many', pathPrefix: '/many/', before: '/many/01400', order: 'desc', limit: 2 }],
      {},
      s,
    );
    expect((out.docs['many'] as Array<{ path: string }>).map((d) => d.path)).toEqual([
      '/many/01399.md',
      '/many/01398.md',
    ]);
    expect(s.listings[0]).toEqual({
      prefix: '/many/',
      before: '/many/01400',
      order: 'desc',
      max: MEMORY_COLLECT_SCAN_LIMIT + 1,
    });
    // The limit filled inside the scan, so the cut lost nothing.
    expect(out.incomplete).toEqual([]);
  });

  it('names a source the scan cut before it filled its limit', () => {
    const out = collect(
      [{ key: 'many', pathPrefix: '/many/', where: { never: true }, limit: 1 }],
      {},
      store(many(MEMORY_COLLECT_SCAN_LIMIT + 5)),
    );
    expect(out.incomplete).toEqual(['many']);
    const within = collect(
      [{ key: 'many', pathPrefix: '/many/', where: { never: true }, limit: 1 }],
      {},
      store(many(MEMORY_COLLECT_SCAN_LIMIT)),
    );
    expect(within.incomplete).toEqual([]);
  });

  it('runs the same against a store that answers later', async () => {
    const sync = store();
    const input = MemoryCollectInputSchema.parse({
      sources: [{ key: 'journal', pathPrefix: '/journal/', order: 'desc', limit: 3 }],
    });
    const later = await collectMemoryDocuments(input, {
      list: async (listing) => sync.list(listing),
      read: async (path) => sync.read(path),
    });
    expect(later).toEqual(collectMemoryDocumentsSync(input, sync));
  });

  it('refuses a source naming both or neither of path and pathPrefix, and a filter on a path', () => {
    for (const source of [
      { key: 'a' },
      { key: 'a', path: '/x', pathPrefix: '/y' },
      { key: 'a', path: '/x', limit: 3 },
      { key: 'a', path: '/x', updatedSince: '2026-07-14T00:00:00Z' },
      { key: 'a', pathPrefix: '/x/', updatedSince: '2026-07-14' },
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
