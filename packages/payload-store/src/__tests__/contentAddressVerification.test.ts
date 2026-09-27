import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { TenantId, PayloadKind, PayloadRef } from '@aflow/schemas';
import {
  createMemoryPayloadStore,
  createPayloadStore,
  createRedisPayloadStore,
  contentAddressForJson,
  type PayloadStore,
} from '../store.js';

const gcs = vi.hoisted(() => ({
  objects: new Map<string, { data: Buffer; metadata: Record<string, unknown> }>(),
}));

vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket(): {
      file: (path: string) => {
        save: (data: Buffer, options: { metadata?: Record<string, unknown> }) => Promise<void>;
        exists: () => Promise<[boolean]>;
        download: () => Promise<[Buffer]>;
      };
    } {
      return {
        file(path: string) {
          return {
            save(data: Buffer, options: { metadata?: Record<string, unknown> }): Promise<void> {
              gcs.objects.set(path, {
                data: Buffer.from(data),
                metadata: options.metadata ?? {},
              });
              return Promise.resolve();
            },
            exists(): Promise<[boolean]> {
              return Promise.resolve([gcs.objects.has(path)]);
            },
            download(): Promise<[Buffer]> {
              const object = gcs.objects.get(path);
              if (!object) throw new Error(`Payload not found: ${path}`);
              return Promise.resolve([object.data]);
            },
          };
        },
      };
    }
  }
  return { Storage };
});

class FakeRedis {
  readonly values = new Map<string, Buffer>();

  set(key: string, value: string | Buffer): Promise<'OK'> {
    this.values.set(key, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf-8'));
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key)?.toString('utf-8') ?? null);
  }

  getBuffer(key: string): Promise<Buffer | null> {
    const value = this.values.get(key);
    return Promise.resolve(value ? Buffer.from(value) : null);
  }

  exists(key: string): Promise<number> {
    return Promise.resolve(this.values.has(key) ? 1 : 0);
  }
}

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const KIND = 'body' as PayloadKind;
const GCS_BUCKET = 'payload-bucket';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** A syntactically valid address that no content in these tests hashes to. */
const WRONG_ADDRESS = sha256('some other document entirely');

interface Backend {
  name: string;
  bucket: string;
  create: () => PayloadStore;
}

const backends: Backend[] = [
  { name: 'memory', bucket: 'test-bucket', create: () => createMemoryPayloadStore() },
  {
    name: 'redis',
    bucket: 'redis-store',
    create: () => createRedisPayloadStore(new FakeRedis() as unknown as Redis),
  },
  {
    name: 'gcs',
    bucket: GCS_BUCKET,
    create: () => createPayloadStore({ bucketName: GCS_BUCKET }),
  },
];

const addressOf = (backend: Backend, hash: string, ext: 'json' | 'bin'): PayloadRef =>
  `gs://${backend.bucket}/tenants/${TENANT}/content/${hash}/body.${ext}` as PayloadRef;

beforeEach(() => {
  gcs.objects.clear();
});

describe.each(backends)('content address verification ($name backend)', (backend) => {
  it('refuses a JSON body whose claimed address is not its digest, and stores nothing there', async () => {
    const store = backend.create();

    await expect(
      store.storeContentAddressed({
        tenantId: TENANT,
        contentHash: WRONG_ADDRESS,
        kind: KIND,
        data: 'the body that was actually handed over',
      }),
    ).rejects.toThrow(/does not match/i);

    expect(await store.exists(addressOf(backend, WRONG_ADDRESS, 'json'))).toBe(false);
  });

  it('refuses bytes whose claimed address is not their digest, and stores nothing there', async () => {
    const store = backend.create();

    await expect(
      store.storeBytesContentAddressed({
        tenantId: TENANT,
        contentHash: WRONG_ADDRESS,
        kind: KIND,
        data: Buffer.from([0x00, 0xff, 0x80, 0xfe]),
      }),
    ).rejects.toThrow(/does not match/i);

    expect(await store.exists(addressOf(backend, WRONG_ADDRESS, 'bin'))).toBe(false);
  });

  it('names the claimed address and the actual digest so the mismatch is diagnosable', async () => {
    const store = backend.create();
    const data = 'the body that was actually handed over';

    await expect(
      store.storeContentAddressed({
        tenantId: TENANT,
        contentHash: WRONG_ADDRESS,
        kind: KIND,
        data,
      }),
    ).rejects.toThrow(new RegExp(`${WRONG_ADDRESS}[\\s\\S]*${contentAddressForJson(data)}`));
  });

  it('cannot be used to overwrite content already at an address', async () => {
    const store = backend.create();
    const first = 'the version this address holds';
    const address = contentAddressForJson(first);

    const ref = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash: address,
      kind: KIND,
      data: first,
    });

    await expect(
      store.storeContentAddressed({
        tenantId: TENANT,
        contentHash: address,
        kind: KIND,
        data: 'a different version claiming that address',
      }),
    ).rejects.toThrow(/does not match/i);

    expect(await store.retrieve(ref)).toBe(first);
  });

  it('stores a JSON body whose claimed address is its digest', async () => {
    const store = backend.create();
    const data = { title: 'a document', body: 'with content' };

    const ref = await store.storeContentAddressed({
      tenantId: TENANT,
      contentHash: contentAddressForJson(data),
      kind: KIND,
      data,
      persist: true,
    });

    expect(ref).toBe(addressOf(backend, contentAddressForJson(data), 'json'));
    expect(await store.retrieve(ref)).toEqual(data);
  });

  it('stores bytes whose claimed address is their digest', async () => {
    const store = backend.create();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0xfe, 0x01]);

    const ref = await store.storeBytesContentAddressed({
      tenantId: TENANT,
      contentHash: sha256(bytes),
      kind: KIND,
      data: bytes,
      persist: true,
    });

    expect(ref).toBe(addressOf(backend, sha256(bytes), 'bin'));
    expect((await store.retrieveBytes(ref)).equals(bytes)).toBe(true);
  });

  it('still refuses an address that is not lowercase SHA-256 hex', async () => {
    const store = backend.create();

    await expect(
      store.storeContentAddressed({
        tenantId: TENANT,
        contentHash: 'not-a-hash',
        kind: KIND,
        data: 'x',
      }),
    ).rejects.toThrow(/SHA-256/);

    await expect(
      store.storeBytesContentAddressed({
        tenantId: TENANT,
        contentHash: sha256('x').toUpperCase(),
        kind: KIND,
        data: Buffer.from('x'),
      }),
    ).rejects.toThrow(/SHA-256/);
  });
});

describe('content address derivation', () => {
  it('derives the address every backend writes at, so a caller never guesses the encoding', async () => {
    const data = { b: 2, a: 1 };
    const address = contentAddressForJson(data);

    for (const backend of backends) {
      const store = backend.create();
      const ref = await store.storeContentAddressed({
        tenantId: TENANT,
        contentHash: address,
        kind: KIND,
        data,
      });
      expect(ref).toBe(addressOf(backend, address, 'json'));
    }
  });

  it('gives identical content one address and different content different addresses', () => {
    expect(contentAddressForJson('same')).toBe(contentAddressForJson('same'));
    expect(contentAddressForJson('same')).not.toBe(contentAddressForJson('other'));
  });
});
