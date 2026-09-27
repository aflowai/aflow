/**
 * The single eval-label insert path (Plan 269 D10): both operator label
 * routes (the ad-hoc exemplar route and the queue submit) write through
 * here, so the identity-uniqueness contract and its conflict shape cannot
 * drift between them.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema, evalLabels } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { databaseErrorText } from '../lib/databaseErrors.js';

export type EvalLabelInsertResult = { ok: true; id: string } | { ok: false; code: 'label_exists' };

export async function insertEvalLabelRow(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  values: typeof evalLabels.$inferInsert,
): Promise<EvalLabelInsertResult> {
  const tenantCtx = createTenantContext(tenantId);
  try {
    const [inserted] = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.insert(evalLabels).values(values).returning({ id: evalLabels.id }),
    );
    return { ok: true, id: inserted!.id };
  } catch (error: unknown) {
    const message = databaseErrorText(error);
    if (message.includes('unique') || message.includes('duplicate')) {
      return { ok: false, code: 'label_exists' };
    }
    throw error;
  }
}
