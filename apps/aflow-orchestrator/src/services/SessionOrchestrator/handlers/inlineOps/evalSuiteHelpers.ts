/**
 * Eval suite helpers for Coach proposal validation (104e §4.7).
 *
 * @packageDocumentation
 */
import { getDatabase, createTenantContext, withTenantSchema, memoryDocs } from '@aflow/database';
import { eq, and, isNull } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';

/**
 * Load the total criterion count for a skill's eval suite.
 * Returns 0 if no eval suite exists.
 */
export async function loadEvalSuiteCriterionCount(
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
): Promise<number> {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const suitePath = `/evals/${workflowSlug}/suite.json`;

  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ inlineContent: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          eq(memoryDocs.path, suitePath),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row?.inlineContent) return 0;

  try {
    const suite = JSON.parse(row.inlineContent) as {
      goalCriteria?: unknown[];
      taskCriteria?: Record<string, unknown[]>;
      trajectoryCriteria?: unknown[];
    };
    const goalCount = suite.goalCriteria?.length ?? 0;
    const taskCount = Object.values(suite.taskCriteria ?? {}).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    const trajCount = suite.trajectoryCriteria?.length ?? 0;
    return goalCount + taskCount + trajCount;
  } catch {
    return 0;
  }
}
