import {
  OAuthConsentRequestPayloadSchema,
  type OAuthConsentRequestPayload,
  type SessionBlockedOn,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * Best-effort read of an executor-supplied `oauth_consent` request payload from
 * a paused step's `requestedInputRef`. Returns `null` for any other paused-step
 * contract (the common path), so this only fires for the OAuth consent pause
 * (Plan 185 §9.3, Plane A).
 */
async function readOAuthConsentRequest(
  payloadStore: PayloadStore,
  requestedInputRef: string,
): Promise<OAuthConsentRequestPayload | null> {
  try {
    const raw = await payloadStore.retrieve(requestedInputRef as never);
    if (typeof raw !== 'object' || raw === null) return null;
    if ((raw as Record<string, unknown>)['kind'] !== 'oauth_consent') return null;
    const parsed = OAuthConsentRequestPayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the typed `needs_oauth_consent` blockedOn for a paused step, or
 * `null` when the step is not an OAuth consent pause. The orchestrator threads
 * the result into `waitForInput` so the session parks with the recoverable
 * cause the Action Center surfaces.
 */
export async function resolveOAuthConsentBlockedOn(
  payloadStore: PayloadStore,
  requestedInputRef: string | null | undefined,
): Promise<SessionBlockedOn | null> {
  if (!requestedInputRef) return null;
  const consent = await readOAuthConsentRequest(payloadStore, requestedInputRef);
  if (!consent) return null;
  return {
    kind: 'needs_oauth_consent',
    integrationKind: consent.integrationKind,
    resourceKey: consent.resourceKey,
    bindingId: consent.bindingId,
    ownerScope: consent.ownerScope,
    ...(consent.consentUrlHint ? { consentUrlHint: consent.consentUrlHint } : {}),
    reason: consent.reason,
  };
}
