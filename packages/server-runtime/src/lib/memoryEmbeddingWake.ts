import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createDefaultModelCatalog, type AIProvider } from '@aflow/ai-client';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';

type TenantId = Parameters<typeof createTenantContext>[0];

/**
 * After a provider key is saved, mark the documents that were waiting for one,
 * or that failed — a replaced key is the usual repair for a refused one — as
 * pending, so the embedder tries them on its next cycle. A personal key
 * embeds only in the spaces its holder owns, so it wakes only those.
 */
export async function wakeDocsWaitingForEmbedding(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  credential: { providerId: string; scope: 'user' | 'space' | 'tenant'; scopeId: string },
): Promise<number> {
  const embeds = createDefaultModelCatalog()
    .listModels(credential.providerId as AIProvider)
    .some((m) => m.capabilities.embedding && !m.deprecated);
  if (!embeds) return 0;
  return createMemoryDocRepository(db, createTenantContext(tenantId)).markDocsPendingForEmbedding(
    credential.scope === 'space'
      ? { spaceId: credential.scopeId }
      : credential.scope === 'user'
        ? { ownedBy: credential.scopeId }
        : 'tenant',
    ['unconfigured', 'failed'],
  );
}
