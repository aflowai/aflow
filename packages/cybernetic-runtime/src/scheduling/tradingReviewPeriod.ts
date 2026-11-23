import { and, desc, eq, gte, isNull, like, or, sql } from 'drizzle-orm';
import {
  registerCampaignReader,
  type CampaignReaderContext,
  type CampaignReaderResult,
  type TenantId,
} from '@aflow/schemas';
import { type Database, createTenantContext, memoryDocs, withTenantSchema } from '@aflow/database';
import {
  isBinaryPayloadRef,
  readMemoryBodyBytes,
  type PinnedReadPayloadStore,
} from '@aflow/memory-store';
import {
  readLedgerTheses,
  THESIS_CYCLES_PREFIX,
  THESIS_OPEN_PREFIX,
  THESIS_RESOLVED_PREFIX,
  type ArmResolutionOutcome,
  type ThesisLedgerDoc,
} from './tradingArmTable.js';

/**
 * The Performance Review's period, read from the stored docs by rule. A
 * boundary review covers the whole campaign window, and the window holds as
 * many cycle docs, desk records and lens records as its days and desk reruns
 * write. So no agent copies them: this reader reads every doc of the period
 * and gives them to the review as stored, with the pooled sample counted over
 * the thesis ledger. The analyst reads them from its inputs file, so no agent
 * output grows with the window.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_REVIEW_PERIOD_READER = 'trading.review-period' as const;

const SNAPSHOTS_PREFIX = '/portfolio/snapshots/';
const RESEARCH_PREFIX = '/research/';
const JOURNAL_PREFIX = '/research/journal/';
const REVIEWS_PREFIX = '/strategy/reviews/';
const PRIOR_REVIEWS_MAX = 4;
const EXCHANGE_TIME_ZONE = 'America/New_York';

const DAY = '(\\d{4}-\\d{2}-\\d{2})';
const CYCLE_DOC = new RegExp(`^${THESIS_CYCLES_PREFIX}${DAY}-[^/]+\\.json$`);
const AFTER_CLOSE_SNAPSHOT = new RegExp(`^${SNAPSHOTS_PREFIX}${DAY}-after_close\\.json$`);
const DESK_RECORD = new RegExp(`^${RESEARCH_PREFIX}${DAY}/(?:desk-[^/]+\\.json|desk-runs/[^/]+)$`);
const LENS_RECORD = new RegExp(`^${RESEARCH_PREFIX}${DAY}/lens-reviews/[^/]+$`);
const JOURNAL_DOC = new RegExp(`^${JOURNAL_PREFIX}${DAY}[^/]*$`);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An entry that never filled is no sample point. */
const FILLED_OUTCOMES: ReadonlySet<ArmResolutionOutcome> = new Set([
  'confirmed',
  'falsified',
  'expired',
  'tactical_exit',
]);

const SNAPSHOT_FIELDS = [
  'equity',
  'benchmarkClose',
  'grossExposurePct',
  'brokerGrossExposurePct',
  'armTable',
] as const;
const RESOLVED_FIELDS = [
  'thesisId',
  'hypothesisId',
  'instrument',
  'direction',
  'outcome',
  'entryFillState',
  'statedConfidence',
  'openedTradingDay',
  'resolvedTradingDay',
  'realizedR',
  'lenses',
] as const;
const OPEN_FIELDS = [
  'thesisId',
  'hypothesisId',
  'instrument',
  'direction',
  'sizePct',
  'openedTradingDay',
  'deadlineTradingDays',
  'status',
] as const;
const LENS_FIELDS = ['slotKey', 'round', 'lenses'] as const;

/** One stored memory doc: its path, its inline text and when it was last written. */
export interface StoredDoc {
  path: string;
  content: string | null;
  updatedAt: string;
}

export interface ReviewPeriodRequest {
  regimeName: string;
  /** The campaign's first trading day, in exchange time. */
  windowStart: string;
  periodStart: string;
  periodEnd: string;
}

type Item = Record<string, unknown>;

export interface ReviewPeriod {
  [key: string]: unknown;
  regimeName: string;
  pooledN: number;
  cycles: Item[];
  snapshots: Item[];
  resolvedTheses: Item[];
  openTheses: Item[];
  deskRecords: Item[];
  lensReviews: Item[];
  journal: Item[];
  priorReviews: Item[];
  readNote: string;
}

/** The filled resolutions of one campaign, counted over the ledger docs. */
export function pooledSampleOf(docs: readonly ThesisLedgerDoc[], regimeName: string): number {
  return readLedgerTheses(docs).theses.filter(
    (thesis) =>
      thesis.regimeName === regimeName &&
      thesis.outcome !== null &&
      FILLED_OUTCOMES.has(thesis.outcome),
  ).length;
}

function parseObject(content: string | null): Item | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Item)
      : null;
  } catch {
    return null;
  }
}

function pick(body: Item, fields: readonly string[]): Item {
  return Object.fromEntries(fields.map((field) => [field, body[field] ?? null]));
}

const inPeriod = (day: string, from: string, to: string) => day >= from && day <= to;
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);

/** The trading day of an instant, in exchange time. */
export function exchangeDayOf(instant: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EXCHANGE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/**
 * Every doc of the period, as the review reads it. Each item carries the
 * memory path it was read from, and a field a doc lacks reads null. A doc
 * that is not inline JSON is named in the note, never dropped silently.
 */
export function reviewPeriodOf(
  docs: readonly StoredDoc[],
  request: ReviewPeriodRequest,
): ReviewPeriod {
  const { regimeName, windowStart, periodStart, periodEnd } = request;
  const unreadable: string[] = [];
  const json = (doc: StoredDoc): Item | null => {
    const body = parseObject(doc.content);
    if (body === null) unreadable.push(doc.path);
    return body;
  };
  const sorted = [...docs].sort(byPath);
  const dayOf = (pattern: RegExp, path: string) => pattern.exec(path)?.[1] ?? null;

  const cycles: Item[] = [];
  const snapshots: Item[] = [];
  const resolvedTheses: Item[] = [];
  const openTheses: Item[] = [];
  const deskRecords: Item[] = [];
  const lensReviews: Item[] = [];
  const journal: Item[] = [];
  const reviews: StoredDoc[] = [];

  for (const doc of sorted) {
    const { path } = doc;
    const cycleDay = dayOf(CYCLE_DOC, path);
    if (cycleDay !== null) {
      if (!inPeriod(cycleDay, periodStart, periodEnd)) continue;
      const body = json(doc);
      if (body) cycles.push({ ...body, path });
      continue;
    }
    const snapshotDay = dayOf(AFTER_CLOSE_SNAPSHOT, path);
    if (snapshotDay !== null) {
      if (!inPeriod(snapshotDay, windowStart, periodEnd)) continue;
      const body = json(doc);
      if (body) snapshots.push({ path, tradingDay: snapshotDay, ...pick(body, SNAPSHOT_FIELDS) });
      continue;
    }
    if (path.startsWith(THESIS_RESOLVED_PREFIX)) {
      const body = json(doc);
      if (body?.['regimeName'] === regimeName) {
        resolvedTheses.push({ path, ...pick(body, RESOLVED_FIELDS) });
      }
      continue;
    }
    if (path.startsWith(THESIS_OPEN_PREFIX)) {
      const body = json(doc);
      if (body) openTheses.push({ path, ...pick(body, OPEN_FIELDS) });
      continue;
    }
    const journalDay = dayOf(JOURNAL_DOC, path);
    if (journalDay !== null) {
      if (!inPeriod(journalDay, periodStart, periodEnd)) continue;
      if (doc.content === null) unreadable.push(path);
      else journal.push({ path, tradingDay: journalDay, text: doc.content });
      continue;
    }
    const deskDay = dayOf(DESK_RECORD, path);
    if (deskDay !== null) {
      if (!inPeriod(deskDay, periodStart, periodEnd)) continue;
      const body = json(doc);
      if (body) deskRecords.push({ ...body, path });
      continue;
    }
    const lensDay = dayOf(LENS_RECORD, path);
    if (lensDay !== null) {
      if (!inPeriod(lensDay, periodStart, periodEnd)) continue;
      const body = json(doc);
      if (body) lensReviews.push({ path, ...pick(body, LENS_FIELDS) });
      continue;
    }
    if (path.startsWith(REVIEWS_PREFIX)) reviews.push(doc);
  }

  const priorReviews: Item[] = [];
  for (const doc of reviews
    .sort((a, b) =>
      a.updatedAt === b.updatedAt ? byPath(b, a) : a.updatedAt < b.updatedAt ? 1 : -1,
    )
    .slice(0, PRIOR_REVIEWS_MAX)) {
    if (doc.content === null) unreadable.push(doc.path);
    else priorReviews.push({ path: doc.path, text: doc.content });
  }

  const ledger = sorted.filter(
    (doc) => doc.path.startsWith(THESIS_OPEN_PREFIX) || doc.path.startsWith(THESIS_RESOLVED_PREFIX),
  );
  const counts = [
    `${String(cycles.length)} cycle docs`,
    `${String(snapshots.length)} after_close snapshots`,
    `${String(resolvedTheses.length)} resolved theses`,
    `${String(openTheses.length)} open theses`,
    `${String(deskRecords.length)} desk records`,
    `${String(lensReviews.length)} lens records`,
    `${String(journal.length)} journal entries`,
    `${String(priorReviews.length)} prior reviews`,
  ];
  const empty = [
    ['cycle docs', cycles],
    ['after_close snapshots', snapshots],
    ['journal entries', journal],
  ]
    .filter(([, list]) => (list as Item[]).length === 0)
    .map(([name]) => name as string);
  const readNote = [
    `Read from ${periodStart} to ${periodEnd}, snapshots from ${windowStart}: ${counts.join(', ')}.`,
    empty.length > 0 ? `The period holds no ${empty.join(', no ')}.` : '',
    unreadable.length > 0
      ? `These docs are not inline JSON or text and were not read: ${unreadable.join(', ')}.`
      : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return {
    regimeName,
    pooledN: pooledSampleOf(ledger, regimeName),
    cycles,
    snapshots,
    resolvedTheses,
    openTheses,
    deskRecords,
    lensReviews,
    journal,
    priorReviews,
    readNote,
  };
}

/** One path range a review period reads: a prefix, and the inclusive day bounds within it. */
export interface PeriodPathRange {
  prefix: string;
  /** The lowest path in the range. */
  from: string;
  /** Above every path of the range's last day, in byte order. */
  through: string;
  /** A LIKE pattern every path of the range matches. */
  pattern: string;
}

/**
 * The paths a review period reads, bounded by its days. A day sorts as a
 * path segment, so a range from the first day's path to past the last day's
 * covers exactly the days between. The bounds compare in byte order, which
 * the query asks for with the C collation.
 */
export function reviewPeriodPathRanges(request: ReviewPeriodRequest): PeriodPathRange[] {
  const range = (prefix: string, from: string, through: string, pattern: string) => ({
    prefix,
    from: `${prefix}${from}`,
    // '~' sorts above '-', '.' and '/', which follow a day in every path.
    through: `${prefix}${through}~`,
    pattern,
  });
  const { windowStart, periodStart, periodEnd } = request;
  return [
    range(THESIS_CYCLES_PREFIX, periodStart, periodEnd, `${THESIS_CYCLES_PREFIX}%`),
    range(SNAPSHOTS_PREFIX, windowStart, periodEnd, `${SNAPSHOTS_PREFIX}%-after\\_close.json`),
    range(RESEARCH_PREFIX, periodStart, periodEnd, `${RESEARCH_PREFIX}____-__-__/desk-%`),
    range(RESEARCH_PREFIX, periodStart, periodEnd, `${RESEARCH_PREFIX}____-__-__/lens-reviews/%`),
    range(JOURNAL_PREFIX, periodStart, periodEnd, `${JOURNAL_PREFIX}%`),
  ];
}

/** A stored doc's row: where its body lives, inline or by reference. */
export interface StoredDocRow {
  path: string;
  inlineContent: string | null;
  payloadRef: string | null;
  updatedAt: Date;
}

/**
 * Each row's body, whichever lane it was written on: a doc over the inline
 * threshold is fetched whole from the payload store, as memory.store.get
 * reads it. A body the store cannot give reads null, and the period names it.
 */
export async function storedDocsOf(
  rows: readonly StoredDocRow[],
  payloadStore: PinnedReadPayloadStore,
): Promise<StoredDoc[]> {
  return Promise.all(
    rows.map(async (row) => {
      let content: string | null = row.inlineContent;
      if (content === null && row.payloadRef !== null && !isBinaryPayloadRef(row.payloadRef)) {
        try {
          content = (await readMemoryBodyBytes(row, payloadStore))?.toString('utf-8') ?? null;
        } catch {
          content = null;
        }
      }
      return { path: row.path, content, updatedAt: row.updatedAt.toISOString() };
    }),
  );
}

/**
 * The stored docs of one review period, in one space. The query reads only
 * the period's paths, the live thesis ledger written since the campaign
 * started and the latest reviews, so its load stays the window's whatever
 * the space ran before.
 */
export async function loadReviewPeriodDocs(
  db: Database,
  payloadStore: PinnedReadPayloadStore,
  scope: { tenantId: string; spaceId: string; campaignStartedAt: string },
  request: ReviewPeriodRequest,
): Promise<StoredDoc[]> {
  const tenantContext = createTenantContext(scope.tenantId as TenantId);
  const startedAt = new Date(scope.campaignStartedAt);
  const columns = {
    path: memoryDocs.path,
    inlineContent: memoryDocs.inlineContent,
    payloadRef: memoryDocs.payloadRef,
    updatedAt: memoryDocs.updatedAt,
  };
  const live = and(eq(memoryDocs.spaceId, scope.spaceId), isNull(memoryDocs.deletedAt));
  const inRange = (range: PeriodPathRange) =>
    and(
      sql`${memoryDocs.path} COLLATE "C" >= ${range.from}`,
      sql`${memoryDocs.path} COLLATE "C" < ${range.through}`,
      like(memoryDocs.path, range.pattern),
    );
  const rows = await withTenantSchema(db, tenantContext, async (tx) => {
    const period = await tx
      .select(columns)
      .from(memoryDocs)
      .where(
        and(
          live,
          gte(memoryDocs.updatedAt, startedAt),
          or(
            ...reviewPeriodPathRanges(request).map(inRange),
            like(memoryDocs.path, `${THESIS_OPEN_PREFIX}%`),
            like(memoryDocs.path, `${THESIS_RESOLVED_PREFIX}%`),
          ),
        ),
      );
    const reviews = await tx
      .select(columns)
      .from(memoryDocs)
      .where(and(live, like(memoryDocs.path, `${REVIEWS_PREFIX}%`)))
      .orderBy(desc(memoryDocs.updatedAt), desc(memoryDocs.path))
      .limit(PRIOR_REVIEWS_MAX);
    return [...period, ...reviews];
  });
  return storedDocsOf(rows, payloadStore);
}

function dayArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && ISO_DAY.test(value) ? value : null;
}

async function reviewPeriodReader(ctx: CampaignReaderContext): Promise<CampaignReaderResult> {
  const periodStart = dayArg(ctx.args, 'periodStart');
  const periodEnd = dayArg(ctx.args, 'periodEnd');
  if (periodStart === null || periodEnd === null || periodStart > periodEnd) {
    return {
      ok: false,
      message:
        'Pass periodStart and periodEnd as YYYY-MM-DD trading days, with periodStart no later than periodEnd.',
    };
  }
  const regimeName = ctx.config['regimeName'];
  if (typeof regimeName !== 'string' || regimeName.length === 0) {
    return { ok: false, message: 'The campaign config names no regimeName, so no period is its.' };
  }
  const request = { regimeName, windowStart: exchangeDayOf(ctx.startedAt), periodStart, periodEnd };
  const docs = await loadReviewPeriodDocs(
    ctx.db as Database,
    ctx.payloadStore as PinnedReadPayloadStore,
    { tenantId: ctx.tenantId, spaceId: ctx.spaceId, campaignStartedAt: ctx.startedAt },
    request,
  );
  return { ok: true, value: reviewPeriodOf(docs, request) };
}

registerCampaignReader(TRADING_REVIEW_PERIOD_READER, reviewPeriodReader);
