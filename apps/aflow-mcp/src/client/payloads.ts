/**
 * Resolving a PayloadRef the session reads hand back.
 *
 * - inline:base64 → decoded here, no API call
 * - gs:// / redis:// in eager mode → GET /v1/payloads?ref=
 * - gs:// / redis:// in lazy mode → a handle for fetch_payload
 *
 * Errors are always resolved eagerly: they are small, and the caller cannot
 * act on a failure it cannot read.
 */

import type { Session } from '../auth/SessionStore.js';
import { log } from '../util/logger.js';

export type PayloadResolveMode = 'eager' | 'lazy';

export interface PayloadReadClient {
  get<T>(session: Session, path: string): Promise<T>;
}

export async function resolvePayloadRef(
  client: PayloadReadClient,
  session: Session,
  ref: string,
  spaceId: string,
  mode: PayloadResolveMode,
): Promise<unknown> {
  if (ref.startsWith('inline:')) {
    try {
      const json = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf-8');
      return JSON.parse(json) as unknown;
    } catch (err) {
      log('warn', 'payload_decode_error', { ref: ref.slice(0, 50), error: String(err) });
      return undefined;
    }
  }

  if (mode === 'lazy') {
    return { _ref: ref, _hint: 'Call fetch_payload with this ref to get the content.' };
  }

  try {
    return await client.get<unknown>(
      session,
      `/v1/payloads?ref=${encodeURIComponent(ref)}&spaceId=${encodeURIComponent(spaceId)}`,
    );
  } catch (err) {
    log('warn', 'payload_fetch_error', { ref: ref.slice(0, 80), error: String(err) });
    return { _ref: ref, _hint: 'Payload fetch failed. Call fetch_payload to retry.' };
  }
}
