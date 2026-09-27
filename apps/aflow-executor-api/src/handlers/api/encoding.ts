/**
 * Request body encoding for API calls.
 *
 * Centralizes body encoding so size enforcement uses the encoded payload,
 * not raw JSON.stringify. Supports json, form-data, and form-urlencoded.
 */
import type { BodyEncoding } from '@aflow/schemas';

/** Stringify a form field value without producing "[object Object]" for plain objects. */
function scalarToFormString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

export interface EncodedBody {
  /** The encoded body ready for fetch(). undefined if no body. */
  body: BodyInit | undefined;
  /**
   * Explicit Content-Type header to set.
   * - string: set this header
   * - undefined: do NOT set Content-Type (let fetch handle it, e.g., multipart boundary)
   */
  contentType: string | undefined;
  /** Encoded size in bytes for request budget enforcement. undefined if unknown (multipart). */
  sizeBytes: number | undefined;
}

/**
 * Encode a request body according to the endpoint's bodyEncoding.
 *
 * Phase 1 supports scalar fields only:
 * - json: JSON.stringify
 * - form-urlencoded: URLSearchParams
 * - form-data: FormData with string values (no binary parts)
 */
export function encodeRequestBody(body: unknown, encoding: BodyEncoding | undefined): EncodedBody {
  if (body === undefined || body === null) {
    return { body: undefined, contentType: undefined, sizeBytes: undefined };
  }

  // Raw string bodies pass through.
  //
  // When the caller supplies a literal string (the CSV-bound-for-GCS
  // case, an already-stringified JSON payload, an XML body, etc.) the
  // intent is "send these bytes verbatim." JSON.stringify on a string
  // would wrap it in quotes AND escape every \n → \\n — e.g. a CSV
  // upload PUT lands, but the receiver's parser
  // sees `"PassengerId,Survived\n892,0\n..."` (a single line of
  // escape sequences) and rejects the file with "Required column
  // 'PassengerId' could not be found" — the body content is wrong
  // before it ever hits the wire.
  //
  // Caller-supplied Content-Type wins (the execute path at
  // execution.ts:259-268 preserves it). When no Content-Type is set
  // we leave it unset rather than defaulting to application/json,
  // which would mislabel the body and confuse the receiver. Raw
  // string bodies should carry an explicit Content-Type
  // (text/csv, application/octet-stream, etc.) from the caller.
  if (typeof body === 'string') {
    return {
      body,
      contentType: undefined,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
    };
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return {
      // A Uint8Array/Buffer is a valid fetch BodyInit at runtime; the cast
      // bridges the @types/node generic-Buffer vs lib BodyInit mismatch.
      body: body as unknown as BodyInit,
      contentType: undefined,
      sizeBytes: body.byteLength,
    };
  }

  const effectiveEncoding = encoding ?? 'json';

  switch (effectiveEncoding) {
    case 'json': {
      const jsonStr = JSON.stringify(body);
      return {
        body: jsonStr,
        contentType: 'application/json',
        sizeBytes: Buffer.byteLength(jsonStr, 'utf8'),
      };
    }

    case 'form-urlencoded': {
      const params = new URLSearchParams();
      const entries = Object.entries(body as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (Array.isArray(value)) {
          // Repeated keys for array values
          for (const item of value) {
            params.append(key, scalarToFormString(item));
          }
        } else if (value !== undefined && value !== null) {
          params.append(key, scalarToFormString(value));
        }
      }
      const encoded = params.toString();
      return {
        body: encoded,
        contentType: 'application/x-www-form-urlencoded',
        sizeBytes: Buffer.byteLength(encoded, 'utf8'),
      };
    }

    case 'form-data': {
      const formData = new FormData();
      const entries = Object.entries(body as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (Array.isArray(value)) {
          for (const item of value) {
            formData.append(key, scalarToFormString(item));
          }
        } else if (value !== undefined && value !== null) {
          formData.append(key, scalarToFormString(value));
        }
      }
      // Do NOT set Content-Type — fetch sets it with the multipart boundary.
      // Size is not precisely known before encoding, so leave undefined.
      // The size check for multipart is best-effort via input size estimation.
      return {
        body: formData,
        contentType: undefined,
        sizeBytes: undefined,
      };
    }
  }
}
