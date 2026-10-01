import {
  WorkflowRunWakeupEnvelopeSchema,
  type WaiterNotifiedOutcome,
  type WorkflowRunWakeupEnvelope,
} from '@aflow/schemas';
import { decodeInlinePayload } from '../../lib/fetch-payload.js';
import type { WorkflowSurfaceRunStatus } from '../../lib/types.js';
import {
  HANDED_OFF_RUN,
  orbForRunStatus,
  runPill,
  type OrbKind,
  type PillTone,
} from '../workflow-run-surface/workflowRunSurfaceHelpers.js';

export interface RunWakeupView {
  orb: OrbKind;
  pill: { label: string; tone: PillTone };
  /** What happened, in a few words. */
  headline: string;
  /** The one line the envelope carries for it, when it carries one. */
  line: string | undefined;
}

const RUN_STATUS_BY_OUTCOME: Record<
  Exclude<WaiterNotifiedOutcome, 'handed_off'>,
  WorkflowSurfaceRunStatus
> = {
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const HEADLINE: Record<WaiterNotifiedOutcome, string> = {
  paused: 'Paused with a decision to make',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  handed_off: 'Handed to another session',
};

export function readRunWakeupEnvelope(data: unknown): WorkflowRunWakeupEnvelope | undefined {
  const parsed = WorkflowRunWakeupEnvelopeSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The envelope an `inline:` reference carries. Read during render, where a
 * decode error would take the card down rather than reject a fetch, so a
 * reference that does not decode carries none.
 */
export function readInlineRunWakeupEnvelope(ref: string): WorkflowRunWakeupEnvelope | undefined {
  let decoded: unknown;
  try {
    decoded = decodeInlinePayload(ref);
  } catch {
    return undefined;
  }
  return readRunWakeupEnvelope(decoded);
}

function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line === undefined || line.length === 0 ? undefined : line;
}

function envelopeLine(
  outcome: WaiterNotifiedOutcome,
  envelope: WorkflowRunWakeupEnvelope | undefined,
): string | undefined {
  if (envelope === undefined) return undefined;
  switch (outcome) {
    case 'paused':
      return firstLine(envelope.pause?.reason);
    case 'completed':
    case 'failed':
      return firstLine(envelope.result?.summary);
    case 'cancelled': {
      const reason = firstLine(envelope.cancellation?.reason);
      if (reason !== undefined) return reason;
      return envelope.cancellation?.cancelledBy === 'operator'
        ? 'Stopped by an operator.'
        : undefined;
    }
    case 'handed_off':
      return undefined;
  }
}

/**
 * How a run's wakeup reads in the transcript. The outcome comes from the event
 * itself, so the card says what happened before the envelope has loaded.
 */
export function describeRunWakeup(
  outcome: WaiterNotifiedOutcome,
  envelope: WorkflowRunWakeupEnvelope | undefined,
): RunWakeupView {
  const headline = HEADLINE[outcome];
  const line = envelopeLine(outcome, envelope);
  if (outcome === 'handed_off') return { ...HANDED_OFF_RUN, headline, line };
  const status = RUN_STATUS_BY_OUTCOME[outcome];
  return { orb: orbForRunStatus(status), pill: runPill(status), headline, line };
}
