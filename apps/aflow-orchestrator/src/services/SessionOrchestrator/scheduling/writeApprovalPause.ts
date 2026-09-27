import {
  WriteApprovalRequestPayloadSchema,
  type WriteApprovalRequestPayload,
  type SessionBlockedOn,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * Best-effort read of an executor-supplied `write_approval` request payload from
 * a paused step's `requestedInputRef`. Returns `null` for any other paused-step
 * contract (the common path), so this only fires for the write-approval pause
 * (Plan 253).
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
 * `null` when the step is not a write-approval pause. The orchestrator threads
 * the result into `waitForInput` so the session parks with the cause the Action
 * Center surfaces as a "approve this write" prompt.
 */
export async function resolveWriteApprovalBlockedOn(
  payloadStore: PayloadStore,
  requestedInputRef: string | null | undefined,
  stepExecutionId: string,
): Promise<SessionBlockedOn | null> {
  if (!requestedInputRef) return null;
  const request = await readWriteApprovalRequest(payloadStore, requestedInputRef);
  if (!request) return null;
  return {
    kind: 'needs_write_approval',
    stepExecutionId,
    apiId: request.apiId,
    endpointId: request.endpointId,
    method: request.method,
    urlHost: request.urlHost,
    writeRiskTier: request.writeRiskTier,
    requestHash: request.requestHash,
  };
}
