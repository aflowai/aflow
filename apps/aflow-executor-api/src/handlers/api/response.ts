/**
 * Response processing and budget enforcement for API calls.
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ApiCallInput } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { internalError } from '@aflow/executor-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import { apiError } from '../../lib/api-errors.js';
import { stripSensitiveHeaders } from '../../lib/header-redaction.js';
import {
  INLINE_BODY_THRESHOLD,
  DEFAULT_INLINE_RESPONSE_BYTES,
  SAVE_TO_DEFAULT_RESPONSE_BYTES,
} from './config.js';
import {
  applyTextTransformPreset,
  applyTransformPreset,
  getTextTransform,
  validateAgainstJsonSchema,
} from './transforms.js';
import { saveResponseBodyToMemory } from './saveResponse.js';
import type { ResolvedCall } from './types.js';
import { ApiExecutionError } from './types.js';

export interface ResponseSaveDeps {
  db?: PostgresJsDatabase;
  payloadStore?: PayloadStore;
  redis?: Redis;
}

/**
 * Build a structural summary of a large JSON response for inline agent context.
 * The full body is stored in PayloadStore via dataRef; this summary gives the
 * agent enough to understand the data shape without seeing all rows.
 */
function buildJsonSummary(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3);
    const firstItem: unknown = value[0];
    const keys =
      firstItem !== undefined && typeof firstItem === 'object' && firstItem !== null
        ? Object.keys(firstItem as Record<string, unknown>)
        : undefined;
    return {
      _type: 'array',
      _length: value.length,
      ...(keys ? { _keys: keys } : {}),
      _sample: sample,
    };
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const sample: Record<string, unknown> = {};
    for (const key of keys.slice(0, 5)) {
      const v = (value as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        sample[key] = `[Array(${String(v.length)})]`;
      } else if (v !== null && typeof v === 'object') {
        sample[key] = `{Object(${String(Object.keys(v as Record<string, unknown>).length)} keys)}`;
      } else {
        sample[key] = v;
      }
    }
    return {
      _type: 'object',
      _keys: keys,
      _sample: sample,
    };
  }
  return { _type: typeof value, _preview: String(value).slice(0, 200) };
}

function parseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export async function storeToPayloadStore(ctx: ExecutorContext, data: unknown): Promise<string> {
  // Use 'body' kind so the path is .../body.json — distinct from the step output at .../output.json.
  // Without this separation, successWithData() overwrites the body content when storing the step output.
  return ctx.writePayload('body', data);
}

/**
 * Decompress a buffer based on the Content-Encoding header.
 * Supports br (Brotli), gzip, and deflate — the three standard HTTP encodings.
 * Returns the input unchanged if no encoding or an unknown encoding is specified.
 *
 * IMPORTANT: Node's fetch (undici) sometimes auto-decompresses the body stream
 * but leaves the content-encoding header intact. If decompression fails, we
 * assume the runtime already decompressed and return the buffer as-is.
 * This handles both cases gracefully without needing to detect the runtime behavior.
 */
function decompressBuffer(buffer: Buffer, contentEncoding: string | null): Buffer {
  if (!contentEncoding) return buffer;

  const encoding = contentEncoding.trim().toLowerCase();
  let decompress: ((buf: Buffer) => Buffer) | undefined;
  switch (encoding) {
    case 'br':
      decompress = (b) => Buffer.from(brotliDecompressSync(b));
      break;
    case 'gzip':
    case 'x-gzip':
      decompress = (b) => Buffer.from(gunzipSync(b));
      break;
    case 'deflate':
      decompress = (b) => Buffer.from(inflateSync(b));
      break;
    default:
      // identity or unknown — return as-is
      return buffer;
  }

  try {
    return decompress(buffer);
  } catch {
    // Decompression failed — the runtime likely already decompressed the body
    // while leaving the content-encoding header in place. Return as-is.
    return buffer;
  }
}

/**
 * Guidance appended to an over-budget error ONLY on the inline read path. A
 * `saveTo` download shares readWithBudget but streams to memory, so it must NOT
 * receive this hint (it would name the fix an inline caller already used).
 */
const INLINE_OVER_BUDGET_HINT =
  'For a large file, use the api.http.download operation with a required toMemoryPath ' +
  '(it streams the body straight to a memory path) instead of an inline api.http.call.';

function withHint(message: string, hint?: string): string {
  return hint ? `${message} ${hint}` : message;
}

export async function readWithBudget(
  response: Response,
  maxBytes: number,
  overBudgetHint?: string,
): Promise<ArrayBuffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new ApiExecutionError(
      apiError(
        'API_RESPONSE_TOO_LARGE',
        withHint(
          `Response Content-Length ${contentLength} exceeds budget of ${String(maxBytes)} bytes`,
          overBudgetHint,
        ),
        { retryable: false, details: { contentLength, maxBytes } },
      ),
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return new ArrayBuffer(0);
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    totalSize += value.byteLength;
    if (totalSize > maxBytes) {
      await reader.cancel();
      throw new ApiExecutionError(
        apiError(
          'API_RESPONSE_TOO_LARGE',
          withHint(
            `Response body exceeded budget of ${String(maxBytes)} bytes (read ${String(totalSize)})`,
            overBudgetHint,
          ),
          { retryable: false, details: { readBytes: totalSize, maxBytes } },
        ),
      );
    }
    chunks.push(value);
  }

  const rawBuffer = Buffer.concat(chunks, totalSize);

  // Decompress if the response has a content-encoding header.
  // response.body.getReader() returns raw bytes without automatic decompression,
  // so we must decompress manually for br/gzip/deflate.
  const contentEncoding = response.headers.get('content-encoding');
  const decompressed = decompressBuffer(rawBuffer, contentEncoding);

  // Re-check budget against decompressed size (a small compressed payload
  // could expand beyond the budget after decompression).
  if (decompressed.byteLength > maxBytes) {
    throw new ApiExecutionError(
      apiError(
        'API_RESPONSE_TOO_LARGE',
        withHint(
          `Decompressed response body (${String(decompressed.byteLength)} bytes) exceeds budget of ${String(maxBytes)} bytes`,
          overBudgetHint,
        ),
        { retryable: false, details: { decompressedBytes: decompressed.byteLength, maxBytes } },
      ),
    );
  }

  // Copy into a fresh ArrayBuffer to avoid SharedArrayBuffer type mismatch
  const out = new Uint8Array(decompressed.byteLength);
  out.set(decompressed);
  return out.buffer;
}

async function readTextWithBudget(
  response: Response,
  maxBytes: number,
  overBudgetHint?: string,
): Promise<string> {
  const buffer = await readWithBudget(response, maxBytes, overBudgetHint);
  return new TextDecoder().decode(buffer);
}

export async function processResponse(
  ctx: ExecutorContext,
  input: ApiCallInput,
  response: Response,
  durationMs: number,
  finalUrl: string,
  resolved: ResolvedCall,
  saveDeps: ResponseSaveDeps = {},
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  data: unknown;
  dataRef?: string;
  rawBodyRef?: string;
  savedTo?: string;
  sizeBytes?: number;
  durationMs: number;
  finalUrl?: string;
  /** Which path produced this response. `simulated` made no network request. */
  backend: 'http' | 'simulated';
  apiId?: string;
  endpointId?: string;
  truncated?: boolean;
  originalSizeBytes?: number;
  parsedMeta?: { contentType?: string; sourceContentType?: string };
}> {
  const rawHeaders = parseHeaders(response.headers);
  const safeHeaders = stripSensitiveHeaders(rawHeaders);

  const responseConfig = input.response;
  // An explicit maxBytes always wins; when omitted, a saveTo download persists
  // to a Memory path rather than inlining, so it is not bound by the small
  // inline default.
  const maxBytes =
    responseConfig.maxBytes ??
    (responseConfig.saveTo ? SAVE_TO_DEFAULT_RESPONSE_BYTES : DEFAULT_INLINE_RESPONSE_BYTES);
  const contentType = response.headers.get('content-type') ?? '';
  let data: unknown;
  let dataRef: string | undefined;
  let rawBodyRef: string | undefined;
  let truncated = false;
  let originalSizeBytes: number | undefined;
  let normalizedToJson = false;

  // An explicit call-level transform always wins over the endpoint's curated
  // default. An explicit id that names no text preset keeps the legacy
  // raw-text behavior (object presets and unknown ids fall back soft), but a
  // DECLARED preset is strict — an unknown id fails loud downstream (typo or
  // deploy skew must never silently hand the agent the raw source format).
  const declaredPresetId = resolved.endpoint?.responseTransformPresetId;
  const explicitPresetId = responseConfig.transformPresetId;
  const activeTextPresetId = !response.ok
    ? undefined
    : explicitPresetId !== undefined
      ? getTextTransform(explicitPresetId) !== undefined
        ? explicitPresetId
        : undefined
      : declaredPresetId;

  if (responseConfig.saveTo && response.ok) {
    if (activeTextPresetId !== undefined) {
      // Saving would persist the RAW wire body while the endpoint contract
      // promises normalized records — contradictory by construction.
      throw new ApiExecutionError(
        apiError(
          'API_RESPONSE_TRANSFORM_FAILED',
          `response.saveTo would bypass the '${activeTextPresetId}' response normalization and ` +
            'persist the raw body. Omit saveTo (the normalized body is returned inline or by ' +
            'reference) and persist it with memory.store.put(content: {fromPath: ' +
            '"/run/outputs/<toolCallId>/data"}), or drop the transform.',
          { retryable: false, details: { presetId: activeTextPresetId } },
        ),
      );
    }
    const saveTarget = responseConfig.saveTo;
    const { db, payloadStore, redis } = saveDeps;
    const spaceId = ctx.job.spaceId;
    if (!db || !payloadStore) {
      throw new ApiExecutionError(
        internalError(
          'response.saveTo requires database + payload store access (server misconfiguration).',
          { retryable: false },
        ),
      );
    }
    if (!spaceId) {
      throw new ApiExecutionError(
        internalError('response.saveTo requires a space context.', { retryable: false }),
      );
    }
    const buffer = Buffer.from(await readWithBudget(response, maxBytes));
    const saved = await saveResponseBodyToMemory(ctx, {
      db,
      payloadStore,
      ...(redis ? { redis } : {}),
      spaceId,
      saveTo: saveTarget,
      bytes: buffer,
      contentType: response.headers.get('content-type'),
    });
    const savedChangedUrl = finalUrl !== resolved.url;
    return {
      statusCode: response.status,
      headers: safeHeaders,
      // No inline body, no dataRef — the Memory path is the single handle
      data: undefined,
      savedTo: saved.savedTo,
      sizeBytes: saved.sizeBytes,
      durationMs,
      backend: resolved.simulation ? ('simulated' as const) : ('http' as const),
      ...(savedChangedUrl ? { finalUrl } : {}),
      ...(resolved.apiId ? { apiId: resolved.apiId } : {}),
      ...(resolved.endpointId ? { endpointId: resolved.endpointId } : {}),
      ...(contentType ? { parsedMeta: { contentType } } : {}),
    };
  }

  if (responseConfig.format === 'binary') {
    const buffer = await readWithBudget(response, maxBytes, INLINE_OVER_BUDGET_HINT);
    dataRef = await storeToPayloadStore(ctx, buffer);
    data = undefined;
  } else if (responseConfig.format === 'text' || !contentType.includes('application/json')) {
    const text = await readTextWithBudget(response, maxBytes, INLINE_OVER_BUDGET_HINT);
    if (
      response.ok &&
      explicitPresetId !== undefined &&
      activeTextPresetId === undefined &&
      declaredPresetId !== undefined
    ) {
      ctx.log.warn('Explicit transformPresetId disables the declared response normalization', {
        explicitPresetId,
        declaredPresetId,
      });
    }
    if (activeTextPresetId !== undefined) {
      // Normalize the FULL text before the inline/reference decision so the
      // by-reference body (and every /run/outputs/<id>/data read) is the
      // normalized value, never the raw source format. The raw text is kept
      // under an internal ref for debugging only.
      rawBodyRef = await ctx.writePayload('raw_body', text);
      const normalized = applyTextTransformPreset(activeTextPresetId, text, { rawBodyRef });
      normalizedToJson = true;
      const normalizedJson: string | undefined = JSON.stringify(normalized);
      const normalizedLength = normalizedJson?.length ?? 0;
      if (normalizedLength > INLINE_BODY_THRESHOLD) {
        dataRef = await storeToPayloadStore(ctx, normalized);
        truncated = true;
        originalSizeBytes = normalizedLength;
        data = buildJsonSummary(normalized);
      } else {
        data = normalized;
      }
    } else if (text.length > INLINE_BODY_THRESHOLD) {
      dataRef = await storeToPayloadStore(ctx, text);
      const inlinePreview = text.slice(0, 1024);
      truncated = true;
      originalSizeBytes = text.length;
      data = inlinePreview + '…[truncated]';
    } else {
      data = text;
    }
  } else {
    const text = await readTextWithBudget(response, maxBytes, INLINE_OVER_BUDGET_HINT);
    let parsed: unknown;
    let jsonValid = false;
    try {
      parsed = JSON.parse(text) as unknown;
      jsonValid = true;
    } catch {
      parsed = text;
    }
    if (text.length > INLINE_BODY_THRESHOLD) {
      dataRef = await storeToPayloadStore(ctx, jsonValid ? parsed : text);
      truncated = true;
      originalSizeBytes = text.length;
      if (jsonValid) {
        data = buildJsonSummary(parsed);
      } else {
        data = text.slice(0, 1024) + '…[truncated]';
      }
    } else {
      data = parsed;
    }
  }

  // Validated BEFORE any transform preset runs. `responseSchemas` describes what
  // the service returns — the wire shape — while a preset reshapes it for the
  // caller, so checking afterwards measured the response against a contract it
  // was never meant to satisfy. It is also the shape a simulation answers with,
  // so the two paths now hold the same body to the same schema.
  //
  // Still a warning, not a failure. Making it fatal would reject live responses
  // that work today, and the schema is only advisory until conformance mode
  // (Plan 293 §5.9) gives it a measured meaning.
  if (responseConfig.validateResponse && resolved.endpoint?.responseSchemas) {
    const statusClass = `${String(Math.floor(response.status / 100))}xx`;
    const schema = resolved.endpoint.responseSchemas[statusClass];
    if (schema) {
      const issues = validateAgainstJsonSchema(data, schema);
      if (issues.length > 0) {
        ctx.log.warn('Response schema validation failed', {
          apiId: resolved.apiId,
          endpointId: resolved.endpointId,
          statusClass,
          issues,
        });
      }
    }
  }

  if (
    !normalizedToJson &&
    responseConfig.transformPresetId &&
    data !== undefined &&
    typeof data === 'object' &&
    data !== null
  ) {
    data = applyTransformPreset(responseConfig.transformPresetId, data, ctx);
  }

  if (!response.ok) {
    ctx.log.warn('API call returned non-OK status', { statusCode: response.status });
  }

  const changedUrl = finalUrl !== resolved.url;

  const bareContentType = contentType.split(';')[0]?.trim() ?? '';
  const parsedMeta = normalizedToJson
    ? {
        contentType: 'application/json',
        ...(bareContentType !== '' ? { sourceContentType: bareContentType } : {}),
      }
    : contentType
      ? { contentType }
      : undefined;

  return {
    statusCode: response.status,
    headers: safeHeaders,
    data,
    durationMs,
    backend: resolved.simulation ? ('simulated' as const) : ('http' as const),
    ...(dataRef ? { dataRef } : {}),
    ...(rawBodyRef ? { rawBodyRef } : {}),
    ...(changedUrl ? { finalUrl } : {}),
    ...(resolved.apiId ? { apiId: resolved.apiId } : {}),
    ...(resolved.endpointId ? { endpointId: resolved.endpointId } : {}),
    ...(truncated && originalSizeBytes !== undefined ? { truncated, originalSizeBytes } : {}),
    ...(parsedMeta !== undefined ? { parsedMeta } : {}),
  };
}
