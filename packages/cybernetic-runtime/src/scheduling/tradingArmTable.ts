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
 * a number an agent supplies. The record contract runs this rule on every
 * slot, so a thesis doc that lacks either field is refused in the cycle that
 * wrote it.
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

/** A ledger doc the reader refuses, with what it lacks. */
export interface RefusedLedgerDoc {
  path: string;
  reason: string;
}

export interface LedgerReading {
  theses: LedgerThesis[];
  /** Every doc under the ledger prefixes that is not a complete thesis doc. */
  refused: RefusedLedgerDoc[];
}

const REQUIRED_THESIS_DOC_FIELDS = ['thesisId', 'regimeName', 'hypothesisId'] as const;

function refusalReason(body: Record<string, unknown> | null, resolved: boolean): string | null {
  // A doc over the inline threshold is stored by reference, so it reads as
  // null here and is refused rather than counted as absent.
  if (!body) return 'its content is not an inline JSON object';
  const missing = REQUIRED_THESIS_DOC_FIELDS.filter(
    (field) => nonEmptyString(body[field]) === null,
  );
  if (missing.length > 0) return `it has no ${missing.join(', ')}`;
  if (resolved && !isOutcome(body['outcome'])) {
    return `its outcome is not one of ${ARM_RESOLUTION_OUTCOMES.join(', ')}`;
  }
  return null;
}

/**
 * One entry per thesisId. A resolved doc wins over an open doc for the same
 * thesis, which a record step that crashed between its writes leaves behind.
 * A doc under the ledger prefixes that names no thesis, arm or campaign is
 * refused, never skipped: a skipped doc would undercount every number the
 * ledger gives.
 */
export function readLedgerTheses(docs: readonly ThesisLedgerDoc[]): LedgerReading {
  const byId = new Map<string, LedgerThesis>();
  const refused: RefusedLedgerDoc[] = [];
  for (const doc of docs) {
    const resolved = doc.path.startsWith(THESIS_RESOLVED_PREFIX);
    if (!resolved && !doc.path.startsWith(THESIS_OPEN_PREFIX)) continue;
    const body = parseObject(doc.content);
    const reason = refusalReason(body, resolved);
    if (body === null || reason !== null) {
      refused.push({ path: doc.path, reason: reason ?? 'it is not a thesis doc' });
      continue;
    }
    const thesisId = body['thesisId'] as string;
    if (!resolved && byId.get(thesisId)?.outcome) continue;
    const outcome = body['outcome'];
    byId.set(thesisId, {
      thesisId,
      hypothesisId: body['hypothesisId'] as string,
      regimeName: body['regimeName'] as string,
      openedTradingDay: nonEmptyString(body['openedTradingDay']),
      outcome: resolved && isOutcome(outcome) ? outcome : null,
    });
  }
  return { theses: [...byId.values()], refused };
}

/**
 * One issue per refused ledger doc. The record task writes every thesis doc,
 * so its remedy is to rewrite the doc with the missing field.
 */
export function refusedLedgerDocIssues(
  refused: readonly RefusedLedgerDoc[],
): RuntimeValidatorIssue[] {
  return refused.map((doc) => ({
    code: 'custom' as const,
    path: [],
    message: `The thesis ledger doc ${doc.path} cannot be counted: ${doc.reason}. Every doc under ${THESIS_OPEN_PREFIX} and ${THESIS_RESOLVED_PREFIX} carries a non-empty thesisId, regimeName and hypothesisId, and a resolved doc carries its outcome. Rewrite the doc with them.`,
  }));
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
  theses: readonly LedgerThesis[],
  scope: { regimeName: string; hypothesisIds: readonly string[] },
): ArmRow[] {
  const rows = scope.hypothesisIds.map(emptyRow);
  const byArm = new Map(rows.map((row) => [row.hypothesisId, row]));
  for (const thesis of theses) {
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
 * Every record output, whatever its slot, leaves a ledger of complete thesis
 * docs. On after_close its `armTable` must also be the table that ledger
 * gives, and the snapshot must carry the same table. A shape the JSON Schema
 * already refuses yields no issue here.
 */
export function armTableIssues(
  data: unknown,
  docs: readonly ThesisLedgerDoc[],
): RuntimeValidatorIssue[] {
  const parsed = RecordArmTableSchema.safeParse(data);
  if (!parsed.success) return [];
  const { armTable, snapshotDoc } = parsed.data;
  const ledger = readLedgerTheses(docs);
  const issues = refusedLedgerDocIssues(ledger.refused);
  if (stableHash({ table: snapshotDoc.armTable ?? null }) !== stableHash({ table: armTable })) {
    issues.push({
      code: 'custom',
      path: ['snapshotDoc', 'armTable'],
      message: 'snapshotDoc.armTable must be the same table as armTable.',
    });
  }
  if (armTable === null || ledger.refused.length > 0) return issues;
  const expected = computeArmTable(ledger.theses, {
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
  if (!RecordArmTableSchema.safeParse(data).success) return [];
  const docs = await loadThesisLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
  return armTableIssues(data, docs);
}

registerRuntimeValidator(TRADING_ARM_TABLE_VALIDATOR_REF, armTableValidator);
