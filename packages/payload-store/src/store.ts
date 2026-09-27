/**
 * Payload store for GCS object storage.
 * Stores large payloads and returns payload_ref URIs.
 */
import type { Redis } from 'ioredis';
import { Storage, type Bucket, type CreateReadStreamOptions } from '@google-cloud/storage';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  type TenantId,
  type SessionId,
  type StepExecutionId,
  type PayloadKind,
  type PayloadRef,
  MAX_INLINE_PAYLOAD_BYTES,
  CONTENT_ADDRESSED_LABEL,
  CONTENT_HASH_PATTERN,
  parsePayloadRef,
} from '@aflow/schemas';

// ============================================================================
// Configuration
// ============================================================================

export interface PayloadStoreConfig {
  /** GCS bucket name */
  bucketName: string;
  /** Project ID (optional, uses default credentials if not specified) */
  projectId?: string;
  /** Key file path (optional, uses default credentials if not specified) */
  keyFilename?: string;
}

/**
 * Get payload store configuration from environment.
 */
export function getPayloadStoreConfig(env: NodeJS.ProcessEnv = process.env): PayloadStoreConfig {
  const bucketName = env['GCS_PAYLOAD_BUCKET'];
  if (!bucketName) {
    throw new Error('GCS_PAYLOAD_BUCKET environment variable is required');
  }

  const config: PayloadStoreConfig = { bucketName };

  const projectId = env['GCP_PROJECT_ID'];
  if (projectId) {
    config.projectId = projectId;
  }

  const keyFilename = env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (keyFilename) {
    config.keyFilename = keyFilename;
  }

  return config;
}

// ============================================================================
// Payload Store Interface
// ============================================================================

/** Inclusive byte offsets — the same semantics an HTTP `Range` header carries. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Address for a payload whose identity is its own content, not the run that
 * produced it. Two stores of the same bytes resolve to one object; a store of
 * different bytes can never land on an address another payload already holds.
 */
export interface ContentAddressedParams {
  tenantId: TenantId;
  /**
   * Lowercase SHA-256 hex of the content — this IS the address. The store
   * verifies it against the bytes being written and refuses a mismatch; derive
   * it with `contentAddressForJson` on the JSON lane, or from the bytes
   * themselves on the binary lane.
   */
  contentHash: string;
  kind: PayloadKind;
  contentType?: string;
  /** Skip TTL — content persists indefinitely. No-op for GCS. */
  persist?: boolean;
}

/**
 * What a signed URL is allowed to do, and — for a write — what the upload is
 * allowed to call the bytes it sends.
 *
 * A stored object keeps the Content-Type its upload declared, and a later
 * signed read serves it back with that type. An unpinned write URL therefore
 * hands the uploader the choice of how a browser will run the bytes, which is
 * the whole question the storable-type allowlist exists to answer — the
 * allowlist is checked at the mint and then discarded one hop later. Pinning
 * the type into the signature moves the constraint into the storage backend:
 * a PUT carrying any other Content-Type header fails to verify, so no caller
 * has to be trusted to send what it asked for.
 *
 * `contentType` is required on the write arm rather than optional so a call
 * site cannot omit it — the property this carries is only true if every write
 * URL has one.
 */
export type SignedUrlOptions =
  | { action: 'read'; expiresInSeconds?: number }
  | { action: 'write'; contentType: string; expiresInSeconds?: number };

export interface PayloadStore {
  /**
   * Store a payload and return its reference.
   */
  store(params: {
    tenantId: TenantId;
    runId: SessionId;
    stepExecutionId: StepExecutionId;
    attempt: number;
    kind: PayloadKind;
    data: unknown;
    contentType?: string;
    /** Skip TTL — content persists indefinitely. Used by memory docs whose
     *  Postgres row outlives the default Redis/run-scoped TTL. No-op for GCS. */
    persist?: boolean;
  }): Promise<PayloadRef>;

  /**
   * Build a payload reference without storing.
   * Used for idempotency checks.
   */
  buildRef(params: {
    tenantId: TenantId;
    runId: SessionId;
    stepExecutionId: StepExecutionId;
    attempt: number;
    kind: PayloadKind;
  }): PayloadRef;

  /**
   * Store a JSON payload at its content address. Read back with `retrieve`.
   */
  storeContentAddressed(params: ContentAddressedParams & { data: unknown }): Promise<PayloadRef>;

  /**
   * Store raw bytes at their content address. Read back with `retrieveBytes`.
   */
  storeBytesContentAddressed(
    params: ContentAddressedParams & { data: Buffer },
  ): Promise<PayloadRef>;

  /**
   * Retrieve a JSON payload by reference. The stored bytes are JSON-parsed;
   * do NOT use this for refs produced by `storeBytes` (use `retrieveBytes`).
   */
  retrieve(payloadRef: PayloadRef): Promise<unknown>;

  storeBytes(params: {
    tenantId: TenantId;
    runId: SessionId;
    stepExecutionId: StepExecutionId;
    attempt: number;
    kind: PayloadKind;
    data: Buffer;
    contentType?: string;
    /** Skip TTL — content persists indefinitely (e.g. memory docs). No-op for GCS. */
    persist?: boolean;
  }): Promise<PayloadRef>;

  /**
   * Retrieve raw bytes stored via `storeBytes`. Returns the exact Buffer —
   * never a JSON-parsed value. Throws if the ref does not resolve to bytes.
   */
  retrieveBytes(payloadRef: PayloadRef): Promise<Buffer>;

  /**
   * Stream bytes stored via `storeBytes`. When a range is given only those
   * bytes leave the backend, so seeking inside a large media object never
   * pulls the whole object through the process.
   */
  openByteStream(payloadRef: PayloadRef, range?: ByteRange): Promise<Readable>;

  /**
   * Check if a payload exists.
   */
  exists(payloadRef: PayloadRef): Promise<boolean>;

  /**
   * Delete a payload.
   */
  delete(payloadRef: PayloadRef): Promise<void>;

  /**
   * Get a signed URL for direct upload/download.
   */
  getSignedUrl(payloadRef: PayloadRef, options: SignedUrlOptions): Promise<string>;

  /**
   * Whether a URL from `getSignedUrl` is one a client can actually fetch.
   *
   * Only a backend with an object host in front of it can sign; the others
   * either reject or answer a placeholder that resolves nowhere. A caller that
   * cannot tell those apart hands the browser a dead URL, and the failure lands
   * far from the store that produced it — so the store says which it is, and
   * the caller serves the bytes itself when the answer is no.
   */
  readonly servesSignedUrls: boolean;

  /**
   * Determine if data should be stored (vs inline).
   */
  shouldStore(data: unknown): boolean;

  shouldStoreBytes(bytes: Buffer): boolean;
}

// ============================================================================
// GCS Payload Store Implementation
// ============================================================================

function buildPayloadPath(
  params: {
    tenantId: TenantId;
    runId: SessionId;
    stepExecutionId: StepExecutionId;
    attempt: number;
    kind: PayloadKind;
  },
  ext: 'json' | 'bin' = 'json',
): string {
  return `tenants/${params.tenantId}/runs/${params.runId}/steps/${params.stepExecutionId}/attempt/${String(params.attempt)}/${params.kind}.${ext}`;
}

/**
 * The bytes a JSON-lane content-addressed payload is addressed by. The store
 * owns this encoding rather than each backend, so one value has one address
 * wherever it is stored and the digest a caller claims is checkable.
 */
function contentAddressedJsonBytes(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data), 'utf-8');
}

/**
 * The address a JSON-lane payload must be stored at. Callers derive the claimed
 * address from this rather than hashing an encoding of their own.
 */
export function contentAddressForJson(data: unknown): string {
  return computeHash(contentAddressedJsonBytes(data));
}

/**
 * Encode a value as an inline ref, refusing to produce one no reader accepts.
 *
 * Hand-rolling `inline:${base64}` cannot express the cap, so a value over it
 * yields a ref that every reader rejects — and the rejection surfaces wherever
 * the ref is eventually read, carrying nothing about which writer produced it.
 * Failing at the writer is what makes the size the writer's problem, which is
 * the only place it can be solved: a caller whose value can be large asks
 * `shouldStore` first and stores it instead.
 */
export function encodeInlinePayloadRef(value: unknown): PayloadRef {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf-8');
  if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
    throw new Error(
      `Inline payload is ${String(bytes)} bytes, over the ${String(MAX_INLINE_PAYLOAD_BYTES)}-byte ` +
        'cap. Store it and pass the resulting ref.',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
  return `inline:${Buffer.from(json, 'utf-8').toString('base64')}` as PayloadRef;
}

/**
 * Resolve the object path a content-addressed write may use.
 *
 * Every content-addressed write goes through here with the exact bytes it is
 * about to store, because the claimed address is only an address if the content
 * hashes to it: an unverified claim writes content Y at content X's address and
 * overwrites what was there, which is the one thing this lane exists to make
 * impossible. A malformed hash is refused for a second reason — no reader can
 * parse the ref it would produce.
 */
function contentAddressedPath(
  params: ContentAddressedParams,
  bytes: Buffer,
  ext: 'json' | 'bin',
): string {
  if (!CONTENT_HASH_PATTERN.test(params.contentHash)) {
    throw new Error(`Content address must be lowercase SHA-256 hex: ${params.contentHash}`);
  }
  const actual = computeHash(bytes);
  if (actual !== params.contentHash) {
    throw new Error(
      `Content address ${params.contentHash} does not match the content it addresses ` +
        `(sha256 ${actual}) — a content address must be the digest of the content stored at it`,
    );
  }
  return `tenants/${params.tenantId}/${CONTENT_ADDRESSED_LABEL}/${params.contentHash}/${params.kind}.${ext}`;
}

/**
 * Check if a payload ref is an inline reference.
 */
function isInlineRef(payloadRef: PayloadRef): boolean {
  return payloadRef.startsWith('inline:');
}

/**
 * Guard the binary lane: `retrieveBytes` must only resolve refs produced by
 * `storeBytes` (which always address a `.bin` object). Rejecting inline and
 * JSON-lane (`.json`) refs keeps the contract honest across every backend — a
 * mistaken `.json` ref can never be returned as upload/download bytes.
 */
function assertBinaryRef(payloadRef: PayloadRef): void {
  if (isInlineRef(payloadRef)) {
    throw new Error(`Not a binary payload ref (inline): ${payloadRef}`);
  }
  if (!payloadRef.endsWith('.bin')) {
    throw new Error(`Not a binary payload ref (expected .bin): ${payloadRef}`);
  }
}

/**
 * A ref carrying its own bytes still has to be one this system recognises.
 *
 * The cap on an inline ref exists to keep an unbounded, caller-supplied string
 * away from a base64 decode and a JSON parse, and a ref arrives on operation
 * input the agent wrote. Every backend answers an inline ref from the ref
 * itself, so this is the only thing standing between that caller and the
 * decode — checking it in the parser alone leaves the protection to whoever
 * happens to call the parser first.
 *
 * The check is a length test and a regex, both of which run before anything is
 * decoded. The refused ref is not echoed: an oversized one is the size of the
 * payload it carries, and its content is the caller's.
 */
function assertCanonicalInlineRef(payloadRef: PayloadRef): void {
  if (parsePayloadRef(payloadRef)?.form !== 'inline') {
    throw new Error(`Invalid inline payload_ref (${String(payloadRef.length)} chars)`);
  }
}

/**
 * Parse an inline payload reference and return the decoded data.
 */
function parseInlineRef(payloadRef: PayloadRef): unknown {
  assertCanonicalInlineRef(payloadRef);
  const base64Data = payloadRef.slice('inline:'.length);
  const jsonStr = Buffer.from(base64Data, 'base64').toString('utf-8');
  return JSON.parse(jsonStr) as unknown;
}

/**
 * Resolve a ref to the object path this store may act on.
 *
 * The ref must parse as canonical and must name this store's own bucket:
 * every backend resolves the path against its configured bucket, so accepting
 * a ref that names a different one would silently redirect the operation onto
 * a same-named path in the store's own bucket.
 */
function objectPathForStore(payloadRef: PayloadRef, bucketName: string): string {
  const parsed = parsePayloadRef(payloadRef);
  if (parsed?.form !== 'object') {
    throw new Error(`Invalid GCS payload_ref format: ${payloadRef}`);
  }
  if (parsed.bucket !== bucketName) {
    throw new Error(`payload_ref names bucket "${parsed.bucket}", store serves "${bucketName}"`);
  }
  return parsed.objectPath;
}

/**
 * The query a backend with no signing key answers a signed-URL request with.
 *
 * Those backends cannot enforce the pin, but dropping it would make a dev URL
 * differ from a real one in exactly the property the upload is constrained by —
 * and a caller written against the silent version only discovers the header it
 * must send in production. Echoing the pin keeps the contract visible wherever
 * the store is swapped out.
 */
function unsignedUrlQuery(options: SignedUrlOptions): string {
  const params = new URLSearchParams({ mock: 'true', action: options.action });
  if (options.action === 'write') {
    params.set('contentType', options.contentType);
  }
  return params.toString();
}

/**
 * Compute SHA-256 hash of data.
 */
function computeHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Create a GCS-backed payload store.
 */
export function createPayloadStore(config: PayloadStoreConfig): PayloadStore {
  // Build storage options conditionally to satisfy exactOptionalPropertyTypes
  const storageOptions: ConstructorParameters<typeof Storage>[0] = {};
  if (config.projectId) {
    storageOptions.projectId = config.projectId;
  }
  if (config.keyFilename) {
    storageOptions.keyFilename = config.keyFilename;
  }

  const storage = new Storage(storageOptions);
  const bucket: Bucket = storage.bucket(config.bucketName);

  return {
    servesSignedUrls: true,
    buildRef(params) {
      const path = buildPayloadPath(params);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      return `gs://${config.bucketName}/${path}` as PayloadRef;
    },

    async store(params) {
      const path = buildPayloadPath(params);
      // Type assertion needed to add brand to template literal
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payloadRef = `gs://${config.bucketName}/${path}` as PayloadRef;

      const jsonData = JSON.stringify(params.data, null, 2);
      const buffer = Buffer.from(jsonData, 'utf-8');
      const hash = computeHash(buffer);

      const file = bucket.file(path);

      await file.save(buffer, {
        contentType: params.contentType ?? 'application/json',
        metadata: {
          sha256: hash,
          tenantId: params.tenantId,
          runId: params.runId,
          stepExecutionId: params.stepExecutionId,
          attempt: String(params.attempt),
          kind: params.kind,
        },
      });

      return payloadRef;
    },

    async storeContentAddressed(params) {
      const buffer = contentAddressedJsonBytes(params.data);
      const path = contentAddressedPath(params, buffer, 'json');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      const payloadRef = `gs://${config.bucketName}/${path}` as PayloadRef;

      await bucket.file(path).save(buffer, {
        contentType: params.contentType ?? 'application/json',
        metadata: {
          sha256: params.contentHash,
          tenantId: params.tenantId,
          kind: params.kind,
        },
      });

      return payloadRef;
    },

    async storeBytesContentAddressed(params) {
      const path = contentAddressedPath(params, params.data, 'bin');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      const payloadRef = `gs://${config.bucketName}/${path}` as PayloadRef;

      await bucket.file(path).save(params.data, {
        contentType: params.contentType ?? 'application/octet-stream',
        metadata: {
          sha256: params.contentHash,
          encoding: 'bytes',
          tenantId: params.tenantId,
          kind: params.kind,
        },
      });

      return payloadRef;
    },

    async retrieve(payloadRef) {
      // Handle inline refs
      if (isInlineRef(payloadRef)) {
        return parseInlineRef(payloadRef);
      }

      const path = objectPathForStore(payloadRef, config.bucketName);
      const file = bucket.file(path);

      const [contents] = await file.download();
      return JSON.parse(contents.toString('utf-8')) as unknown;
    },

    async storeBytes(params) {
      const path = buildPayloadPath(params, 'bin');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payloadRef = `gs://${config.bucketName}/${path}` as PayloadRef;
      const hash = computeHash(params.data);

      await bucket.file(path).save(params.data, {
        contentType: params.contentType ?? 'application/octet-stream',
        metadata: {
          sha256: hash,
          encoding: 'bytes',
          tenantId: params.tenantId,
          runId: params.runId,
          stepExecutionId: params.stepExecutionId,
          attempt: String(params.attempt),
          kind: params.kind,
        },
      });

      return payloadRef;
    },

    async retrieveBytes(payloadRef) {
      assertBinaryRef(payloadRef);
      const path = objectPathForStore(payloadRef, config.bucketName);
      const [contents] = await bucket.file(path).download();
      return contents;
    },

    openByteStream(payloadRef, range) {
      assertBinaryRef(payloadRef);
      const path = objectPathForStore(payloadRef, config.bucketName);
      // The stored checksum covers the whole object, so a ranged read can
      // never satisfy it.
      const options: CreateReadStreamOptions = range
        ? { start: range.start, end: range.end, validation: false }
        : {};
      return Promise.resolve(bucket.file(path).createReadStream(options));
    },

    async exists(payloadRef) {
      // An inline ref exists once it is one — it carries its own bytes. Which
      // makes "is it one" the whole question, and answering true without
      // asking reports that a ref no read can resolve is present.
      if (isInlineRef(payloadRef)) {
        assertCanonicalInlineRef(payloadRef);
        return true;
      }

      const path = objectPathForStore(payloadRef, config.bucketName);
      const file = bucket.file(path);

      const [exists] = await file.exists();
      return exists;
    },

    async delete(payloadRef) {
      // Cannot delete inline refs
      if (isInlineRef(payloadRef)) {
        return;
      }

      const path = objectPathForStore(payloadRef, config.bucketName);
      const file = bucket.file(path);

      await file.delete({ ignoreNotFound: true });
    },

    async getSignedUrl(payloadRef, options) {
      // Inline refs don't need signed URLs - they are self-contained
      if (isInlineRef(payloadRef)) {
        throw new Error('Inline refs do not support signed URLs');
      }

      const path = objectPathForStore(payloadRef, config.bucketName);
      const file = bucket.file(path);
      const expires = Date.now() + (options.expiresInSeconds ?? 3600) * 1000;

      // `contentType` becomes a signed header, so GCS itself rejects a PUT that
      // labels the object anything else.
      const [url] = await file.getSignedUrl(
        options.action === 'write'
          ? { action: 'write', expires, contentType: options.contentType }
          : { action: 'read', expires },
      );

      return url;
    },

    shouldStore(data) {
      const jsonData = JSON.stringify(data);
      return Buffer.byteLength(jsonData, 'utf-8') > MAX_INLINE_PAYLOAD_BYTES;
    },

    shouldStoreBytes() {
      return true;
    },
  };
}

// ============================================================================
// Local/Mock Payload Store (for development/testing)
// ============================================================================

/**
 * Create an in-memory payload store for testing.
 */
export function createMemoryPayloadStore(): PayloadStore {
  const store = new Map<string, unknown>();

  /**
   * Keyed by the PARSED object path, exactly as the GCS and Redis backends are.
   *
   * Using the ref string as the key made this the one backend that would read
   * whatever it was handed. It was saved only by every key having been written
   * through `buildPayloadPath`, which is a property of the current writers
   * rather than a rule — and callers are entitled to rely on "the store refuses
   * an unusable ref" being true of the store, not of two thirds of it.
   */
  const keyFor = (payloadRef: PayloadRef): string =>
    objectPathForStore(payloadRef, MEMORY_STORE_BUCKET);

  const readBinary = (payloadRef: PayloadRef): Buffer => {
    assertBinaryRef(payloadRef);
    const data = store.get(keyFor(payloadRef));
    if (data === undefined) {
      throw new Error(`Payload not found: ${payloadRef}`);
    }
    if (!Buffer.isBuffer(data)) {
      throw new Error(`Payload at ${payloadRef} is not binary bytes`);
    }
    return data;
  };

  return {
    // A process-local map, reachable by no URL at all.
    servesSignedUrls: false,
    buildRef(params) {
      const path = buildPayloadPath(params);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      return `gs://${MEMORY_STORE_BUCKET}/${path}` as PayloadRef;
    },

    async store(params) {
      const path = buildPayloadPath(params);
      // Type assertion needed to add brand to template literal
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payloadRef = `gs://${MEMORY_STORE_BUCKET}/${path}` as PayloadRef;

      store.set(keyFor(payloadRef), params.data);
      return payloadRef;
    },

    storeContentAddressed(params) {
      try {
        const path = contentAddressedPath(params, contentAddressedJsonBytes(params.data), 'json');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
        const payloadRef = `gs://${MEMORY_STORE_BUCKET}/${path}` as PayloadRef;
        store.set(keyFor(payloadRef), params.data);
        return Promise.resolve(payloadRef);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    storeBytesContentAddressed(params) {
      try {
        const path = contentAddressedPath(params, params.data, 'bin');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
        const payloadRef = `gs://${MEMORY_STORE_BUCKET}/${path}` as PayloadRef;
        store.set(keyFor(payloadRef), Buffer.from(params.data));
        return Promise.resolve(payloadRef);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    // Async so that a ref the parser rejects arrives as a rejection, the way it
    // does from the GCS and Redis backends. A synchronous throw from a method
    // typed as returning a promise escapes the caller's `.catch`.
    async retrieve(payloadRef) {
      // Handle inline refs
      if (isInlineRef(payloadRef)) {
        return parseInlineRef(payloadRef);
      }

      const data = store.get(keyFor(payloadRef));
      if (data === undefined) {
        throw new Error(`Payload not found: ${payloadRef}`);
      }
      return data;
    },

    async storeBytes(params) {
      const path = buildPayloadPath(params, 'bin');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payloadRef = `gs://${MEMORY_STORE_BUCKET}/${path}` as PayloadRef;
      // Clone so later mutation of the caller's buffer can't corrupt the store.
      store.set(keyFor(payloadRef), Buffer.from(params.data));
      return payloadRef;
    },

    retrieveBytes(payloadRef) {
      try {
        return Promise.resolve(Buffer.from(readBinary(payloadRef)));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    openByteStream(payloadRef, range) {
      try {
        const data = readBinary(payloadRef);
        const bytes = range ? data.subarray(range.start, range.end + 1) : data;
        return Promise.resolve(Readable.from([Buffer.from(bytes)], { objectMode: false }));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    async exists(payloadRef) {
      // An inline ref exists once it is one — it carries its own bytes. Which
      // makes "is it one" the whole question, and answering true without
      // asking reports that a ref no read can resolve is present.
      if (isInlineRef(payloadRef)) {
        assertCanonicalInlineRef(payloadRef);
        return true;
      }
      return store.has(keyFor(payloadRef));
    },

    async delete(payloadRef) {
      // Cannot delete inline refs
      if (isInlineRef(payloadRef)) {
        return;
      }
      store.delete(keyFor(payloadRef));
    },

    getSignedUrl(payloadRef, options) {
      // Inline refs don't need signed URLs
      if (isInlineRef(payloadRef)) {
        return Promise.reject(new Error('Inline refs do not support signed URLs'));
      }
      // Return a mock URL for testing
      return Promise.resolve(
        `https://storage.googleapis.com/${payloadRef.replace('gs://', '')}?${unsignedUrlQuery(options)}`,
      );
    },

    shouldStore(data) {
      const jsonData = JSON.stringify(data);
      return Buffer.byteLength(jsonData, 'utf-8') > MAX_INLINE_PAYLOAD_BYTES;
    },

    shouldStoreBytes() {
      return true;
    },
  };
}

// ============================================================================
// Redis Payload Store (for local development with shared state)
// ============================================================================

// ============================================================================
// Filesystem Payload Store Implementation
// ============================================================================

export interface FilePayloadStoreConfig {
  /** Directory every object is written beneath. */
  rootDir: string;
}

/** Synthetic bucket name in refs this backend owns — it has no real bucket. */
const FILE_STORE_BUCKET = 'file-store';

/**
 * Resolve a ref to the file it names, and refuse one that names a file
 * elsewhere.
 *
 * `parsePayloadRef` already validates every path segment, so a traversal
 * segment does not survive it. This checks the property that actually matters
 * here and that the parser does not promise: whatever the ref parsed to, the
 * path it resolves to is under this store's root.
 */
function fileStorePath(rootDir: string, payloadRef: PayloadRef): string {
  const objectPath = objectPathForStore(payloadRef, FILE_STORE_BUCKET);
  const root = resolvePath(rootDir);
  const target = resolvePath(root, objectPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`payload_ref resolves outside the payload directory: ${payloadRef}`);
  }
  return target;
}

/**
 * Write through a temporary name, then rename.
 *
 * A rename within one filesystem is atomic, so a process killed mid-write
 * leaves no half-written object — which would otherwise be indistinguishable
 * from a complete one to `exists`, and would fail a JSON parse on read long
 * after the crash that caused it.
 */
async function writeObjectAtomically(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(staging, data);
    await rename(staging, path);
  } catch (err) {
    await rm(staging, { force: true });
    throw err;
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Create a filesystem-backed payload store.
 *
 * This is the durable local backend. The Redis store expires a non-persistent
 * payload after 24 hours, which is correct for a development cache and is data
 * loss for an appliance whose Postgres rows reference those payloads
 * indefinitely — so `persist` is not a distinction here: a file that was
 * written stays written.
 *
 * Nothing reclaims space. Retention over run payloads is a policy this store
 * does not have and should not invent; an operator prunes the directory or a
 * registered background task does it later.
 */
export function createFilePayloadStore(config: FilePayloadStoreConfig): PayloadStore {
  const rootDir = resolvePath(config.rootDir);

  const refFor = (path: string): PayloadRef =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
    `gs://${FILE_STORE_BUCKET}/${path}` as PayloadRef;

  return {
    // A directory on the appliance's disk has no object host to sign against.
    servesSignedUrls: false,
    buildRef(params) {
      return refFor(buildPayloadPath(params));
    },

    async store(params) {
      const payloadRef = refFor(buildPayloadPath(params));
      await writeObjectAtomically(fileStorePath(rootDir, payloadRef), JSON.stringify(params.data));
      return payloadRef;
    },

    async storeContentAddressed(params) {
      const bytes = contentAddressedJsonBytes(params.data);
      const payloadRef = refFor(contentAddressedPath(params, bytes, 'json'));
      await writeObjectAtomically(fileStorePath(rootDir, payloadRef), bytes);
      return payloadRef;
    },

    async storeBytesContentAddressed(params) {
      const payloadRef = refFor(contentAddressedPath(params, params.data, 'bin'));
      await writeObjectAtomically(fileStorePath(rootDir, payloadRef), params.data);
      return payloadRef;
    },

    async retrieve(payloadRef) {
      if (isInlineRef(payloadRef)) {
        return parseInlineRef(payloadRef);
      }
      try {
        const raw = await readFile(fileStorePath(rootDir, payloadRef), 'utf-8');
        return JSON.parse(raw) as unknown;
      } catch (err) {
        if (isMissing(err)) throw new Error(`Payload not found: ${payloadRef}`);
        throw err;
      }
    },

    async storeBytes(params) {
      const payloadRef = refFor(buildPayloadPath(params, 'bin'));
      await writeObjectAtomically(fileStorePath(rootDir, payloadRef), params.data);
      return payloadRef;
    },

    async retrieveBytes(payloadRef) {
      assertBinaryRef(payloadRef);
      try {
        return await readFile(fileStorePath(rootDir, payloadRef));
      } catch (err) {
        if (isMissing(err)) throw new Error(`Payload not found: ${payloadRef}`);
        throw err;
      }
    },

    async openByteStream(payloadRef, range) {
      assertBinaryRef(payloadRef);
      const path = fileStorePath(rootDir, payloadRef);
      // Asked before the stream opens: `createReadStream` reports a missing
      // file as an asynchronous 'error' on a stream the caller already holds,
      // which reaches a response that has begun rather than the caller's
      // catch.
      try {
        await stat(path);
      } catch (err) {
        if (isMissing(err)) throw new Error(`Payload not found: ${payloadRef}`);
        throw err;
      }
      return range
        ? createReadStream(path, { start: range.start, end: range.end })
        : createReadStream(path);
    },

    async exists(payloadRef) {
      if (isInlineRef(payloadRef)) {
        assertCanonicalInlineRef(payloadRef);
        return true;
      }
      try {
        await stat(fileStorePath(rootDir, payloadRef));
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },

    async delete(payloadRef) {
      if (isInlineRef(payloadRef)) return;
      await rm(fileStorePath(rootDir, payloadRef), { force: true });
    },

    getSignedUrl(payloadRef, _options) {
      if (isInlineRef(payloadRef)) {
        return Promise.reject(new Error('Inline refs do not support signed URLs'));
      }
      // There is no object host to sign against. The Redis backend answers a
      // mock URL because it is a development fallback and nothing shipped
      // depends on it resolving; this one is a production backend, and a URL
      // that does not resolve fails in the browser, far from the cause.
      return Promise.reject(
        new Error(
          'The filesystem payload store cannot mint signed URLs — ' +
            `read ${objectPathForStore(payloadRef, FILE_STORE_BUCKET)} through the API instead.`,
        ),
      );
    },

    shouldStore(data) {
      return Buffer.byteLength(JSON.stringify(data), 'utf-8') > MAX_INLINE_PAYLOAD_BYTES;
    },

    shouldStoreBytes() {
      return true;
    },
  };
}

/**
 * Redis payload store configuration.
 */
export interface RedisPayloadStoreConfig {
  /** TTL in seconds for stored payloads (default: 24 hours) */
  ttlSeconds?: number;
  /** Key prefix (default: "aflow:payload") */
  keyPrefix?: string;
}

/** Synthetic bucket name in refs this backend owns — it has no real bucket. */
/** Exported so a reader can recognise a ref this backend wrote. */
export const REDIS_STORE_BUCKET = 'redis-store';

/** The in-memory backend's bucket, named so its refs parse like any other. */
const MEMORY_STORE_BUCKET = 'test-bucket';

/**
 * Build a Redis key for a payload.
 */
function buildRedisKey(prefix: string, payloadRef: PayloadRef): string {
  return `${prefix}:${objectPathForStore(payloadRef, REDIS_STORE_BUCKET)}`;
}

/**
 * Create a Redis-backed payload store for local development.
 * This enables shared state between orchestrator and executors.
 *
 * Requires: ioredis Redis instance
 *
 * @example
 * ```ts
 * import { getRedisConnection } from "@aflow/redis";
 * import { createRedisPayloadStore } from "@aflow/payload-store";
 *
 * const redis = getRedisConnection();
 * const payloadStore = createRedisPayloadStore(redis);
 * ```
 */
export function createRedisPayloadStore(
  redis: Redis,
  config: RedisPayloadStoreConfig = {},
): PayloadStore {
  const ttlSeconds = config.ttlSeconds ?? 24 * 60 * 60; // 24 hours default
  const keyPrefix = config.keyPrefix ?? 'aflow:payload';

  return {
    // Redis holds the bytes; nothing fronts it that could sign for them.
    servesSignedUrls: false,
    buildRef(params) {
      const path = buildPayloadPath(params);
      // Use gs:// format for compatibility with existing code
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      return `gs://${REDIS_STORE_BUCKET}/${path}` as PayloadRef;
    },

    async store(params) {
      const path = buildPayloadPath(params);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payloadRef = `gs://${REDIS_STORE_BUCKET}/${path}` as PayloadRef;
      const key = buildRedisKey(keyPrefix, payloadRef);

      const jsonData = JSON.stringify(params.data);
      if (params.persist) {
        // No TTL — content must survive indefinitely (e.g., memory docs)
        await redis.set(key, jsonData);
      } else {
        await redis.set(key, jsonData, 'EX', ttlSeconds);
      }

      return payloadRef;
    },

    async storeContentAddressed(params) {
      const bytes = contentAddressedJsonBytes(params.data);
      const path = contentAddressedPath(params, bytes, 'json');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      const payloadRef = `gs://${REDIS_STORE_BUCKET}/${path}` as PayloadRef;
      const key = buildRedisKey(keyPrefix, payloadRef);
      if (params.persist) {
        await redis.set(key, bytes);
      } else {
        await redis.set(key, bytes, 'EX', ttlSeconds);
      }
      return payloadRef;
    },

    async storeBytesContentAddressed(params) {
      const path = contentAddressedPath(params, params.data, 'bin');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- branded type
      const payloadRef = `gs://${REDIS_STORE_BUCKET}/${path}` as PayloadRef;
      const key = buildRedisKey(keyPrefix, payloadRef);
      if (params.persist) {
        await redis.set(key, params.data);
      } else {
        await redis.set(key, params.data, 'EX', ttlSeconds);
      }
      return payloadRef;
    },

    async retrieve(payloadRef) {
      // Handle inline refs
      if (isInlineRef(payloadRef)) {
        return parseInlineRef(payloadRef);
      }

      const key = buildRedisKey(keyPrefix, payloadRef);
      const data = await redis.get(key);

      if (data === null) {
        throw new Error(`Payload not found: ${payloadRef}`);
      }

      return JSON.parse(data) as unknown;
    },

    async storeBytes(params) {
      const path = buildPayloadPath(params, 'bin');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payloadRef = `gs://${REDIS_STORE_BUCKET}/${path}` as PayloadRef;
      const key = buildRedisKey(keyPrefix, payloadRef);
      // Store the raw Buffer verbatim (ioredis writes bytes for Buffer values).
      if (params.persist) {
        await redis.set(key, params.data);
      } else {
        await redis.set(key, params.data, 'EX', ttlSeconds);
      }
      return payloadRef;
    },

    async retrieveBytes(payloadRef) {
      assertBinaryRef(payloadRef);
      const key = buildRedisKey(keyPrefix, payloadRef);
      const data = await redis.getBuffer(key);
      if (data === null) {
        throw new Error(`Payload not found: ${payloadRef}`);
      }
      return data;
    },

    async openByteStream(payloadRef, range) {
      assertBinaryRef(payloadRef);
      const key = buildRedisKey(keyPrefix, payloadRef);
      const data = range
        ? await redis.getrangeBuffer(key, range.start, range.end)
        : await redis.getBuffer(key);
      // GETRANGE answers a missing key with empty bytes, so absence and an
      // empty slice are only distinguishable by asking.
      if (data === null || (data.length === 0 && (await redis.exists(key)) !== 1)) {
        throw new Error(`Payload not found: ${payloadRef}`);
      }
      return Readable.from([data], { objectMode: false });
    },

    async exists(payloadRef) {
      // An inline ref exists once it is one — it carries its own bytes. Which
      // makes "is it one" the whole question, and answering true without
      // asking reports that a ref no read can resolve is present.
      if (isInlineRef(payloadRef)) {
        assertCanonicalInlineRef(payloadRef);
        return true;
      }

      const key = buildRedisKey(keyPrefix, payloadRef);
      const result = await redis.exists(key);
      return result === 1;
    },

    async delete(payloadRef) {
      // Cannot delete inline refs
      if (isInlineRef(payloadRef)) {
        return;
      }

      const key = buildRedisKey(keyPrefix, payloadRef);
      await redis.del(key);
    },

    getSignedUrl(payloadRef, options) {
      // Inline refs don't need signed URLs
      if (isInlineRef(payloadRef)) {
        return Promise.reject(new Error('Inline refs do not support signed URLs'));
      }
      // Redis store doesn't support signed URLs - return a mock URL for testing
      return Promise.resolve(
        `https://redis-store.local/${objectPathForStore(payloadRef, REDIS_STORE_BUCKET)}?${unsignedUrlQuery(options)}`,
      );
    },

    shouldStore(data) {
      const jsonData = JSON.stringify(data);
      return Buffer.byteLength(jsonData, 'utf-8') > MAX_INLINE_PAYLOAD_BYTES;
    },

    shouldStoreBytes() {
      return true;
    },
  };
}
