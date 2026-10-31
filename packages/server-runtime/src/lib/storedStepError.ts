/**
 * The error a failed session stored, as a `?wait` start returns it (Plan 336
 * D6). The step's code, message and details travel with the response, so a
 * caller shows why the step failed without fetching the payload itself.
 */
import { z } from 'zod';
import type { PayloadStore } from '@aflow/payload-store';

export const StoredStepErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  })
  .describe(
    "A failed session's stored step error: its code, message and details. " +
      'A refused MCP connect carries kind, range, target and remedy in details.',
  );
export type StoredStepError = z.infer<typeof StoredStepErrorSchema>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The stored error's own fields, at the top of the payload or under `error`. */
export function storedStepErrorFrom(decoded: unknown): StoredStepError | undefined {
  const top = record(decoded);
  if (!top) return undefined;
  const nested = record(top['error']);
  const source = nested && typeof nested['message'] === 'string' ? nested : top;
  const code = source['code'];
  const message = source['message'];
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  const details = record(source['details']);
  return { code, message, ...(details ? { details } : {}) };
}

/** `undefined` when the payload is missing or holds no error, never a throw. */
export async function readStoredStepError(
  payloadStore: Pick<PayloadStore, 'retrieve'> | null | undefined,
  errorRef: string | undefined,
): Promise<StoredStepError | undefined> {
  if (!payloadStore || !errorRef) return undefined;
  try {
    return storedStepErrorFrom(await payloadStore.retrieve(errorRef));
  } catch {
    return undefined;
  }
}

/** The stored error of a session that ended FAILED, else nothing. */
export async function failedSessionError(
  payloadStore: Pick<PayloadStore, 'retrieve'> | null | undefined,
  session: { status: string; errorRef?: string | undefined },
): Promise<StoredStepError | undefined> {
  if (session.status !== 'FAILED') return undefined;
  return readStoredStepError(payloadStore, session.errorRef);
}
