import { randomUUID } from 'node:crypto';
import type { PlanNode, PlanNodeSummary } from '@aflow/schemas';
import { planNoteHead, type PlanNodeStore } from '../plan/store.js';

/**
 * `PlanNodeStore` in memory, with the one property the engine leans on kept
 * exact: `updateAtRevision` writes only while the node is still at the
 * expected revision, as the SQL `WHERE revision = $expected` does.
 */
export class InMemoryPlanNodeStore implements PlanNodeStore {
  readonly nodes = new Map<string, PlanNode>();
  private clock = Date.parse('2026-10-04T09:00:00.000Z');

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
  ) => {
    const node = this.nodes.get(nodeId);
    if (!node || node.spaceId !== spaceId || node.revision !== expectedRevision) {
      return Promise.resolve(null);
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
    return Promise.resolve(structuredClone(next));
  };

  nextPosition: PlanNodeStore['nextPosition'] = (spaceId, parentId) => {
    const siblings = this.inSpace(spaceId).filter((n) => n.parentId === parentId);
    return Promise.resolve(
      siblings.length === 0 ? 0 : Math.max(...siblings.map((n) => n.position)) + 1,
    );
  };

  listChildren: PlanNodeStore['listChildren'] = (spaceId, parentId, limit) => {
    const children = this.inSpace(spaceId)
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.position - b.position);
    return Promise.resolve({
      children: children.slice(0, limit).map((n) => this.summary(n)),
      total: children.length,
    });
  };

  scan: PlanNodeStore['scan'] = (spaceId, opts) => {
    const statuses = opts.statuses;
    return Promise.resolve(
      this.inSpace(spaceId)
        .filter((n) => statuses === undefined || statuses.includes(n.status))
        .slice(0, opts.limit)
        .map((n) => this.summary(n)),
    );
  };
}
