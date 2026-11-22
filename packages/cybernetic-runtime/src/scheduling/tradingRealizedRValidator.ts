import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import { loadThesisLedgerDocs, type ThesisLedgerDoc } from './tradingArmTable.js';

/**
 * A resolved thesis's realized R is arithmetic over three recorded prices,
 * never a number an agent supplies. The Daily Trading Cycle's record step
 * writes it on each resolved doc, and this rule recomputes it from that doc's
 * entryFillPrice, invalidationLevel and closeOrder.filledAvgPrice, and
 * refuses another value. Each arm's expectancy rests on it.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_REALIZED_R_VALIDATOR_REF = 'trading.realized-r' as const;

/** How far a recorded R may sit from the recomputed one: rounding, never a different number. */
export const REALIZED_R_TOLERANCE = 0.001;

const RESOLVED_PREFIX = '/portfolio/theses/resolved/';

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** The realized R a resolved doc's own fields give, with why it is null where it is. */
export function expectedRealizedR(body: Record<string, unknown>): {
  value: number | null;
  why: string;
} {
  if (body['outcome'] === 'entry_failed') {
    return { value: null, why: 'an entry_failed resolution never filled' };
  }
  const entry = positive(body['entryFillPrice']);
  const invalidation = positive(body['invalidationLevel']);
  const close = body['closeOrder'];
  const exit =
    close !== null && typeof close === 'object'
      ? positive((close as Record<string, unknown>)['filledAvgPrice'])
      : null;
  if (entry === null) return { value: null, why: 'the doc holds no entryFillPrice' };
  if (invalidation === null) return { value: null, why: 'the doc holds no invalidationLevel' };
  if (exit === null) return { value: null, why: 'its close has no filledAvgPrice yet' };
  const long = body['direction'] !== 'short';
  const risk = long ? entry - invalidation : invalidation - entry;
  if (risk <= 0) {
    return { value: null, why: 'its invalidationLevel leaves no risk on the entry fill' };
  }
  return { value: (long ? exit - entry : entry - exit) / risk, why: '' };
}

const RecordViewSchema = z
  .object({
    resolvedDocPaths: z.array(z.string()),
    cycleDoc: z
      .object({
        thesesResolved: z.array(z.object({ thesisId: z.string() }).passthrough()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

function bodyOf(doc: ThesisLedgerDoc | undefined): Record<string, unknown> | null {
  if (doc?.content == null) return null;
  try {
    const parsed: unknown = JSON.parse(doc.content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const close = (a: unknown, b: number | null): boolean =>
  b === null ? a === null : typeof a === 'number' && Math.abs(a - b) <= REALIZED_R_TOLERANCE;

const shown = (value: number | null) => (value === null ? 'null' : value.toFixed(4));

/**
 * Every resolved doc this record step wrote carries the realized R its own
 * fields give, and the cycle doc cites the same value for each thesis it
 * resolved. A doc stored by reference reads as null here and is left to the
 * arm-table rule, which refuses it.
 */
export function realizedRIssues(
  data: unknown,
  docs: readonly ThesisLedgerDoc[],
): RuntimeValidatorIssue[] {
  const view = RecordViewSchema.safeParse(data);
  if (!view.success) return [];
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const issues: RuntimeValidatorIssue[] = [];
  const recorded = new Map<string, unknown>();
  for (const path of view.data.resolvedDocPaths) {
    const body = bodyOf(byPath.get(path));
    if (body === null) continue;
    const want = expectedRealizedR(body);
    const got = body['realizedR'];
    recorded.set(path, got);
    if (close(got, want.value)) continue;
    issues.push({
      code: 'custom',
      path: ['resolvedDocPaths', view.data.resolvedDocPaths.indexOf(path)],
      message:
        want.value === null
          ? `The resolved doc ${path} must carry realizedR null: ${want.why}. Rewrite it with realizedR null.`
          : `The resolved doc ${path} carries realizedR ${JSON.stringify(got ?? null)}, but its entryFillPrice, invalidationLevel and closeOrder.filledAvgPrice give ${shown(want.value)}. Rewrite it with realizedR ${shown(want.value)}.`,
    });
  }
  (view.data.cycleDoc.thesesResolved ?? []).forEach((item, i) => {
    const path = `${RESOLVED_PREFIX}${item.thesisId}.json`;
    if (!recorded.has(path)) return;
    const onDoc = recorded.get(path);
    const want = typeof onDoc === 'number' ? onDoc : null;
    if (close(item['realizedR'] ?? null, want)) return;
    issues.push({
      code: 'custom',
      path: ['cycleDoc', 'thesesResolved', i, 'realizedR'],
      message: `The resolved doc of thesis "${item.thesisId}" carries realizedR ${shown(want)}. Cite the same value.`,
    });
  });
  return issues;
}

async function realizedRValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  if (!RecordViewSchema.safeParse(data).success) return [];
  const docs = await loadThesisLedgerDocs(ctx.db as PostgresJsDatabase, ctx.tenantId, ctx.spaceId);
  return realizedRIssues(data, docs);
}

registerRuntimeValidator(TRADING_REALIZED_R_VALIDATOR_REF, realizedRValidator);
