import { randomUUID } from 'node:crypto';
import {
  PLAN_NODE_POSITION_MAX,
  PLAN_TREE_DEPTH_LIMIT,
  type PlanNode,
  type PlanNodeSummary,
} from '@aflow/schemas';
import {
  planNoteHead,
  type PlanNodeInsert,
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
    return walkPlanTree(
      (level, limit) =>
        Promise.resolve(
          this.inSpace(spaceId)
            .filter((n) => inLevel(n, level))
            .filter((n) => statuses === undefined || statuses.includes(n.status))
            .map((n) => this.summary(n))
            .sort(bySiblingOrder)
            .slice(0, limit),
        ),
      opts.rootId !== undefined ? { rootId: opts.rootId } : {},
      opts,
    );
  };
}
