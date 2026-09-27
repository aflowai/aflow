/**
 * A stored object keeps the Content-Type its upload declared, and a signed read
 * hands that type straight to the browser. A write URL that does not pin the
 * type therefore delegates the rendering decision to whoever holds the URL,
 * which undoes any allowlist the caller passed to get it.
 *
 * Pinning has to hold in the backend, not in the caller: only a signed header
 * makes a PUT with a different Content-Type fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PayloadRef } from '@aflow/schemas';

const gcsFile = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));

vi.mock('@google-cloud/storage', () => {
  class FakeStorage {
    bucket(): unknown {
      return { file: (): unknown => gcsFile };
    }
  }
  return { Storage: FakeStorage } as unknown as typeof import('@google-cloud/storage');
});

const { createPayloadStore, createMemoryPayloadStore, createRedisPayloadStore } =
  await import('../store.js');

const OBJECT_PATH = 'tenants/t1/runs/r1/steps/s1/attempt/0/output.bin';
const gcsRef = 'gs://gcs-bucket/' + OBJECT_PATH;
const memoryRef = 'gs://test-bucket/' + OBJECT_PATH;
const redisRef = 'gs://redis-store/' + OBJECT_PATH;

function signedConfig(): Record<string, unknown> {
  const call = gcsFile.getSignedUrl.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (!call) throw new Error('getSignedUrl was never called');
  return call;
}

describe('signed write URLs pin the Content-Type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gcsFile.getSignedUrl.mockResolvedValue(['https://signed.example/url']);
  });

  it('signs the requested content type for a write', async () => {
    const store = createPayloadStore({ bucketName: 'gcs-bucket' });

    await store.getSignedUrl(gcsRef as PayloadRef, {
      action: 'write',
      contentType: 'text/plain',
    });

    expect(signedConfig()['action']).toBe('write');
    expect(signedConfig()['contentType']).toBe('text/plain');
  });

  // A read URL serves an object that already has a type; pinning one here would
  // make the signature refuse the very object it was minted for.
  it('signs no content type for a read', async () => {
    const store = createPayloadStore({ bucketName: 'gcs-bucket' });

    await store.getSignedUrl(gcsRef as PayloadRef, { action: 'read' });

    expect(signedConfig()['action']).toBe('read');
    expect(signedConfig()).not.toHaveProperty('contentType');
  });

  it('carries the pin through the in-memory backend', async () => {
    const url = await createMemoryPayloadStore().getSignedUrl(memoryRef as PayloadRef, {
      action: 'write',
      contentType: 'application/octet-stream',
    });

    expect(new URL(url).searchParams.get('contentType')).toBe('application/octet-stream');
  });

  it('carries the pin through the Redis backend', async () => {
    const redis = {} as unknown as Parameters<typeof createRedisPayloadStore>[0];
    const url = await createRedisPayloadStore(redis).getSignedUrl(redisRef as PayloadRef, {
      action: 'write',
      contentType: 'application/json',
    });

    expect(new URL(url).searchParams.get('contentType')).toBe('application/json');
  });
});
