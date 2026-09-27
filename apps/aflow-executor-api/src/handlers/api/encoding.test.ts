import { describe, it, expect } from 'vitest';
import { encodeRequestBody } from './encoding.js';

describe('encodeRequestBody', () => {
  // ======================================================================
  // JSON (default)
  // ======================================================================

  describe('json encoding', () => {
    it('returns JSON-stringified body with application/json content type', () => {
      const result = encodeRequestBody({ foo: 'bar', count: 42 }, 'json');
      expect(result.body).toBe('{"foo":"bar","count":42}');
      expect(result.contentType).toBe('application/json');
      expect(result.sizeBytes).toBe(24);
    });

    it('uses json as default when encoding is undefined', () => {
      const result = encodeRequestBody({ a: 1 }, undefined);
      expect(result.body).toBe('{"a":1}');
      expect(result.contentType).toBe('application/json');
      expect(result.sizeBytes).toBe(7);
    });

    it('handles nested objects', () => {
      const result = encodeRequestBody({ outer: { inner: 'val' } }, 'json');
      expect(result.body).toBe('{"outer":{"inner":"val"}}');
      expect(result.contentType).toBe('application/json');
    });
  });

  // ======================================================================
  // Raw string bodies pass through
  // ======================================================================

  describe('string body pass-through', () => {
    it('does NOT JSON.stringify a raw string body (CSV / text / pre-encoded JSON)', () => {
      // CSV content needs to land at GCS as
      // raw bytes. JSON.stringify would wrap the CSV in quotes
      // and escape every \n → \\n; the receiving parser then sees a
      // single line of escape sequences and rejects the file.
      const csv = 'PassengerId,Survived\n892,0\n893,1\n';
      const result = encodeRequestBody(csv, undefined);
      expect(result.body).toBe(csv); // verbatim
      expect(result.body).toContain('\n'); // real newlines, not escaped
      expect(result.body).not.toMatch(/^".*"$/); // not JSON-wrapped
    });

    it('reports UTF-8 byte length, not JS string length', () => {
      // UTF-8: ASCII chars are 1 byte each, but multi-byte chars matter.
      const ascii = 'hello';
      const multibyte = 'héllo'; // é is 2 bytes in UTF-8

      const asciiResult = encodeRequestBody(ascii, undefined);
      expect(asciiResult.sizeBytes).toBe(5);

      const multibyteResult = encodeRequestBody(multibyte, undefined);
      expect(multibyteResult.sizeBytes).toBe(6); // 4 ASCII + 2-byte é
    });

    it('reports the exact CSV byte length the Runner uses for contentLength', () => {
      // Runner computes byte length
      // and sends it to Kaggle's start_competition_submission_upload as
      // contentLength; the GCS resumable upload validates Content-Range
      // against the actual PUT body. Mismatch → HTTP 400. The byte
      // count we report HERE must equal what hits the wire.
      const csv =
        'PassengerId,Survived\n' +
        Array.from({ length: 418 }, (_, i) => `${String(892 + i)},0`).join('\n') +
        '\n';
      const result = encodeRequestBody(csv, undefined);
      expect(result.sizeBytes).toBe(Buffer.byteLength(csv, 'utf8'));
      // ... and that's exactly the byte count of the raw CSV — no JSON
      // wrapping, no escape expansion.
      expect(result.body).toBe(csv);
    });

    it('leaves Content-Type unset for raw string bodies — caller-supplied header wins', () => {
      const result = encodeRequestBody('any string body', undefined);
      // Pre-fix, this returned 'application/json' which mislabelled the
      // body. Now the encoding doesn't claim a Content-Type; execution.ts
      // preserves the caller's header (e.g. text/csv, application/xml).
      expect(result.contentType).toBeUndefined();
    });

    it('does not double-encode a pre-stringified JSON body the caller already prepared', () => {
      // Caller passes a string they've already JSON-encoded (e.g. via
      // their own JSON.stringify on a complex shape). Pre-fix, this
      // would become '"{\\"foo\\":1}"' — quoted-string-of-a-string.
      const preEncoded = '{"foo":1}';
      const result = encodeRequestBody(preEncoded, undefined);
      expect(result.body).toBe(preEncoded);
    });

    it('still JSON-encodes object bodies (no regression on the common path)', () => {
      const result = encodeRequestBody({ ok: true }, undefined);
      expect(result.body).toBe('{"ok":true}');
      expect(result.contentType).toBe('application/json');
    });
  });

  // ======================================================================

  describe('raw bytes pass-through', () => {
    it('sends a Buffer verbatim with the exact byte length and no Content-Type', () => {
      const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xfe]); // non-UTF-8
      const result = encodeRequestBody(bytes, undefined);
      expect(result.body).toBe(bytes); // same bytes, not JSON-wrapped
      expect(result.sizeBytes).toBe(bytes.byteLength);
      expect(result.contentType).toBeUndefined(); // caller / source mimeType owns it
    });

    it('sends a Uint8Array verbatim', () => {
      const bytes = new Uint8Array([1, 2, 3, 250]);
      const result = encodeRequestBody(bytes, 'json'); // encoding ignored for bytes
      expect(result.body).toBe(bytes);
      expect(result.sizeBytes).toBe(4);
      expect(result.contentType).toBeUndefined();
    });
  });

  // ======================================================================
  // form-urlencoded
  // ======================================================================

  describe('form-urlencoded encoding', () => {
    it('encodes as URL-encoded form', () => {
      const result = encodeRequestBody({ username: 'test', password: 'p@ss' }, 'form-urlencoded');
      expect(result.contentType).toBe('application/x-www-form-urlencoded');
      expect(typeof result.body).toBe('string');
      const params = new URLSearchParams(result.body as string);
      expect(params.get('username')).toBe('test');
      expect(params.get('password')).toBe('p@ss');
    });

    it('provides encoded size in bytes', () => {
      const result = encodeRequestBody({ key: 'value' }, 'form-urlencoded');
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.sizeBytes).toBe(Buffer.byteLength(result.body as string, 'utf8'));
    });

    it('handles array values as repeated keys', () => {
      const result = encodeRequestBody({ tags: ['a', 'b', 'c'] }, 'form-urlencoded');
      const params = new URLSearchParams(result.body as string);
      expect(params.getAll('tags')).toEqual(['a', 'b', 'c']);
    });

    it('skips undefined and null values', () => {
      const result = encodeRequestBody({ a: 'yes', b: undefined, c: null }, 'form-urlencoded');
      const params = new URLSearchParams(result.body as string);
      expect(params.has('a')).toBe(true);
      expect(params.has('b')).toBe(false);
      expect(params.has('c')).toBe(false);
    });

    it('converts numbers to strings', () => {
      const result = encodeRequestBody({ count: 42 }, 'form-urlencoded');
      const params = new URLSearchParams(result.body as string);
      expect(params.get('count')).toBe('42');
    });
  });

  // ======================================================================
  // form-data (multipart)
  // ======================================================================

  describe('form-data encoding', () => {
    it('returns FormData body with no explicit content type', () => {
      const result = encodeRequestBody({ field1: 'value1', field2: 'value2' }, 'form-data');
      expect(result.body).toBeInstanceOf(FormData);
      // Content-Type must be undefined so fetch sets the boundary
      expect(result.contentType).toBeUndefined();
      // Size is unknown for multipart
      expect(result.sizeBytes).toBeUndefined();
    });

    it('includes all scalar fields', () => {
      const result = encodeRequestBody({ name: 'test', value: '123' }, 'form-data');
      const fd = result.body as FormData;
      expect(fd.get('name')).toBe('test');
      expect(fd.get('value')).toBe('123');
    });

    it('handles array values as repeated fields', () => {
      const result = encodeRequestBody({ items: ['a', 'b'] }, 'form-data');
      const fd = result.body as FormData;
      expect(fd.getAll('items')).toEqual(['a', 'b']);
    });

    it('converts numbers to strings', () => {
      const result = encodeRequestBody({ num: 42 }, 'form-data');
      const fd = result.body as FormData;
      expect(fd.get('num')).toBe('42');
    });

    it('skips undefined and null values', () => {
      const result = encodeRequestBody({ a: 'yes', b: undefined, c: null }, 'form-data');
      const fd = result.body as FormData;
      expect(fd.has('a')).toBe(true);
      expect(fd.has('b')).toBe(false);
      expect(fd.has('c')).toBe(false);
    });
  });

  // ======================================================================
  // Edge cases
  // ======================================================================

  describe('edge cases', () => {
    it('returns undefined body for undefined input', () => {
      const result = encodeRequestBody(undefined, 'json');
      expect(result.body).toBeUndefined();
      expect(result.contentType).toBeUndefined();
      expect(result.sizeBytes).toBeUndefined();
    });

    it('returns undefined body for null input', () => {
      const result = encodeRequestBody(null, 'json');
      expect(result.body).toBeUndefined();
      expect(result.contentType).toBeUndefined();
      expect(result.sizeBytes).toBeUndefined();
    });

    it('handles empty object for all encodings', () => {
      const json = encodeRequestBody({}, 'json');
      expect(json.body).toBe('{}');

      const urlenc = encodeRequestBody({}, 'form-urlencoded');
      expect(urlenc.body).toBe('');

      const formdata = encodeRequestBody({}, 'form-data');
      expect(formdata.body).toBeInstanceOf(FormData);
    });

    it('json size matches byte length for ASCII', () => {
      const body = { key: 'hello world' };
      const result = encodeRequestBody(body, 'json');
      expect(result.sizeBytes).toBe(JSON.stringify(body).length);
    });
  });
});
