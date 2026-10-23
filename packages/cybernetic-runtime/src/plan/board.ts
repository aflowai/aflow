/**
 * The plan as the operator's board reads it (Plan 322 P3.3): each node with
 * what its card shows — counts in place of its links, the goal's head in place
 * of its prose — and each plan's tallies, counted before a done window leaves
 * anything out. Pure: the store's reads come in, the response goes out.
 */
import {
  PlanNodeLinkKindSchema,
  planBoardColumn,
  type PlanDoneDay,
  type PlanNodeSummary,
  type PlanRootTally,
  type PlanTreeNode,
  type PlanTreeOutput,
} from '@aflow/schemas';
import { nestPlanTree, type PlacedPlanNode } from './tree.js';
import { mergeShaOf } from './stream.js';
import type {
  PlanLinkPageKey,
  PlanNodeBoardFacts,
  PlanNodeLinkTally,
  PlanNodeNewestPullRequest,
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
  return {
    ...node,
    // A node the walk read and its own row did not is one deleted between
    // the two reads; its summary's time stands in for both.
    createdAt: facts?.createdAt ?? node.updatedAt,
    ...(facts?.closedAt !== undefined ? { closedAt: facts.closedAt } : {}),
    goalHead: facts?.goalHead ?? '',
    counts: { ...links, inFlightRuns },
    rounds,
    ownedBy:
      node.status === 'active' && links.runs === 0 && inFlightRuns === 0 ? 'operator' : 'loop',
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

/**
 * A parent's progress and owner are its children's: progress, those done of
 * those not dropped; owner, the loop's where a run serves it or the loop holds
 * an active child — runs serve the steps under a root or phase, rarely the
 * parent itself. A child done, dropped, blocked or waiting is no work the loop
 * is moving, though its own card reads the loop's. Only an active parent can be
 * the operator's, as only an active node is: one not active stays the loop's.
 */
function withChildren(node: PlanTreeNode): PlanTreeNode {
  const children = node.children.map(withChildren);
  if (children.length === 0) return { ...node, children };
  const counted = children.filter((child) => child.status !== 'dropped');
  const served = node.counts.runs > 0 || node.counts.inFlightRuns > 0;
  return {
    ...node,
    children,
    ownedBy:
      node.status === 'active' &&
      !served &&
      !children.some((child) => child.status === 'active' && child.ownedBy === 'loop')
        ? 'operator'
        : 'loop',
    progress: {
      done: counted.filter((child) => child.status === 'done').length,
      total: counted.length,
    },
  };
}

function tallyOf(root: PlanTreeNode, dayOf: (iso: string) => string): PlanRootTally {
  const tally: PlanRootTally = {
    rootId: root.nodeId,
    steps: 0,
    done: 0,
    active: 0,
    decide: 0,
    dropped: 0,
    doneByDay: [],
  };
  const byDay = new Map<string, number>();
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stack.push(...node.children);
    tally.steps++;
    const column = planBoardColumn(node);
    if (column === 'done') tally.done++;
    else if (column === 'progress') tally.active++;
    else if (column === 'decide') tally.decide++;
    else if (column === 'dropped') tally.dropped++;
    if (column === 'done' && node.closedAt !== undefined) {
      const day = dayOf(node.closedAt);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
  }
  tally.doneByDay = [...byDay]
    .map(([day, count]): PlanDoneDay => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return tally;
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
 * facts and a parent with its progress and owner; each root's tallies over every node
 * under it; then the done window applied below the roots, which always stay —
 * each is a tab.
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
