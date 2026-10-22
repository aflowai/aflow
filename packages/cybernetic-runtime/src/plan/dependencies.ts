/**
 * Dependency edges between plan nodes (Plan 322 P2): the one rule a write of
 * an edge is judged by — it may not close a loop of nodes waiting on each
 * other — kept apart from the SQL so the store and its fake walk alike.
 */

/** What a cycle check reads inside the write's transaction. */
export interface DependencyReads {
  /**
   * The nodes `nodeId` waits on — read after its row is held, so no edge out
   * of it can be written until the check's transaction ends. Undefined where
   * the node is not in the space.
   */
  dependenciesOf(nodeId: string): Promise<readonly string[] | undefined>;
}

export type DependencyCheck =
  | { outcome: 'clear' }
  /** `path` runs from the waiting node through the new edge back to itself. */
  | { outcome: 'cycle'; path: string[] }
  /** The node the edge would wait on is not in the space. */
  | { outcome: 'not_found' }
  /** More than `maxNodes` nodes are reachable, so no answer was read: refused, not guessed. */
  | { outcome: 'walk_limit'; maxNodes: number };

/**
 * Whether `nodeId` waiting on `dependsOnId` closes a loop: whether `nodeId` is
 * reachable from `dependsOnId` along the edges already written. Breadth first,
 * so the loop it names is a shortest one.
 */
export async function checkDependency(
  nodeId: string,
  dependsOnId: string,
  reads: DependencyReads,
  maxNodes: number,
): Promise<DependencyCheck> {
  if (dependsOnId === nodeId) return { outcome: 'cycle', path: [nodeId, nodeId] };
  const cameFrom = new Map<string, string | null>([[dependsOnId, null]]);
  let level = [dependsOnId];
  while (level.length > 0) {
    const next: string[] = [];
    for (const current of level) {
      const edges = await reads.dependenciesOf(current);
      if (edges === undefined) {
        if (current === dependsOnId) return { outcome: 'not_found' };
        continue;
      }
      for (const target of edges) {
        if (target === nodeId) {
          const back: string[] = [];
          for (let at: string | null = current; at !== null; at = cameFrom.get(at) ?? null) {
            back.push(at);
          }
          return { outcome: 'cycle', path: [nodeId, ...back.reverse(), nodeId] };
        }
        if (cameFrom.has(target)) continue;
        if (cameFrom.size >= maxNodes) return { outcome: 'walk_limit', maxNodes };
        cameFrom.set(target, current);
        next.push(target);
      }
    }
    level = next;
  }
  return { outcome: 'clear' };
}
