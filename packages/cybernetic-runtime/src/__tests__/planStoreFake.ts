import { randomUUID } from 'node:crypto';
import {
  PLAN_NODE_POSITION_MAX,
  PLAN_REVIEW_WORKFLOW_SLUGS,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  type CoachLearning,
  type PlanNode,
  type PlanNodeDependency,
  type PlanNodeDependencyView,
  type PlanNodeLink,
  type PlanNodeRun,
  type PlanNodeSummary,
} from '@aflow/schemas';
import { checkDependency } from '../plan/dependencies.js';
import { placeAmongSiblings } from '../plan/placement.js';
import {
  PLAN_LEARNING_READ_STATUSES,
  PLAN_NODE_RUN_STATUSES,
  planDependencyView,
  planBoardNoteHead,
  planGoalHead,
  planNoteHead,
  type PlanDependencyWrite,
  type PlanNodeInsert,
  type PlanNodeLinkTally,
  type PlanNodeNewestPullRequest,
  type PlanNodeMove,
  type PlanNodePatch,
  type PlanNodePlaceWrite,
  type PlanNodeStore,
  type PlanTreeWalkOptions,
} from '../plan/store.js';
import type {
  PlanOverviewNode,
  PlanOverviewRead,
  PlanOverviewRootCount,
} from '../plan/overviewReads.js';
import {
  bySiblingOrder,
  checkPlacement,
  walkPlanTree,
  type PlacementReads,
  type PlanTreeLevel,
  type PlanTreeWalk,
  type PlanTreeWalkBounds,
} from '../plan/tree.js';

/**
 * `PlanNodeStore` in memory, with the two properties the engine leans on kept
 * exact: a write lands only while the node is still at the expected revision,
 * as the SQL `WHERE revision = $expected` does; and creates and moves run one
 * at a time, as the row locks on their paths make two that cross each other do.
 */
export class InMemoryPlanNodeStore implements PlanNodeStore {
  readonly nodes = new Map<string, PlanNode>();
  readonly links: PlanNodeLink[] = [];
  /** Runs as `workflow_runs` holds them, for the reads that join a node to its runs. */
  readonly runs: FakeRun[] = [];
  readonly dependencies: PlanNodeDependency[] = [];
  /** `coach_learnings` rows of `plan` scope, with the space each was written in. */
  readonly learnings: Array<{ spaceId: string; learning: CoachLearning }> = [];
  /** `plan_nodes.opened_at`: when a person last opened each node, as the open write stamps it. */
  readonly openedAt = new Map<string, Date>();
  private clock = Date.parse('2026-10-04T09:00:00.000Z');
  private placements: Promise<unknown> = Promise.resolve();

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private summary(node: PlanNode): PlanNodeSummary {
    const noteHead = planNoteHead(node.note);
    return {
      nodeId: node.nodeId,
      parentId: node.parentId,
      kind: node.kind,
      title: node.title,
      status: node.status,
      revision: node.revision,
      position: node.position,
      ...(noteHead !== undefined ? { noteHead } : {}),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      ...(node.closedAt !== undefined ? { closedAt: node.closedAt } : {}),
    };
  }

  private inSpace(spaceId: string): PlanNode[] {
    return [...this.nodes.values()].filter((n) => n.spaceId === spaceId);
  }

  private placementReads(spaceId: string): PlacementReads {
    return {
      parentOf: (id) => {
        const node = this.nodes.get(id);
        return Promise.resolve(node && node.spaceId === spaceId ? node.parentId : undefined);
      },
      heightBelow: (nodeId, maxHeight) => {
        let height = 0;
        let level = [nodeId];
        while (height < maxHeight) {
          const ids = new Set(level);
          level = this.inSpace(spaceId)
            .filter((n) => n.parentId !== null && ids.has(n.parentId))
            .map((n) => n.nodeId);
          if (level.length === 0) break;
          height++;
        }
        return Promise.resolve(height);
      },
    };
  }

  /** Writes rows as given, past every rule: the shape of data no engine write leaves. */
  seed(spaceId: string, values: Partial<PlanNode> & Pick<PlanNode, 'title'>): PlanNode {
    const at = this.tick();
    const node: PlanNode = {
      nodeId: randomUUID(),
      spaceId,
      parentId: null,
      kind: 'execute',
      goal: 'Seeded.',
      criteria: 'Seeded.',
      status: 'active',
      revision: 1,
      position: 0,
      createdAt: at,
      updatedAt: at,
      ...values,
    };
    this.nodes.set(node.nodeId, node);
    return structuredClone(node);
  }

  insert: PlanNodeStore['insert'] = (spaceId, values) =>
    this.oneAtATime(async (): Promise<PlanNodeInsert> => {
      if (values.parentId !== null) {
        const check = await checkPlacement(
          values.parentId,
          null,
          this.placementReads(spaceId),
          PLAN_TREE_DEPTH_LIMIT,
        );
        if (check.outcome !== 'clear') return check;
      }
      const node = this.seed(spaceId, {
        parentId: values.parentId,
        kind: values.kind,
        title: values.title,
        goal: values.goal,
        criteria: values.criteria,
        ...(values.note !== null ? { note: values.note } : {}),
        position: values.position ?? this.positionAfterLast(spaceId, values.parentId),
        ...(values.createdBy !== null ? { createdBy: values.createdBy } : {}),
        ...(values.status !== undefined ? { status: values.status } : {}),
      });
      return { outcome: 'inserted', node };
    });

  find: PlanNodeStore['find'] = (spaceId, nodeId) => {
    const node = this.nodes.get(nodeId);
    return Promise.resolve(node && node.spaceId === spaceId ? structuredClone(node) : null);
  };

  updateAtRevision: PlanNodeStore['updateAtRevision'] = (
    spaceId,
    nodeId,
    expectedRevision,
    patch,
  ) => Promise.resolve(this.write(spaceId, nodeId, expectedRevision, patch));

  moveAtRevision: PlanNodeStore['moveAtRevision'] = (
    spaceId,
    nodeId,
    expectedRevision,
    parentId,
    patch,
  ) => this.oneAtATime(() => this.moveNow(spaceId, nodeId, expectedRevision, parentId, patch));

  /** Positions written by a renumbering, which moves no revision: what a test reads to prove it. */
  readonly renumbered: Array<{ nodeId: string; position: number }> = [];

  placeAtRevision: PlanNodeStore['placeAtRevision'] = (spaceId, nodeId, expectedRevision, anchor) =>
    this.oneAtATime((): Promise<PlanNodePlaceWrite> => {
      const node = this.nodes.get(nodeId);
      if (!node || node.spaceId !== spaceId) return Promise.resolve({ outcome: 'not_found' });
      if (node.revision !== expectedRevision) {
        return Promise.resolve({ outcome: 'stale', node: structuredClone(node) });
      }
      const siblings = this.inSpace(spaceId)
        .filter((n) => n.parentId === node.parentId)
        .map((n) => this.summary(n))
        .sort(bySiblingOrder);
      const placement = placeAmongSiblings(siblings, nodeId, anchor);
      if (placement.outcome === 'not_sibling') {
        return Promise.resolve({
          outcome: 'not_sibling',
          siblings: siblings.map(({ nodeId: id, title, status, position }) => ({
            nodeId: id,
            title,
            status,
            position,
          })),
        });
      }
      if (placement.outcome === 'unchanged') {
        return Promise.resolve({ outcome: 'unchanged', node: structuredClone(node) });
      }
      for (const [id, position] of placement.renumbered) {
        const sibling = this.nodes.get(id)!;
        this.nodes.set(id, { ...sibling, position });
        this.renumbered.push({ nodeId: id, position });
      }
      const placed = this.write(spaceId, nodeId, expectedRevision, {
        position: placement.position,
      });
      return Promise.resolve({ outcome: 'placed', node: placed! });
    });

  private oneAtATime<T>(write: () => Promise<T>): Promise<T> {
    const done = this.placements.then(write);
    this.placements = done.catch(() => undefined);
    return done;
  }

  private async moveNow(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    parentId: string | null,
    patch: PlanNodePatch,
  ): Promise<PlanNodeMove> {
    if (parentId !== null) {
      const node = this.nodes.get(nodeId);
      if (!node || node.spaceId !== spaceId) return { outcome: 'stale' };
      const check = await checkPlacement(
        parentId,
        nodeId,
        this.placementReads(spaceId),
        PLAN_TREE_DEPTH_LIMIT,
      );
      if (check.outcome !== 'clear') return check;
    }
    const position = patch.position ?? this.positionAfterLast(spaceId, parentId);
    const node = this.write(spaceId, nodeId, expectedRevision, { ...patch, parentId, position });
    return node ? { outcome: 'moved', node } : { outcome: 'stale' };
  }

  private write(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    patch: PlanNodePatch & { parentId?: string | null },
  ): PlanNode | null {
    const node = this.nodes.get(nodeId);
    if (!node || node.spaceId !== spaceId || node.revision !== expectedRevision) {
      return null;
    }
    const { note, outcome, closedAt, openedAt, ...rest } = patch;
    const next: PlanNode = {
      ...node,
      ...rest,
      revision: node.revision + 1,
      updatedAt: this.tick(),
    };
    if (note !== undefined) {
      if (note === null) delete next.note;
      else next.note = note;
    }
    if (outcome !== undefined) {
      if (outcome === null) delete next.outcome;
      else next.outcome = outcome;
    }
    if (closedAt !== undefined) {
      if (closedAt === null) delete next.closedAt;
      else next.closedAt = closedAt.toISOString();
    }
    if (openedAt !== undefined) this.openedAt.set(nodeId, openedAt);
    this.nodes.set(nodeId, next);
    return structuredClone(next);
  }

  private positionAfterLast(spaceId: string, parentId: string | null): number {
    const siblings = this.inSpace(spaceId).filter((n) => n.parentId === parentId);
    return siblings.length === 0
      ? 0
      : Math.min(Math.max(...siblings.map((n) => n.position)) + 1, PLAN_NODE_POSITION_MAX);
  }

  listChildren: PlanNodeStore['listChildren'] = (spaceId, parentId, limit, offset = 0) => {
    const children = this.inSpace(spaceId)
      .filter((n) => n.parentId === parentId)
      .map((n) => this.summary(n))
      .sort(bySiblingOrder);
    return Promise.resolve({
      children: children.slice(offset, offset + limit),
      total: children.length,
    });
  };

  walk: PlanNodeStore['walk'] = (spaceId, opts) => this.walkOf(this.inSpace(spaceId), opts);

  /** Calls of `readOverview`, as one snapshot each. */
  overviewReads = 0;
  /** The lookups each `readOverview` made in its snapshot, in call order. */
  overviewLookups: Array<{ pullRequestsOf: readonly string[]; runsOf: readonly string[] }> = [];
  /** Runs once `readOverview` has walked, before its lookups: a run's change its snapshot must not see. */
  afterOverviewWalk: (() => void) | undefined;

  readOverview: PlanNodeStore['readOverview'] = async (spaceId, bounds, place) => {
    this.overviewReads++;
    // The snapshot: the lookups read the runs as they stood at the walk.
    const runsThen = structuredClone(this.runs);
    const read = this.overviewOf(spaceId, bounds);
    this.afterOverviewWalk?.();
    const { placed, pullRequestsOf, runsOf, runsPerNode } = place(read);
    this.overviewLookups.push({ pullRequestsOf, runsOf });
    return {
      read,
      placed,
      pullRequests: await this.newestPullRequestsOf(spaceId, pullRequestsOf),
      runs: runsInFlightAmong(runsThen, spaceId, runsOf, runsPerNode),
    };
  };

  private overviewOf(spaceId: string, bounds: PlanTreeWalkBounds): PlanOverviewRead {
    const nodes = this.inSpace(spaceId);
    const childrenOf = new Map<string, PlanNode[]>();
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(node);
      childrenOf.set(node.parentId, siblings);
    }
    for (const siblings of childrenOf.values()) siblings.sort(bySiblingOrder);
    const closed = (node: PlanNode) => node.status === 'done' || node.status === 'dropped';
    const inFlight = (nodeId: string) =>
      this.runs.filter(
        (r) =>
          r.spaceId === spaceId &&
          r.nodeId === nodeId &&
          (PLAN_NODE_RUN_STATUSES as readonly string[]).includes(r.status),
      ).length;
    interface Reached {
      node: PlanNode;
      rootId: string;
      depth: number;
      openParentId: string | null;
      closedAncestor: PlanNode | undefined;
      phase: PlanNode | undefined;
      /** Where the node sorts as the SQL's paths do: parents first, siblings by position. */
      path: string[];
    }
    const pathKey = (node: PlanNode) => `${String(node.position).padStart(10, '0')}:${node.nodeId}`;
    const byPath = (a: Reached, b: Reached) => {
      const [x, y] = [a.path.join('/'), b.path.join('/')];
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const below = (at: Reached) =>
      (childrenOf.get(at.node.nodeId) ?? []).map((child): Reached => ({
        node: child,
        rootId: at.rootId,
        depth: at.depth + 1,
        openParentId: closed(at.node) ? at.openParentId : at.node.nodeId,
        closedAncestor: closed(at.node) ? at.node : at.closedAncestor,
        phase: at.depth === 1 ? at.node : at.phase,
        path: [...at.path, pathKey(child)],
      }));
    const roots = nodes.filter((n) => n.parentId === null).sort(bySiblingOrder);
    const asRoot = (root: PlanNode): Reached => ({
      node: root,
      rootId: root.nodeId,
      depth: 0,
      openParentId: null,
      closedAncestor: undefined,
      phase: undefined,
      path: [pathKey(root)],
    });
    // A level at a time, as the recursion yields them: the open nodes in
    // reading order, stopped one past the bound, and beside them the closed
    // steps something lies under, which spend nothing. A closed leaf is only
    // ever counted.
    const reached: Reached[] = [];
    let opened = 0;
    let level: Reached[] = roots
      .filter((root) => !closed(root))
      .slice(0, bounds.maxNodes + 1)
      .map(asRoot);
    for (;;) {
      reached.push(...level);
      opened += level.filter((at) => !closed(at.node)).length;
      const depth = level[0]?.depth;
      if (depth === undefined || depth >= bounds.maxDepth || opened > bounds.maxNodes) break;
      const next = level.flatMap(below);
      level = [
        ...next
          .filter((at) => !closed(at.node))
          .sort(byPath)
          .slice(0, bounds.maxNodes + 1 - opened),
        ...next.filter((at) => closed(at.node) && childrenOf.has(at.node.nodeId)),
      ].sort(byPath);
    }
    const walkCut = opened > bounds.maxNodes;
    const overBound = new Set(
      reached
        .filter((at) => !closed(at.node))
        .slice(bounds.maxNodes)
        .map((at) => at.node.nodeId),
    );
    const walked = reached.filter((at) => !overBound.has(at.node.nodeId));
    const lastDepth = Math.max(...walked.map((at) => at.depth));
    const closedRoots = roots.filter(closed).slice(0, bounds.maxNodes).map(asRoot);

    const counted = new Map<string, PlanOverviewRootCount>();
    for (const at of [...walked, ...closedRoots]) {
      const count = counted.get(at.rootId) ?? { done: 0, dropped: 0, deeper: false, cut: false };
      counted.set(at.rootId, count);
      if (at.depth === 0 && closed(at.node)) continue;
      if (walkCut && at.depth >= lastDepth - 1) count.cut = true;
      if (at.depth === bounds.maxDepth && childrenOf.has(at.node.nodeId)) count.deeper = true;
      if (at.depth >= bounds.maxDepth) continue;
      for (const child of childrenOf.get(at.node.nodeId) ?? []) {
        if (!closed(child)) continue;
        if (child.status === 'done') count.done++;
        else count.dropped++;
        if (
          count.closedWrittenAt === undefined ||
          child.updatedAt.localeCompare(count.closedWrittenAt) > 0
        ) {
          count.closedWrittenAt = child.updatedAt;
        }
      }
    }
    const shipped = [...walked.filter((at) => !closed(at.node)), ...closedRoots]
      .sort(byPath)
      .map((at, i) => ({ at, walkOrder: i + 1 }))
      .sort((a, b) => a.at.depth - b.at.depth || a.walkOrder - b.walkOrder);
    const rows = shipped.map(({ at, walkOrder }): PlanOverviewNode => {
      const noteHead = planBoardNoteHead(at.node.note);
      const { noteHead: _summaryNoteHead, ...summary } = this.summary(at.node);
      return {
        ...summary,
        ...(noteHead !== undefined ? { noteHead } : {}),
        rootId: at.rootId,
        depth: at.depth,
        walkOrder,
        openParentId: at.openParentId,
        ...(at.closedAncestor !== undefined
          ? {
              closedAncestor: {
                nodeId: at.closedAncestor.nodeId,
                title: at.closedAncestor.title,
              },
            }
          : {}),
        ...(at.phase !== undefined ? { phaseTitle: at.phase.title } : {}),
        inFlightRuns: closed(at.node) ? 0 : inFlight(at.node.nodeId),
      };
    });
    const returnedRoots = new Set(rows.filter((r) => r.depth === 0).map((r) => r.nodeId));
    return {
      nodes: rows,
      counted: new Map([...counted].filter(([rootId]) => returnedRoots.has(rootId))),
      rootsTotal: nodes.filter((n) => n.parentId === null).length,
      ...(walkCut
        ? {
            truncated: { bound: 'nodes' as const, value: bounds.maxNodes },
            frontierDepth: lastDepth,
          }
        : {}),
    };
  }

  private walkOf(nodes: readonly PlanNode[], opts: PlanTreeWalkOptions): Promise<PlanTreeWalk> {
    const statuses = opts.statuses;
    const inLevel = (node: PlanNode, level: PlanTreeLevel): boolean => {
      switch (level.kind) {
        case 'roots':
          return node.parentId === null;
        case 'node':
          return node.nodeId === level.nodeId;
        case 'children':
          return node.parentId !== null && level.parentIds.includes(node.parentId);
      }
    };
    const ofStatus = (node: PlanNode, level: PlanTreeLevel): boolean =>
      level.kind === 'node' || statuses === undefined || statuses.includes(node.status);
    return walkPlanTree(
      (level, limit) =>
        Promise.resolve(
          nodes
            .filter((n) => inLevel(n, level))
            .filter((n) => ofStatus(n, level))
            .map((n) => this.summary(n))
            .sort(bySiblingOrder)
            .slice(0, limit),
        ),
      opts.rootId !== undefined ? { rootId: opts.rootId } : {},
      opts,
    );
  }

  parentsOf: PlanNodeStore['parentsOf'] = (spaceId, nodeIds) =>
    Promise.resolve(
      new Map(
        this.inSpace(spaceId)
          .filter((n) => nodeIds.includes(n.nodeId))
          .map((n) => [n.nodeId, n.parentId]),
      ),
    );

  closedAncestorOf: PlanNodeStore['closedAncestorOf'] = (spaceId, nodeId) => {
    const node = this.nodes.get(nodeId);
    let parentId = node !== undefined && node.spaceId === spaceId ? node.parentId : null;
    for (let height = 1; parentId !== null && height <= PLAN_TREE_DEPTH_LIMIT + 1; height++) {
      const above = this.nodes.get(parentId);
      if (above === undefined || above.spaceId !== spaceId) break;
      if (above.status === 'done' || above.status === 'dropped') {
        return Promise.resolve({ nodeId: above.nodeId, title: above.title });
      }
      parentId = above.parentId;
    }
    return Promise.resolve(null);
  };

  insertLink: PlanNodeStore['insertLink'] = (spaceId, link) => {
    const node = this.nodes.get(link.nodeId);
    if (!node || node.spaceId !== spaceId) return Promise.resolve({ outcome: 'node_not_found' });
    const held = this.links.find(
      (l) => l.nodeId === link.nodeId && l.kind === link.kind && l.ref === link.ref,
    );
    if (held) return Promise.resolve({ outcome: 'exists', link: structuredClone(held) });
    const inserted: PlanNodeLink = {
      nodeId: link.nodeId,
      kind: link.kind,
      ref: link.ref,
      ...(link.label !== null ? { label: link.label } : {}),
      createdAt: this.tick(),
    };
    this.links.push(inserted);
    return Promise.resolve({
      outcome: 'inserted',
      link: structuredClone(inserted),
      revision: node.revision,
    });
  };

  newestLink: PlanNodeStore['newestLink'] = (spaceId, nodeId, kind) => {
    const links = this.links
      .filter(
        (l) =>
          l.nodeId === nodeId && l.kind === kind && this.nodes.get(l.nodeId)?.spaceId === spaceId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve(links[0] ? structuredClone(links[0]) : null);
  };

  findLink: PlanNodeStore['findLink'] = (spaceId, nodeId, kind, ref) => {
    const link = this.links.find(
      (l) =>
        l.nodeId === nodeId &&
        l.kind === kind &&
        l.ref === ref &&
        this.nodes.get(l.nodeId)?.spaceId === spaceId,
    );
    return Promise.resolve(link ? structuredClone(link) : null);
  };

  private linksOf(spaceId: string, nodeId: string): PlanNodeLink[] {
    return this.links.filter(
      (l) => l.nodeId === nodeId && this.nodes.get(l.nodeId)?.spaceId === spaceId,
    );
  }

  pageLinks: PlanNodeStore['pageLinks'] = (spaceId, nodeId, page) => {
    // The SQL's order: newest first, then kind, then ref.
    const key = (l: PlanNodeLink): [number, string, string] => [
      -Date.parse(l.createdAt),
      l.kind,
      l.ref,
    ];
    const compare = (a: [number, string, string], b: [number, string, string]): number => {
      for (let i = 0; i < 3; i++) {
        if (a[i]! < b[i]!) return -1;
        if (a[i]! > b[i]!) return 1;
      }
      return 0;
    };
    const ofKind = this.linksOf(spaceId, nodeId)
      .filter((l) => page.kind === undefined || l.kind === page.kind)
      .sort((a, b) => compare(key(a), key(b)));
    const after = page.after;
    const rest =
      after === undefined
        ? ofKind
        : ofKind.filter((l) => compare(key(l), [-Date.parse(after.at), after.kind, after.ref]) > 0);
    const shown = rest.slice(0, page.limit);
    const last = shown.at(-1);
    return Promise.resolve({
      links: structuredClone(shown),
      total: ofKind.length,
      ...(rest.length > page.limit && last !== undefined
        ? { next: { at: last.createdAt, kind: last.kind, ref: last.ref } }
        : {}),
    });
  };

  boardFactsOf: PlanNodeStore['boardFactsOf'] = (spaceId, nodeIds) =>
    Promise.resolve(
      new Map(
        this.inSpace(spaceId)
          .filter((n) => nodeIds.includes(n.nodeId))
          .map((n) => {
            const noteHead = planBoardNoteHead(n.note);
            return [
              n.nodeId,
              {
                createdAt: n.createdAt,
                ...(n.closedAt !== undefined ? { closedAt: n.closedAt } : {}),
                goalHead: planGoalHead(n.goal),
                ...(noteHead !== undefined ? { noteHead } : {}),
              },
            ];
          }),
      ),
    );

  linkTalliesOf: PlanNodeStore['linkTalliesOf'] = (spaceId, nodeIds) => {
    const tallies = new Map<string, PlanNodeLinkTally>();
    for (const nodeId of nodeIds) {
      const links = this.linksOf(spaceId, nodeId);
      if (links.length === 0) continue;
      const ofKind = (kind: PlanNodeLink['kind']) => links.filter((l) => l.kind === kind).length;
      tallies.set(nodeId, {
        runs: ofKind('run'),
        pullRequests: ofKind('pull_request'),
        findings: ofKind('finding'),
        documents: ofKind('document'),
        rounds: links.filter(
          (l) =>
            l.kind === 'run' &&
            (PLAN_REVIEW_WORKFLOW_SLUGS as readonly string[]).includes(
              (l.label ?? '').split(' ', 1)[0] ?? '',
            ),
        ).length,
      });
    }
    return Promise.resolve(tallies);
  };

  newestPullRequestsOf: PlanNodeStore['newestPullRequestsOf'] = (spaceId, nodeIds) => {
    const newest = new Map<string, PlanNodeNewestPullRequest>();
    for (const nodeId of nodeIds) {
      const links = this.linksOf(spaceId, nodeId);
      const [pr] = links
        .filter((l) => l.kind === 'pull_request')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.ref.localeCompare(b.ref));
      if (!pr) continue;
      const merge = links.find((l) => l.kind === 'merge' && l.ref === pr.ref);
      newest.set(nodeId, { ref: pr.ref, merge: merge ? structuredClone(merge) : null });
    }
    return Promise.resolve(newest);
  };

  inFlightRunCountsOf: PlanNodeStore['inFlightRunCountsOf'] = (spaceId, nodeIds) => {
    const counts = new Map<string, number>();
    for (const run of this.runs) {
      if (run.spaceId !== spaceId || !nodeIds.includes(run.nodeId)) continue;
      if (!(PLAN_NODE_RUN_STATUSES as readonly string[]).includes(run.status)) continue;
      counts.set(run.nodeId, (counts.get(run.nodeId) ?? 0) + 1);
    }
    return Promise.resolve(counts);
  };

  listRunsServing: PlanNodeStore['listRunsServing'] = (spaceId, nodeIds, limit, rootId) => {
    const belongs = (nodeId: string): boolean => {
      if (rootId === undefined) return nodeIds.includes(nodeId);
      const seen = new Set<string>();
      let node = this.nodes.get(nodeId);
      while (node && !seen.has(node.nodeId)) {
        if (node.nodeId === rootId) return true;
        seen.add(node.nodeId);
        node = node.parentId ? this.nodes.get(node.parentId) : undefined;
      }
      return false;
    };
    const runs = this.runs
      .filter(
        (r) =>
          r.spaceId === spaceId &&
          belongs(r.nodeId) &&
          (PLAN_NODE_RUN_STATUSES as readonly string[]).includes(r.status),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ spaceId: _spaceId, ...run }) => run as PlanNodeRun);
    return Promise.resolve({ runs: runs.slice(0, limit), total: runs.length });
  };

  setDependencyAtRevision: PlanNodeStore['setDependencyAtRevision'] = (
    spaceId,
    nodeId,
    expectedRevision,
    dependsOnId,
    condition,
  ) =>
    this.oneAtATime(async (): Promise<PlanDependencyWrite> => {
      const node = this.nodes.get(nodeId);
      if (node?.spaceId !== spaceId || node.revision !== expectedRevision) {
        return { outcome: 'stale' };
      }
      const at = this.dependencies.findIndex(
        (d) => d.nodeId === nodeId && d.dependsOnId === dependsOnId,
      );
      if (condition === null) {
        if (at !== -1) this.dependencies.splice(at, 1);
        const written = this.write(spaceId, nodeId, expectedRevision, {});
        return written ? { outcome: 'written', node: written } : { outcome: 'stale' };
      }
      const check = await checkDependency(
        nodeId,
        dependsOnId,
        {
          dependenciesOf: (id) =>
            Promise.resolve(
              this.nodes.get(id)?.spaceId === spaceId
                ? this.dependencies.filter((d) => d.nodeId === id).map((d) => d.dependsOnId)
                : undefined,
            ),
        },
        PLAN_TREE_WALK_NODE_LIMIT,
      );
      if (check.outcome !== 'clear') return check;
      const dependency: PlanNodeDependency =
        at !== -1
          ? { ...this.dependencies[at]!, condition }
          : { nodeId, dependsOnId, condition, createdAt: this.tick() };
      if (at !== -1) this.dependencies[at] = dependency;
      else this.dependencies.push(dependency);
      const written = this.write(spaceId, nodeId, expectedRevision, {});
      return written
        ? { outcome: 'written', node: written, dependency: structuredClone(dependency) }
        : { outcome: 'stale' };
    });

  findDependency: PlanNodeStore['findDependency'] = (spaceId, nodeId, dependsOnId) => {
    const held = this.dependencies.find(
      (d) =>
        d.nodeId === nodeId &&
        d.dependsOnId === dependsOnId &&
        this.nodes.get(nodeId)?.spaceId === spaceId,
    );
    return Promise.resolve(held ? structuredClone(held) : null);
  };

  private dependencyEnds(
    spaceId: string,
    nodeId: string,
    end: 'nodeId' | 'dependsOnId',
  ): PlanNodeDependencyView[] {
    const other = end === 'nodeId' ? 'dependsOnId' : 'nodeId';
    return this.dependencies
      .filter((d) => d[end] === nodeId && this.nodes.get(nodeId)?.spaceId === spaceId)
      .flatMap((d) => {
        const shown = this.nodes.get(d[other]);
        const dependency = this.nodes.get(d.dependsOnId);
        return shown && dependency
          ? [planDependencyView(shown, d.condition, dependency.status)]
          : [];
      })
      .sort((a, b) => a.title.localeCompare(b.title) || a.nodeId.localeCompare(b.nodeId));
  }

  listDependencies: PlanNodeStore['listDependencies'] = (spaceId, nodeId, limit) => {
    const dependencies = this.dependencyEnds(spaceId, nodeId, 'nodeId');
    return Promise.resolve({
      dependencies: dependencies.slice(0, limit),
      total: dependencies.length,
    });
  };

  listDependents: PlanNodeStore['listDependents'] = (spaceId, nodeId, limit) => {
    const dependents = this.dependencyEnds(spaceId, nodeId, 'dependsOnId');
    return Promise.resolve({ dependents: dependents.slice(0, limit), total: dependents.length });
  };

  private learningsReadOn(spaceId: string, nodeIds: readonly string[]): CoachLearning[] {
    return this.learnings
      .filter(
        (l) =>
          l.spaceId === spaceId &&
          l.learning.scope.kind === 'plan' &&
          nodeIds.includes(l.learning.scope.planNodeId) &&
          PLAN_LEARNING_READ_STATUSES.includes(l.learning.status),
      )
      .map((l) => l.learning);
  }

  insertLearning: PlanNodeStore['insertLearning'] = (spaceId, learning) => {
    if (learning.scope.kind !== 'plan') throw new Error('plan-scope learnings only');
    const nodeId = learning.scope.planNodeId;
    if (this.nodes.get(nodeId)?.spaceId !== spaceId) {
      return Promise.resolve({ outcome: 'node_not_found' });
    }
    const readable = new Set(this.learningsReadOn(spaceId, [nodeId]).map((l) => l.learningId));
    const missing = learning.supersedes.filter((id) => !readable.has(id));
    if (missing.length > 0) {
      return Promise.resolve({ outcome: 'supersedes_unknown', learningIds: missing });
    }
    for (const held of this.learnings) {
      if (learning.supersedes.includes(held.learning.learningId)) {
        held.learning = { ...held.learning, status: 'superseded' };
      }
    }
    // The store's clock, so newest-first holds between writes of one test.
    const stored = { ...structuredClone(learning), createdAt: this.tick() };
    this.learnings.push({ spaceId, learning: stored });
    return Promise.resolve({ outcome: 'inserted', learning: structuredClone(stored) });
  };

  listLearningsOf: PlanNodeStore['listLearningsOf'] = (spaceId, nodeIds, limit) => {
    const learnings = this.learningsReadOn(spaceId, nodeIds).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.learningId.localeCompare(a.learningId),
    );
    return Promise.resolve({
      learnings: structuredClone(learnings.slice(0, limit)),
      total: learnings.length,
    });
  };
}

type FakeRun = Omit<PlanNodeRun, 'status'> & { spaceId: string; status: string };

/** The running and paused runs among `runs` serving each of `nodeIds` itself, newest first, at most `perNode` each. */
function runsInFlightAmong(
  runs: readonly FakeRun[],
  spaceId: string,
  nodeIds: readonly string[],
  perNode: number,
): Map<string, PlanNodeRun[]> {
  const held = new Map<string, PlanNodeRun[]>();
  const inFlight = runs
    .filter(
      (r) =>
        r.spaceId === spaceId &&
        nodeIds.includes(r.nodeId) &&
        (PLAN_NODE_RUN_STATUSES as readonly string[]).includes(r.status),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId));
  for (const { spaceId: _spaceId, ...run } of inFlight) {
    const onIt = held.get(run.nodeId) ?? [];
    if (onIt.length < perNode) onIt.push(run as PlanNodeRun);
    held.set(run.nodeId, onIt);
  }
  return held;
}
