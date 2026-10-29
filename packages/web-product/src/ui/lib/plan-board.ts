/**
 * What the plan board (Plan 322 P3.3, its columns Plan 332 D4's) derives from
 * the tree it reads: the cards under one plan with their phase, which column
 * each stands in and why where it needs the operator, the plan's header, the
 * Phase filter, and how the Done column folds by day; and what the overview's
 * lanes derive from their rows (Plan 332 D7). Pure, so it is tested without
 * rendering.
 */
import {
  isClosedPlanNodeStatus,
  PLAN_NODE_NOTE_HEAD_MAX_CHARS,
  planBoardCards,
  planBoardColumn,
  type PlanBoardCard,
  type PlanBoardColumn,
  type PlanBoardPlacement,
  type PlanDoneDay,
  type PlanLane,
  type PlanLaneItem,
  type PlanNeedsYouReason,
  type PlanNodeDetailOutput,
  type PlanOverviewLanes,
  type PlanRootRow,
  type PlanRootState,
  type PlanRootTally,
  type PlanTreeNode,
} from '@aflow/schemas';

export const PLAN_BOARD_COLUMNS: ReadonlyArray<{
  id: PlanBoardColumn;
  label: string;
  /** A token from tokens.css. */
  color: string;
}> = [
  { id: 'needs_you', label: 'Needs you', color: 'var(--color-warning-default)' },
  { id: 'in_flight', label: 'In flight', color: 'var(--color-status-running)' },
  { id: 'up_next', label: 'Up next', color: 'var(--color-accent-default)' },
  { id: 'done', label: 'Done', color: 'var(--color-success-default)' },
  { id: 'dropped', label: 'Dropped', color: 'var(--color-danger-default)' },
];

/** Why a step stands under Needs you, as its card and the rail say it. */
export const NEEDS_YOU_REASON_LABEL: Record<PlanNeedsYouReason, string> = {
  decide: 'Decision',
  blocked: 'Blocked',
  stranded: 'Under a closed step',
};

/** A node as the board places it: its column, why where it needs the operator, and its phase. */
export type PlanCard = PlanBoardCard;

/**
 * Every node under `root` in the walk's order — parents before children,
 * siblings by position — so each column, Up next included, lists its cards in
 * the order the loop reaches them.
 */
export function planCards(root: PlanTreeNode): PlanCard[] {
  return planBoardCards(root);
}

const PHASE_CODE = /^([A-Z]{1,3}\d+[a-z]?(?:\.\d+)*)\b/;
const PHASE_LABEL_MAX = 14;

/** A phase's chip: its code where its title leads with one ("P3 — …" reads "P3"), else its title cut short. */
export function phaseLabel(title: string): string {
  const code = PHASE_CODE.exec(title.trim());
  if (code?.[1] !== undefined) return code[1];
  const trimmed = title.trim();
  return trimmed.length <= PHASE_LABEL_MAX
    ? trimmed
    : `${trimmed.slice(0, PHASE_LABEL_MAX - 1).trimEnd()}…`;
}

const PLAN_CODE = /^(plan\s+\d+[a-z]?)\b/i;

/** A plan's tag on a lane row: its code where its title leads with one ("Plan 331 · …" reads "Plan 331"), else as a phase's chip. */
export function planTag(title: string): string {
  return PLAN_CODE.exec(title.trim())?.[1] ?? phaseLabel(title);
}

/** A plan's state (Plan 332 D3) as its row and its header say it. */
export const PLAN_STATE_LABEL: Record<PlanRootState, string> = {
  closed: 'Closed',
  needs_you: 'Needs you',
  in_flight: 'In flight',
  queued: 'Queued',
  finished: 'Finished',
  empty: 'No steps',
};

/** The plan's header (Plan 332 D10): its state, its steps closed of all, and the non-zero count of each column. */
export function planHeader(tally: PlanRootTally): {
  state: string;
  progress: string;
  counts: Array<{ column: PlanBoardColumn; label: string }>;
} {
  const counts: Array<{ column: PlanBoardColumn; count: number; noun: string }> = [
    { column: 'needs_you', count: tally.needsYou, noun: 'need you' },
    { column: 'in_flight', count: tally.inFlight, noun: 'in flight' },
    { column: 'up_next', count: tally.upNext, noun: 'up next' },
    { column: 'done', count: tally.done, noun: 'done' },
    { column: 'dropped', count: tally.dropped, noun: 'dropped' },
  ];
  return {
    state: PLAN_STATE_LABEL[tally.state],
    progress: `${String(tally.done + tally.dropped)} of ${String(tally.steps)} closed`,
    counts: counts
      .filter((c) => c.count > 0)
      .map((c) => ({
        column: c.column,
        label: `${String(c.count)} ${c.column === 'needs_you' && c.count === 1 ? 'needs you' : c.noun}`,
      })),
  };
}

// ============================================================================
// The plan list (Plan 332 D2)
// ============================================================================

/**
 * The plan list's sections, each in the rows' position order: open plans —
 * the order the loop takes them — then **Finished**, open roots whose every
 * step is closed, then **Closed**. A row counted short stays among the open
 * plans whatever its state: the steps it did not count may be open, so the
 * list does not offer to close it.
 */
export function planListSections(rows: readonly PlanRootRow[]): {
  open: PlanRootRow[];
  finished: PlanRootRow[];
  closed: PlanRootRow[];
} {
  const isFinished = (r: PlanRootRow) => r.state === 'finished' && r.truncated === undefined;
  return {
    open: rows.filter((r) => r.state !== 'closed' && !isFinished(r)),
    finished: rows.filter(isFinished),
    closed: rows.filter((r) => r.state === 'closed'),
  };
}

/** A row's progress: its steps closed of all; none on a closed plan, whose steps are not counted. */
export function planRowProgress(row: PlanRootRow): string | undefined {
  if (row.counts === undefined) return undefined;
  return `${String(row.counts.done + row.counts.dropped)}/${String(row.counts.steps)}`;
}

/**
 * The open rows directly above and below a plan in the list: what **Move up**
 * and **Move down** place it before and after (Plan 332 D6). Every open plan is
 * a row of the list, so the root the write names is one the operator can see.
 */
export function planRowMoveTargets(
  open: readonly PlanRootRow[],
  nodeId: string,
): { above?: PlanRootRow; below?: PlanRootRow } {
  const at = open.findIndex((r) => r.nodeId === nodeId);
  if (at < 0) return {};
  const above = open[at - 1];
  const below = open[at + 1];
  return {
    ...(above !== undefined ? { above } : {}),
    ...(below !== undefined ? { below } : {}),
  };
}

/**
 * Where the operator is, as the page's URL holds it (Plan 332 D8): the plan
 * and the step whose rail is open. Every other parameter is kept.
 */
export function planViewQuery(
  current: string,
  view: { plan?: string | undefined; node?: string | undefined },
): string {
  const params = new URLSearchParams(current);
  for (const key of ['plan', 'node'] as const) {
    const value = view[key];
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

/**
 * What holds a `waiting` step, which is the loop's on a run: the run still
 * going, or ended with the loop yet to advance the step. Undefined otherwise.
 */
export function waitingLine(node: PlanTreeNode): string | undefined {
  if (node.status !== 'waiting') return undefined;
  const running = node.counts.inFlightRuns;
  if (running === 0) return 'Its run ended; the loop advances it when it returns';
  return running === 1 ? 'A run is on it' : `${String(running)} runs are on it`;
}

/** The root's children with steps of their own: what the Phase filter offers. */
export function planPhases(root: PlanTreeNode): PlanTreeNode[] {
  return root.children.filter((child) => child.children.length > 0);
}

/** One phase is no choice: the filter shows only where there are two or more. */
export function showsPhaseFilter(phases: readonly PlanTreeNode[]): boolean {
  return phases.length >= 2;
}

export interface PlanBoardFilters {
  /** A phase's node id, or undefined for every phase. */
  phaseId?: string;
}

export function planBoardFiltered(filters: PlanBoardFilters): boolean {
  return filters.phaseId !== undefined;
}

export function planCardMatches(card: PlanCard, filters: PlanBoardFilters): boolean {
  if (filters.phaseId === undefined) return true;
  return card.node.nodeId === filters.phaseId || card.phase?.nodeId === filters.phaseId;
}

/** The nodes from `root` down to `nodeId`, both included; empty where it is not under `root`. */
function pathTo(root: PlanTreeNode, nodeId: string): PlanTreeNode[] {
  if (root.nodeId === nodeId) return [root];
  for (const child of root.children) {
    const below = pathTo(child, nodeId);
    if (below.length > 0) return [root, ...below];
  }
  return [];
}

/**
 * The closed node nearest above a stranded step — the root included — which
 * is what the operator reopens for the loop to reach it (Plan 332 D5).
 */
export function planClosedAncestor(root: PlanTreeNode, nodeId: string): PlanTreeNode | undefined {
  return pathTo(root, nodeId)
    .slice(0, -1)
    .reverse()
    .find((node) => isClosedPlanNodeStatus(node.status));
}

/**
 * The nearest open sibling above and below a step, in position order: what
 * **Move up** and **Move down** place it before and after (Plan 332 D6).
 * Every open step is on the board, so the siblings the write names are ones
 * the operator can see.
 */
export function planMoveTargets(
  root: PlanTreeNode,
  nodeId: string,
): { above?: PlanTreeNode; below?: PlanTreeNode } {
  const path = pathTo(root, nodeId);
  const parent = path.at(-2);
  if (parent === undefined) return {};
  const siblings = parent.children;
  const at = siblings.findIndex((s) => s.nodeId === nodeId);
  const open = (s: PlanTreeNode) => !isClosedPlanNodeStatus(s.status);
  const above = siblings.slice(0, at).reverse().find(open);
  const below = siblings.slice(at + 1).find(open);
  return {
    ...(above !== undefined ? { above } : {}),
    ...(below !== undefined ? { below } : {}),
  };
}

// ============================================================================
// The overview's lanes (Plan 332 D1, D7)
// ============================================================================

export type PlanLaneId = 'needs_you' | 'in_flight' | 'up_next';

/** The lanes in the order they ask for attention, each named as the board's column is. */
export const PLAN_LANES: ReadonlyArray<{
  id: PlanLaneId;
  key: keyof Pick<PlanOverviewLanes, 'needsYou' | 'inFlight' | 'upNext'>;
  label: string;
  empty: string;
}> = [
  { id: 'needs_you', key: 'needsYou', label: 'Needs you', empty: 'Nothing waits on you' },
  { id: 'in_flight', key: 'inFlight', label: 'In flight', empty: 'No step is on a run' },
  { id: 'up_next', key: 'upNext', label: 'Up next', empty: 'No plan has a step to take next' },
];

/** What an empty lane says where a bound left steps unread: it may not be empty. */
export const PLAN_LANE_EMPTY_CUT = 'None among the steps read';

/** The lane a step stands in on the overview, and its row there; undefined where it stands in none. */
export function planLaneOf(
  lanes: PlanOverviewLanes,
  nodeId: string | undefined,
): { lane: PlanLaneId; item: PlanLaneItem } | undefined {
  if (nodeId === undefined) return undefined;
  for (const { id, key } of PLAN_LANES) {
    const item = lanes[key].items.find((i) => i.nodeId === nodeId);
    if (item !== undefined) return { lane: id, item };
  }
  return undefined;
}

/** What a lane holds past the rows it lists, as the page says it; undefined where it lists all. */
export function planLaneMore(lane: PlanLane): string | undefined {
  const more = lane.total - lane.items.length;
  return more > 0 ? `and ${String(more)} more` : undefined;
}

/**
 * A lane's count as its heading says it: the steps it holds, and `+` where a
 * bound left steps unread, so a lane cut short never reads as complete.
 */
export function planLaneCount(lane: PlanLane, lanes: Pick<PlanOverviewLanes, 'truncated'>): string {
  return lanes.truncated !== undefined ? `${String(lane.total)}+` : String(lane.total);
}

/** A step as the rail opens it from a lane row, before the rail's own read answers. */
export function planLaneRailNode(
  item: PlanLaneItem,
): Pick<
  PlanTreeNode,
  'nodeId' | 'kind' | 'title' | 'status' | 'revision' | 'noteHead' | 'pullRequest' | 'goalHead'
> & { rounds: number; children: PlanTreeNode[]; counts: { runs: number } } {
  return {
    nodeId: item.nodeId,
    kind: item.kind,
    title: item.title,
    status: item.status,
    revision: item.revision,
    ...(item.noteHead !== undefined ? { noteHead: item.noteHead } : {}),
    ...(item.pullRequest !== undefined ? { pullRequest: item.pullRequest } : {}),
    // The lanes read no goal, no links and no children: the rail reads them.
    goalHead: '',
    rounds: 0,
    children: [],
    counts: { runs: 0 },
  };
}

/**
 * A step the URL names that no lane holds, as the rail opens it from the
 * step's own read: placed by the board's column rule on its status and the
 * activity the read derives as the board does — in flight where a run serves
 * the step or any active node under it — and stranded where the read names a closed node above it — the
 * node the rail offers to reopen.
 */
export function planDetailRailNode(detail: PlanNodeDetailOutput): {
  node: Pick<
    PlanTreeNode,
    'nodeId' | 'kind' | 'title' | 'status' | 'revision' | 'noteHead' | 'closedAt' | 'goalHead'
  > & { rounds: number; children: PlanTreeNode[]; counts: { runs: number } };
  placement: PlanBoardPlacement;
  closedAncestor?: { nodeId: string; title: string };
} {
  const { node } = detail;
  const line = (node.note ?? '').split('\n', 1)[0]?.trim() ?? '';
  const placement = planBoardColumn(
    { kind: node.kind, status: node.status, activity: detail.activity },
    { closedAncestor: detail.closedAncestor !== undefined },
  );
  return {
    node: {
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      status: node.status,
      revision: node.revision,
      ...(line !== '' ? { noteHead: line.slice(0, PLAN_NODE_NOTE_HEAD_MAX_CHARS) } : {}),
      ...(node.closedAt !== undefined ? { closedAt: node.closedAt } : {}),
      goalHead: node.goal,
      rounds: 0,
      children: [],
      counts: { runs: detail.linksTotal },
    },
    placement,
    ...(placement.reason === 'stranded' && detail.closedAncestor !== undefined
      ? { closedAncestor: detail.closedAncestor }
      : {}),
  };
}

/** How long ago `iso` was, as a lane row says it: `now`, `12m`, `3h`, `2d`. */
export function planAge(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

/** Why the lanes may miss a step: the bound their read reached. */
export const PLAN_LANES_TRUNCATION_LINE: Record<
  'limit' | 'depth' | 'nodes',
  (value: number) => string
> = {
  limit: (value) => `The lanes read the first ${String(value)} open steps; some may be missing`,
  depth: (value) =>
    `Steps deeper than ${String(value)} levels were not read; the lanes may miss some`,
  nodes: (value) =>
    `The lanes read the first ${String(value)} steps across plans, closed ones included; some may be missing`,
};

// ============================================================================
// Days, in the reader's own time zone
// ============================================================================

/** The reader's IANA time zone, which the tree counts `doneByDay` in. */
export function readerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `YYYY-MM-DD` of an instant in the reader's time zone. */
export function localDay(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateOf(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

/** `day` moved by `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  const date = dateOf(day);
  date.setDate(date.getDate() + delta);
  return localDay(date);
}

/** The instant the reader's `day` begins, as the tree's `closedSince` takes it. */
export function startOfDay(day: string): string {
  return dateOf(day).toISOString();
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });

// ============================================================================
// The Done column, folded by day
// ============================================================================

/** One fold of the Done column: today, yesterday, or an earlier run of days in one month. */
export interface PlanDoneGroup {
  id: string;
  label: string;
  count: number;
  /** The first and last day it covers, oldest first. */
  from: string;
  to: string;
}

/**
 * The Done column's folds from the plan's done days — "Today", "Yesterday",
 * then one per earlier month ("Oct 5 – 20").
 */
export function planDoneGroups(doneByDay: readonly PlanDoneDay[], today: string): PlanDoneGroup[] {
  const yesterday = addDays(today, -1);
  const groups = new Map<string, PlanDoneGroup>();
  const days = [...doneByDay].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const { day, count } of days) {
    const id = day === today ? 'today' : day === yesterday ? 'yesterday' : day.slice(0, 7);
    const held = groups.get(id);
    if (held) {
      held.count += count;
      held.from = day;
      continue;
    }
    groups.set(id, { id, label: id, count, from: day, to: day });
  }
  return [...groups.values()].map((group) => ({ ...group, label: groupLabel(group) }));
}

function groupLabel(group: PlanDoneGroup): string {
  if (group.id === 'today') return 'Today';
  if (group.id === 'yesterday') return 'Yesterday';
  const month = MONTH.format(dateOf(group.from));
  const first = String(Number(group.from.slice(8)));
  const last = String(Number(group.to.slice(8)));
  return first === last ? `${month} ${first}` : `${month} ${first} – ${last}`;
}

/** The group a done card falls in, by the reader's day it closed. */
export function doneGroupOf(
  card: PlanCard,
  groups: readonly PlanDoneGroup[],
): PlanDoneGroup | undefined {
  if (card.node.closedAt === undefined) return undefined;
  const day = localDay(card.node.closedAt);
  return groups.find((group) => day >= group.from && day <= group.to);
}

/**
 * What the tree must hold for the folds open: done nodes from the first day
 * of the oldest open fold. With none open, today's — the cheapest read. Under
 * a filter every fold is counted from its cards, so every fold is read.
 */
export function doneCardsSince(
  groups: readonly PlanDoneGroup[],
  expanded: ReadonlySet<string>,
  today: string,
  filtered = false,
): string {
  const read = groups.filter((group) => filtered || expanded.has(group.id)).map((g) => g.from);
  return read.reduce((oldest, day) => (day < oldest ? day : oldest), today);
}

/** A fold as the board shows it; `shown` is undefined while its cards are still being read. */
export interface PlanDoneFold extends PlanDoneGroup {
  shown: number | undefined;
  cards: PlanCard[];
}

/**
 * Each fold with the count it shows. Unfiltered, the plan's own count for its
 * days. Filtered, the matching cards in it — which only a tree read from the
 * fold's first day holds, so a fold the read on screen does not reach shows
 * no count rather than a short one.
 */
export function planDoneFolds(
  groups: readonly PlanDoneGroup[],
  doneCards: readonly PlanCard[],
  filtered: boolean,
  readSince: string | undefined,
): PlanDoneFold[] {
  return groups.map((group) => {
    const cards = doneCards.filter((card) => doneGroupOf(card, groups)?.id === group.id);
    const held = readSince !== undefined && readSince <= group.from;
    return { ...group, cards, shown: !filtered ? group.count : held ? cards.length : undefined };
  });
}

// ============================================================================
// Pull requests and runs, as a chip or a line reads them
// ============================================================================

const PULL_REQUEST_NUMBER = /\/pull\/(\d+)/;

/** `#181` for a pull request URL, else the URL. */
export function pullRequestLabel(url: string): string {
  const number = PULL_REQUEST_NUMBER.exec(url)?.[1];
  return number !== undefined ? `#${number}` : url;
}

/** A pull request as its chip reads it: what it is, which one, and whether it merged. */
export function pullRequestChipLabel(pullRequest: { url: string; merged: boolean }): string {
  const number = PULL_REQUEST_NUMBER.exec(pullRequest.url)?.[1];
  const state = pullRequest.merged ? 'merged' : 'open';
  return number !== undefined ? `PR #${number} · ${state}` : `Pull request · ${state}`;
}

/** The mark on the step the stream walk takes next for its plan. */
export const PLAN_NEXT_LABEL = 'Next for the loop';

/** A step's review rounds, named as what they count. */
export function reviewRoundsLabel(rounds: number): string {
  return `${String(rounds)} review round${rounds === 1 ? '' : 's'}`;
}

/** Runs in flight on a step, named as what they count. */
export function runsInFlightLabel(runs: number): string {
  return `${String(runs)} run${runs === 1 ? '' : 's'} in flight`;
}

const RUN_KIND_LABEL: Record<string, string> = {
  'commission-change': 'Commission',
  'publish-local-changes': 'Publish',
  'review-local-changes': 'Review',
  'review-pull-request': 'Review',
};

/** A run's kind from its workflow slug, or a run link's label (`<slug> <status>`). */
export function runKindLabel(slugOrLabel: string | undefined): string {
  const slug = (slugOrLabel ?? '').split(' ', 1)[0] ?? '';
  if (slug === '') return 'Run';
  return RUN_KIND_LABEL[slug] ?? slug;
}

/** The status a run link's label ends with, where it names one. */
export function runLinkStatus(label: string | undefined): string | undefined {
  const status = (label ?? '').split(' ')[1];
  return status === undefined || status === '' ? undefined : status;
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
