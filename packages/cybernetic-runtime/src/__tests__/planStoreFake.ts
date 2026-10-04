import { randomUUID } from 'node:crypto';
import { PLAN_TREE_DEPTH_LIMIT, type PlanNode, type PlanNodeSummary } from '@aflow/schemas';
import {
  planNoteHead,
  type PlanNodeMove,
  type PlanNodePatch,
  type PlanNodeStore,
} from '../plan/store.js';
import { bySiblingOrder, checkNewParent, walkPlanTree, type PlanTreeLevel } from '../plan/tree.js';

/**
 * `PlanNodeStore` in memory, with the two properties the engine leans on kept
 * exact: a write lands only while the node is still at the expected revision,
 * as the SQL `WHERE revision = $expected` does; and moves run one at a time,
 * as the row locks on a move's path make two moves that cross each other do.
 */
export class InMemoryPlanNodeStore implements PlanNodeStore {
  readonly nodes = new Map<string, PlanNode>();
  private clock = Date.parse('2026-10-04T09:00:00.000Z');
  private moves: Promise<unknown> = Promise.resolve();

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

  insert: PlanNodeStore['insert'] = (spaceId, values) => {
    const at = this.tick();
    const node: PlanNode = {
      nodeId: randomUUID(),
      spaceId,
      parentId: values.parentId,
      kind: values.kind,
      title: values.title,
      goal: values.goal,
      criteria: values.criteria,
      status: 'active',
      ...(values.note !== null ? { note: values.note } : {}),
      revision: 1,
      position: values.position,
      ...(values.createdBy !== null ? { createdBy: values.createdBy } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.nodes.set(node.nodeId, node);
    return Promise.resolve(structuredClone(node));
  };

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
  ) => {
    const move = this.moves.then(() =>
      this.moveNow(spaceId, nodeId, expectedRevision, parentId, patch),
    );
    this.moves = move.catch(() => undefined);
    return move;
  };

  private async moveNow(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    parentId: string | null,
    patch: PlanNodePatch,
  ): Promise<PlanNodeMove> {
    if (parentId !== null) {
      const check = await checkNewParent(
        nodeId,
        parentId,
        (id) => {
          const node = this.nodes.get(id);
          return Promise.resolve(node && node.spaceId === spaceId ? node.parentId : undefined);
        },
        PLAN_TREE_DEPTH_LIMIT,
      );
      if (check !== 'clear') return { outcome: check };
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
    const { note, closedAt, ...rest } = patch;
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
      siblings.length === 0 ? 0 : Math.max(...siblings.map((n) => n.position)) + 1,
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
