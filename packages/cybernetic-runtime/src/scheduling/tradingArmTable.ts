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
 * a number an agent supplies. A doc written before arms existed names
 * neither: no arm can count it, so it is excluded and the table reports how
 * many were. The record contract runs this rule on every slot, so a doc that
 * names one field and lacks another is refused.
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
  /** The record output being checked names it in `openedDocPaths`. */
  writtenThisCycle: boolean;
}

/** A doc written before hypothesis arms: it names no campaign and no arm. */
export interface LegacyLedgerDoc {
  path: string;
  thesisId: string | null;
}

export interface LedgerReading {
  theses: LedgerThesis[];
  /** Excluded from every arm count, and reported by the arm table. */
  legacy: LegacyLedgerDoc[];
  /** Every doc that names its campaign or arm but is not a complete thesis doc. */
  refused: RefusedLedgerDoc[];
}

const REQUIRED_THESIS_DOC_FIELDS = ['thesisId', 'regimeName', 'hypothesisId'] as const;

/**
 * The arm fields arrived with the arms themselves, so a doc holding neither
 * key was written before them. A doc this cycle opened was written under the
 * arm schema whatever it holds, so it never reads as legacy.
 */
function isLegacyDoc(body: Record<string, unknown>, writtenThisCycle: boolean): boolean {
  return !writtenThisCycle && !('regimeName' in body) && !('hypothesisId' in body);
}

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
 * A legacy doc is set aside by path, never skipped unseen. Any other doc
 * that is not a complete thesis doc is refused: a skipped doc would
 * undercount every number the ledger gives.
 */
export function readLedgerTheses(
  docs: readonly ThesisLedgerDoc[],
  openedThisCycle: ReadonlySet<string> = new Set(),
): LedgerReading {
  const byId = new Map<string, LedgerThesis>();
  const legacy: LegacyLedgerDoc[] = [];
  const refused: RefusedLedgerDoc[] = [];
  for (const doc of docs) {
    const resolved = doc.path.startsWith(THESIS_RESOLVED_PREFIX);
    if (!resolved && !doc.path.startsWith(THESIS_OPEN_PREFIX)) continue;
    const body = parseObject(doc.content);
    const writtenThisCycle = openedThisCycle.has(doc.path);
    if (body !== null && isLegacyDoc(body, writtenThisCycle)) {
      legacy.push({ path: doc.path, thesisId: nonEmptyString(body['thesisId']) });
      continue;
    }
    const reason = refusalReason(body, resolved);
    if (body === null || reason !== null) {
      refused.push({
        path: doc.path,
        reason: reason ?? 'it is not a thesis doc',
        writtenThisCycle,
      });
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
  return { theses: [...byId.values()], legacy, refused };
}

/** The task whose output a refused doc blocks, which decides what it can honestly do. */
export type LedgerReader = 'record' | 'decide';

/**
 * Only a doc this cycle opened has an attribution the agent knows: its own
 * thesis carries it. Any other value would be invented, so the remedy for
 * every other doc goes to the operator.
 */
function refusalRemedy(doc: RefusedLedgerDoc, reader: LedgerReader): string {
  if (reader === 'decide') {
    return 'This task cannot repair the ledger. Submit no theses and name the doc in decisionRationale, because the operator must correct or remove it before any arm budget can be counted.';
  }
  if (doc.writtenThisCycle) {
    return 'This cycle opened it, and its thesis in your input carries the hypothesisId. Rewrite the doc with that hypothesisId and the campaign’s regimeName.';
  }
  return 'This cycle did not open it, so never fill a missing field with a value no ledger doc records for this thesis. If no doc records it, this output cannot pass until the operator corrects or removes the doc.';
}

/** One issue per refused ledger doc, with the remedy its reader can carry out. */
export function refusedLedgerDocIssues(
  refused: readonly RefusedLedgerDoc[],
  reader: LedgerReader,
): RuntimeValidatorIssue[] {
  return refused.map((doc) => ({
    code: 'custom' as const,
    path: [],
    message: `The thesis ledger doc ${doc.path} cannot be counted: ${doc.reason}. A doc that names its campaign or arm carries a non-empty thesisId, regimeName and hypothesisId, and a resolved doc carries its outcome. ${refusalRemedy(doc, reader)}`,
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
        legacyDocsExcluded: z.number(),
        arms: z.array(z.object({ hypothesisId: z.string() }).passthrough()),
      })
      .passthrough()
      .nullable(),
    snapshotDoc: z.object({ armTable: z.unknown().optional() }).passthrough(),
    openedDocPaths: z.array(z.string()).optional(),
    cycleDoc: z
      .object({
        thesesResolved: z
          .array(z.object({ thesisId: z.string(), hypothesisId: z.string().optional() }))
          .optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * The cycle doc cites, for each thesis it resolved, the arm its ledger doc
 * names, and no arm for a legacy thesis, which has none to cite.
 */
function resolvedArmIssues(
  resolvedTheses: ReadonlyArray<{ thesisId: string; hypothesisId?: string | undefined }>,
  ledger: LedgerReading,
): RuntimeValidatorIssue[] {
  const armOf = new Map(ledger.theses.map((t) => [t.thesisId, t.hypothesisId]));
  const legacyIds = new Set(ledger.legacy.map((doc) => doc.thesisId));
  const issues: RuntimeValidatorIssue[] = [];
  resolvedTheses.forEach((item, i) => {
    const path = ['cycleDoc', 'thesesResolved', i, 'hypothesisId'];
    const arm = armOf.get(item.thesisId);
    if (arm !== undefined && item.hypothesisId !== arm) {
      issues.push({
        code: 'custom',
        path,
        message: `The ledger doc of thesis "${item.thesisId}" names the arm "${arm}". Cite that arm.`,
      });
    } else if (arm === undefined && legacyIds.has(item.thesisId) && item.hypothesisId) {
      issues.push({
        code: 'custom',
        path,
        message: `Thesis "${item.thesisId}" was opened before hypothesis arms, and its ledger doc names no arm. Omit hypothesisId for it.`,
      });
    }
  });
  return issues;
}

/**
 * Every record output, whatever its slot, leaves a ledger in which every doc
 * that names its campaign or arm is complete, and every doc this cycle
 * opened names both. On after_close its `armTable` must also be the table
 * that ledger gives, with the count of legacy docs it excluded, and the
 * snapshot must carry the same table. A shape the JSON Schema already
 * refuses yields no issue here.
 */
export function armTableIssues(
  data: unknown,
  docs: readonly ThesisLedgerDoc[],
): RuntimeValidatorIssue[] {
  const parsed = RecordArmTableSchema.safeParse(data);
  if (!parsed.success) return [];
  const { armTable, snapshotDoc, openedDocPaths, cycleDoc } = parsed.data;
  const ledger = readLedgerTheses(docs, new Set(openedDocPaths ?? []));
  const issues = refusedLedgerDocIssues(ledger.refused, 'record');
  issues.push(...resolvedArmIssues(cycleDoc?.thesesResolved ?? [], ledger));
  if (stableHash({ table: snapshotDoc.armTable ?? null }) !== stableHash({ table: armTable })) {
    issues.push({
      code: 'custom',
      path: ['snapshotDoc', 'armTable'],
      message: 'snapshotDoc.armTable must be the same table as armTable.',
    });
  }
  if (armTable === null || ledger.refused.length > 0) return issues;
  if (armTable.legacyDocsExcluded !== ledger.legacy.length) {
    issues.push({
      code: 'custom',
      path: ['armTable', 'legacyDocsExcluded'],
      message: `The thesis ledger holds ${String(ledger.legacy.length)} docs written before hypothesis arms, which name no campaign and no arm. Set legacyDocsExcluded to ${String(ledger.legacy.length)}.`,
    });
  }
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
