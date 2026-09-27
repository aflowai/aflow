import { describe, it, expect } from 'vitest';
import { parsePayloadRef, MAX_INLINE_PAYLOAD_BYTES } from './payloadRef.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = 'b0000000-0000-0000-0000-000000000002';
const STEP = 'c0000000-0000-0000-0000-000000000003';
const CANONICAL = `gs://bucket/tenants/${TENANT}/runs/${RUN}/steps/${STEP}/attempt/0/output.json`;

describe('parsePayloadRef', () => {
  it('parses a canonical object ref', () => {
    expect(parsePayloadRef(CANONICAL)).toEqual({
      form: 'object',
      layout: 'run',
      bucket: 'bucket',
      objectPath: `tenants/${TENANT}/runs/${RUN}/steps/${STEP}/attempt/0/output.json`,
      tenantId: TENANT,
      runId: RUN,
      stepExecutionId: STEP,
      attempt: 0,
      payloadKind: 'output',
      extension: 'json',
    });
  });

  // The orchestrator derives these ids for poll stamps and projected outputs.
  // A ref shape the runtime writes but cannot read back is a silent data loss,
  // so the writers' id grammar is part of this contract.
  for (const suffix of ['poll', 'projected']) {
    it(`parses a runtime-derived "${suffix}" step id`, () => {
      const ref = CANONICAL.replace(`/steps/${STEP}/`, `/steps/${STEP}:${suffix}/`);
      expect(parsePayloadRef(ref)).toMatchObject({
        form: 'object',
        stepExecutionId: `${STEP}:${suffix}`,
        tenantId: TENANT,
      });
    });
  }

  it('parses the binary lane', () => {
    const parsed = parsePayloadRef(CANONICAL.replace('output.json', 'body.bin'));
    expect(parsed).toMatchObject({ payloadKind: 'body', extension: 'bin' });
  });

  it('parses inline refs', () => {
    expect(parsePayloadRef('inline:eyJhIjoxfQ==')).toEqual({ form: 'inline' });
  });

  it('rejects an inline ref carrying non-base64 bytes', () => {
    expect(parsePayloadRef('inline:../../etc/passwd')).toBeNull();
  });

  it('rejects an inline ref that decodes past the inline payload cap', () => {
    // Sized in decoded bytes, which is what the cap governs. Deriving the body
    // from the cap by the 3-to-4 expansion instead names a length that is two
    // bytes over once decoded — see the canonicality suite below, which pins
    // both edges of the boundary.
    const atCap = `inline:${Buffer.alloc(MAX_INLINE_PAYLOAD_BYTES, 0x61).toString('base64')}`;
    expect(parsePayloadRef(atCap)).toEqual({ form: 'inline' });
    expect(parsePayloadRef(`${atCap}AAAA`)).toBeNull();
  });

  // The tenant segment is what the API compares against the authenticated
  // tenant, so anything that could make it read as a different value — or make
  // the path resolve somewhere the segment does not name — must fail to parse.
  const REJECTED: [string, string][] = [
    ['parent traversal in the tenant segment', `gs://bucket/tenants/../${RUN}/x/y/z/a/b/c.json`],
    [
      'traversal after a valid tenant',
      `gs://bucket/tenants/${TENANT}/runs/../../other/steps/${STEP}/attempt/0/output.json`,
    ],
    [
      'percent-encoded traversal',
      `gs://bucket/tenants/${TENANT}%2f..%2fother/runs/${RUN}/steps/${STEP}/attempt/0/output.json`,
    ],
    [
      'encoded slash inside the tenant segment',
      `gs://bucket/tenants/${TENANT}%2Fother/runs/${RUN}/steps/${STEP}/attempt/0/output.json`,
    ],
    [
      'double slash producing an empty segment',
      `gs://bucket/tenants//${TENANT}/runs/${RUN}/steps/${STEP}/attempt/0/output.json`,
    ],
    ['trailing segment beyond the canonical depth', `${CANONICAL}/extra`],
    [
      'missing the tenants label',
      `gs://bucket/${TENANT}/runs/${RUN}/steps/${STEP}/attempt/0/output.json`,
    ],
    [
      'reordered labels',
      `gs://bucket/runs/${RUN}/tenants/${TENANT}/steps/${STEP}/attempt/0/output.json`,
    ],
    ['unknown payload kind', CANONICAL.replace('output.json', 'credentials.json')],
    ['unexpected extension', CANONICAL.replace('output.json', 'output.exe')],
    ['no extension', CANONICAL.replace('output.json', 'output')],
    ['non-numeric attempt', CANONICAL.replace('/attempt/0/', '/attempt/x/')],
    ['negative attempt', CANONICAL.replace('/attempt/0/', '/attempt/-1/')],
    ['backslash separators', CANONICAL.replace(/\//g, '\\')],
    ['http scheme', CANONICAL.replace('gs://', 'https://')],
    ['bare object path with no scheme', CANONICAL.replace('gs://bucket/', '')],
    ['empty string', ''],
  ];

  for (const [name, ref] of REJECTED) {
    it(`rejects ${name}`, () => {
      expect(parsePayloadRef(ref)).toBeNull();
    });
  }

  // The content lane addresses an object by the SHA-256 of its own bytes. A ref
  // this system writes but cannot read back is silent data loss, so the grammar
  // of that layout is part of this contract too.
  describe('content-addressed layout', () => {
    const HASH = 'a'.repeat(64);
    const CONTENT_REF = `gs://bucket/tenants/${TENANT}/content/${HASH}/body.json`;

    it('parses a content-addressed ref and exposes no run identity', () => {
      expect(parsePayloadRef(CONTENT_REF)).toEqual({
        form: 'object',
        layout: 'content',
        bucket: 'bucket',
        objectPath: `tenants/${TENANT}/content/${HASH}/body.json`,
        tenantId: TENANT,
        contentHash: HASH,
        payloadKind: 'body',
        extension: 'json',
      });
    });

    it('parses the binary lane of a content-addressed ref', () => {
      expect(parsePayloadRef(CONTENT_REF.replace('body.json', 'body.bin'))).toMatchObject({
        layout: 'content',
        payloadKind: 'body',
        extension: 'bin',
      });
    });

    const CONTENT_REJECTED: [string, string][] = [
      ['an address that is not a sha256 hex', CONTENT_REF.replace(HASH, 'not-a-hash')],
      ['an uppercase hex address', CONTENT_REF.replace(HASH, 'A'.repeat(64))],
      ['a truncated hash', CONTENT_REF.replace(HASH, 'a'.repeat(63))],
      ['traversal in place of the hash', `gs://bucket/tenants/${TENANT}/content/../x/body.json`],
      ['a missing content label', `gs://bucket/tenants/${TENANT}/${HASH}/body.json`],
      ['a trailing segment beyond the layout', `${CONTENT_REF}/extra`],
      ['an unknown payload kind', CONTENT_REF.replace('body.json', 'credentials.json')],
    ];

    for (const [name, ref] of CONTENT_REJECTED) {
      it(`rejects ${name}`, () => {
        expect(parsePayloadRef(ref)).toBeNull();
      });
    }
  });

  it('surfaces the tenant of a foreign ref rather than silently accepting it', () => {
    const foreign = CANONICAL.replace(TENANT, 'd0000000-0000-0000-0000-000000000009');
    const parsed = parsePayloadRef(foreign);
    expect(parsed).toMatchObject({ tenantId: 'd0000000-0000-0000-0000-000000000009' });
    expect(parsed).not.toMatchObject({ tenantId: TENANT });
  });
});

/**
 * Callers treat "does it parse" as "can it be resolved", so the inline branch is
 * a canonicality oracle whether or not it was built as one. An alphabet test is
 * not that: it admits strings that decode to nothing, and it bounds the
 * characters a payload arrives as rather than the bytes a reader materializes.
 */
describe('parsePayloadRef — inline canonicality', () => {
  const inlineOf = (value: unknown): string =>
    `inline:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;

  it('accepts what the writers actually produce', () => {
    // Every inline ref in the system is built by Buffer.toString('base64'),
    // which pads canonically — so tightening the parser must not reject any of
    // them. Sizes chosen to land on each padding case.
    for (const value of [{ a: 1 }, { ab: 12 }, { abc: 123 }, 'x', 'xy', 'xyz']) {
      expect(parsePayloadRef(inlineOf(value))).toEqual({ form: 'inline' });
    }
  });

  it('refuses padding that is not an encoding', () => {
    // Drawn entirely from the base64 alphabet, and decodes to nothing.
    expect(parsePayloadRef('inline:====')).toBeNull();
    expect(parsePayloadRef('inline:=')).toBeNull();
  });

  it('refuses a body that is not whole groups', () => {
    expect(parsePayloadRef('inline:QUJD')).toEqual({ form: 'inline' });
    expect(parsePayloadRef('inline:QUJ')).toBeNull();
    expect(parsePayloadRef('inline:Q')).toBeNull();
  });

  it('refuses padding outside the final group', () => {
    expect(parsePayloadRef('inline:QU==QUJD')).toBeNull();
    expect(parsePayloadRef('inline:=QUJ')).toBeNull();
  });

  it('refuses an empty body, which names no payload', () => {
    expect(parsePayloadRef('inline:')).toBeNull();
  });

  it('measures the decoded size, not the encoded one', () => {
    // The encoded-length bound rounds up to the next whole group, so the
    // largest body it admits carries two bytes more than the cap allows.
    const overByTwo = 'A'.repeat(Math.ceil(MAX_INLINE_PAYLOAD_BYTES / 3) * 4);
    expect(Buffer.from(overByTwo, 'base64')).toHaveLength(MAX_INLINE_PAYLOAD_BYTES + 2);
    expect(parsePayloadRef(`inline:${overByTwo}`)).toBeNull();
  });

  it('admits a payload of exactly the cap, and refuses one byte more', () => {
    const atCap = Buffer.alloc(MAX_INLINE_PAYLOAD_BYTES, 0x61).toString('base64');
    expect(parsePayloadRef(`inline:${atCap}`)).toEqual({ form: 'inline' });

    const overByOne = Buffer.alloc(MAX_INLINE_PAYLOAD_BYTES + 1, 0x61).toString('base64');
    expect(parsePayloadRef(`inline:${overByOne}`)).toBeNull();
  });
});
