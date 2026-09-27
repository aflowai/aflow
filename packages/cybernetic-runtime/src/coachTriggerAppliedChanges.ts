import { desc, eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AppliedChangeOutcome, TenantId } from '@aflow/schemas';
import { AppliedChangeOutcomeSchema } from '@aflow/schemas';
import {
  causalMeasurements,
  createMemoryDocRepository,
  createTenantContext,
  withTenantSchema,
} from '@aflow/database';

export interface LoadAppliedChangeOutcomesParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** `learningPolicy.appliedChangeEvidenceLimit` — the named evidence cap. */
  limit: number;
}

/**
 * Load the measured outcomes of the most recently ratified proposals
 * targeting this skill. Best-effort per record: a missing/unparsable staged
 * doc degrades to the measurement-only fields (the lift is still evidence).
 */
export async function loadAppliedChangeOutcomes(
  params: LoadAppliedChangeOutcomesParams,
): Promise<AppliedChangeOutcome[]> {
  const { db, tenantId, spaceId, workflowSlug, limit } = params;
  if (limit <= 0) return [];
  const tenantCtx = createTenantContext(tenantId as TenantId);

  let rows: Array<typeof causalMeasurements.$inferSelect>;
  try {
    rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(causalMeasurements)
        .where(
          and(
            eq(causalMeasurements.spaceId, spaceId),
            eq(causalMeasurements.subjectId, workflowSlug),
          ),
        )
        .orderBy(desc(causalMeasurements.ratifiedAt))
        .limit(limit),
    );
  } catch {
    return [];
  }
  if (rows.length === 0) return [];

  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const outcomes: AppliedChangeOutcome[] = [];
  for (const row of rows) {
    const baseline = (row.baselineMetrics ?? {}) as Record<string, unknown>;
    const post = (row.postMetrics ?? {}) as Record<string, unknown>;
    const baselineAvg = numberOrUndefined(baseline['avgOverall']);
    const postAvg = numberOrUndefined(post['avgOverall']);
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const issueCategory =
      typeof metadata['issueCategory'] === 'string' ? metadata['issueCategory'] : undefined;

    // Warrant fields from the staged record — best-effort.
    let expectedEffect: string | undefined;
    let warrantMetric: string | undefined;
    let kind: string | undefined;
    let summary: string | undefined;
    try {
      const doc = await docRepo.getByPath(`/coach/staged/${row.proposalId}.json`, spaceId);
      if (doc?.inlineContent) {
        const staged = JSON.parse(doc.inlineContent) as {
          kind?: unknown;
          proposal?: { summary?: unknown };
          evidence?: { warrant?: { expectedEffect?: unknown; metric?: unknown } };
        };
        const ee = staged.evidence?.warrant?.expectedEffect;
        if (typeof ee === 'string') expectedEffect = ee.slice(0, 500);
        const wm = staged.evidence?.warrant?.metric;
        if (typeof wm === 'string') warrantMetric = wm.slice(0, 128);
        if (typeof staged.kind === 'string') kind = staged.kind.slice(0, 64);
        if (typeof staged.proposal?.summary === 'string') {
          summary = staged.proposal.summary.slice(0, 300);
        }
      }
    } catch {
      // measurement-only evidence still stands
    }

    const candidate = {
      proposalId: row.proposalId,
      ratifiedAt: row.ratifiedAt.toISOString(),
      ...(issueCategory ? { issueCategory } : {}),
      ...(kind ? { kind } : {}),
      ...(summary ? { summary } : {}),
      ...(expectedEffect ? { expectedEffect } : {}),
      ...(warrantMetric ? { metric: warrantMetric } : {}),
      measured: {
        ...(baselineAvg !== undefined ? { baselineAvg } : {}),
        ...(postAvg !== undefined ? { postAvg } : {}),
        ...(baselineAvg !== undefined && postAvg !== undefined
          ? { delta: postAvg - baselineAvg }
          : {}),
        baselineSamples: countOrZero(baseline['sampleCount']),
        postSamples: countOrZero(post['sampleCount']),
        finalized: row.deltaComputedAt !== null,
      },
    };
    const parsed = AppliedChangeOutcomeSchema.safeParse(candidate);
    if (parsed.success) outcomes.push(parsed.data);
  }
  return outcomes;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function countOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Prompt block for the brief. Expected vs measured per applied change, with
 * the consequence the evidence exists to teach: don't re-propose a change
 * whose applied predecessor demonstrably didn't move the metric — diagnose
 * differently or escalate to `platform_issue`.
 */
export function formatAppliedChangeOutcomesForPrompt(outcomes: AppliedChangeOutcome[]): string {
  if (outcomes.length === 0) return '';
  const lines = outcomes.map((o) => {
    const m = o.measured;
    const measuredBits: string[] = [];
    if (m.baselineAvg !== undefined) measuredBits.push(`baseline=${m.baselineAvg.toFixed(3)}`);
    if (m.postAvg !== undefined) measuredBits.push(`post=${m.postAvg.toFixed(3)}`);
    if (m.delta !== undefined) {
      measuredBits.push(`delta=${m.delta > 0 ? '+' : ''}${m.delta.toFixed(3)}`);
    }
    measuredBits.push(`samples=${String(m.baselineSamples)}→${String(m.postSamples)}`);
    measuredBits.push(m.finalized ? 'window closed' : 'window still open');
    const head = [
      `- ${o.proposalId.slice(0, 8)}`,
      o.kind ?? 'change',
      ...(o.issueCategory ? [o.issueCategory] : []),
      `ratified ${o.ratifiedAt}`,
    ].join(' · ');
    const parts = [head];
    if (o.summary) parts.push(`    change: ${o.summary}`);
    if (o.expectedEffect) {
      parts.push(`    expected: ${o.expectedEffect}${o.metric ? ` (metric: ${o.metric})` : ''}`);
    }
    parts.push(`    measured: ${measuredBits.join(' · ')}`);
    return parts.join('\n');
  });
  return [
    'Outcomes of your recently applied changes (expected vs measured):',
    ...lines,
    'If an applied change did not produce its expected effect, do NOT re-propose the same fix — diagnose differently, or escalate procedure → platform_issue when a skill-side fix demonstrably failed.',
  ].join('\n');
}
