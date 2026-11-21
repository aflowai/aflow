import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import { createTenantContext, memoryDocs, withTenantSchema } from '@aflow/database';
import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
  type TenantId,
} from '@aflow/schemas';
import { approvedThesesIssues, type ApprovedSetRead } from '@aflow/platform-artifacts';

/**
 * The Daily Trading Cycle's `decide` output opens a thesis only as an
 * instance of an approved entry of the set for its (tradingDay, slot). The
 * set is a document in the space's memory, so this rule reads it at
 * submission. A read that fails refuses the theses rather than passing them.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_APPROVED_THESES_VALIDATOR_REF = 'trading.approved-theses' as const;

async function readApprovedSet(
  ctx: RuntimeValidatorContext,
  path: string,
): Promise<ApprovedSetRead> {
  try {
    const db = ctx.db as PostgresJsDatabase;
    const rows = await withTenantSchema(db, createTenantContext(ctx.tenantId as TenantId), (tx) =>
      tx
        .select({ inlineContent: memoryDocs.inlineContent })
        .from(memoryDocs)
        .where(
          and(
            eq(memoryDocs.spaceId, ctx.spaceId),
            eq(memoryDocs.path, path),
            isNull(memoryDocs.deletedAt),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return { status: 'missing' };
    if (row.inlineContent === null) {
      return { status: 'unreadable', reason: 'the document is not stored inline' };
    }
    return { status: 'found', content: JSON.parse(row.inlineContent) as unknown };
  } catch (err) {
    return { status: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function tradingApprovedThesesValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const issues = await approvedThesesIssues(data, (path) => readApprovedSet(ctx, path));
  return issues.map((issue) => ({ code: 'custom' as const, ...issue }));
}

registerRuntimeValidator(TRADING_APPROVED_THESES_VALIDATOR_REF, tradingApprovedThesesValidator);
