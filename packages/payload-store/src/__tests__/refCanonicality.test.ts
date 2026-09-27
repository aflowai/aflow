import { describe, expect, it } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES, parsePayloadRef, type PayloadRef } from '@aflow/schemas';
import { createMemoryPayloadStore } from '../store.js';

/**
 * Every backend addresses an object through the one shared ref parser, so the
 * refs a caller cannot parse are exactly the refs no backend can reach.
 *
 * The memory backend stands in for GCS across the suite. Keying its map on the
 * raw ref string would let it serve shapes the deployed backends refuse, and
 * then every test using it attests to a reachability property production does
 * not have — including the tenant-boundary tests, which rely on an unparseable
 * ref reaching nothing in order to leave parsing to the store.
 */
describe('a payload ref that is not canonical', () => {
  const NOT_CANONICAL = 'gs://test-bucket/../etc/passwd' as PayloadRef;

  it('is refused by the memory backend rather than treated as an opaque key', async () => {
    const store = createMemoryPayloadStore();
    await expect(store.retrieve(NOT_CANONICAL)).rejects.toThrow(/invalid .*payload_ref format/i);
  });

  it('is refused on the existence check, which would otherwise answer for it', async () => {
    const store = createMemoryPayloadStore();
    await expect(store.exists(NOT_CANONICAL)).rejects.toThrow(/invalid .*payload_ref format/i);
  });

  it('names the shape it refused, so a refusal is not mistaken for a missing object', async () => {
    const store = createMemoryPayloadStore();
    const thrown: unknown = await store.retrieve(NOT_CANONICAL).catch((err: unknown) => err);
    expect(String(thrown)).not.toMatch(/not found/i);
  });
});

/**
 * The cap keeps an unbounded, caller-supplied string away from a base64 decode
 * and a JSON parse. A ref arrives on operation input the agent wrote, and every
 * backend answers an inline ref from the ref itself — so if the store decodes
 * one the parser rejects, the cap protects nothing on the path that matters.
 */
describe('an inline payload ref over the cap', () => {
  const oversized = { blob: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 10_000) };
  const OVERSIZED = `inline:${Buffer.from(JSON.stringify(oversized)).toString(
    'base64',
  )}` as PayloadRef;

  it('is not a ref this system recognises', () => {
    expect(parsePayloadRef(OVERSIZED)).toBeNull();
  });

  it('is refused by the store rather than decoded', async () => {
    const store = createMemoryPayloadStore();
    await expect(store.retrieve(OVERSIZED)).rejects.toThrow(/invalid inline payload_ref/i);
  });

  it('is refused by the existence check, which answered for it without looking', async () => {
    const store = createMemoryPayloadStore();
    await expect(store.exists(OVERSIZED)).rejects.toThrow(/invalid inline payload_ref/i);
  });

  it('is refused when its payload is not base64 at all', async () => {
    const store = createMemoryPayloadStore();
    await expect(store.exists('inline:@@@not-base64@@@' as PayloadRef)).rejects.toThrow(
      /invalid inline payload_ref/i,
    );
  });

  it('is refused without echoing the payload the caller chose', async () => {
    const store = createMemoryPayloadStore();
    const thrown: unknown = await store.retrieve(OVERSIZED).catch((err: unknown) => err);
    expect(String(thrown)).not.toContain('xxxxxxxxxx');
    expect(String(thrown).length).toBeLessThan(200);
  });

  it('still carries an inline ref within the cap', async () => {
    const store = createMemoryPayloadStore();
    const small =
      `inline:${Buffer.from(JSON.stringify({ a: 1 })).toString('base64')}` as PayloadRef;
    await expect(store.retrieve(small)).resolves.toEqual({ a: 1 });
    await expect(store.exists(small)).resolves.toBe(true);
  });
});
