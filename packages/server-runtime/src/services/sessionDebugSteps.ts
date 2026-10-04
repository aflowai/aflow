/**
 * The status of each step a session injected, read from its events newest
 * first.
 *
 * A session's step list outlives any one page of its events: a long
 * conversation names hundreds of steps, and a page from either end of its
 * history covers only some of them. Walking back from the newest event until
 * every step has been placed is what lets the debug view report a status for
 * each one instead of leaving the older ones blank.
 */

export interface StepEventLike {
  eventType: string;
  stepExecutionId?: string | undefined;
  timestamp: string;
  data: { stepId?: string | undefined; [key: string]: unknown };
  metadata?: Record<string, unknown> | undefined;
}

export interface StepEventPage<E extends StepEventLike> {
  /** Chronological, oldest first. */
  events: E[];
  olderCursor?: string | undefined;
  hasOlder: boolean;
}

export type FoldedStepStatus = 'SCHEDULED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PAUSED';

export interface FoldedStep {
  status: FoldedStepStatus;
  stepExecutionId?: string;
  errorMessage?: string;
  durationMs?: number;
}

export interface StepStatusScan {
  steps: Map<string, FoldedStep>;
  /** Events read to place them. */
  eventsRead: number;
  /** Every step was placed, or the walk reached the start of the history. */
  complete: boolean;
}

/** How far back the walk goes before it stops and says so. */
export const STEP_STATUS_SCAN_MAX_EVENTS = 10_000;
export const STEP_STATUS_PAGE_SIZE = 500;

const STATUS_OF_EVENT: Readonly<Record<string, FoldedStepStatus>> = {
  StepSucceeded: 'SUCCEEDED',
  StepFailed: 'FAILED',
  StepPaused: 'PAUSED',
  StepStarted: 'RUNNING',
  StepScheduled: 'SCHEDULED',
};

interface Placing extends FoldedStep {
  endedAtMs?: number;
}

function errorMessageOf(event: StepEventLike): string | undefined {
  const fromMeta = event.metadata?.['errorMessage'];
  if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta;
  const fromData = event.data['errorMessage'];
  return typeof fromData === 'string' && fromData !== '' ? fromData : undefined;
}

/**
 * Walks pages back from `newest` until each id in `stepIds` has been seen
 * scheduled — its earliest event, so its latest status is already known — or
 * the history or the bound runs out.
 */
export async function scanStepStatuses<E extends StepEventLike>(
  stepIds: ReadonlySet<string>,
  newest: StepEventPage<E>,
  readOlder: (cursor: string) => Promise<StepEventPage<E> | undefined>,
  maxEvents: number = STEP_STATUS_SCAN_MAX_EVENTS,
): Promise<StepStatusScan> {
  const placing = new Map<string, Placing>();
  const settled = new Set<string>();
  let eventsRead = 0;
  let page: StepEventPage<E> | undefined = newest;
  let complete = stepIds.size === 0;

  while (page !== undefined && !complete) {
    for (let i = page.events.length - 1; i >= 0; i--) {
      const event = page.events[i]!;
      eventsRead++;
      const stepId = event.data.stepId;
      if (stepId === undefined || !stepIds.has(stepId) || settled.has(stepId)) continue;
      const status = STATUS_OF_EVENT[event.eventType];
      if (status === undefined) continue;

      const atMs = new Date(event.timestamp).getTime();
      let entry = placing.get(stepId);
      if (entry === undefined) {
        entry = { status };
        if (event.stepExecutionId) entry.stepExecutionId = event.stepExecutionId;
        if (status === 'FAILED') {
          const message = errorMessageOf(event);
          if (message !== undefined) entry.errorMessage = message;
        }
        if ((status === 'SUCCEEDED' || status === 'FAILED') && Number.isFinite(atMs)) {
          entry.endedAtMs = atMs;
        }
        placing.set(stepId, entry);
      }
      if (status === 'SCHEDULED') {
        if (entry.endedAtMs !== undefined && Number.isFinite(atMs)) {
          entry.durationMs = entry.endedAtMs - atMs;
        }
        settled.add(stepId);
        if (settled.size === stepIds.size) {
          complete = true;
          break;
        }
      }
    }
    if (complete) break;
    if (!page.hasOlder || page.olderCursor === undefined) {
      complete = true;
      break;
    }
    if (eventsRead >= maxEvents) break;
    page = await readOlder(page.olderCursor);
  }

  const steps = new Map<string, FoldedStep>();
  for (const [stepId, placed] of placing) {
    const step: FoldedStep = { status: placed.status };
    if (placed.stepExecutionId !== undefined) step.stepExecutionId = placed.stepExecutionId;
    if (placed.errorMessage !== undefined) step.errorMessage = placed.errorMessage;
    if (placed.durationMs !== undefined) step.durationMs = placed.durationMs;
    steps.set(stepId, step);
  }
  return { steps, eventsRead, complete };
}
