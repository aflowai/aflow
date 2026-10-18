/**
 * API executor configuration.
 */
import type { EgressPolicy } from '@aflow/schemas';
import { resolveWebBaseUrl } from '@aflow/lib';

export const ALLOW_UNSAFE_DIRECT_URL = process.env['ALLOW_UNSAFE_DIRECT_URL'] === 'true';

const WEB_BASE = resolveWebBaseUrl();
export const INTEGRATIONS_URL = `${WEB_BASE}/integrations`;

/** Responses smaller than this are returned inline; larger are stored via PayloadStore. */
export const INLINE_BODY_THRESHOLD = 64 * 1024; // 64 KB

/**
 * Effective `response.maxBytes` when the caller omits it. An inline response is
 * bounded small to protect the hot path. A response that is never held whole —
 * a `saveTo` response persists straight to a Memory path, a tail-reading text
 * preset keeps only the body's end — is not what that guard protects against,
 * so it defaults to the schema ceiling (a data-file download or a long job log
 * is not throttled by the inline default). An explicit `maxBytes` always wins
 * over both. Values match `packages/schemas/src/operations/api.ts`
 * `response.maxBytes` (.default / .max).
 */
export const DEFAULT_INLINE_RESPONSE_BYTES = 10_485_760; // 10 MB
export const STREAMED_RESPONSE_DEFAULT_BYTES = 104_857_600; // 100 MB

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  allowedHosts: [],
  allowedMethods: ['GET', 'POST'],
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 10_485_760,
  timeoutMs: 30_000,
  maxRedirects: 5,
  allowCrossHostRedirects: false,
  retryPolicy: {
    maxRetries: 2,
    retryableStatusCodes: [429, 502, 503, 504],
    retryOnlyIdempotent: true,
    backoffBaseMs: 1000,
    backoffMaxMs: 30_000,
  },
};
