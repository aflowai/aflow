import type { PayloadStore } from '@aflow/payload-store';

export async function loadPausePayload(
  payloadStore: PayloadStore | null | undefined,
  ref: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!payloadStore || !ref) return null;
  try {
    const raw = await payloadStore.retrieve(ref as never);
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  } catch {
    /* malformed or missing payload */
  }
  return null;
}
