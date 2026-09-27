/**
 * @aflow/payload-store - Payload storage for Aflow
 *
 * This package provides:
 * - Payload storage to GCS with structured paths
 * - Payload retrieval by reference
 * - Signed URL generation for direct access
 * - In-memory store for testing
 * - Redis-backed store for local development (shared between services)
 * - Filesystem store for the durable local appliance
 *
 * @packageDocumentation
 */

export {
  type PayloadStoreConfig,
  type PayloadStore,
  type ContentAddressedParams,
  type ByteRange,
  type SignedUrlOptions,
  type RedisPayloadStoreConfig,
  type FilePayloadStoreConfig,
  getPayloadStoreConfig,
  contentAddressForJson,
  encodeInlinePayloadRef,
  createPayloadStore,
  createMemoryPayloadStore,
  createRedisPayloadStore,
  createFilePayloadStore,
} from './store.js';

export {
  type PayloadStoreBackend,
  type ResolvedPayloadStore,
  type ResolvePayloadStoreOptions,
  resolvePayloadStore,
} from './resolve.js';

export { storeArtifactViewHtml, storeArtifactSource } from './artifactView.js';
