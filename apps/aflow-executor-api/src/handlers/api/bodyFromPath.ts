import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { TenantId } from '@aflow/schemas';
import {
  readMemoryBodyBytes,
  workspacePathToMemoryPath as bodyPathToMemoryPath,
} from '@aflow/memory-store';

import { apiError } from '../../lib/api-errors.js';
import { ApiExecutionError } from './types.js';

export { bodyPathToMemoryPath };

export function buildContentRangeHeader(sizeBytes: number): string {
  if (sizeBytes <= 0) return 'bytes */0';
  return `bytes 0-${String(sizeBytes - 1)}/${String(sizeBytes)}`;
}

export interface ResolveBodyFromMemoryParams {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  tenantId: TenantId;
  spaceId: string;
  fromPath: string;
  /** Egress-policy request-body cap; checked against the doc size BEFORE reading bytes. */
  maxBytes: number;
}

export interface ResolvedBody {
  bytes: Buffer;
  /** The Memory doc's mimeType — used as Content-Type unless the caller set one. */
  mimeType: string | undefined;
}

export async function resolveBodyFromMemory(
  params: ResolveBodyFromMemoryParams,
): Promise<ResolvedBody> {
  const { db, payloadStore, tenantId, spaceId, fromPath, maxBytes } = params;
  const memoryPath = bodyPathToMemoryPath(fromPath);

  const repo = createMemoryDocRepository(db, createTenantContext(tenantId));
  const doc = await repo.getByPath(memoryPath, spaceId);
  if (!doc) {
    throw new ApiExecutionError(
      apiError(
        'API_BODY_SOURCE_NOT_FOUND',
        `bodySource.fromPath not found in Memory: "${fromPath}" (resolved to "${memoryPath}"). ` +
          'Write the file to /workspace/<path> first, or check the path.',
        { details: { fromPath, memoryPath } },
      ),
    );
  }

  // Size cap BEFORE reading — never pull a multi-GB doc into memory just to
  // reject it. The doc's recorded sizeBytes is authoritative.
  if (doc.sizeBytes > maxBytes) {
    throw new ApiExecutionError(
      apiError(
        'API_REQUEST_TOO_LARGE',
        `bodySource "${memoryPath}" is ${String(doc.sizeBytes)} bytes; exceeds the request body cap of ${String(maxBytes)} bytes.`,
        { details: { memoryPath, sizeBytes: doc.sizeBytes, maxBytes } },
      ),
    );
  }

  const bytes = await readMemoryBodyBytes(doc, payloadStore);
  if (bytes === null) {
    throw new ApiExecutionError(
      apiError('API_BODY_SOURCE_NOT_FOUND', `bodySource "${memoryPath}" has no content.`, {
        details: { memoryPath },
      }),
    );
  }

  return { bytes, mimeType: doc.mimeType };
}
