/**
 * API call execution with retry and SSRF/egress checks.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData } from '@aflow/executor-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import type { ApiCallInput } from '@aflow/schemas';
import {
  validateUrl,
  isMethodAllowed,
  isIdempotentMethod,
  isRedirectSafe,
  SsrfBlockedError,
  DnsBlockedError,
} from '@aflow/network-safety';
import { apiError } from '../../lib/api-errors.js';
import { processResponse } from './response.js';
import {
  pinUrlToIp,
  isRetryableNetworkError,
  assertTenantPolicyPermitsHost,
  buildEgressBlockedMessage,
  SUGGESTED_FIX_BIND_CAPABILITY,
  DO_NOT_RUNNER_GUIDANCE,
} from './errors.js';
import type { ResolvedCall } from './types.js';
import { ApiExecutionError } from './types.js';
import { encodeRequestBody } from './encoding.js';
import { writeSourceEvidence, hashResponseBody } from './sourceEvidence.js';

export interface ExecuteOpts {
  db?: PostgresJsDatabase;
  payloadStore?: PayloadStore;
  redis?: Redis;
}

export function isRetryableExecutionError(error: unknown): boolean {
  if (error instanceof ApiExecutionError) {
    return error.aflowError.retryable;
  }
  return error instanceof Error && isRetryableNetworkError(error);
}

/**
 * Allowlist-mode backstop: a binding written before a policy tightening fails
 * closed here (initial URL and every redirect hop).
 */
export function assertTenantPolicyPermits(resolved: ResolvedCall, hostname: string): void {
  assertTenantPolicyPermitsHost(resolved.tenantHostGuard, hostname, resolved);
}

/** The enriched result of a completed HTTP call, before it becomes a StepResult. */
export type ApiCallResultData = Awaited<ReturnType<typeof executeSingle>> & {
  wasRetried?: boolean;
};

export async function executeWithRetry(
  ctx: ExecutorContext,
  input: ApiCallInput,
  resolved: ResolvedCall,
  opts: ExecuteOpts = {},
): Promise<StepResult> {
  return successWithData(ctx, await fetchWithRetry(ctx, input, resolved, opts));
}

/**
 * Run the HTTP call (with egress checks, redirects, and retry) and return the
 * enriched result data — the shared core behind both api.http.call (which
 * inlines/saves it as-is) and api.http.download (which maps it to a
 * destination-only output). Throws on a terminal error.
 */
export async function fetchWithRetry(
  ctx: ExecutorContext,
  input: ApiCallInput,
  resolved: ResolvedCall,
  opts: ExecuteOpts = {},
): Promise<ApiCallResultData> {
  const { egressPolicy } = resolved;
  const retry = egressPolicy.retryPolicy;
  const maxAttempts = retry.maxRetries + 1;
  const retryableStatusCodes = new Set(retry.retryableStatusCodes);
  let lastError: unknown;
  let wasRetried = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      wasRetried = true;
      const backoff = Math.min(retry.backoffBaseMs * 2 ** (attempt - 1), retry.backoffMaxMs);
      const jitter = Math.random() * backoff * 0.1;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
      ctx.log.info('Retrying API call', { attempt: attempt + 1, maxAttempts });
    }

    try {
      const result = await executeSingle(ctx, input, resolved, opts);

      if (
        retryableStatusCodes.has(result.statusCode) &&
        attempt < maxAttempts - 1 &&
        (!retry.retryOnlyIdempotent || isIdempotentMethod(resolved.method))
      ) {
        ctx.log.warn('Retryable status code received', { statusCode: result.statusCode });
        lastError = result;
        continue;
      }

      let sourceEvidenceRef: string | undefined;
      const isSuccess = result.statusCode >= 200 && result.statusCode < 400;
      const spaceId = ctx.job.spaceId;
      // Direct-URL calls (apiId + bindingId + url) carry no endpointId — record
      // provenance under a 'direct_url' sentinel so signed cross-host fetches
      // (e.g. a GCS download) still produce SourceEvidence.
      const evidenceEndpointId = result.endpointId ?? 'direct_url';
      if (isSuccess && opts.db && spaceId && result.apiId && resolved.bindingId) {
        const evidenceWrite = await writeSourceEvidence({
          db: opts.db,
          tenantId: ctx.tenantId,
          spaceId,
          runId: ctx.runId,
          apiId: result.apiId,
          bindingId: resolved.bindingId,
          endpointId: evidenceEndpointId,
          responseStatus: result.statusCode,
          provenance: 'live',
          ...(result.data !== undefined
            ? { responseHash: hashResponseBody(result.data) ?? '' }
            : {}),
        });
        if (evidenceWrite.ok) {
          sourceEvidenceRef = evidenceWrite.callId;
        } else {
          ctx.log.warn(
            'Plan 118: failed to write SourceEvidence — runner will not receive sourceEvidenceRef',
            { apiId: result.apiId, endpointId: evidenceEndpointId },
          );
        }
      }

      const enrichedResult = sourceEvidenceRef ? { ...result, sourceEvidenceRef } : result;
      return wasRetried ? { ...enrichedResult, wasRetried } : enrichedResult;
    } catch (error) {
      lastError = error;

      if (error instanceof SsrfBlockedError || error instanceof DnsBlockedError) {
        throw error;
      }

      if (!isRetryableExecutionError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }

      if (retry.retryOnlyIdempotent && !isIdempotentMethod(resolved.method)) {
        throw error;
      }

      ctx.log.warn('Retryable network error', {
        error: error instanceof Error ? error.message : String(error),
        attempt: attempt + 1,
      });
    }
  }

  throw lastError;
}

export async function executeSingle(
  ctx: ExecutorContext,
  input: ApiCallInput,
  resolved: ResolvedCall,
  opts: ExecuteOpts = {},
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  data: unknown;
  dataRef?: string;
  savedTo?: string;
  sizeBytes?: number;
  durationMs: number;
  finalUrl?: string;
  backend: 'http' | 'simulated';
  apiId?: string;
  endpointId?: string;
  parsedMeta?: { contentType?: string };
  sourceEvidenceRef?: string;
}> {
  const { egressPolicy } = resolved;
  const allowedHosts = egressPolicy.allowedHosts;
  const validated = await validateUrl(resolved.url, allowedHosts);
  assertTenantPolicyPermits(resolved, validated.url.hostname);

  if (!isMethodAllowed(resolved.method, egressPolicy.allowedMethods)) {
    throw new ApiExecutionError(
      apiError('API_METHOD_NOT_ALLOWED', `HTTP method ${resolved.method} is not allowed`, {
        details: { method: resolved.method, allowed: egressPolicy.allowedMethods },
      }),
    );
  }

  const encoded = encodeRequestBody(resolved.body, resolved.endpoint?.bodyEncoding);
  if (encoded.sizeBytes !== undefined && encoded.sizeBytes > egressPolicy.maxRequestBodyBytes) {
    throw new ApiExecutionError(
      apiError(
        'API_REQUEST_TOO_LARGE',
        `Request body exceeds ${String(egressPolicy.maxRequestBodyBytes)} bytes`,
        {
          details: {
            bodySize: encoded.sizeBytes,
            maxSize: egressPolicy.maxRequestBodyBytes,
          },
        },
      ),
    );
  }

  const inputTimeoutMs =
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 30_000;
  const policyTimeoutMs =
    Number.isFinite(egressPolicy.timeoutMs) && egressPolicy.timeoutMs > 0
      ? egressPolicy.timeoutMs
      : 30_000;
  const timeoutMs = Math.min(inputTimeoutMs, policyTimeoutMs);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  ctx.signal.addEventListener(
    'abort',
    () => {
      controller.abort();
    },
    { once: true },
  );

  const startTime = Date.now();
  let response: Response;
  let finalUrl = resolved.url;
  let redirectCount = 0;

  try {
    const isHttps = validated.url.protocol === 'https:';
    const fetchUrl = isHttps ? validated.url.toString() : pinUrlToIp(resolved.url, validated);
    const pinnedHeaders = { ...resolved.headers };
    if (!isHttps) pinnedHeaders['Host'] = validated.url.host;

    const fetchOptions: RequestInit = {
      method: resolved.method,
      headers: pinnedHeaders,
      signal: controller.signal,
      redirect: 'manual',
    };

    if (encoded.body !== undefined && resolved.method !== 'GET' && resolved.method !== 'HEAD') {
      fetchOptions.body = encoded.body;
      const hdrs = fetchOptions.headers as Record<string, string>;
      if (encoded.contentType) {
        // Set Content-Type from encoding unless the caller already provided one
        if (!resolved.headers['Content-Type'] && !resolved.headers['content-type']) {
          hdrs['Content-Type'] = encoded.contentType;
        }
      } else {
        // Encoding owns the header (e.g., multipart boundary) — remove any pre-set Content-Type
        delete hdrs['Content-Type'];
        delete hdrs['content-type'];
      }
    }

    response = await fetch(fetchUrl, fetchOptions);

    while (
      [301, 302, 303, 307, 308].includes(response.status) &&
      redirectCount < egressPolicy.maxRedirects
    ) {
      const location = response.headers.get('location');
      if (!location) break;

      const redirectTarget = new URL(location, resolved.url).toString();
      if (
        !isRedirectSafe(
          validated.url.hostname,
          redirectTarget,
          egressPolicy.allowCrossHostRedirects,
        )
      ) {
        throw new ApiExecutionError(
          apiError(
            'API_BINDING_EGRESS_BLOCKED',
            buildEgressBlockedMessage(redirectTarget, 'cross-host-redirect-blocked'),
            {
              retryable: false,
              details: {
                originalHost: validated.url.hostname,
                blockedTarget: redirectTarget,
                reason: 'cross-host-redirect-blocked',
                blockKind: 'cross_host_redirect_blocked',
                blockedHost: new URL(redirectTarget).hostname,
                ...(resolved.bindingId ? { bindingId: resolved.bindingId } : {}),
                suggestedFix: SUGGESTED_FIX_BIND_CAPABILITY,
                doNot: DO_NOT_RUNNER_GUIDANCE,
              },
            },
          ),
        );
      }

      // A redirect that passed the cross-host check but whose target host is not
      // in allowedHosts is still a REDIRECT block — label it as such so the
      // remedy (add the host to egress) isn't misread as a direct-URL failure.
      let redirectValidated;
      try {
        redirectValidated = await validateUrl(redirectTarget, allowedHosts);
      } catch (err) {
        if (err instanceof SsrfBlockedError && err.kind === 'allowlist-host') {
          throw new ApiExecutionError(
            apiError(
              'API_BINDING_EGRESS_BLOCKED',
              buildEgressBlockedMessage(redirectTarget, 'cross-host-redirect-blocked'),
              {
                retryable: false,
                details: {
                  originalHost: validated.url.hostname,
                  blockedTarget: redirectTarget,
                  reason: 'cross-host-redirect-blocked',
                  blockKind: 'cross_host_redirect_blocked',
                  blockedHost: new URL(redirectTarget).hostname,
                  ...(resolved.bindingId ? { bindingId: resolved.bindingId } : {}),
                  suggestedFix: SUGGESTED_FIX_BIND_CAPABILITY,
                  doNot: DO_NOT_RUNNER_GUIDANCE,
                },
              },
            ),
          );
        }
        throw err;
      }
      assertTenantPolicyPermits(resolved, redirectValidated.url.hostname);
      const isRedirectHttps = redirectValidated.url.protocol === 'https:';
      const pinnedRedirectUrl = isRedirectHttps
        ? redirectValidated.url.toString()
        : pinUrlToIp(redirectTarget, redirectValidated);

      redirectCount++;
      finalUrl = redirectTarget;
      const redirectMethod = [303].includes(response.status) ? 'GET' : resolved.method;
      response = await fetch(pinnedRedirectUrl, {
        ...fetchOptions,
        method: redirectMethod,
        headers: {
          ...pinnedHeaders,
          ...(isRedirectHttps ? {} : { Host: redirectValidated.url.host }),
        },
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const durationMs = Date.now() - startTime;
  return processResponse(ctx, input, response, durationMs, finalUrl, resolved, {
    ...(opts.db ? { db: opts.db } : {}),
    ...(opts.payloadStore ? { payloadStore: opts.payloadStore } : {}),
    ...(opts.redis ? { redis: opts.redis } : {}),
  });
}
