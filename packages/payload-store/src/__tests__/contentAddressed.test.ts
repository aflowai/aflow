import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { TenantId, PayloadKind } from '@aflow/schemas';
import { parsePayloadRef } from '@aflow/schemas';
import { createMemoryPayloadStore, contentAddressForJson } from '../store.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const KIND = 'body' as PayloadKind;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

describe('PayloadStore content-addressed lane', () => {
  it('addresses an object by its content hash, under the tenant and outside any run', async () => {
    const store = createMemoryPayloadStore();
    const text = 'the body';
    const address = contentAddressForJson(text);
    const ref = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash: address,
      kind: KIND,
      data: text,
    });

    expect(ref).toBe(`gs://test-bucket/tenants/${TENANT}/content/${address}/body.json`);

    const parsed = parsePayloadRef(ref);
    expect(parsed).toEqual({
      form: 'object',
      layout: 'content',
      bucket: 'test-bucket',
      objectPath: `tenants/${TENANT}/content/${address}/body.json`,
      tenantId: TENANT,
      contentHash: address,
      payloadKind: 'body',
      extension: 'json',
    });
  });

  it('gives different content different addresses and identical content one address', async () => {
    const store = createMemoryPayloadStore();
    const a = 'document A';
    const b = 'document B';

    const refA = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash: contentAddressForJson(a),
      kind: KIND,
      data: a,
    });
    const refB = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash: contentAddressForJson(b),
      kind: KIND,
      data: b,
    });
    const refADuplicate = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash: contentAddressForJson(a),
      kind: KIND,
      data: a,
    });

    expect(refA).not.toBe(refB);
    expect(refADuplicate).toBe(refA);
    expect(await store.retrieve(refA)).toBe(a);
    expect(await store.retrieve(refB)).toBe(b);
  });

  it('keeps the binary lane on its own .bin object and round-trips the exact bytes', async () => {
    const store = createMemoryPayloadStore();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0xfe, 0x01]);

    const ref = await store.storeBytesContentAddressed({
      tenantId: TENANT,
      contentHash: sha256(bytes),
      kind: KIND,
      data: bytes,
      contentType: 'application/octet-stream',
    });

    expect(ref.endsWith(`/content/${sha256(bytes)}/body.bin`)).toBe(true);
    expect((await store.retrieveBytes(ref)).equals(bytes)).toBe(true);
  });

  it('refuses an address that is not a content hash, instead of storing bytes nothing can read', async () => {
    const store = createMemoryPayloadStore();
    await expect(
      store.storeContentAddressed({
        tenantId: TENANT,
        contentHash: 'not-a-hash',
        kind: KIND,
        data: 'x',
      }),
    ).rejects.toThrow(/SHA-256/);
  });

  it('leaves the run-scoped address untouched for step payloads', async () => {
    const store = createMemoryPayloadStore();
    const ref = await store.store({
      tenantId: TENANT,
      runId: 'run-1' as never,
      stepExecutionId: 'step-1' as never,
      attempt: 2,
      kind: 'output' as PayloadKind,
      data: { a: 1 },
    });
    expect(ref).toBe(
      `gs://test-bucket/tenants/${TENANT}/runs/run-1/steps/step-1/attempt/2/output.json`,
    );
    expect(parsePayloadRef(ref)).toMatchObject({ layout: 'run', runId: 'run-1', attempt: 2 });
  });
});
