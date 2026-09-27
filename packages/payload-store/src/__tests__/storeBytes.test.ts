import { describe, it, expect } from 'vitest';
import type { Readable } from 'node:stream';
import type { TenantId, SessionId, StepExecutionId, PayloadKind } from '@aflow/schemas';
import { createMemoryPayloadStore } from '../store.js';

const base = {
  tenantId: 'tenant-1' as TenantId,
  runId: 'run-1' as SessionId,
  stepExecutionId: 'step-1' as StepExecutionId,
  attempt: 0,
  kind: 'body' as PayloadKind,
};

/** Bytes that are NOT valid UTF-8 — would be corrupted by a JSON/string round-trip. */
function nonUtf8Bytes(): Buffer {
  return Buffer.from([0x00, 0xff, 0x80, 0xfe, 0x01, 0x7f, 0x90, 0xc0]);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

describe('PayloadStore binary lane (memory store)', () => {
  it('round-trips non-UTF-8 bytes exactly (no JSON mangling)', async () => {
    const store = createMemoryPayloadStore();
    const bytes = nonUtf8Bytes();

    const ref = await store.storeBytes({ ...base, data: bytes });
    const got = await store.retrieveBytes(ref);

    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(bytes)).toBe(true);
  });

  it('uses a .bin ref distinct from the .json ref for the same key', async () => {
    const store = createMemoryPayloadStore();
    const jsonRef = await store.store({ ...base, data: { hello: 'world' } });
    const binRef = await store.storeBytes({ ...base, data: Buffer.from([1, 2, 3]) });
    expect(jsonRef).not.toEqual(binRef);
    expect(binRef.endsWith('.bin')).toBe(true);
    expect(jsonRef.endsWith('.json')).toBe(true);
  });

  it('clones on store so later mutation of the caller buffer cannot corrupt the payload', async () => {
    const store = createMemoryPayloadStore();
    const bytes = Buffer.from([10, 20, 30]);
    const ref = await store.storeBytes({ ...base, data: bytes });

    bytes[0] = 99; // mutate the original after storing

    const got = await store.retrieveBytes(ref);
    expect(got[0]).toBe(10); // payload unaffected by the mutation
  });

  it('clones on retrieve so callers cannot mutate the stored payload', async () => {
    const store = createMemoryPayloadStore();
    const ref = await store.storeBytes({ ...base, data: Buffer.from([5, 6, 7]) });

    const first = await store.retrieveBytes(ref);
    first[0] = 42; // mutate the returned buffer

    const second = await store.retrieveBytes(ref);
    expect(second[0]).toBe(5); // stored copy intact
  });

  it('retrieveBytes rejects a JSON-lane (.json) ref', async () => {
    const store = createMemoryPayloadStore();
    const jsonRef = await store.store({ ...base, data: { a: 1 } });
    expect(jsonRef.endsWith('.json')).toBe(true);
    await expect(store.retrieveBytes(jsonRef)).rejects.toThrow(/not a binary payload ref/i);
  });

  it('retrieveBytes rejects an inline ref', async () => {
    const store = createMemoryPayloadStore();
    await expect(store.retrieveBytes('inline:e30=' as never)).rejects.toThrow(/inline/i);
  });

  it('retrieveBytes rejects a missing ref', async () => {
    const store = createMemoryPayloadStore();
    const ref = store.buildRef(base).replace('.json', '.bin') as never;
    await expect(store.retrieveBytes(ref)).rejects.toThrow(/not found/i);
  });

  it('the JSON lane is unaffected by the binary lane', async () => {
    const store = createMemoryPayloadStore();
    const ref = await store.store({ ...base, data: { keep: 'json' } });
    const got = (await store.retrieve(ref)) as { keep: string };
    expect(got.keep).toBe('json');
  });

  it('openByteStream streams the whole payload, and only the requested slice for a range', async () => {
    const store = createMemoryPayloadStore();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const ref = await store.storeBytes({ ...base, data: bytes });

    expect((await collect(await store.openByteStream(ref))).equals(bytes)).toBe(true);
    expect(
      (await collect(await store.openByteStream(ref, { start: 10, end: 19 }))).equals(
        bytes.subarray(10, 20),
      ),
    ).toBe(true);
    // A range end past the last byte yields what is there, nothing more.
    expect(
      (await collect(await store.openByteStream(ref, { start: 250, end: 999 }))).equals(
        bytes.subarray(250),
      ),
    ).toBe(true);
  });

  it('openByteStream rejects a JSON-lane ref and a missing ref', async () => {
    const store = createMemoryPayloadStore();
    const jsonRef = await store.store({ ...base, data: { a: 1 } });
    await expect(store.openByteStream(jsonRef)).rejects.toThrow(/not a binary payload ref/i);

    const missing = store.buildRef(base).replace('.json', '.bin') as never;
    await expect(store.openByteStream(missing)).rejects.toThrow(/not found/i);
  });

  it('shouldStoreBytes is always true (binary always externalizes)', () => {
    const store = createMemoryPayloadStore();
    expect(store.shouldStoreBytes(Buffer.alloc(0))).toBe(true);
    expect(store.shouldStoreBytes(Buffer.from([1]))).toBe(true);
  });
});
