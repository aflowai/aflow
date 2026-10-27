/**
 * What the plan board (Plan 322 P3.3, its columns Plan 332 D4's) derives from
 * the tree it reads: the cards under one plan with their phase, which column
 * each stands in and why where it needs the operator, the plan's header, the
 * Phase filter, and how the Done column folds by day. Pure, so it is tested
 * without rendering.
 */
import {
  planBoardCards,
  type PlanBoardCard,
  type PlanBoardColumn,
  type PlanDoneDay,
  type PlanNeedsYouReason,
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

/** The plan's header: its steps closed of all, and the non-zero count of each column. */
export function planHeader(tally: PlanRootTally): {
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
    progress: `${String(tally.done + tally.dropped)} of ${String(tally.steps)} closed`,
    counts: counts
      .filter((c) => c.count > 0)
      .map((c) => ({
        column: c.column,
        label: `${String(c.count)} ${c.column === 'needs_you' && c.count === 1 ? 'needs you' : c.noun}`,
      })),
  };
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
