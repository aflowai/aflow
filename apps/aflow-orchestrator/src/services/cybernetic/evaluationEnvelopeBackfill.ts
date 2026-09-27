/**
 * Null-envelope backfill (Plan 269 D16, the "known accepted window").
 *
 * The evaluation envelope is written by the in-process post-run hook after
 * the run's terminal CAS commits — a worker crash between the two leaves a
 * terminal run with no envelope, and orphan reconciliation only examines
 * non-terminal runs. This pass drains terminal cybernetic runs past a grace
 * window whose `evaluation_json` is still NULL and records a decision for
 * each, split by the envelope era boundary (derived from the rows, never a
 * hardcoded date) only to say WHY the envelope is missing.
 *
 * **The pass records a decision; it never re-runs evaluation.** The hook's
 * paid and irreversible effects — judge model calls, the hook-failed event,
 * score and candidate-learning materialization, Coach and campaign-end
 * triggers — all run BEFORE the envelope write, so a NULL envelope cannot
 * distinguish "nothing happened" from "everything happened and the write was
 * lost". Most of the hook's wall clock sits at or after the judge call, so
 * that is where a crash most often lands. Re-firing would buy a second
 * evaluation for the minority case at the cost of double-charging the
 * operator and feeding the learning loop duplicate evidence in the majority
 * one — and a corrupted learning loop is worse than a thinner one, because
 * nothing downstream can tell the duplicate from the original.
 *
 * The invariant D16 actually owes is unchanged: every terminal cybernetic run
 * carries an evaluation decision. A run whose hook died carries `error` with
 * the reason, which is the honest record — not a silently re-run evaluation
 * whose side effects already happened once.
 */
import {
  getEarliestEnvelopeDecidedAt,
  listRunsMissingEvaluationEnvelope,
  loadEvalSuite,
  partitionEnvelopeBackfillCandidates,
  selectEnvelopeBackfillCandidates,
  writeRunEvaluationEnvelope,
  type EnvelopeBackfillCandidateRow,
} from '@aflow/cybernetic-runtime';
import type { TenantId } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../lib/orchestratorLogger.js';
import type { HarnessDeps } from './harness/types.js';

/** Long enough that a live in-process hook has certainly landed or died. */
const DEFAULT_BACKFILL_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_BACKFILL_LIMIT = 25;

const PRE_ENVELOPE_BACKFILL_NOTE =
  'Run reached terminal state before the evaluation envelope existed; ' +
  'the backfill recorded this decision without re-running evaluation.';

const INTERRUPTED_HOOK_NOTE =
  'The post-run hook did not complete for this run, so its evaluation outcome was never recorded. ' +
  'Evaluation was not re-run: the hook spends money and writes learning evidence before the ' +
  'envelope, so a repeat could double both.';

export interface BackfillEnvelopesResult {
  /** NULL-envelope terminal runs seen (pre grace-window cut). */
  scanned: number;
  /** Runs whose post-run hook died mid-flight and got a decision recorded. */
  crashWindowWrites: number;
  /** Pre-envelope historical runs that got a plain decision write. */
  historicalPlainWrites: number;
  /** Runs that threw while their decision was written. */
  errors: number;
}

export async function backfillMissingEvaluationEnvelopes(
  deps: HarnessDeps,
  tenantId: TenantId,
  opts: { limit?: number; graceMs?: number; now?: Date } = {},
): Promise<BackfillEnvelopesResult> {
  const tenantIdStr = tenantId as string;
  const limit = opts.limit ?? DEFAULT_BACKFILL_LIMIT;
  const graceMs = opts.graceMs ?? DEFAULT_BACKFILL_GRACE_MS;
  const now = opts.now ?? new Date();
  const log = getOrchestratorLogger().child({
    component: 'evaluationEnvelopeBackfill',
    tenantId: tenantIdStr,
  });

  const result: BackfillEnvelopesResult = {
    scanned: 0,
    crashWindowWrites: 0,
    historicalPlainWrites: 0,
    errors: 0,
  };

  // Over-fetch so rows inside the grace window can't starve older ones out of
  // the page — the pure selection applies the window, and every survivor is a
  // single cheap write, so the whole fetched page drains in one pass.
  const rows = await listRunsMissingEvaluationEnvelope(deps.db, tenantIdStr, {
    limit: limit * 2,
  });
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const eligible = selectEnvelopeBackfillCandidates(rows, { now, graceMs, limit: rows.length });
  if (eligible.length === 0) return result;

  const envelopeEraStart = await getEarliestEnvelopeDecidedAt(deps.db, tenantIdStr);
  const { historical, crashWindow } = partitionEnvelopeBackfillCandidates(eligible, {
    envelopeEraStart,
  });

  for (const candidate of historical) {
    try {
      await writeMissingEnvelope(deps, tenantIdStr, candidate, PRE_ENVELOPE_BACKFILL_NOTE);
      result.historicalPlainWrites += 1;
    } catch (err) {
      logOrchestratorError(
        `[evaluationEnvelopeBackfill] historical plain write failed: run=${candidate.runId}`,
        err,
        { tenantId: tenantIdStr, runId: candidate.runId },
      );
      result.errors += 1;
    }
  }

  for (const candidate of crashWindow) {
    try {
      await writeMissingEnvelope(deps, tenantIdStr, candidate, INTERRUPTED_HOOK_NOTE);
      result.crashWindowWrites += 1;
    } catch (err) {
      logOrchestratorError(
        `[evaluationEnvelopeBackfill] crash-window write failed: run=${candidate.runId}`,
        err,
        { tenantId: tenantIdStr, runId: candidate.runId },
      );
      result.errors += 1;
    }
  }

  if (result.crashWindowWrites > 0 || result.historicalPlainWrites > 0 || result.errors > 0) {
    log.info(
      `[evaluationEnvelopeBackfill] scanned=${String(result.scanned)} ` +
        `crashWindow=${String(result.crashWindowWrites)} ` +
        `historical=${String(result.historicalPlainWrites)} errors=${String(result.errors)}`,
    );
  }
  return result;
}

/**
 * The decision for a run whose envelope is missing, picked honestly:
 * `no_suite` when the workflow has no suite (nothing would have been
 * evaluated either way, so the run loses nothing), else `error` carrying the
 * reason it is missing. Never re-runs evaluation.
 */
async function writeMissingEnvelope(
  deps: HarnessDeps,
  tenantId: string,
  candidate: EnvelopeBackfillCandidateRow,
  errorMessage: string,
): Promise<void> {
  const suite = await loadEvalSuite(deps.db, tenantId, candidate.spaceId, candidate.workflowSlug);
  await writeRunEvaluationEnvelope(deps.db, tenantId, {
    runId: candidate.runId,
    write:
      suite === null
        ? { kind: 'decision', decision: 'no_suite' }
        : { kind: 'decision', decision: 'error', errorMessage },
  });
}
