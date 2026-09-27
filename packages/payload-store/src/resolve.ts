/**
 * One place that decides which payload backend a process runs on.
 *
 * Every service used to carry its own copy of this chain, and the copies had
 * already drifted — some fell back to the in-memory store when Redis was
 * refused, others left the store null. A backend that differs between the
 * writer and the reader of the same `PayloadRef` is not a configuration
 * difference; it is a payload that cannot be read back.
 */
import type { Redis } from 'ioredis';
import type { PayloadRef } from '@aflow/schemas';
import type { PayloadStore } from './store.js';
import {
  REDIS_STORE_BUCKET,
  createFilePayloadStore,
  createMemoryPayloadStore,
  createPayloadStore,
  createRedisPayloadStore,
  getPayloadStoreConfig,
} from './store.js';

export type PayloadStoreBackend = 'file' | 'gcs' | 'redis' | 'memory';

export interface ResolvedPayloadStore {
  store: PayloadStore;
  backend: PayloadStoreBackend;
  /** One line, ready to log, saying what was chosen and why. */
  reason: string;
}

export interface ResolvePayloadStoreOptions {
  /** Present only where the process has a Redis connection to share. */
  redis?: Redis | null | undefined;
  /**
   * Whether the in-memory store is an acceptable last resort.
   *
   * It is process-local, so every process that took one would hold a different
   * store and a ref written by an executor would not resolve in the
   * orchestrator or the API. Only a process whose payloads nothing else reads
   * — the dev-only mock, an isolated test — may accept it.
   */
  allowMemory?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Read a ref the way it was written, even when this process writes elsewhere.
 *
 * Every backend stamps its own bucket into the refs it produces, so a ref says
 * where its bytes are. A store handed a foreign one strips the wrong prefix and
 * reports nothing found — which reads downstream as "the payload expired".
 *
 * That used to be unreachable: one appliance, one directory, every executor
 * sharing it. The host lane broke the assumption by design. Its executor runs on
 * the operator's own machine and cannot mount the appliance's payload volume, so
 * it falls through to Redis — while every reader inside the appliance looks on
 * disk. The step succeeds, the bytes are written, and the agent that asks for the
 * output is told it has expired. A `host.file.get` carries the revision a
 * conditional write needs, so losing it does not merely hide a result: it makes
 * read-then-write impossible.
 *
 * Reads dispatch on the ref. Writes never do — they belong to the backend this
 * process chose, whose durability the operator configured.
 */
function readingForeignRefsThroughRedis(primary: PayloadStore, redis: Redis): PayloadStore {
  const viaRedis = createRedisPayloadStore(redis);
  const wroteByRedis = (ref: PayloadRef): boolean =>
    typeof ref === 'string' && ref.startsWith(`gs://${REDIS_STORE_BUCKET}/`);
  const pick = (ref: PayloadRef): PayloadStore => (wroteByRedis(ref) ? viaRedis : primary);

  return {
    ...primary,
    retrieve: (ref) => pick(ref).retrieve(ref),
    retrieveBytes: (ref) => pick(ref).retrieveBytes(ref),
    exists: (ref) => pick(ref).exists(ref),
    openByteStream: (ref, range) => pick(ref).openByteStream(ref, range),
    delete: (ref) => pick(ref).delete(ref),
    getSignedUrl: (ref, options) => pick(ref).getSignedUrl(ref, options),
  };
}

/**
 * Resolve the backend, most durable first.
 *
 * `PHOENIX_PAYLOAD_DIR` wins outright: naming a directory is an operator
 * saying where payloads live, and silently preferring a bucket or a 24-hour
 * Redis key over it would be the one answer that loses data.
 */
export function resolvePayloadStore(
  options: ResolvePayloadStoreOptions & { allowMemory: true },
): ResolvedPayloadStore;
export function resolvePayloadStore(
  options?: ResolvePayloadStoreOptions,
): ResolvedPayloadStore | null;
export function resolvePayloadStore({
  redis,
  allowMemory = false,
  env = process.env,
}: ResolvePayloadStoreOptions = {}): ResolvedPayloadStore | null {
  const rootDir = env['PHOENIX_PAYLOAD_DIR']?.trim();
  if (rootDir !== undefined && rootDir !== '') {
    const store = createFilePayloadStore({ rootDir });
    return {
      store: redis ? readingForeignRefsThroughRedis(store, redis) : store,
      backend: 'file',
      reason: `filesystem payload store at ${rootDir}`,
    };
  }

  try {
    const store = createPayloadStore(getPayloadStoreConfig(env));
    return {
      store: redis ? readingForeignRefsThroughRedis(store, redis) : store,
      backend: 'gcs',
      reason: 'GCS payload store',
    };
  } catch {
    // No bucket configured — fall through.
  }

  if (redis && env['USE_REDIS_PAYLOAD_STORE'] !== 'false') {
    return {
      store: createRedisPayloadStore(redis),
      backend: 'redis',
      reason: 'GCS not configured, using Redis payload store',
    };
  }

  if (allowMemory) {
    return {
      store: createMemoryPayloadStore(),
      backend: 'memory',
      reason: 'in-memory payload store — not shared between services',
    };
  }

  return null;
}
