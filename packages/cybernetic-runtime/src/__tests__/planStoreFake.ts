import { randomUUID } from 'node:crypto';
import {
  PLAN_NODE_POSITION_MAX,
  PLAN_REVIEW_WORKFLOW_SLUGS,
  PLAN_TREE_DEPTH_LIMIT,
  type PlanNode,
  type PlanNodeLink,
  type PlanNodeRun,
  type PlanNodeSummary,
} from '@aflow/schemas';
import {
  PLAN_NODE_RUN_STATUSES,
  planGoalHead,
  planNoteHead,
  type PlanNodeInsert,
  type PlanNodeLinkTally,
  type PlanNodeNewestPullRequest,
  type PlanNodeMove,
  type PlanNodePatch,
  type PlanNodeStore,
} from '../plan/store.js';
import {
  bySiblingOrder,
  checkPlacement,
  walkPlanTree,
  type PlacementReads,
  type PlanTreeLevel,
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
  readonly runs: Array<Omit<PlanNodeRun, 'status'> & { spaceId: string; status: string }> = [];
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
      updatedAt: node.updatedAt,
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
        position: values.position,
        ...(values.createdBy !== null ? { createdBy: values.createdBy } : {}),
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
    const position = patch.position ?? (await this.nextPosition(spaceId, parentId));
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
    const { note, outcome, closedAt, ...rest } = patch;
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
    this.nodes.set(nodeId, next);
    return structuredClone(next);
  }

  nextPosition: PlanNodeStore['nextPosition'] = (spaceId, parentId) => {
    const siblings = this.inSpace(spaceId).filter((n) => n.parentId === parentId);
    return Promise.resolve(
      siblings.length === 0
        ? 0
        : Math.min(Math.max(...siblings.map((n) => n.position)) + 1, PLAN_NODE_POSITION_MAX),
    );
  };

  listChildren: PlanNodeStore['listChildren'] = (spaceId, parentId, limit) => {
    const children = this.inSpace(spaceId)
      .filter((n) => n.parentId === parentId)
      .map((n) => this.summary(n))
      .sort(bySiblingOrder);
    return Promise.resolve({ children: children.slice(0, limit), total: children.length });
  };

  walk: PlanNodeStore['walk'] = (spaceId, opts) => {
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
          this.inSpace(spaceId)
            .filter((n) => inLevel(n, level))
            .filter((n) => ofStatus(n, level))
            .map((n) => this.summary(n))
            .sort(bySiblingOrder)
            .slice(0, limit),
        ),
      opts.rootId !== undefined ? { rootId: opts.rootId } : {},
      opts,
    );
  };

  parentsOf: PlanNodeStore['parentsOf'] = (spaceId, nodeIds) =>
    Promise.resolve(
      new Map(
        this.inSpace(spaceId)
          .filter((n) => nodeIds.includes(n.nodeId))
          .map((n) => [n.nodeId, n.parentId]),
      ),
    );

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
    return Promise.resolve({ outcome: 'inserted', link: structuredClone(inserted) });
  };

  listLinks: PlanNodeStore['listLinks'] = (spaceId, nodeId, limit) => {
    const links = this.links
      .filter((l) => l.nodeId === nodeId && this.nodes.get(l.nodeId)?.spaceId === spaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve({ links: links.slice(0, limit), total: links.length });
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
          .map((n) => [
            n.nodeId,
            {
              createdAt: n.createdAt,
              ...(n.closedAt !== undefined ? { closedAt: n.closedAt } : {}),
              goalHead: planGoalHead(n.goal),
            },
          ]),
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

  listRunsServing: PlanNodeStore['listRunsServing'] = (spaceId, nodeIds, limit) => {
    const runs = this.runs
      .filter(
        (r) =>
          r.spaceId === spaceId &&
          nodeIds.includes(r.nodeId) &&
          (PLAN_NODE_RUN_STATUSES as readonly string[]).includes(r.status),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ spaceId: _spaceId, ...run }) => run as PlanNodeRun);
    return Promise.resolve({ runs: runs.slice(0, limit), total: runs.length });
  };
}
