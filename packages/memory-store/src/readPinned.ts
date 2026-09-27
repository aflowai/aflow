/**
 * Reading a memory document back as bytes — the counterpart of the write side.
 *
 * A pinned read is the only kind that can be quoted afterwards. It names a
 * version and the hash that version held, and both are enforced here: a version
 * that no longer exists and a hash that disagrees each refuse, because falling
 * back to "whatever the path holds now" would let a caller state it read bytes
 * it never read.
 */
import type { MemoryDocRepository } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { PinnedMemoryRef } from '@aflow/schemas';
import { isBinaryPayloadRef } from './binaryDetection.js';
import { computeBytesHash } from './contentUtils.js';
import { workspacePathToMemoryPath } from './saveBytes.js';

/** The half of a doc or version row that says where its body lives. */
export interface MemoryBodyLocation {
  inlineContent: string | null;
  payloadRef: string | null;
}

export type PinnedReadPayloadStore = Pick<PayloadStore, 'retrieve' | 'retrieveBytes'>;

/**
 * The bytes of a memory-doc body, whichever lane it was written on.
 *
 * `storeBytes` addresses a `.bin` object that only `retrieveBytes` can read;
 * every other ref belongs to the lane `retrieve` parses. The docType does not
 * decide this — the write lane does, and the two disagree in both directions.
 */
export async function readMemoryBodyBytes(
  source: MemoryBodyLocation,
  payloadStore: PinnedReadPayloadStore,
): Promise<Buffer | null> {
  if (source.inlineContent !== null) return Buffer.from(source.inlineContent, 'utf-8');
  if (source.payloadRef === null) return null;
  if (isBinaryPayloadRef(source.payloadRef)) {
    return await payloadStore.retrieveBytes(source.payloadRef);
  }
  const payload = await payloadStore.retrieve(source.payloadRef);
  return Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf-8');
}

export type PinnedReadFailure =
  'not_found' | 'version_not_found' | 'content_hash_mismatch' | 'no_content';

export class PinnedMemoryReadError extends Error {
  constructor(
    message: string,
    readonly code: PinnedReadFailure,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PinnedMemoryReadError';
  }
}

export interface PinnedMemoryContent {
  bytes: Buffer;
  mimeType: string;
  docId: string;
  /** The canonical path the reference resolved to, which the caller may have spelled as a mount. */
  path: string;
  version: number;
  contentHash: string;
}

export interface ReadPinnedMemoryDocParams {
  repo: MemoryDocRepository;
  payloadStore: PinnedReadPayloadStore;
  spaceId: string;
  ref: PinnedMemoryRef;
}

export async function readPinnedMemoryDoc(
  params: ReadPinnedMemoryDocParams,
): Promise<PinnedMemoryContent> {
  const { repo, payloadStore, spaceId, ref } = params;
  const path = workspacePathToMemoryPath(ref.path);

  const doc = await repo.getByPath(path, spaceId);
  if (!doc) {
    throw new PinnedMemoryReadError(`No memory document at ${path}.`, 'not_found', { path });
  }

  const version = await repo.getVersion(doc.id, ref.version);
  if (!version) {
    throw new PinnedMemoryReadError(
      `${path} has no version ${String(ref.version)} (current version is ` +
        `${String(doc.currentVersion)}). A pinned read never falls back to the current version.`,
      'version_not_found',
      { path, requestedVersion: ref.version, currentVersion: doc.currentVersion },
    );
  }

  // Checked before the body is fetched: a pin the row already contradicts is
  // not worth pulling megabytes of image out of the payload store for.
  if (version.contentHash !== ref.contentHash) {
    throw new PinnedMemoryReadError(
      hashMismatchMessage(path, ref.version, version.contentHash, ref.contentHash),
      'content_hash_mismatch',
      {
        path,
        version: ref.version,
        actualContentHash: version.contentHash,
        expectedContentHash: ref.contentHash,
      },
    );
  }

  const bytes = await readMemoryBodyBytes(version, payloadStore);
  if (bytes === null) {
    throw new PinnedMemoryReadError(
      `${path} version ${String(ref.version)} has no content.`,
      'no_content',
      { path, version: ref.version },
    );
  }

  // The row's hash describes what was written; this one describes what came
  // back. Only the second makes the pin a statement about the bytes in hand.
  const deliveredHash = computeBytesHash(bytes);
  if (deliveredHash !== ref.contentHash) {
    throw new PinnedMemoryReadError(
      hashMismatchMessage(path, ref.version, deliveredHash, ref.contentHash),
      'content_hash_mismatch',
      {
        path,
        version: ref.version,
        actualContentHash: deliveredHash,
        expectedContentHash: ref.contentHash,
      },
    );
  }

  return {
    bytes,
    mimeType: doc.mimeType,
    docId: doc.id,
    path,
    version: version.version,
    contentHash: version.contentHash,
  };
}

function hashMismatchMessage(
  path: string,
  version: number,
  actual: string,
  expected: string,
): string {
  return (
    `${path} version ${String(version)} hashes to ${actual}, but contentHash was ${expected}. ` +
    'These are not the bytes this reference was pinned to — read the version the pin names, or ' +
    're-pin to the current content deliberately.'
  );
}
