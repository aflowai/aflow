import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import { saveBytesToMemoryDoc, runOrigin, MemoryWriteDeniedError } from '@aflow/memory-store';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { validationError } from '@aflow/executor-runtime';
import { ApiExecutionError } from './types.js';

export interface SaveResponseTarget {
  path: string;
  docType?: string | undefined;
  mimeType?: string | undefined;
  indexing?: 'auto' | 'disabled' | 'force' | undefined;
}

export interface SaveResponseParams {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  redis?: Redis;
  spaceId: string;
  saveTo: SaveResponseTarget;
  /** The full (budget-checked, decompressed) response body. */
  bytes: Buffer;
  /** Raw response Content-Type header (may carry parameters). */
  contentType: string | null;
}

export interface SaveResponseResult {
  /** Canonical Memory path the body was written to. */
  savedTo: string;
  sizeBytes: number;
}

export async function saveResponseBodyToMemory(
  ctx: ExecutorContext,
  params: SaveResponseParams,
): Promise<SaveResponseResult> {
  const { db, payloadStore, redis, spaceId, saveTo, bytes, contentType } = params;

  try {
    return await saveBytesToMemoryDoc({
      db,
      payloadStore,
      ...(redis ? { redis } : {}),
      log: ctx.log,
      tenantId: ctx.tenantId,
      origin: runOrigin(ctx),
      spaceId,
      path: saveTo.path,
      docType: saveTo.docType,
      mimeType: saveTo.mimeType,
      indexing: saveTo.indexing,
      tags: ['api_response'],
      content: { kind: 'bytes', bytes },
      contentType,
    });
  } catch (err) {
    if (err instanceof MemoryWriteDeniedError) {
      throw new ApiExecutionError(validationError(err.message));
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('MEMORY_')) {
      throw new ApiExecutionError(validationError(message));
    }
    throw err;
  }
}
