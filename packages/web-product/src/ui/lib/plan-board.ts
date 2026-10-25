/**
 * What the plan board (Plan 322 P3.3) derives from the tree it reads: the
 * cards under one plan with their phase, which column each stands in, the
 * filters, and how the Done column folds by day. Pure, so it is tested
 * without rendering.
 */
import {
  planBoardColumn,
  type PlanBoardColumn,
  type PlanDoneDay,
  type PlanTreeNode,
} from '@aflow/schemas';

export const PLAN_BOARD_COLUMNS: ReadonlyArray<{
  id: PlanBoardColumn;
  label: string;
  /** A token from tokens.css. */
  color: string;
}> = [
  { id: 'next', label: 'Up next', color: 'var(--color-accent-default)' },
  { id: 'progress', label: 'In progress', color: 'var(--color-status-running)' },
  { id: 'decide', label: 'Needs you', color: 'var(--color-warning-default)' },
  { id: 'done', label: 'Done', color: 'var(--color-success-default)' },
  { id: 'dropped', label: 'Dropped', color: 'var(--color-danger-default)' },
];

/** A node as the board places it: the phase is the node's ancestor directly under the root. */
export interface PlanCard {
  node: PlanTreeNode;
  column: PlanBoardColumn;
  phase?: PlanTreeNode;
}

/** Every node under `root`, parents before children, each with its column and phase. */
export function planCards(root: PlanTreeNode): PlanCard[] {
  const cards: PlanCard[] = [];
  const visit = (node: PlanTreeNode, phase: PlanTreeNode | undefined) => {
    cards.push({ node, column: planBoardColumn(node), ...(phase ? { phase } : {}) });
    for (const child of node.children) visit(child, phase ?? node);
  };
  for (const child of root.children) visit(child, undefined);
  return cards;
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

export type PlanActivityFilter = 'all' | 'in_flight' | 'idle';
export type PlanDoneWindow = 'today' | 'week' | 'all';

export interface PlanBoardFilters {
  /** A phase's node id, or undefined for every phase. */
  phaseId?: string;
  activity: PlanActivityFilter;
}

export function planBoardFiltered(filters: PlanBoardFilters): boolean {
  return filters.phaseId !== undefined || filters.activity !== 'all';
}

export function planCardMatches(card: PlanCard, filters: PlanBoardFilters): boolean {
  if (filters.phaseId !== undefined) {
    const inPhase = card.node.nodeId === filters.phaseId || card.phase?.nodeId === filters.phaseId;
    if (!inPhase) return false;
  }
  return filters.activity === 'all' || card.node.activity === filters.activity;
}

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

/** The first day the window shows, or undefined for every day. */
export function doneWindowStart(window: PlanDoneWindow, today: string): string | undefined {
  if (window === 'today') return today;
  if (window === 'week') return addDays(today, -6);
  return undefined;
}

/**
 * The Done column's folds from the plan's done days — "Today", "Yesterday",
 * then one per earlier month ("Oct 5 – 20") — counting only days the window shows.
 */
export function planDoneGroups(
  doneByDay: readonly PlanDoneDay[],
  today: string,
  window: PlanDoneWindow,
): PlanDoneGroup[] {
  const start = doneWindowStart(window, today);
  const yesterday = addDays(today, -1);
  const groups = new Map<string, PlanDoneGroup>();
  const days = doneByDay
    .filter((d) => start === undefined || d.day >= start)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
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
