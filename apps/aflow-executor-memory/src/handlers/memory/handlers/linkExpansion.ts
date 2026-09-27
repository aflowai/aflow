import type { Neighbor } from '@aflow/database';

/** A distinct seed doc, in the seeds' existing rank order. */
export interface ExpansionSeed {
  docId: string;
  path: string;
}

/** Neighbor doc metadata materialized with filter-parity to the seeds. */
export interface NeighborDoc {
  path: string;
  id: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  preview: string | undefined;
  scope: Record<string, string>;
}

/** A link-expanded query item — carries `via`, never a `hit`. */
export interface ExpandedItem {
  path: string;
  id: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  via: { kind: 'link'; direction: 'out' | 'in'; from: string };
  preview?: string;
  spaceId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

/** Cap on candidate neighbors fetched per seed before materialization. */
export function perSeedCap(maxLinkedItems: number): number {
  return Math.max(1, Math.min(maxLinkedItems, 50));
}

/** Take the top distinct seed docs, preserving rank order. */
export function distinctSeeds(
  items: ReadonlyArray<{ id: string; path: string }>,
  cap: number,
): ExpansionSeed[] {
  const seen = new Set<string>();
  const seeds: ExpansionSeed[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    seeds.push({ docId: it.id, path: it.path });
    if (seeds.length >= cap) break;
  }
  return seeds;
}

/**
 * Choose the link-expanded items from seed neighbors, in final rank order
 * (all seeds first is the caller's concern — this returns only the expanded
 * tail). Dedupe drops any neighbor that is itself a seed and any neighbor
 * reachable from more than one seed (kept once, at its first pull); when a
 * path is both an out-neighbor of one seed and an in-neighbor of another,
 * 'out' wins (higher trust) — the emitted `via` reflects the outgoing edge
 * and the seed that owns it, regardless of which seed's round-robin pull
 * first claimed the path. Fill is round-robin across seeds in rank order —
 * each seed contributes its first not-yet-taken neighbor, then its second,
 * etc. — so no single hub dominates. Within one seed the repo's pinned order
 * (out before in) is preserved. Finally, incoming-derived items are moved
 * after all outgoing-derived ones (incoming is the lower-trust self-nomination
 * channel), and the whole tail is truncated to `maxLinkedItems`.
 */
export function selectExpandedNeighbors(
  seeds: readonly ExpansionSeed[],
  neighborsBySeed: ReadonlyMap<string, readonly Neighbor[]>,
  neighborDocByPath: ReadonlyMap<string, NeighborDoc>,
  maxLinkedItems: number,
): ExpandedItem[] {
  const seedPaths = new Set(seeds.map((s) => s.path));

  interface Label {
    direction: 'out' | 'in';
    from: string;
    seedRank: number;
  }
  const bestLabelByPath = new Map<string, Label>();
  for (let seedRank = 0; seedRank < seeds.length; seedRank++) {
    const seed = seeds[seedRank];
    if (seed === undefined) continue;
    for (const n of neighborsBySeed.get(seed.docId) ?? []) {
      if (seedPaths.has(n.path)) continue;
      const current = bestLabelByPath.get(n.path);
      const candidate: Label = { direction: n.direction, from: seed.path, seedRank };
      if (current === undefined) {
        bestLabelByPath.set(n.path, candidate);
        continue;
      }
      if (current.direction === 'in' && n.direction === 'out') {
        bestLabelByPath.set(n.path, candidate);
      }
    }
  }

  const taken = new Set<string>();

  interface Picked {
    doc: NeighborDoc;
    direction: 'out' | 'in';
    from: string;
    seedRank: number;
  }
  const picked: Picked[] = [];

  const cursors = seeds.map(() => 0);
  let progressed = true;
  while (picked.length < maxLinkedItems && progressed) {
    progressed = false;
    for (let seedRank = 0; seedRank < seeds.length; seedRank++) {
      if (picked.length >= maxLinkedItems) break;
      const seed = seeds[seedRank];
      if (seed === undefined) continue;
      const neighbors = neighborsBySeed.get(seed.docId) ?? [];
      let cursor = cursors[seedRank] ?? 0;
      while (cursor < neighbors.length) {
        const n = neighbors[cursor];
        cursor += 1;
        if (n === undefined) continue;
        if (seedPaths.has(n.path)) continue;
        if (taken.has(n.path)) continue;
        const doc = neighborDocByPath.get(n.path);
        if (doc === undefined) continue;
        taken.add(n.path);
        const label = bestLabelByPath.get(n.path) ?? {
          direction: n.direction,
          from: seed.path,
          seedRank,
        };
        picked.push({
          doc,
          direction: label.direction,
          from: label.from,
          seedRank: label.seedRank,
        });
        progressed = true;
        break;
      }
      cursors[seedRank] = cursor;
    }
  }

  const stableIndex = new Map<Picked, number>();
  picked.forEach((p, i) => stableIndex.set(p, i));
  picked.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
    return (stableIndex.get(a) ?? 0) - (stableIndex.get(b) ?? 0);
  });

  return picked.map((p) => {
    const scope = p.doc.scope;
    const item: ExpandedItem = {
      path: p.doc.path,
      id: p.doc.id,
      docType: p.doc.docType,
      mimeType: p.doc.mimeType,
      sizeBytes: p.doc.sizeBytes,
      updatedAt: p.doc.updatedAt,
      via: { kind: 'link', direction: p.direction, from: p.from },
      ...(p.doc.preview !== undefined ? { preview: p.doc.preview } : {}),
      ...(scope['spaceId'] !== undefined ? { spaceId: scope['spaceId'] } : {}),
      ...(scope['userId'] !== undefined ? { userId: scope['userId'] } : {}),
      ...(scope['agentId'] !== undefined ? { agentId: scope['agentId'] } : {}),
      ...(scope['sessionId'] !== undefined ? { sessionId: scope['sessionId'] } : {}),
    };
    return item;
  });
}
