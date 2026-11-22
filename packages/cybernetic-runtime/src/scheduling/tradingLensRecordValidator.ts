import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  approvedThesesPath,
  lensRecordGapIssues,
  slotKeyOf,
  type LensRecordSources,
} from '@aflow/platform-artifacts';
import { readApprovedSet } from './tradingApprovedThesesValidator.js';
import { loadCycleLedgerDocs, type ThesisLedgerDoc } from './tradingArmTable.js';

/**
 * The Daily Trading Cycle's record step reports `lensRecordGaps`, which the
 * lens-record-carried criterion scores. This rule holds it to what the cycle
 * held: the lens record of each opened thesis's approved entry, and of each
 * resolved thesis as the cycle that opened it recorded. The record step writes
 * neither source, so a record it dropped from its own docs is still a gap. A thesis that held none is not applicable, so
 * an operator's set or a thesis from before lens records counts no gap.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_LENS_RECORD_VALIDATOR_REF = 'trading.lens-record' as const;

function parse(content: string | null): unknown {
  if (content === null) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Each thesis's lenses value as the cycle that opened it recorded it, from the
 * openedApprovals of every cycle doc other than this cycle's own.
 */
export function openedLensesOf(
  docs: readonly ThesisLedgerDoc[],
  ownCycleDocPath: string,
): Map<string, unknown> {
  return new Map(
    docs
      .filter((doc) => doc.path !== ownCycleDocPath)
      .flatMap((doc) => {
        const approvals = asRecord(parse(doc.content))?.['openedApprovals'];
        return Array.isArray(approvals) ? (approvals as unknown[]) : [];
      })
      .flatMap((approval): Array<[string, unknown]> => {
        const item = asRecord(approval);
        const thesisId = item?.['thesisId'];
        return typeof thesisId === 'string' ? [[thesisId, item?.['lenses'] ?? null]] : [];
      }),
  );
}

/** The set's entries for one slot, or none where the set is missing, unreadable or malformed. */
export function slotEntriesOf(content: unknown, slotKey: string): Array<Record<string, unknown>> {
  const slots =
    content !== null && typeof content === 'object'
      ? (content as Record<string, unknown>)['slots']
      : undefined;
  const entries =
    slots !== null && typeof slots === 'object'
      ? (slots as Record<string, unknown>)[slotKey]
      : undefined;
  return Array.isArray(entries)
    ? entries.filter(
        (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
      )
    : [];
}

interface CycleIdentity {
  tradingDay: string;
  slotKey: string;
}

function identityOf(data: unknown): CycleIdentity | null {
  const doc =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)['cycleDoc']
      : undefined;
  if (doc === null || typeof doc !== 'object') return null;
  const { tradingDay, slot, slotIndex } = doc as Record<string, unknown>;
  if (typeof tradingDay !== 'string' || typeof slot !== 'string') return null;
  const index = typeof slotIndex === 'number' ? slotIndex : null;
  return { tradingDay, slotKey: slotKeyOf(slot as Parameters<typeof slotKeyOf>[0], index) };
}

async function tradingLensRecordValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const identity = identityOf(data);
  // The record contract's own schema names a malformed cycle doc.
  if (identity === null) return [];
  const set = await readApprovedSet(ctx, approvedThesesPath(identity.tradingDay));
  const cycles = await loadCycleLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
  const sources: LensRecordSources = {
    entries: set.status === 'found' ? slotEntriesOf(set.content, identity.slotKey) : [],
    openedLenses: openedLensesOf(
      cycles,
      `/portfolio/theses/cycles/${identity.tradingDay}-${identity.slotKey}.json`,
    ),
  };
  return lensRecordGapIssues(data, sources).map((issue) => ({ code: 'custom' as const, ...issue }));
}

registerRuntimeValidator(TRADING_LENS_RECORD_VALIDATOR_REF, tradingLensRecordValidator);
