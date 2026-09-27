import {
  getDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';

export function getCoachCrudRepos(tenantId: TenantId) {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);
  return { db, tenantCtx, docRepo, dirRepo };
}

export async function writeCoachJsonDoc(
  docRepo: ReturnType<typeof createMemoryDocRepository>,
  dirRepo: ReturnType<typeof createMemoryDirRepository>,
  path: string,
  data: Record<string, unknown>,
  docType: string,
  spaceId: string,
  writeMode: 'upsert' | 'create' | 'overwrite' = 'upsert',
  semanticType: string | null = null,
): Promise<{ id: string; path: string; version: number }> {
  const content = JSON.stringify(data, null, 2);

  await dirRepo.ensureParentDirs(path, { spaceId });

  const result = await docRepo.put({
    path,
    writeMode,
    docType,
    mimeType: 'application/json',
    inlineContent: content,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    contentHash: '',
    preview: content.substring(0, 200),
    tags: ['coach'],
    summary: null,
    semanticType,
    indexing: 'disabled',
    scope: { spaceId },
  });

  return { id: result.id, path: result.path, version: result.currentVersion };
}
