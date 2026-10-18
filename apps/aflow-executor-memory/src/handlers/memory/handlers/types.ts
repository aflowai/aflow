/**
 * Shared types for memory handlers.
 */
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { EmbeddingBudgetLimitsView, MemoryLinkRepository } from '@aflow/database';
import type { MemoryEmbeddingResolver } from '@aflow/credential-resolver';

export interface MemoryHandlerDeps {
  payloadStore: PayloadStore;
  redis: Redis;
  /** Space ID from the flow run context — enforced by the platform. */
  spaceId: string | undefined;
  /** Cached embedding budget knobs — vector search degrades to FTS when exhausted. */
  loadEmbeddingBudgetLimits?: (tenantId: string) => Promise<EmbeddingBudgetLimitsView>;
  /** Link graph reads (backlinks, outgoing counts, hub/edge listings). */
  linkRepo: MemoryLinkRepository;
  /** The space's embedding model and client; absent, search is lexical only. */
  embedding?: MemoryEmbeddingResolver;
}
