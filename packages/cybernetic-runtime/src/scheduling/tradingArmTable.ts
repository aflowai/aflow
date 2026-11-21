import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, like, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  registerRuntimeValidator,
  stableHash,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
  type TenantId,
} from '@aflow/schemas';
import { createTenantContext, memoryDocs, withTenantSchema } from '@aflow/database';

/**
 * The per-arm table of a multi-hypothesis trading campaign, read from the
 * thesis ledger the Daily Trading Cycle keeps under `/portfolio/theses/`.
 * Every thesis doc names its campaign (`regimeName`) and the hypothesis arm
 * it tests (`hypothesisId`), so the table is a count over the docs and never
 * a number an agent supplies.
 */
export const TRADING_ARM_TABLE_VALIDATOR_REF = 'trading.arm-table' as const;

export const THESIS_OPEN_PREFIX = '/portfolio/theses/open/';
export const THESIS_RESOLVED_PREFIX = '/portfolio/theses/resolved/';

export const ARM_RESOLUTION_OUTCOMES = [
  'confirmed',
  'falsified',
  'tactical_exit',
  'expired',
  'entry_failed',
] as const;
export type ArmResolutionOutcome = (typeof ARM_RESOLUTION_OUTCOMES)[number];

/** One thesis-ledger document as stored: its path and its JSON text. */
export interface ThesisLedgerDoc {
  path: string;
  content: string | null;
}

export interface ArmRow {
  hypothesisId: string;
  opened: number;
  open: number;
  resolved: Record<ArmResolutionOutcome, number>;
}

export interface LedgerThesis {
  thesisId: string;
  hypothesisId: string;
  regimeName: string;
  openedTradingDay: string | null;
  /** null while the thesis has no resolved doc. */
  outcome: ArmResolutionOutcome | null;
}

function parseObject(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isOutcome(value: unknown): value is ArmResolutionOutcome {
  return (ARM_RESOLUTION_OUTCOMES as readonly unknown[]).includes(value);
}

/**
 * One entry per thesisId. A resolved doc wins over an open doc for the same
 * thesis, which a record step that crashed between its writes leaves behind.
 * A doc that names no thesis, arm or campaign is not part of any campaign's
 * table.
 */
export function readLedgerTheses(docs: readonly ThesisLedgerDoc[]): LedgerThesis[] {
  const byId = new Map<string, LedgerThesis>();
  for (const doc of docs) {
    const resolved = doc.path.startsWith(THESIS_RESOLVED_PREFIX);
    if (!resolved && !doc.path.startsWith(THESIS_OPEN_PREFIX)) continue;
    const body = parseObject(doc.content);
    if (!body) continue;
    const thesisId = nonEmptyString(body['thesisId']);
    const hypothesisId = nonEmptyString(body['hypothesisId']);
    const regimeName = nonEmptyString(body['regimeName']);
    if (!thesisId || !hypothesisId || !regimeName) continue;
    const outcome = resolved ? body['outcome'] : null;
    if (resolved && !isOutcome(outcome)) continue;
    if (!resolved && byId.get(thesisId)?.outcome) continue;
    byId.set(thesisId, {
      thesisId,
      hypothesisId,
      regimeName,
      openedTradingDay: nonEmptyString(body['openedTradingDay']),
      outcome: isOutcome(outcome) ? outcome : null,
    });
  }
  return [...byId.values()];
}

function emptyRow(hypothesisId: string): ArmRow {
  return {
    hypothesisId,
    opened: 0,
    open: 0,
    resolved: { confirmed: 0, falsified: 0, tactical_exit: 0, expired: 0, entry_failed: 0 },
  };
}

/**
 * The table for one campaign, one row per arm in the order given: theses
 * opened, theses not yet resolved, and resolutions by outcome. `opened` is
 * always `open` plus every resolution.
 */
export function computeArmTable(
  docs: readonly ThesisLedgerDoc[],
  scope: { regimeName: string; hypothesisIds: readonly string[] },
): ArmRow[] {
  const rows = scope.hypothesisIds.map(emptyRow);
  const byArm = new Map(rows.map((row) => [row.hypothesisId, row]));
  for (const thesis of readLedgerTheses(docs)) {
    if (thesis.regimeName !== scope.regimeName) continue;
    const row = byArm.get(thesis.hypothesisId);
    if (!row) continue;
    row.opened += 1;
    if (thesis.outcome === null) row.open += 1;
    else row.resolved[thesis.outcome] += 1;
  }
  return rows;
}

const RecordArmTableSchema = z
  .object({
    armTable: z
      .object({
        regimeName: z.string(),
        arms: z.array(z.object({ hypothesisId: z.string() }).passthrough()),
      })
      .passthrough()
      .nullable(),
    snapshotDoc: z.object({ armTable: z.unknown().optional() }).passthrough(),
  })
  .passthrough();

/**
 * The record output's `armTable` must be the table the ledger gives, and the
 * snapshot must carry the same table. A shape the JSON Schema already refuses
 * yields no issue here.
 */
export function armTableIssues(
  data: unknown,
  docs: readonly ThesisLedgerDoc[],
): RuntimeValidatorIssue[] {
  const parsed = RecordArmTableSchema.safeParse(data);
  if (!parsed.success) return [];
  const { armTable, snapshotDoc } = parsed.data;
  const issues: RuntimeValidatorIssue[] = [];
  if (stableHash({ table: snapshotDoc.armTable ?? null }) !== stableHash({ table: armTable })) {
    issues.push({
      code: 'custom',
      path: ['snapshotDoc', 'armTable'],
      message: 'snapshotDoc.armTable must be the same table as armTable.',
    });
  }
  if (armTable === null) return issues;
  const expected = computeArmTable(docs, {
    regimeName: armTable.regimeName,
    hypothesisIds: armTable.arms.map((row) => row.hypothesisId),
  });
  const seen = new Set<string>();
  armTable.arms.forEach((row, i) => {
    if (seen.has(row.hypothesisId)) {
      issues.push({
        code: 'custom',
        path: ['armTable', 'arms', i, 'hypothesisId'],
        message: `arm "${row.hypothesisId}" has more than one row. Give each campaign hypothesis exactly one.`,
      });
      return;
    }
    seen.add(row.hypothesisId);
    const want = expected[i];
    if (!want || stableHash(row) === stableHash(want)) return;
    issues.push({
      code: 'custom',
      path: ['armTable', 'arms', i],
      message: `The thesis ledger gives ${JSON.stringify(want)} for arm "${want.hypothesisId}". The table counts the thesis docs as they stand after this cycle's writes. Set the row to the ledger's count.`,
    });
  });
  return issues;
}

/** Every open and resolved thesis doc of one space. */
export async function loadThesisLedgerDocs(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<ThesisLedgerDoc[]> {
  const tenantContext = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ path: memoryDocs.path, content: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          isNull(memoryDocs.deletedAt),
          or(
            like(memoryDocs.path, `${THESIS_OPEN_PREFIX}%`),
            like(memoryDocs.path, `${THESIS_RESOLVED_PREFIX}%`),
          ),
        ),
      ),
  );
}

async function armTableValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const armTable = (data as { armTable?: unknown } | null)?.armTable;
  const docs =
    armTable === null || armTable === undefined
      ? []
      : await loadThesisLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
  return armTableIssues(data, docs);
}

registerRuntimeValidator(TRADING_ARM_TABLE_VALIDATOR_REF, armTableValidator);
