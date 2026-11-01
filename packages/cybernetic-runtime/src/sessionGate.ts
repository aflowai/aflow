/**
 * What a gate is: a paused session whose request waits on a person (Plan 338
 * D2). The attention block counts gates with `PAUSED_SESSIONS_SQL`, and the
 * projection moves the attention generation on a row that enters a gate,
 * leaves one or stands at another (`movesSessionGate`). Both read this rule,
 * so no row the count holds as a gate enters or leaves it without a bump.
 */
import { CanonicalOperationIds, type PauseType } from '@aflow/schemas';

/** The request a gate holds, as the Action Center's step source lists it. */
export type GateRequestKind = 'input' | 'approval' | 'oauth_consent' | 'write_approval';

/**
 * The request each user executor operation pauses for. The operation is read
 * before the pause type, because a pause type outlives the resume it was
 * stamped for: an ask can still carry the `user_input` of the chat turn before it.
 */
export const GATE_REQUEST_KIND_BY_OPERATION: Readonly<Record<string, GateRequestKind>> = {
  [CanonicalOperationIds.USER_INTERACTION_ASK]: 'input',
  [CanonicalOperationIds.USER_INTERACTION_APPROVE]: 'approval',
};

/** The request each gate pause type holds: a consent, and a write approval. */
export const GATE_REQUEST_KIND_BY_PAUSE_TYPE: Readonly<
  Partial<Record<PauseType, GateRequestKind>>
> = {
  oauth_consent: 'oauth_consent',
  approval: 'write_approval',
};

/**
 * The pause type a parent takes when its child's pause bubbles to it. The
 * parent then holds the child's request, so the step source lists the parent
 * by it. The count follows the chain down and counts each level wherever the
 * pause at its foot is a gate.
 */
export const BUBBLED_PAUSE_TYPE = 'subflow_waiting' satisfies PauseType;

/**
 * The request a session's own pause holds, or null where its pause asks no
 * person. A bubbled pause reads null here, because its request is its child's.
 */
export function gateRequestKind(
  operationId: string | null | undefined,
  pauseType: string | null | undefined,
): GateRequestKind | null {
  if (operationId != null) {
    const byOperation = GATE_REQUEST_KIND_BY_OPERATION[operationId];
    if (byOperation !== undefined) return byOperation;
  }
  if (pauseType == null) return null;
  return GATE_REQUEST_KIND_BY_PAUSE_TYPE[pauseType as PauseType] ?? null;
}

/** The columns of a session row that say whether, and at which step, it waits on a person. */
export interface SessionGateColumns {
  status: string | null;
  currentStepExecutionId?: string | null | undefined;
  /** The pause type the orchestrator stamped on the session's hot state. */
  pauseType?: string | null | undefined;
  /** The operation of the step the session is parked on. */
  operationId?: string | null | undefined;
}

/**
 * Whether the count can hold a row as a gate: the row is paused, and its own
 * pause asks a person or holds a child's bubbled pause. The count reads a
 * bubbled pause by the chain below it, which one row cannot show, so a bubbled
 * pause reads as a gate here. One that asks no person then moves the
 * generation for nothing and costs one rebuild. Reading it as no gate would
 * leave the count wrong until the cache expires.
 */
export function mayHoldSessionGate(columns: SessionGateColumns | undefined): boolean {
  if (columns?.status !== 'PAUSED') return false;
  if (columns.pauseType === BUBBLED_PAUSE_TYPE) return true;
  return gateRequestKind(columns.operationId, columns.pauseType) !== null;
}
