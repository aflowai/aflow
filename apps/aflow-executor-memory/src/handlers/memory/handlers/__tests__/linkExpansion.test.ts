import { describe, it, expect } from 'vitest';
import type { Neighbor } from '@aflow/database';
import {
  distinctSeeds,
  perSeedCap,
  selectExpandedNeighbors,
  type ExpansionSeed,
  type NeighborDoc,
} from '../linkExpansion.js';

function doc(path: string): NeighborDoc {
  return {
    path,
    id: `id${path}`,
    docType: 'markdown',
    mimeType: 'text/markdown',
    sizeBytes: 10,
    updatedAt: '2026-01-01T00:00:00.000Z',
    preview: undefined,
    scope: {},
  };
}

function docMap(...paths: string[]): Map<string, NeighborDoc> {
  return new Map(paths.map((p) => [p, doc(p)]));
}

describe('Plan 249 P4 — link expansion selection', () => {
  it('perSeedCap clamps to [1, 50]', () => {
    expect(perSeedCap(10)).toBe(10);
    expect(perSeedCap(0)).toBe(1);
    expect(perSeedCap(999)).toBe(50);
  });

  it('distinctSeeds keeps rank order and dedupes by doc id, capped', () => {
    const seeds = distinctSeeds(
      [
        { id: 'a', path: '/a' },
        { id: 'a', path: '/a' },
        { id: 'b', path: '/b' },
        { id: 'c', path: '/c' },
      ],
      2,
    );
    expect(seeds).toEqual([
      { docId: 'a', path: '/a' },
      { docId: 'b', path: '/b' },
    ]);
  });

  it('appends an outgoing neighbor with via, from the pulling seed', () => {
    const seeds: ExpansionSeed[] = [{ docId: 'a', path: '/a' }];
    const neighbors = new Map<string, Neighbor[]>([['a', [{ path: '/b', direction: 'out' }]]]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/b'), 10);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe('/b');
    expect(out[0]?.via).toEqual({ kind: 'link', direction: 'out', from: '/a' });
  });

  it('drops a neighbor that is itself a seed', () => {
    const seeds: ExpansionSeed[] = [
      { docId: 'a', path: '/a' },
      { docId: 'b', path: '/b' },
    ];
    const neighbors = new Map<string, Neighbor[]>([
      ['a', [{ path: '/b', direction: 'out' }]],
      ['b', []],
    ]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/b'), 10);
    expect(out).toHaveLength(0);
  });

  it('a neighbor reachable from two seeds appears once', () => {
    const seeds: ExpansionSeed[] = [
      { docId: 'a', path: '/a' },
      { docId: 'b', path: '/b' },
    ];
    const neighbors = new Map<string, Neighbor[]>([
      ['a', [{ path: '/shared', direction: 'out' }]],
      ['b', [{ path: '/shared', direction: 'out' }]],
    ]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/shared'), 10);
    expect(out.map((i) => i.path)).toEqual(['/shared']);
    expect(out[0]?.via?.from).toBe('/a');
  });

  it('drops a neighbor with no materialized doc (filter failed)', () => {
    const seeds: ExpansionSeed[] = [{ docId: 'a', path: '/a' }];
    const neighbors = new Map<string, Neighbor[]>([
      [
        'a',
        [
          { path: '/keep', direction: 'out' },
          { path: '/drop', direction: 'out' },
        ],
      ],
    ]);
    // Only /keep is materialized — /drop failed the filter predicate upstream.
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/keep'), 10);
    expect(out.map((i) => i.path)).toEqual(['/keep']);
  });

  it('round-robin: 2 seeds × 5 neighbors, cap 4 → 2 from each, interleaved', () => {
    const seeds: ExpansionSeed[] = [
      { docId: 's1', path: '/s1' },
      { docId: 's2', path: '/s2' },
    ];
    const n1: Neighbor[] = [0, 1, 2, 3, 4].map((i) => ({ path: `/a${i}`, direction: 'out' }));
    const n2: Neighbor[] = [0, 1, 2, 3, 4].map((i) => ({ path: `/b${i}`, direction: 'out' }));
    const neighbors = new Map<string, Neighbor[]>([
      ['s1', n1],
      ['s2', n2],
    ]);
    const docs = docMap(...n1.map((n) => n.path), ...n2.map((n) => n.path));
    const out = selectExpandedNeighbors(seeds, neighbors, docs, 4);
    expect(out.map((i) => i.path)).toEqual(['/a0', '/b0', '/a1', '/b1']);
    expect(out.filter((i) => i.via?.from === '/s1')).toHaveLength(2);
    expect(out.filter((i) => i.via?.from === '/s2')).toHaveLength(2);
  });

  it('cross-seed: a path that is in from one seed and out from another emits out', () => {
    const seeds: ExpansionSeed[] = [
      { docId: 's1', path: '/s1' },
      { docId: 's2', path: '/s2' },
    ];
    // s1 (rank 0) sees X as an incoming referrer; s2 (rank 1) links out to X.
    // The lower-rank incoming pull must NOT win — out is higher trust.
    const neighbors = new Map<string, Neighbor[]>([
      ['s1', [{ path: '/x', direction: 'in' }]],
      ['s2', [{ path: '/x', direction: 'out' }]],
    ]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/x'), 10);
    expect(out).toHaveLength(1);
    expect(out[0]?.via).toEqual({ kind: 'link', direction: 'out', from: '/s2' });
  });

  it('cross-seed: out from a lower rank still wins over a later in pull', () => {
    const seeds: ExpansionSeed[] = [
      { docId: 's1', path: '/s1' },
      { docId: 's2', path: '/s2' },
    ];
    const neighbors = new Map<string, Neighbor[]>([
      ['s1', [{ path: '/x', direction: 'out' }]],
      ['s2', [{ path: '/x', direction: 'in' }]],
    ]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/x'), 10);
    expect(out).toHaveLength(1);
    expect(out[0]?.via).toEqual({ kind: 'link', direction: 'out', from: '/s1' });
  });

  it('outgoing rank before incoming regardless of pull order', () => {
    const seeds: ExpansionSeed[] = [
      { docId: 's1', path: '/s1' },
      { docId: 's2', path: '/s2' },
    ];
    // s1 pulls an incoming referrer first; s2 pulls an outgoing.
    const neighbors = new Map<string, Neighbor[]>([
      ['s1', [{ path: '/in', direction: 'in' }]],
      ['s2', [{ path: '/out', direction: 'out' }]],
    ]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/in', '/out'), 10);
    expect(out.map((i) => i.path)).toEqual(['/out', '/in']);
    expect(out[0]?.via?.direction).toBe('out');
    expect(out[1]?.via?.direction).toBe('in');
  });

  it('within one seed the repo neighbor order (out before in) is preserved', () => {
    const seeds: ExpansionSeed[] = [{ docId: 's1', path: '/s1' }];
    const neighbors = new Map<string, Neighbor[]>([
      [
        's1',
        [
          { path: '/o1', direction: 'out' },
          { path: '/o2', direction: 'out' },
          { path: '/i1', direction: 'in' },
        ],
      ],
    ]);
    const out = selectExpandedNeighbors(seeds, neighbors, docMap('/o1', '/o2', '/i1'), 10);
    expect(out.map((i) => i.path)).toEqual(['/o1', '/o2', '/i1']);
  });

  it('caps the expanded tail at maxLinkedItems', () => {
    const seeds: ExpansionSeed[] = [{ docId: 's1', path: '/s1' }];
    const ns: Neighbor[] = [0, 1, 2, 3, 4].map((i) => ({ path: `/n${i}`, direction: 'out' }));
    const out = selectExpandedNeighbors(
      seeds,
      new Map([['s1', ns]]),
      docMap(...ns.map((n) => n.path)),
      3,
    );
    expect(out).toHaveLength(3);
    expect(out.map((i) => i.path)).toEqual(['/n0', '/n1', '/n2']);
  });
});
