import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import type { IssueCategory, TenantId } from '@aflow/schemas';
import { ENTITY_EVENTS_STREAM_KEY } from '@aflow/redis';
import { createTenantContext, withTenantSchema, causalMeasurements } from '@aflow/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-category counts and ratification rate for Coach-source proposals. */
export interface CoachHealthCategoryStats {
  proposals: number;
  ratified: number;
  rejected: number;
  /** ratified / (ratified + rejected), or null if no decisions in the category. */
  ratificationRate: number | null;
}

export interface CoachHealthStats {
  /** Proposals submitted within the window. */
  proposalCount: number;
  /** Proposals ratified within the window. */
  ratifiedCount: number;
  /** Proposals rejected within the window. */
  rejectedCount: number;
  /** Proposals auto-suppressed (duplicate fingerprint + rate cap). */
  duplicateSuppressedCount: number;
  contextPressureCount: number;
  /** ratified / (ratified + rejected), or null if no decisions. */
  ratificationRate: number | null;
  /** Window duration label for display. */
  windowLabel: string;
  /** Whether the drift alert is firing. */
  driftAlert: boolean;
  /** Active threshold values. */
  thresholds: {
    driftRateFloor: number;
    driftSampleFloor: number;
  };
  /** Daily bucketed series for sparkline (oldest → newest). */
  dailySeries: Array<{
    date: string;
    proposals: number;
    ratified: number;
    rejected: number;
    suppressed: number;
  }>;
  byCategory: Partial<Record<IssueCategory | 'unspecified', CoachHealthCategoryStats>>;
  causalImpactSummary?: {
    ratifiedProposalsWithMeasurement: number;
    meanEvalScoreLift: number | null;
    meanCostDeltaPercent: number | null;
    netPositiveProposalRate: number | null;
    perCategoryLift: Partial<
      Record<IssueCategory | 'unspecified', { mean: number | null; n: number }>
    >;
  };
}

interface CoachHealthParams {
  tenantId: string;
  spaceId: string;
  redis: Redis;
  db?: PostgresJsDatabase;
  /** Window duration in ms. Default: 7 days. */
  windowMs?: number;
  /** Drift alert fires below this rate. */
  driftRateFloor?: number;
  /** Minimum samples before drift alert fires. */
  driftSampleFloor?: number;
}

// ---------------------------------------------------------------------------
// Event types we count
// ---------------------------------------------------------------------------

type CoachEventCategory = 'proposal' | 'ratified' | 'rejected' | 'suppressed' | 'context_pressure';

const COACH_EVENT_TYPES: Record<string, CoachEventCategory> = {
  'entity.coach.proposal': 'proposal',
  'entity.coach.ratified': 'ratified',
  'entity.coach.rejected': 'rejected',
  'entity.coach.suppressed': 'suppressed',
  'entity.coach.context_pressure': 'context_pressure',
};

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute Coach health stats from the entity events stream.
 * Scans the stream within the window — O(events in window).
 */
export async function computeCoachHealth(params: CoachHealthParams): Promise<CoachHealthStats> {
  const {
    tenantId,
    spaceId,
    redis,
    windowMs = 7 * 24 * 60 * 60 * 1000,
    driftRateFloor = 0.3,
    driftSampleFloor = 5,
  } = params;

  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);
  const windowStart = Date.now() - windowMs;

  // Read events from the stream within the window.
  // Use a timestamp-based ID to start from the window boundary.
  const startId = `${String(windowStart)}-0`;
  const rawEntries = await redis.xrange(streamKey, startId, '+', 'COUNT', 5000);

  // Aggregate counts
  let proposalCount = 0;
  let ratifiedCount = 0;
  let rejectedCount = 0;
  let suppressedCount = 0;
  let contextPressureCount = 0;

  // Daily buckets
  const dailyBuckets = new Map<
    string,
    { proposals: number; ratified: number; rejected: number; suppressed: number }
  >();

  type CategoryKey = IssueCategory | 'unspecified';
  const categoryBuckets = new Map<
    CategoryKey,
    { proposals: number; ratified: number; rejected: number }
  >();
  const proposalIdToCategory = new Map<string, CategoryKey>();
  function bumpCategory(key: CategoryKey, kind: 'proposal' | 'ratified' | 'rejected'): void {
    let bucket = categoryBuckets.get(key);
    if (!bucket) {
      bucket = { proposals: 0, ratified: 0, rejected: 0 };
      categoryBuckets.set(key, bucket);
    }
    if (kind === 'proposal') bucket.proposals += 1;
    else if (kind === 'ratified') bucket.ratified += 1;
    else bucket.rejected += 1;
  }

  for (const [, fields] of rawEntries) {
    // Parse fields
    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) {
        fieldObj[key] = value;
      }
    }

    const eventType = fieldObj['eventType'];
    if (!eventType) continue;

    const category = COACH_EVENT_TYPES[eventType];
    if (!category) continue;

    // Count
    switch (category) {
      case 'proposal':
        proposalCount++;
        break;
      case 'ratified':
        ratifiedCount++;
        break;
      case 'rejected':
        rejectedCount++;
        break;
      case 'suppressed':
        suppressedCount++;
        break;
      case 'context_pressure':
        contextPressureCount++;
        break;
    }

    // Daily bucket
    const ts = fieldObj['timestamp'];
    const date = ts ? new Date(Number(ts)).toISOString().slice(0, 10) : 'unknown';
    let bucket = dailyBuckets.get(date);
    if (!bucket) {
      bucket = { proposals: 0, ratified: 0, rejected: 0, suppressed: 0 };
      dailyBuckets.set(date, bucket);
    }
    switch (category) {
      case 'proposal':
        bucket.proposals++;
        break;
      case 'ratified':
        bucket.ratified++;
        break;
      case 'rejected':
        bucket.rejected++;
        break;
      case 'suppressed':
        bucket.suppressed++;
        break;
      case 'context_pressure':
        // Not in the daily series — surfaced as contextPressureCount aggregate.
        break;
    }

    // Per-category aggregation for Coach-source proposal/ratified/rejected events.
    if (category === 'proposal' || category === 'ratified' || category === 'rejected') {
      const sourceField = fieldObj['source'] ?? extractFromPayload(fieldObj['payload'], 'source');
      // Only aggregate categories for Coach-source proposals. Other sources
      // (compose_skill, bind_capability, operator) do not carry a Coach diagnosis.
      if (sourceField === undefined || sourceField === 'coach') {
        const issueCategory =
          fieldObj['issueCategory'] ?? extractFromPayload(fieldObj['payload'], 'issueCategory');
        const key: CategoryKey = isIssueCategory(issueCategory) ? issueCategory : 'unspecified';
        bumpCategory(key, category);
        // Record the proposalId → category mapping on proposal emit so
        // the causal summary can attribute lift back to issue category.
        if (category === 'proposal') {
          const proposalId =
            fieldObj['proposalId'] ?? extractFromPayload(fieldObj['payload'], 'proposalId');
          if (proposalId) proposalIdToCategory.set(proposalId, key);
        }
      }
    }
  }

  // Ratification rate
  const decisions = ratifiedCount + rejectedCount;
  const ratificationRate = decisions > 0 ? ratifiedCount / decisions : null;

  // Drift alert
  const driftAlert =
    decisions >= driftSampleFloor && ratificationRate !== null && ratificationRate < driftRateFloor;

  // Window label
  const days = Math.round(windowMs / (24 * 60 * 60 * 1000));
  const windowLabel = days === 1 ? '1d' : `${String(days)}d`;

  // Daily series sorted oldest → newest
  const dailySeries = Array.from(dailyBuckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({ date, ...b }));

  // Materialize per-category stats (only categories actually seen).
  const byCategory: CoachHealthStats['byCategory'] = {};
  for (const [key, bucket] of categoryBuckets) {
    const decisionsInCategory = bucket.ratified + bucket.rejected;
    byCategory[key] = {
      proposals: bucket.proposals,
      ratified: bucket.ratified,
      rejected: bucket.rejected,
      ratificationRate: decisionsInCategory > 0 ? bucket.ratified / decisionsInCategory : null,
    };
  }

  const causalImpactSummary = params.db
    ? await computeCausalImpactSummary({
        db: params.db,
        tenantId,
        spaceId,
        windowStart: new Date(windowStart),
        proposalIdToCategory,
      })
    : undefined;

  return {
    proposalCount,
    ratifiedCount,
    rejectedCount,
    duplicateSuppressedCount: suppressedCount,
    contextPressureCount,
    ratificationRate,
    windowLabel,
    driftAlert,
    thresholds: { driftRateFloor, driftSampleFloor },
    dailySeries,
    byCategory,
    ...(causalImpactSummary ? { causalImpactSummary } : {}),
  };
}

// ---------------------------------------------------------------------------

interface ComputeCausalImpactSummaryParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  windowStart: Date;
  proposalIdToCategory: Map<string, IssueCategory | 'unspecified'>;
}

async function computeCausalImpactSummary(
  params: ComputeCausalImpactSummaryParams,
): Promise<NonNullable<CoachHealthStats['causalImpactSummary']>> {
  const tenantCtx = createTenantContext(params.tenantId as TenantId);
  // Pull every finalized measurement for this space whose
  // `deltaComputedAt` lands inside the window. Bounded by Postgres
  // index `causal_measurements_space_subject_idx`; in practice the
  // count per space per week is small.
  let rows: Array<{
    proposalId: string;
    baselineMetrics: unknown;
    postMetrics: unknown;
    metadata: unknown;
  }> = [];
  try {
    rows = await withTenantSchema(params.db, tenantCtx, async (tx) =>
      tx
        .select({
          proposalId: causalMeasurements.proposalId,
          baselineMetrics: causalMeasurements.baselineMetrics,
          postMetrics: causalMeasurements.postMetrics,
          metadata: causalMeasurements.metadata,
        })
        .from(causalMeasurements)
        .where(
          and(
            eq(causalMeasurements.spaceId, params.spaceId),
            isNotNull(causalMeasurements.deltaComputedAt),
            gte(causalMeasurements.deltaComputedAt, params.windowStart),
          ),
        ),
    );
  } catch {
    // Best-effort: empty summary on read failure.
    rows = [];
  }

  let lifts = 0;
  let liftSum = 0;
  let positives = 0;
  let costSamples = 0;
  let costSum = 0;
  interface CatBucket {
    sum: number;
    n: number;
  }
  const perCategory: Partial<Record<IssueCategory | 'unspecified', CatBucket>> = {};

  for (const row of rows) {
    const baseline = (row.baselineMetrics as Record<string, unknown> | null) ?? {};
    const post = (row.postMetrics as Record<string, unknown> | null) ?? {};
    const baselineAvg = typeof baseline['avgOverall'] === 'number' ? baseline['avgOverall'] : null;
    const postAvg = typeof post['avgOverall'] === 'number' ? post['avgOverall'] : null;
    if (baselineAvg !== null && postAvg !== null) {
      const lift = postAvg - baselineAvg;
      liftSum += lift;
      lifts += 1;
      if (lift > 0) positives += 1;
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const rawCategory = meta['issueCategory'];
      const persistedCategory: IssueCategory | undefined = isIssueCategory(rawCategory)
        ? rawCategory
        : undefined;
      const category =
        persistedCategory ?? params.proposalIdToCategory.get(row.proposalId) ?? 'unspecified';
      const bucket = perCategory[category] ?? { sum: 0, n: 0 };
      bucket.sum += lift;
      bucket.n += 1;
      perCategory[category] = bucket;
    }
    const baselineCost =
      typeof baseline['avgCostCents'] === 'number' ? baseline['avgCostCents'] : null;
    const postCost = typeof post['avgCostCents'] === 'number' ? post['avgCostCents'] : null;
    if (baselineCost !== null && postCost !== null && baselineCost > 0) {
      costSum += (postCost - baselineCost) / baselineCost;
      costSamples += 1;
    }
  }

  const meanEvalScoreLift = lifts > 0 ? liftSum / lifts : null;
  const meanCostDeltaPercent = costSamples > 0 ? costSum / costSamples : null;
  const netPositiveProposalRate = lifts > 0 ? positives / lifts : null;

  const perCategoryLift: NonNullable<CoachHealthStats['causalImpactSummary']>['perCategoryLift'] =
    {};
  for (const [category, bucket] of Object.entries(perCategory) as Array<
    [IssueCategory | 'unspecified', CatBucket]
  >) {
    perCategoryLift[category] = {
      mean: bucket.n > 0 ? bucket.sum / bucket.n : null,
      n: bucket.n,
    };
  }

  return {
    ratifiedProposalsWithMeasurement: rows.length,
    meanEvalScoreLift,
    meanCostDeltaPercent,
    netPositiveProposalRate,
    perCategoryLift,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISSUE_CATEGORIES: ReadonlySet<string> = new Set<IssueCategory>([
  'procedure',
  'context_spec',
  'tool_capability',
  'reasoning',
  'eval_suite',
  'platform',
  'environment',
]);

function isIssueCategory(value: unknown): value is IssueCategory {
  return typeof value === 'string' && ISSUE_CATEGORIES.has(value);
}

/**
 * Pull a key from a JSON-encoded `payload` field on a Redis stream entry.
 * Stream entries store the envelope as flat key-value pairs; the orchestrator
 * encodes the typed `payload` object as a JSON string. We tolerate both
 * top-level fields (some emitters duplicate for indexing) and nested payload.
 */
function extractFromPayload(raw: string | undefined, key: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  } catch {
    // Non-JSON or malformed payload — skip silently.
  }
  return undefined;
}
