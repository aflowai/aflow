import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  closeReasonIssues,
  dayResolutionIssues,
  type CycleLedgerDoc,
  type DayResolutionIssue,
} from '@aflow/platform-artifacts';
import { loadCycleLedgerDocs } from './tradingArmTable.js';

/**
 * The Daily Trading Cycle's close report covers the whole trading day. Its
 * ledger read lists every resolution and opening the day's cycle docs record,
 * and its reflection gives one reason per resolution. These rules hold each
 * list to the space's cycle docs, so none names a thesis, an outcome or a slot
 * the ledger does not record, and none leaves an entry out.
 *
 * The refs are spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_DAY_RESOLUTIONS_VALIDATOR_REF = 'trading.day-resolutions' as const;
export const TRADING_CLOSE_REASONS_VALIDATOR_REF = 'trading.close-reasons' as const;

function againstCycleDocs(
  rule: (data: unknown, docs: readonly CycleLedgerDoc[]) => DayResolutionIssue[],
) {
  return async (data: unknown, ctx: RuntimeValidatorContext): Promise<RuntimeValidatorIssue[]> => {
    const docs = await loadCycleLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
    return rule(data, docs).map((issue) => ({ code: 'custom' as const, ...issue }));
  };
}

// Each rule is read when a validation runs, never at load, for the same
// suites that mock the package.
registerRuntimeValidator(
  TRADING_DAY_RESOLUTIONS_VALIDATOR_REF,
  againstCycleDocs((data, docs) => dayResolutionIssues(data, docs)),
);
registerRuntimeValidator(
  TRADING_CLOSE_REASONS_VALIDATOR_REF,
  againstCycleDocs((data, docs) => closeReasonIssues(data, docs)),
);
