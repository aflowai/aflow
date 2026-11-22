import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import {
  lensAggregateIssues,
  lensReviewsPathOf,
  type LensReviewsRead,
} from '@aflow/platform-artifacts';
import { readApprovedSet } from './tradingApprovedThesesValidator.js';

/**
 * The Strategy Desk folds its six lens reviews into one approved set by the
 * veto rule. Its aggregate Runner submits the fold, and this rule refuses any
 * value the rule does not give over the lens verdicts the review run itself
 * wrote to memory. The record is read with the writer the memory store
 * recorded, so only a doc a task of this run wrote counts.
 *
 * The ref is spelled here, not read from the skill at load, because suites
 * that mock `@aflow/platform-artifacts` still load this module.
 */
export const TRADING_LENS_AGGREGATE_VALIDATOR_REF = 'trading.lens-aggregate' as const;

export async function readLensReviews(
  ctx: RuntimeValidatorContext,
  path: string,
): Promise<LensReviewsRead> {
  const read = await readApprovedSet(ctx, path);
  if (read.status !== 'found') return { doc: read, writerRunIds: [] };
  const writer = read.writer;
  // A conversation that drives a run is never its writer, and the operator writes no lens verdict.
  const writerRunIds =
    writer.kind === 'session' && writer.drivenRuns.length === 0
      ? writer.runs.map((run) => run.runId)
      : [];
  return { doc: { status: 'found', content: read.content }, writerRunIds };
}

async function tradingLensAggregateValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const path = lensReviewsPathOf(data);
  const read: LensReviewsRead =
    path === null
      ? { doc: { status: 'missing' }, writerRunIds: [] }
      : await readLensReviews(ctx, path);
  return lensAggregateIssues(data, read, ctx.workflowRunId).map((issue) => ({
    code: 'custom' as const,
    ...issue,
  }));
}

registerRuntimeValidator(TRADING_LENS_AGGREGATE_VALIDATOR_REF, tradingLensAggregateValidator);
