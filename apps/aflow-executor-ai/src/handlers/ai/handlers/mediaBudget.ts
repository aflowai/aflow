/**
 * The step budget and the provider poll budget for a video render are one
 * derivation, never two numbers.
 *
 * They were two, and the smaller one won: the executor reaped the step at its
 * flat default while the handler was still polling a render the provider had
 * already been paid for. Deriving the poll budget from the step budget makes
 * that impossible in both directions — including when an operator sets an
 * explicit step timeout, which no separate default could have accounted for.
 */
import { positiveMsEnv } from '@aflow/lib';
import { getAllOperations } from '@aflow/schemas';

/** The interval between provider polls. A budget below it cannot observe anything. */
export const VIDEO_POLL_INTERVAL_MS = 10_000;

/** Time reserved outside the poll loop: the submit call, artifact download, payload write. */
function deliveryMarginMs(): number {
  return positiveMsEnv('AI_VIDEO_DELIVERY_MARGIN_MS', 120_000);
}

function defaultPollBudgetMs(): number {
  return positiveMsEnv('AI_VIDEO_POLL_BUDGET_MS', 600_000);
}

export interface VideoBudget {
  /** What the executor gives the step. */
  stepBudgetMs: number;
  /** What the handler may spend waiting on the provider. Always strictly inside it. */
  pollBudgetMs: number;
}

/**
 * @param explicitStepTimeoutMs an operator-set step timeout, which wins over
 * the default in both directions and therefore also caps the poll budget.
 */
export function resolveVideoBudget(explicitStepTimeoutMs?: number): VideoBudget {
  const stepBudgetMs = explicitStepTimeoutMs ?? defaultPollBudgetMs() + deliveryMarginMs();
  return {
    stepBudgetMs,
    pollBudgetMs: Math.max(0, stepBudgetMs - deliveryMarginMs()),
  };
}

/**
 * Operations whose provider work outlives the request that starts it, read from
 * the registry rather than listed here. A hand-kept list drops an operation the
 * moment one is added, and the operation it drops gets the executor-wide flat
 * default — reaped mid-render, after the provider was paid.
 */
export const ASYNC_JOB_LIFECYCLE_OPERATIONS: ReadonlySet<string> = new Set(
  Array.from(getAllOperations().values())
    .filter((operation) => operation.ownsAsyncJobLifecycle)
    .map((operation) => operation.operationId),
);
