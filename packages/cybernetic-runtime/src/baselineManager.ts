import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, sql, and, isNull } from 'drizzle-orm';
import type { TenantId, EvalResult, EvalBaseline } from '@aflow/schemas';
import { EvalBaselineSchema } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  memoryDocs,
  memoryDocVersions,
} from '@aflow/database';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Default number of recent results for rolling baseline computation. */
const DEFAULT_ROLLING_WINDOW = 10;

/** Minimum number of results before a baseline is considered trustworthy. */
const MIN_BASELINE_SIZE = 3;

// ============================================================================
// Types
// ============================================================================

export interface UpdateBaselineParams {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  newResult: EvalResult;
  db: PostgresJsDatabase;
}

export interface UpdateBaselineResult {
  regressionDetected: boolean;
  breachCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

function computeContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export async function loadRecentResults(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
  windowSize: number,
): Promise<EvalResult[]> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const pathPrefix = `/evals/${workflowSlug}/results/`;

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`${memoryDocs.path} LIKE ${pathPrefix + '%'}`,
          isNull(memoryDocs.deletedAt),
        ),
      )
      .orderBy(sql`${memoryDocs.updatedAt} DESC`)
      .limit(windowSize),
  );

  const results: EvalResult[] = [];
  for (const row of rows) {
    if (!row.inlineContent) continue;
    try {
      const parsed = JSON.parse(row.inlineContent) as EvalResult;
      // Only include non-error results in baseline computation
      if (parsed.verdict !== 'error') {
        results.push(parsed);
      }
    } catch {
      // Skip malformed result docs
    }
  }

  return results;
}

export async function loadBaseline(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
): Promise<EvalBaseline | null> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const baselinePath = `/evals/${workflowSlug}/baseline.json`;

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, baselinePath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row?.inlineContent) return null;

  try {
    return EvalBaselineSchema.parse(JSON.parse(row.inlineContent));
  } catch {
    return null;
  }
}

/**
 * Save or update a baseline doc in memory.
 */
async function saveBaseline(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
  baseline: EvalBaseline,
): Promise<void> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  const baselinePath = `/evals/${workflowSlug}/baseline.json`;
  const content = JSON.stringify(baseline, null, 2);
  const contentHash = computeContentHash(content);
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const now = new Date();

  await withTenantSchema(db, tenantContext, async (tx) => {
    const existing = await tx
      .select({
        id: memoryDocs.id,
        currentVersion: memoryDocs.currentVersion,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, baselinePath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1);

    const existingRow = existing[0];

    if (existingRow) {
      const newVersion = existingRow.currentVersion + 1;

      await tx
        .update(memoryDocs)
        .set({
          inlineContent: content,
          contentHash,
          sizeBytes,
          currentVersion: newVersion,
          updatedAt: now,
        })
        .where(eq(memoryDocs.id, existingRow.id));

      await tx.insert(memoryDocVersions).values({
        docId: existingRow.id,
        version: newVersion,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: 'system:eval-runner',
      });
    } else {
      const [inserted] = await tx
        .insert(memoryDocs)
        .values({
          path: baselinePath,
          spaceId,
          docType: 'json',
          mimeType: 'application/json',
          sizeBytes,
          contentHash,
          inlineContent: content,
          currentVersion: 1,
          embeddingStatus: 'disabled',
          indexingMode: 'disabled',
          tags: ['eval', 'baseline'],
          createdByActor: 'system:eval-runner',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(memoryDocVersions).values({
        docId: inserted!.id,
        version: 1,
        inlineContent: content,
        contentHash,
        sizeBytes,
        createdByActor: 'system:eval-runner',
      });
    }
  });
}

/**
 * Compute standard deviation of an array of numbers.
 */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sumSqDiffs = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(sumSqDiffs / (values.length - 1));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Update the baseline for a workflow procedure after a new eval result.
 *
 * 1. Loads recent eval results (rolling window of N)
 * 2. Computes rolling average scores for the baseline
 * 3. Compares the new result against the baseline threshold
 * 4. Tracks consecutive breaches (resets on pass)
 * 5. Saves updated baseline
 *
 * @returns Whether a regression was detected and the current breach count.
 */
export async function updateBaseline(params: UpdateBaselineParams): Promise<UpdateBaselineResult> {
  const { tenantId, spaceId, workflowSlug, newResult, db } = params;
  const logger = getCyberneticLogger();

  try {
    // Load existing baseline for breach tracking
    const existingBaseline = await loadBaseline(db, tenantId, spaceId, workflowSlug);

    // Load recent results EXCLUDING the current run to avoid self-comparison.
    // The baseline should represent historical performance, not include the run being judged.
    const allRecent = await loadRecentResults(
      db,
      tenantId,
      spaceId,
      workflowSlug,
      DEFAULT_ROLLING_WINDOW + 1, // fetch one extra in case the new result is in the set
    );
    // Fail-verdict runs must not seed or shift the
    // baseline: a run-terminal failure scores overall=0 by construction
    const recentResults = allRecent.filter(
      (r) => r.runId !== newResult.runId && r.verdict !== 'fail',
    );

    // Not enough data to establish a meaningful baseline
    if (recentResults.length < MIN_BASELINE_SIZE) {
      // Create/update a preliminary baseline from available data
      const goalScores = recentResults
        .map((r) => r.scores.goalScore)
        .filter((s): s is number => s !== undefined);
      const taskScores = recentResults
        .map((r) => r.scores.taskScore)
        .filter((s): s is number => s !== undefined);
      const trajectoryScores = recentResults
        .map((r) => r.scores.trajectoryScore)
        .filter((s): s is number => s !== undefined);
      const overallScores = recentResults.map((r) => r.scores.overall);

      const preliminary: EvalBaseline = {
        baselineScores: {
          goalScore:
            goalScores.length > 0 ? goalScores.reduce((a, b) => a + b, 0) / goalScores.length : 0,
          taskScore:
            taskScores.length > 0 ? taskScores.reduce((a, b) => a + b, 0) / taskScores.length : 0,
          trajectoryScore:
            trajectoryScores.length > 0
              ? trajectoryScores.reduce((a, b) => a + b, 0) / trajectoryScores.length
              : 0,
          overall:
            overallScores.length > 0
              ? overallScores.reduce((a, b) => a + b, 0) / overallScores.length
              : 0,
        },
        sampleSize: recentResults.length,
        updatedAt: new Date().toISOString(),
        regressionThreshold: existingBaseline?.regressionThreshold ?? 0.15,
        consecutiveBreachesRequired: existingBaseline?.consecutiveBreachesRequired ?? 3,
        currentBreachCount: 0,
      };

      await saveBaseline(db, tenantId, spaceId, workflowSlug, preliminary);
      return { regressionDetected: false, breachCount: 0 };
    }

    // Compute rolling averages from recent results
    const goalScores = recentResults
      .map((r) => r.scores.goalScore)
      .filter((s): s is number => s !== undefined);
    const taskScores = recentResults
      .map((r) => r.scores.taskScore)
      .filter((s): s is number => s !== undefined);
    const trajectoryScores = recentResults
      .map((r) => r.scores.trajectoryScore)
      .filter((s): s is number => s !== undefined);
    const overallScores = recentResults.map((r) => r.scores.overall);

    const avgGoal =
      goalScores.length > 0 ? goalScores.reduce((a, b) => a + b, 0) / goalScores.length : 0;
    const avgTask =
      taskScores.length > 0 ? taskScores.reduce((a, b) => a + b, 0) / taskScores.length : 0;
    const avgTrajectory =
      trajectoryScores.length > 0
        ? trajectoryScores.reduce((a, b) => a + b, 0) / trajectoryScores.length
        : 0;
    const avgOverall = overallScores.reduce((a, b) => a + b, 0) / overallScores.length;

    // Determine regression threshold from existing baseline or default
    const regressionThreshold = existingBaseline?.regressionThreshold ?? 0.15;
    const consecutiveBreachesRequired = existingBaseline?.consecutiveBreachesRequired ?? 3;

    // Check if the new result breaches the threshold
    // Regression = overall drops below baseline * (1 - threshold)
    const breachThreshold = avgOverall * (1 - regressionThreshold);
    const isBreach = newResult.scores.overall < breachThreshold;

    let currentBreachCount: number;
    if (isBreach) {
      currentBreachCount = (existingBaseline?.currentBreachCount ?? 0) + 1;
    } else {
      currentBreachCount = 0;
    }

    const regressionDetected = currentBreachCount >= consecutiveBreachesRequired;

    // Save updated baseline
    const updatedBaseline: EvalBaseline = {
      baselineScores: {
        goalScore: avgGoal,
        taskScore: avgTask,
        trajectoryScore: avgTrajectory,
        overall: avgOverall,
      },
      sampleSize: recentResults.length,
      updatedAt: new Date().toISOString(),
      overallStddev: stddev(overallScores),
      regressionThreshold,
      consecutiveBreachesRequired,
      currentBreachCount,
    };

    await saveBaseline(db, tenantId, spaceId, workflowSlug, updatedBaseline);

    if (regressionDetected) {
      logger.warn(
        `evalBaseline: regression detected for ${workflowSlug} — ` +
          `${String(currentBreachCount)} consecutive breaches (threshold: ${String(consecutiveBreachesRequired)}), ` +
          `overall score ${String(newResult.scores.overall)} < baseline ${String(avgOverall)} * ${String(1 - regressionThreshold)}`,
      );
    }

    return { regressionDetected, breachCount: currentBreachCount };
  } catch (error) {
    logger.error(
      `evalBaseline: failed to update baseline for ${workflowSlug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return { regressionDetected: false, breachCount: 0 };
  }
}
