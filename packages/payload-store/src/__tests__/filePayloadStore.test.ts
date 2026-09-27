/**
 * The durable local backend, exercised against a real temporary directory —
 * durability is the property it exists for, and a mocked filesystem would not
 * demonstrate it.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayloadKind, PayloadRef, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import {
  contentAddressForJson,
  createFilePayloadStore,
  encodeInlinePayloadRef,
  type PayloadStore,
} from '../store.js';
import { resolvePayloadStore } from '../resolve.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as TenantId;
const RUN = '11111111-1111-4111-8111-111111111111' as SessionId;
const STEP = '22222222-2222-4222-8222-222222222222' as StepExecutionId;

const target = {
  tenantId: TENANT,
  runId: RUN,
  stepExecutionId: STEP,
  attempt: 1,
  kind: 'output' as PayloadKind,
};

describe('createFilePayloadStore', () => {
  let root: string;
  let store: PayloadStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'payload-store-'));
    store = createFilePayloadStore({ rootDir: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a JSON payload', async () => {
    const ref = await store.store({ ...target, data: { hello: 'world' } });
    expect(ref).toMatch(/^gs:\/\/file-store\//);
    expect(await store.retrieve(ref)).toEqual({ hello: 'world' });
    expect(await store.exists(ref)).toBe(true);
  });

  it('round-trips bytes, and streams a range of them', async () => {
    const data = Buffer.from('0123456789');
    const ref = await store.storeBytes({ ...target, data });

    expect(await store.retrieveBytes(ref)).toEqual(data);

    const stream = await store.openByteStream(ref, { start: 2, end: 5 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('2345');
  });

  it('addresses identical content once', async () => {
    const data = { a: 1 };
    const contentHash = contentAddressForJson(data);
    const first = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash,
      kind: 'output',
      data,
    });
    const second = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash,
      kind: 'output',
      data,
    });
    expect(second).toBe(first);
    expect(await store.retrieve(first)).toEqual(data);
  });

  it('reports a missing payload rather than an empty one', async () => {
    const ref = store.buildRef(target);
    expect(await store.exists(ref)).toBe(false);
    await expect(store.retrieve(ref)).rejects.toThrow(/Payload not found/);
    await expect(store.retrieveBytes(`${ref.slice(0, -5)}.bin` as PayloadRef)).rejects.toThrow(
      /Payload not found/,
    );
  });

  // The whole point of this backend: what it wrote is still there.
  it('survives a new store over the same directory', async () => {
    const ref = await store.store({ ...target, data: { durable: true } });
    const reopened = createFilePayloadStore({ rootDir: root });
    expect(await reopened.retrieve(ref)).toEqual({ durable: true });
  });

  it('leaves nothing behind after a write', async () => {
    const ref = await store.storeBytes({ ...target, data: Buffer.from('x') });
    const dir = join(root, 'tenants', TENANT, 'runs', RUN, 'steps', STEP, 'attempt', '1');
    expect(await readdir(dir)).toEqual(['output.bin']);
    await store.delete(ref);
    expect(await readdir(dir)).toEqual([]);
  });

  it('deletes a payload that is already gone without complaining', async () => {
    await expect(store.delete(store.buildRef(target))).resolves.toBeUndefined();
  });

  // A ref naming another store's bucket would otherwise resolve against this
  // root and act on a same-named path here.
  it('refuses a ref from another bucket', async () => {
    const mine = store.buildRef(target);
    const theirs = mine.replace('file-store', 'redis-store') as PayloadRef;
    await expect(store.retrieve(theirs)).rejects.toThrow(/names bucket/);
  });

  // A URL that does not resolve fails in the browser, far from the cause —
  // and this backend is what a shipped appliance runs on.
  it('refuses to mint a signed URL rather than naming a host that does not exist', async () => {
    const ref = await store.storeBytes({ ...target, data: Buffer.from('x') });
    await expect(store.getSignedUrl(ref, { action: 'read', expiresInSeconds: 60 })).rejects.toThrow(
      /cannot mint signed URLs/,
    );
  });

  it('answers an inline ref from the ref itself', async () => {
    const inline = encodeInlinePayloadRef({ small: true });
    expect(await store.retrieve(inline)).toEqual({ small: true });
    expect(await store.exists(inline)).toBe(true);
  });
});

describe('resolvePayloadStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'payload-resolve-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers a named directory over anything else configured', () => {
    const resolved = resolvePayloadStore({
      env: { PHOENIX_PAYLOAD_DIR: root, GCS_PAYLOAD_BUCKET: 'a-bucket' },
    });
    expect(resolved?.backend).toBe('file');
  });

  it('treats a blank directory as unset', () => {
    const resolved = resolvePayloadStore({
      env: { PHOENIX_PAYLOAD_DIR: '  ', GCS_PAYLOAD_BUCKET: 'a-bucket' },
    });
    expect(resolved?.backend).toBe('gcs');
  });

  it('falls back to Redis when a connection is offered', () => {
    const redis = {} as never;
    expect(resolvePayloadStore({ env: {}, redis })?.backend).toBe('redis');
    expect(resolvePayloadStore({ env: { USE_REDIS_PAYLOAD_STORE: 'false' }, redis })).toBeNull();
  });

  // Not shared between processes, so a service whose payloads another service
  // reads must refuse rather than take it.
  it('offers the in-memory store only when the caller says it is acceptable', () => {
    expect(resolvePayloadStore({ env: {} })).toBeNull();
    expect(resolvePayloadStore({ env: {}, allowMemory: true })?.backend).toBe('memory');
  });
});

describe('file payload store containment', () => {
  it('will not write outside its root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'payload-escape-'));
    const store = createFilePayloadStore({ rootDir: join(root, 'inner') });
    await writeFile(join(root, 'outside.json'), '"untouched"');

    // `parsePayloadRef` refuses a traversal segment, so this is what a ref
    // carrying one actually produces.
    await expect(
      store.retrieve('gs://file-store/tenants/../../outside.json' as PayloadRef),
    ).rejects.toThrow();

    await rm(root, { recursive: true, force: true });
  });
});
