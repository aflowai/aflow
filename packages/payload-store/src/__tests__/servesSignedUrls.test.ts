/**
 * `servesSignedUrls` is the store telling callers whether a URL it hands back
 * is one a client can actually fetch, and the answer decides whether a route
 * redirects or delivers the bytes itself. A store that answers `true` while
 * returning a placeholder sends the browser somewhere that does not exist, and
 * the failure surfaces a layer away from the store that caused it — so the
 * declaration is checked against what `getSignedUrl` really does rather than
 * taken at its word.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PayloadRef } from '@aflow/schemas';

vi.mock('@google-cloud/storage', () => {
  class FakeStorage {
    bucket(): unknown {
      return {
        file: (): unknown => ({
          getSignedUrl: () => Promise.resolve(['https://storage.googleapis.com/signed']),
        }),
      };
    }
  }
  return { Storage: FakeStorage } as unknown as typeof import('@google-cloud/storage');
});

const {
  createPayloadStore,
  createMemoryPayloadStore,
  createFilePayloadStore,
  createRedisPayloadStore,
} = await import('../store.js');

const OBJECT_PATH = 'tenants/t1/runs/r1/steps/s1/attempt/0/output.bin';

describe('servesSignedUrls', () => {
  /**
   * The default when `PHOENIX_PAYLOAD_DIR` is unset, so its answer is the one a
   * developer meets first.
   */
  const redis = (): ReturnType<typeof createRedisPayloadStore> =>
    createRedisPayloadStore({} as never);

  it('is set only on the backend with an object host in front of it', () => {
    expect(createPayloadStore({ backend: 'gcs', bucketName: 'gcs-bucket' }).servesSignedUrls).toBe(
      true,
    );
    expect(createMemoryPayloadStore().servesSignedUrls).toBe(false);
    expect(
      createFilePayloadStore({ rootDir: '/tmp/does-not-need-to-exist' }).servesSignedUrls,
    ).toBe(false);
    expect(redis().servesSignedUrls).toBe(false);
  });

  it('is false on the Redis backend, whose URL names a host that does not exist', async () => {
    const store = redis();
    const url = await store.getSignedUrl(`gs://redis-store/${OBJECT_PATH}` as PayloadRef, {
      action: 'read',
      expiresInSeconds: 60,
    });
    expect(url).toContain('redis-store.local');
    expect(store.servesSignedUrls).toBe(false);
  });

  /**
   * The memory backend answers a `storage.googleapis.com` URL for an object it
   * never uploaded. It is a development fallback and the URL is a placeholder,
   * which is exactly why it must not claim to serve one.
   */
  it('is false wherever the URL would not resolve', async () => {
    const memory = createMemoryPayloadStore();
    const url = await memory.getSignedUrl(`gs://test-bucket/${OBJECT_PATH}` as PayloadRef, {
      action: 'read',
      expiresInSeconds: 60,
    });
    expect(url).toContain('storage.googleapis.com');
    expect(memory.servesSignedUrls).toBe(false);
  });

  it('is false wherever asking for a URL is refused outright', async () => {
    const file = createFilePayloadStore({ rootDir: '/tmp/does-not-need-to-exist' });
    await expect(
      file.getSignedUrl(`gs://file-store/${OBJECT_PATH}` as PayloadRef, {
        action: 'read',
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow();
    expect(file.servesSignedUrls).toBe(false);
  });
});
