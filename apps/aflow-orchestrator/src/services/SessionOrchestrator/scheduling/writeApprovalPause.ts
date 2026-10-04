import type { Redis } from 'ioredis';
import { getWriteApprovalGrant } from '@aflow/redis';
import {
  type AflowError,
  grantAnswersAsk,
  WriteApprovalRequestPayloadSchema,
  type WriteApprovalRequestPayload,
  type SessionBlockedOn,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * Best-effort read of an executor-supplied `write_approval` request payload from
 * a paused step's `requestedInputRef`. Returns `null` for any other paused-step
 * contract (the common path), so this only fires for an approval pause — an
 * API write (Plan 253) or a browser action (Plan 320 D7).
 */
export async function readWriteApprovalRequest(
  payloadStore: PayloadStore,
  requestedInputRef: string,
): Promise<WriteApprovalRequestPayload | null> {
  try {
    const raw = await payloadStore.retrieve(requestedInputRef as never);
    if (typeof raw !== 'object' || raw === null) return null;
    if ((raw as Record<string, unknown>)['kind'] !== 'write_approval') return null;
    const parsed = WriteApprovalRequestPayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the typed `needs_write_approval` blockedOn for a paused step, or
 * `null` when the step is not an approval pause. The orchestrator threads the
 * result into `waitForInput` so the session parks with the cause the Action
 * Center surfaces as an approve/deny prompt.
 */
export async function resolveWriteApprovalBlockedOn(
  payloadStore: PayloadStore,
  requestedInputRef: string | null | undefined,
  stepExecutionId: string,
): Promise<SessionBlockedOn | null> {
  if (!requestedInputRef) return null;
  const request = await readWriteApprovalRequest(payloadStore, requestedInputRef);
  if (!request) return null;
  if (request.target === 'browser') {
    return {
      kind: 'needs_write_approval',
      target: 'browser',
      stepExecutionId,
      profileId: request.profileId,
      pageOrigin: request.pageOrigin,
      action: request.action,
      elementRole: request.element.role,
      ...(request.element.name !== undefined ? { elementName: request.element.name } : {}),
      requestHash: request.requestHash,
    };
  }
  return {
    kind: 'needs_write_approval',
    target: 'api',
    stepExecutionId,
    apiId: request.apiId,
    endpointId: request.endpointId,
    method: request.method,
    urlHost: request.urlHost,
    writeRiskTier: request.writeRiskTier,
    requestHash: request.requestHash,
  };
}

/** What a resume of a step parked on an approval does. */
export type WriteApprovalResume =
  /** No authenticated decision answers the pause: this resume is not one, so the step stays paused. */
  | { readonly decision: 'undecided' }
  /** Re-dispatch; the executor finds the same grant and proceeds. */
  | { readonly decision: 'approved' }
  /** Fail the step with this error, which the agent reads as final. */
  | { readonly decision: 'denied'; readonly error: AflowError };

/**
 * The single authority on a resume of an approval pause: the grant the
 * authenticated Action Center resolve wrote, keyed by run and the request's
 * hash — never the resume input, which a scheduled `{}` wake or an
 * agent-driven resume could forge. A grant decides only a pause raised before
 * it was made: a browser request asked again after its approval was spent
 * still has that approval on record, and reading it as an answer would
 * re-dispatch the step only for it to ask again. `null` when the step is not
 * an approval pause.
 */
export async function decideWriteApprovalResume(
  deps: { readonly payloadStore: PayloadStore; readonly redis: Redis },
  params: {
    readonly tenantId: string;
    readonly runId: string;
    readonly requestedInputRef: string;
  },
): Promise<WriteApprovalResume | null> {
  const request = await readWriteApprovalRequest(deps.payloadStore, params.requestedInputRef);
  if (!request) return null;
  const grant = await getWriteApprovalGrant(
    deps.redis,
    params.tenantId,
    params.runId,
    request.requestHash,
  );
  const decidedBefore = request.target === 'browser' ? request.decidedBefore : undefined;
  if (!grant || !grantAnswersAsk(grant, decidedBefore)) return { decision: 'undecided' };
  if (grant.decision === 'approved') return { decision: 'approved' };
  return { decision: 'denied', error: writeApprovalDenial(request, grant.reason) };
}

/**
 * The step's error when the operator denied it. `permission` is load-bearing:
 * toAgentToolError maps it to retry:false, so the agent sees a firm denial
 * rather than a retryable system error. The message is self-contained because
 * the agent envelope is lossy, and carries the operator's reason — the part
 * that tells the agent what to change — when one was given.
 */
export function writeApprovalDenial(
  request: WriteApprovalRequestPayload,
  reason: string | undefined,
): AflowError {
  const because = reason ? `. Operator's reason: "${reason}"` : '';
  const message =
    request.target === 'browser'
      ? `The operator denied this ${request.action} on ${request.pageOrigin} in the Action ` +
        `Center${because}. It is not a system error, and the same action on the same element ` +
        'with the same value is refused with this reason rather than asked again. Use the ' +
        'reason to decide what to do: propose a different action, or tell the user it was ' +
        'declined and ask how to proceed.'
      : 'This write was denied by a human operator in the Action Center' +
        because +
        '. It is not a system error and will NOT succeed on retry — do not call this ' +
        'endpoint again with the same request. Use the operator’s reason to decide what to ' +
        'do: adjust and propose a different action, or tell the user it was declined and ask ' +
        'how to proceed.';
  return {
    code: 'write_approval_denied',
    classification: 'permission',
    retryable: false,
    message,
    timestamp: new Date().toISOString(),
  };
}
