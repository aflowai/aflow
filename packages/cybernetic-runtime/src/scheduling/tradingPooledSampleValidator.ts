import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  loadThesisLedgerDocs,
  readLedgerTheses,
  type ArmResolutionOutcome,
  type ThesisLedgerDoc,
} from './tradingArmTable.js';

/**
 * The Performance Review's pooled sample is a count over the thesis ledger,
 * never a number an agent supplies. Its period read reports `pooledN`, and
 * this rule refuses any count the ledger does not give: the resolutions of
 * filled entries, across every arm of the campaign `regimeName` names. The
 * analyst's verdict is pinned to that count, so every floor rule keys on it.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_POOLED_SAMPLE_VALIDATOR_REF = 'trading.pooled-sample' as const;

/** An entry_failed resolution never filled, so it is no sample point. */
const FILLED_OUTCOMES: ReadonlySet<ArmResolutionOutcome> = new Set([
  'confirmed',
  'falsified',
  'expired',
  'tactical_exit',
]);

const PooledSampleSchema = z.object({ regimeName: z.string(), pooledN: z.unknown() }).passthrough();

/** The filled resolutions of one campaign, counted over the ledger docs. */
export function pooledSampleOf(docs: readonly ThesisLedgerDoc[], regimeName: string): number {
  return readLedgerTheses(docs).theses.filter(
    (thesis) =>
      thesis.regimeName === regimeName &&
      thesis.outcome !== null &&
      FILLED_OUTCOMES.has(thesis.outcome),
  ).length;
}

export function pooledSampleIssues(
  data: unknown,
  docs: readonly ThesisLedgerDoc[],
): RuntimeValidatorIssue[] {
  const parsed = PooledSampleSchema.safeParse(data);
  if (!parsed.success) return [];
  const want = pooledSampleOf(docs, parsed.data.regimeName);
  if (parsed.data.pooledN === want) return [];
  return [
    {
      code: 'custom',
      path: ['pooledN'],
      message: `The thesis ledger holds ${String(want)} resolutions of filled entries for campaign "${parsed.data.regimeName}": confirmed, falsified, expired or tactical_exit. Set pooledN to ${String(want)}.`,
    },
  ];
}

async function pooledSampleValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  if (!PooledSampleSchema.safeParse(data).success) return [];
  const docs = await loadThesisLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
  return pooledSampleIssues(data, docs);
}

registerRuntimeValidator(TRADING_POOLED_SAMPLE_VALIDATOR_REF, pooledSampleValidator);
