import type { Redis } from 'ioredis';
import { getWriteApprovalGrant } from '@aflow/redis';
import {
  type AflowError,
  grantAnswersAsk,
  writeApprovalDenial,
  WriteApprovalRequestPayloadSchema,
  type WriteApprovalRequestPayload,
  type SessionBlockedOn,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * Best-effort read of an executor-supplied `write_approval` request payload from
 * a paused step's `requestedInputRef`. Returns `null` for any other paused-step
 * contract (the common path), so this only fires for an approval pause — an
 * API write (Plan 253), a browser action (Plan 320 D7) or a change to the
 * model runtime on this computer (Plan 323 D10).
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
  if (request.target === 'local_model') {
    return {
      kind: 'needs_write_approval',
      target: 'local_model',
      stepExecutionId,
      action: request.change.action,
      ...(request.modelName !== undefined ? { modelName: request.modelName } : {}),
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
  const decidedBefore = request.target === 'api' ? undefined : request.decidedBefore;
  if (!grant || !grantAnswersAsk(grant, decidedBefore)) return { decision: 'undecided' };
  if (grant.decision === 'approved') return { decision: 'approved' };
  return { decision: 'denied', error: writeApprovalDenial(request, grant.reason) };
}
