import { describe, it, expect, vi } from 'vitest';
import type { MemoryDoc, MemoryDocRepository, MemoryDocVersion } from '@aflow/database';
import { computeBytesHash } from './contentUtils.js';
import { PinnedMemoryReadError, readPinnedMemoryDoc } from './readPinned.js';

const SPACE_ID = 'space-1';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
const HASH = computeBytesHash(BYTES);

function doc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return {
    id: 'doc-1',
    path: '/media/run-1/take-abc-0',
    docType: 'image',
    mimeType: 'image/png',
    currentVersion: 2,
    ...overrides,
  } as MemoryDoc;
}

function version(overrides: Partial<MemoryDocVersion> = {}): MemoryDocVersion {
  return {
    id: 'v-1',
    docId: 'doc-1',
    version: 1,
    inlineContent: null,
    payloadRef: 'gs://bucket/body/abc.bin',
    contentHash: HASH,
    sizeBytes: BYTES.length,
    ...overrides,
  } as MemoryDocVersion;
}

function repoOf(
  found: MemoryDoc | null,
  versions: Record<number, MemoryDocVersion | null>,
): MemoryDocRepository {
  return {
    getByPath: vi.fn().mockResolvedValue(found),
    getVersion: vi.fn((_id: string, v: number) => Promise.resolve(versions[v] ?? null)),
  } as unknown as MemoryDocRepository;
}

function storeOf(overrides: {
  retrieve?: ReturnType<typeof vi.fn>;
  retrieveBytes?: ReturnType<typeof vi.fn>;
}) {
  return {
    retrieve: overrides.retrieve ?? vi.fn().mockRejectedValue(new Error('wrong lane')),
    retrieveBytes: overrides.retrieveBytes ?? vi.fn().mockRejectedValue(new Error('wrong lane')),
  };
}

const pin = { path: '/media/run-1/take-abc-0', version: 1, contentHash: HASH };

describe('readPinnedMemoryDoc — the lane the bytes are actually on', () => {
  it('reads a .bin body through retrieveBytes even when the docType says otherwise', async () => {
    const retrieveBytes = vi.fn().mockResolvedValue(BYTES);
    const payloadStore = storeOf({ retrieveBytes });

    const content = await readPinnedMemoryDoc({
      repo: repoOf(doc({ docType: 'json' }), { 1: version() }),
      payloadStore,
      spaceId: SPACE_ID,
      ref: pin,
    });

    expect(content.bytes).toEqual(BYTES);
    expect(retrieveBytes).toHaveBeenCalledWith('gs://bucket/body/abc.bin');
    expect(payloadStore.retrieve).not.toHaveBeenCalled();
  });

  it('reads a text-lane body through retrieve even when the docType says image', async () => {
    const text = '<svg viewBox="0 0 1 1"/>';
    const retrieve = vi.fn().mockResolvedValue(text);
    const payloadStore = storeOf({ retrieve });

    const content = await readPinnedMemoryDoc({
      repo: repoOf(doc(), {
        1: version({
          payloadRef: 'gs://bucket/body/abc.json',
          contentHash: computeBytesHash(Buffer.from(text, 'utf-8')),
        }),
      }),
      payloadStore,
      spaceId: SPACE_ID,
      ref: { ...pin, contentHash: computeBytesHash(Buffer.from(text, 'utf-8')) },
    });

    expect(content.bytes.toString('utf-8')).toBe(text);
    expect(payloadStore.retrieveBytes).not.toHaveBeenCalled();
  });
});

describe('readPinnedMemoryDoc — what a pin refuses', () => {
  it('refuses a version the document does not have, naming the one it does', async () => {
    const payloadStore = storeOf({});
    await expect(
      readPinnedMemoryDoc({
        repo: repoOf(doc(), { 1: version() }),
        payloadStore,
        spaceId: SPACE_ID,
        ref: { ...pin, version: 7 },
      }),
    ).rejects.toMatchObject({ code: 'version_not_found' });
    expect(payloadStore.retrieveBytes).not.toHaveBeenCalled();
  });

  it('refuses a hash the version row disagrees with, before reading any bytes', async () => {
    const payloadStore = storeOf({});
    const failure = await readPinnedMemoryDoc({
      repo: repoOf(doc(), { 1: version() }),
      payloadStore,
      spaceId: SPACE_ID,
      ref: { ...pin, contentHash: 'f'.repeat(64) },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PinnedMemoryReadError);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain(HASH);
    expect(message).toContain('f'.repeat(64));
    expect(payloadStore.retrieveBytes).not.toHaveBeenCalled();
  });

  it('refuses bytes that disagree with the row the pin matched', async () => {
    const payloadStore = storeOf({
      retrieveBytes: vi.fn().mockResolvedValue(Buffer.from('something else')),
    });

    await expect(
      readPinnedMemoryDoc({
        repo: repoOf(doc(), { 1: version() }),
        payloadStore,
        spaceId: SPACE_ID,
        ref: pin,
      }),
    ).rejects.toMatchObject({ code: 'content_hash_mismatch' });
  });

  it('refuses a path this space has no document at', async () => {
    await expect(
      readPinnedMemoryDoc({
        repo: repoOf(null, {}),
        payloadStore: storeOf({}),
        spaceId: SPACE_ID,
        ref: pin,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
