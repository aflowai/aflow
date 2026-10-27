/**
 * The plan as the operator's board reads it (Plan 322 P3.3): each node with
 * what its card shows — counts in place of its links, the goal's head in place
 * of its prose — and each plan's tallies, counted before a done window leaves
 * anything out. Pure: the store's reads come in, the response goes out.
 */
import {
  PlanNodeLinkKindSchema,
  planBoardCards,
  type PlanDoneDay,
  type PlanNodeSummary,
  type PlanRootTally,
  type PlanTreeNode,
  type PlanTreeOutput,
} from '@aflow/schemas';
import { nestPlanTree, type PlacedPlanNode } from './tree.js';
import { findActiveStreamNode, mergeShaOf } from './stream.js';
import {
  planBoardNoteHead,
  type PlanLinkPageKey,
  type PlanNodeBoardFacts,
  type PlanNodeLinkTally,
  type PlanNodeNewestPullRequest,
} from './store.js';

/** What the store read for the walked nodes, each map keyed by node id. */
export interface PlanBoardReads {
  facts: ReadonlyMap<string, PlanNodeBoardFacts>;
  tallies: ReadonlyMap<string, PlanNodeLinkTally>;
  pullRequests: ReadonlyMap<string, PlanNodeNewestPullRequest>;
  inFlight: ReadonlyMap<string, number>;
}

export interface PlanBoardOptions {
  /** Done nodes closed before this instant leave the tree, unless a node kept sits under one. */
  closedSince?: string;
  /** The IANA time zone `doneByDay` counts days in; UTC when absent. */
  tz?: string;
}

const NO_TALLY: PlanNodeLinkTally = {
  runs: 0,
  pullRequests: 0,
  findings: 0,
  documents: 0,
  rounds: 0,
};

/**
 * Reads the calendar day an instant falls on in `tz`, as `YYYY-MM-DD`. One
 * formatter serves every instant it is asked about: building one is the
 * costly part, and a board reads a day for every done node.
 */
export function planDayReader(tz = 'UTC'): (iso: string) => string {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (iso) => {
    const parts = format.formatToParts(new Date(iso));
    const part = (type: 'year' | 'month' | 'day') =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
}

function boardNode(node: PlanNodeSummary, reads: PlanBoardReads): PlanTreeNode {
  const facts = reads.facts.get(node.nodeId);
  const { rounds, ...links } = reads.tallies.get(node.nodeId) ?? NO_TALLY;
  const inFlightRuns = reads.inFlight.get(node.nodeId) ?? 0;
  const pullRequest = reads.pullRequests.get(node.nodeId);
  const mergeSha = mergeShaOf(pullRequest?.merge?.label);
  // The node's own row, read after the walk, is the newer word on both times:
  // a node reopened between the reads has no `closedAt`, whatever the summary
  // carried. A node the walk read and its row did not was deleted between
  // them, and only its summary's times are left.
  const { closedAt: summaryClosedAt, noteHead: summaryNoteHead, ...summary } = node;
  const closedAt = facts !== undefined ? facts.closedAt : summaryClosedAt;
  const noteHead = facts !== undefined ? facts.noteHead : planBoardNoteHead(summaryNoteHead);
  return {
    ...summary,
    createdAt: facts?.createdAt ?? node.createdAt,
    ...(closedAt !== undefined ? { closedAt } : {}),
    goalHead: facts?.goalHead ?? '',
    ...(noteHead !== undefined ? { noteHead } : {}),
    counts: { ...links, inFlightRuns },
    rounds,
    activity: inFlightRuns > 0 ? 'in_flight' : 'idle',
    ...(pullRequest !== undefined
      ? {
          pullRequest: {
            url: pullRequest.ref,
            merged: pullRequest.merge !== null,
            ...(mergeSha !== undefined ? { mergeSha } : {}),
          },
        }
      : {}),
    children: [],
  };
}

/** A run in flight serves an active node at or under `node`. */
function servesActiveBelow(node: PlanTreeNode): boolean {
  if (node.status === 'active' && node.counts.inFlightRuns > 0) return true;
  return node.children.some(servesActiveBelow);
}

/**
 * A parent's progress and activity are its children's: progress, those done
 * of those not dropped; activity, in flight where a run serves the parent or
 * any active node under it — runs serve the steps under a root or phase,
 * rarely the parent itself. A run still serving a done or dropped child moves
 * no work the parent waits on, so it leaves the parent idle, though that
 * child's own card reads in flight.
 */
function withChildren(node: PlanTreeNode): PlanTreeNode {
  const children = node.children.map(withChildren);
  if (children.length === 0) return { ...node, children };
  const counted = children.filter((child) => child.status !== 'dropped');
  return {
    ...node,
    children,
    activity:
      node.counts.inFlightRuns > 0 || children.some(servesActiveBelow) ? 'in_flight' : 'idle',
    progress: {
      done: counted.filter((child) => child.status === 'done').length,
      total: counted.length,
    },
  };
}

/**
 * The step under `root` the stream walk takes next, read over the same tree
 * the board places: the walk passes over closed nodes itself, so the whole
 * tree is its input. The root is no step, so a walk that stops there names none.
 */
function nextNodeIdOf(root: PlanTreeNode): string | undefined {
  const nodes: PlanTreeNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    stack.push(...node.children);
  }
  const next = findActiveStreamNode(nodes, root.nodeId);
  return next !== null && next.nodeId !== root.nodeId ? next.nodeId : undefined;
}

function tallyOf(root: PlanTreeNode, dayOf: (iso: string) => string): PlanRootTally {
  const counts = { needs_you: 0, in_flight: 0, up_next: 0, done: 0, dropped: 0 };
  const byDay = new Map<string, number>();
  const cards = planBoardCards(root);
  for (const { node, column } of cards) {
    counts[column]++;
    if (column === 'done' && node.closedAt !== undefined) {
      const day = dayOf(node.closedAt);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
  }
  const nextNodeId = nextNodeIdOf(root);
  return {
    rootId: root.nodeId,
    steps: cards.length,
    needsYou: counts.needs_you,
    inFlight: counts.in_flight,
    upNext: counts.up_next,
    done: counts.done,
    dropped: counts.dropped,
    doneByDay: [...byDay]
      .map(([day, count]): PlanDoneDay => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
    ...(nextNodeId !== undefined ? { nextNodeId } : {}),
  };
}

/** A done node closed before `since` leaves, unless a node kept sits under it. */
function prune(nodes: readonly PlanTreeNode[], since: number): PlanTreeNode[] {
  const kept: PlanTreeNode[] = [];
  for (const node of nodes) {
    const children = prune(node.children, since);
    const closedBefore =
      node.status === 'done' && node.closedAt !== undefined && Date.parse(node.closedAt) < since;
    if (!closedBefore || children.length > 0) kept.push({ ...node, children });
  }
  return kept;
}

/**
 * The board from nodes placed in reading order: nested, each with its card's
 * facts and a parent with its progress and activity; each root's tallies over
 * every node under it; then the done window applied below the roots, which
 * always stay — each is a tab.
 */
export function buildPlanBoard(
  placed: readonly PlacedPlanNode[],
  reads: PlanBoardReads,
  opts: PlanBoardOptions = {},
): Omit<PlanTreeOutput, 'truncated'> {
  const full = nestPlanTree(placed, (node) => boardNode(node, reads)).map(withChildren);
  const dayOf = planDayReader(opts.tz);
  const tallies = full.map((root) => tallyOf(root, dayOf));
  const since = opts.closedSince !== undefined ? Date.parse(opts.closedSince) : undefined;
  const roots =
    since === undefined
      ? full
      : full.map((root) => ({ ...root, children: prune(root.children, since) }));
  return { roots, tallies };
}

// ============================================================================
// The node detail's link cursor
// ============================================================================

/** A timestamp as Postgres prints one, or as an ISO string. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** Opaque to the client: where the page before ended. */
export function encodePlanLinkCursor(key: PlanLinkPageKey): string {
  return Buffer.from(JSON.stringify([key.at, key.kind, key.ref]), 'utf8').toString('base64url');
}

/** The key a cursor names, or null for one this server did not issue. */
export function decodePlanLinkCursor(cursor: string): PlanLinkPageKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [at, kind, ref] = parsed as unknown[];
    const linkKind = PlanNodeLinkKindSchema.safeParse(kind);
    if (typeof at !== 'string' || !CURSOR_TIME.test(at) || typeof ref !== 'string') return null;
    return linkKind.success ? { at, kind: linkKind.data, ref } : null;
  } catch {
    return null;
  }
}
