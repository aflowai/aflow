import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { RunnerReflection, TenantId } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, workflowRunTasks } from '@aflow/database';

/**
 * Load RunnerReflection data from workflow_run_tasks for a given run.
 */
export async function loadReflections(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<RunnerReflection[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  try {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({
          taskId: workflowRunTasks.taskId,
          reflectionJson: workflowRunTasks.reflectionJson,
        })
        .from(workflowRunTasks)
        .where(eq(workflowRunTasks.runId, runId)),
    );

    const reflections: RunnerReflection[] = [];
    for (const row of rows) {
      if (!row.reflectionJson) continue;
      reflections.push(row.reflectionJson as RunnerReflection);
    }
    return reflections;
  } catch {
    return [];
  }
}

export function formatReflectionsForPrompt(reflections: RunnerReflection[]): string {
  if (reflections.length === 0) return '';

  const rows = reflections
    .map((r) => {
      const parts: string[] = [`Task "${r.taskId}"`];
      if (r.condition) {
        const c = r.condition;
        parts.push(
          `  Condition: disposition=${c.disposition} (complexity=${c.complexity}, progress=${c.progress})`,
        );
      }
      if (r.blockers && r.blockers.length > 0) {
        parts.push(`  Blockers: ${r.blockers.map((b) => `${b.kind}: ${b.detail}`).join('; ')}`);
      }
      if (r.missingInputs && r.missingInputs.length > 0) {
        parts.push(`  Missing inputs: ${r.missingInputs.join(', ')}`);
      }
      if (r.missingTools && r.missingTools.length > 0) {
        parts.push(`  Missing tools: ${r.missingTools.join(', ')}`);
      }
      // Only emit a row when at least one concrete signal is present.
      return parts.length > 1 ? parts.join('\n') : null;
    })
    .filter((row): row is string => row !== null);

  if (rows.length === 0) return '';
  return ['Runner-reported signals (condition / blockers / missing context):', ...rows].join(
    '\n\n',
  );
}
