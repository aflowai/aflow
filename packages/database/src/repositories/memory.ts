/**
 * Memory Repository - Data access for memory entries.
 *
 * Provides CRUD operations for key-value storage with:
 * - Namespace-scoped keys
 * - Optional TTL expiration
 * - Metadata filtering
 * - Simple vector search support
 */
import { eq, and, or, lt, isNull, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { memoryEntries, type MemoryEntryRow, type NewMemoryEntryRow } from '../schema/tenant.js';

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  metadata?: Record<string, unknown> | undefined;
  sessionId?: string | undefined;
  userId?: string | undefined;
  spaceId?: string | undefined;
  agentId?: string | undefined;
  contentRef?: string | undefined;
  contentType?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date | undefined;
  embedding?: number[] | undefined;
  embeddingModel?: string | undefined;
  embeddingStatus?: 'pending' | 'ready' | 'failed' | 'disabled' | undefined;
  embeddedAt?: Date | undefined;
  embedError?: Record<string, unknown> | undefined;
  contentHash?: string | undefined;
}

export interface MemoryFilter {
  namespace?: string;
  keyPrefix?: string;
  sessionId?: string;
  userId?: string;
  spaceId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRepository {
  /**
   * Read a single entry by ID.
   */
  readById(entryId: string): Promise<MemoryEntry | null>;

  /**
   * Read a single entry by namespace and key.
   * @deprecated Use query() with scope filter instead for scope-aware reads
   */
  read(namespace: string, key: string): Promise<MemoryEntry | null>;

  /**
   * Read multiple entries by namespace and keys.
   */
  readMany(namespace: string, keys: string[]): Promise<MemoryEntry[]>;

  /**
   * Upsert an entry (insert or update).
   */
  upsert(entry: {
    namespace: string;
    key: string;
    value: unknown;
    metadata?: Record<string, unknown>;
    sessionId?: string;
    userId?: string;
    spaceId?: string;
    agentId?: string;
    contentRef?: string;
    contentType?: string;
    ttlSeconds?: number;
    embedding?: number[];
    embeddingModel?: string;
  }): Promise<MemoryEntry>;

  /**
   * Delete an entry by namespace and key.
   */
  delete(namespace: string, key: string): Promise<boolean>;

  /**
   * Delete multiple entries by filter.
   */
  deleteMany(filter: MemoryFilter): Promise<number>;

  /**
   * Query entries with filters.
   */
  query(
    filter: MemoryFilter,
    options?: { limit?: number; offset?: number },
  ): Promise<MemoryEntry[]>;

  /**
   * Simple vector search (cosine similarity).
   * Note: For production, consider using pgvector extension.
   */
  vectorSearch(
    namespace: string,
    embedding: number[],
    options?: { limit?: number; threshold?: number },
  ): Promise<Array<MemoryEntry & { similarity: number }>>;

  /**
   * Clean up expired entries.
   */
  cleanupExpired(): Promise<number>;

  /**
   * List entries with directory-like prefix matching (for progressive disclosure).
   */
  list(options: {
    namespace?: string;
    prefix?: string;
    depth?: number;
    limit?: number;
    offset?: number;
    spaceId?: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<
    Array<{
      key: string;
      kind?: string;
      updatedAt: Date;
      sizeBytes?: number;
      contentType?: string;
    }>
  >;

  /**
   * Keyword search (grep-like) over text content and metadata.
   */
  grep(options: {
    namespace?: string;
    query: string;
    prefix?: string;
    limit?: number;
    spaceId?: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<
    Array<{
      key: string;
      snippet: string;
      score?: number;
      updatedAt: Date;
    }>
  >;

  /**
   * Update embedding status and metadata for a memory entry.
   */
  updateEmbeddingStatus(params: {
    entryId: string;
    status: 'pending' | 'ready' | 'failed' | 'disabled';
    contentHash?: string;
    embedError?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Upsert an embedding for a memory entry.
   */
  upsertEmbedding(params: {
    entryId: string;
    embeddingModel: string;
    dims: number;
    embedding: number[];
    contentHash: string;
  }): Promise<void>;

  /**
   * Semantic search using vector similarity.
   * Returns entries ordered by similarity score.
   */
  semanticSearch(params: {
    namespace: string;
    queryEmbedding: number[];
    embeddingModel: string;
    spaceId?: string;
    agentId?: string;
    sessionId?: string;
    topK?: number;
    threshold?: number;
  }): Promise<
    Array<{
      entryId: string;
      key: string;
      namespace: string;
      kind?: string;
      updatedAt: Date;
      score: number;
      snippet?: string;
      contentRef?: string;
    }>
  >;
}

// ============================================================================
// Row to Entity Mapper
// ============================================================================

function toEntity(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    metadata: row.metadata as Record<string, unknown> | undefined,
    sessionId: row.sessionId ?? undefined,
    userId: row.userId ?? undefined,
    spaceId: row.spaceId ?? undefined,
    agentId: row.agentId ?? undefined,
    contentRef: row.contentRef ?? undefined,
    contentType: row.contentType ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt ?? undefined,
    embedding: row.embedding as number[] | undefined,
    embeddingModel: row.embeddingModel ?? undefined,
    embeddingStatus:
      (row.embeddingStatus as 'pending' | 'ready' | 'failed' | 'disabled' | null) ?? undefined,
    embeddedAt: row.embeddedAt ?? undefined,
    embedError: row.embedError as Record<string, unknown> | undefined,
    contentHash: row.contentHash ?? undefined,
  };
}

// ============================================================================
// Repository Implementation
// ============================================================================

export function createMemoryRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
): MemoryRepository {
  return {
    async readById(entryId) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx
          .select()
          .from(memoryEntries)
          .where(eq(memoryEntries.id, entryId))
          .limit(1);

        return row ? toEntity(row) : null;
      });
    },

    async read(namespace, key) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const [row] = await tx
          .select()
          .from(memoryEntries)
          .where(
            and(
              eq(memoryEntries.namespace, namespace),
              eq(memoryEntries.key, key),
              or(isNull(memoryEntries.expiresAt), lt(sql`now()`, memoryEntries.expiresAt)),
            ),
          )
          .limit(1);

        return row ? toEntity(row) : null;
      });
    },

    async readMany(namespace, keys) {
      if (keys.length === 0) return [];

      return withTenantSchema(db, tenantContext, async (tx) => {
        const rows = await tx
          .select()
          .from(memoryEntries)
          .where(
            and(
              eq(memoryEntries.namespace, namespace),
              sql`${memoryEntries.key} = ANY(${keys})`,
              or(isNull(memoryEntries.expiresAt), lt(sql`now()`, memoryEntries.expiresAt)),
            ),
          );

        return rows.map(toEntity);
      });
    },

    async upsert(entry) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const now = new Date();
        const expiresAt = entry.ttlSeconds
          ? new Date(now.getTime() + entry.ttlSeconds * 1000)
          : null;

        // Build insert data
        const insertData: NewMemoryEntryRow = {
          namespace: entry.namespace,
          key: entry.key,
          value: entry.value,
          updatedAt: now,
        };

        // Add optional fields only if defined
        if (entry.metadata !== undefined) {
          insertData.metadata = entry.metadata;
        }
        if (entry.sessionId !== undefined) {
          insertData.sessionId = entry.sessionId;
        }
        if (entry.userId !== undefined) {
          insertData.userId = entry.userId;
        }
        if (entry.spaceId !== undefined) {
          insertData.spaceId = entry.spaceId;
        }
        if (entry.agentId !== undefined) {
          insertData.agentId = entry.agentId;
        }
        if (entry.contentRef !== undefined) {
          insertData.contentRef = entry.contentRef;
        }
        if (entry.contentType !== undefined) {
          insertData.contentType = entry.contentType;
        }
        if (expiresAt !== null) {
          insertData.expiresAt = expiresAt;
        }
        if (entry.embedding !== undefined) {
          insertData.embedding = entry.embedding;
        }
        if (entry.embeddingModel !== undefined) {
          insertData.embeddingModel = entry.embeddingModel;
        }

        // Use INSERT ... ON CONFLICT DO UPDATE for atomic, race-safe upsert
        // Since search_path is set by withTenantSchema, we can reference the table directly
        const spaceIdVal = entry.spaceId ?? null;
        const agentIdVal = entry.agentId ?? null;
        const sessionIdVal = entry.sessionId ?? null;
        const metadataJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
        const embeddingJson = entry.embedding ? JSON.stringify(entry.embedding) : null;
        const valueJson = JSON.stringify(entry.value);

        // Use Drizzle's sql template with proper parameterization
        const result = await tx.execute(sql`
          INSERT INTO memory_entries (
            namespace, key, value, metadata, session_id, user_id, space_id, agent_id,
            content_ref, content_type, updated_at, expires_at, embedding, embedding_model
          )
          VALUES (
            ${entry.namespace}, ${entry.key}, ${valueJson}::jsonb,
            ${metadataJson}::jsonb, ${sessionIdVal}::uuid, ${entry.userId ?? null},
            ${spaceIdVal}::uuid, ${agentIdVal}, ${entry.contentRef ?? null},
            ${entry.contentType ?? null}, ${now}, ${expiresAt},
            ${embeddingJson}::jsonb, ${entry.embeddingModel ?? null}
          )
          ON CONFLICT (namespace, key, space_id, agent_id, session_id)
          DO UPDATE SET
            value = EXCLUDED.value,
            metadata = EXCLUDED.metadata,
            updated_at = EXCLUDED.updated_at,
            expires_at = EXCLUDED.expires_at,
            embedding = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            content_ref = EXCLUDED.content_ref,
            content_type = EXCLUDED.content_type
          RETURNING *
        `);

        if (!result || result.length === 0) {
          throw new Error('Failed to upsert memory entry');
        }

        // Convert result row to entity
        // Drizzle returns rows as arrays, need to access properly
        const row = (result as unknown as Array<Record<string, unknown>>)[0];
        if (!row) {
          throw new Error('Failed to upsert memory entry');
        }

        // Map the raw row to MemoryEntryRow format
        // Use bracket notation for index signature access
        const mappedRow: MemoryEntryRow = {
          id: row['id'] as string,
          namespace: row['namespace'] as string,
          key: row['key'] as string,
          value: row['value'],
          metadata: row['metadata'] as Record<string, unknown> | null,
          sessionId: row['session_id'] as string | null,
          userId: row['user_id'] as string | null,
          spaceId: row['space_id'] as string | null,
          agentId: row['agent_id'] as string | null,
          contentRef: row['content_ref'] as string | null,
          contentType: row['content_type'] as string | null,
          createdAt: row['created_at'] as Date,
          updatedAt: row['updated_at'] as Date,
          expiresAt: row['expires_at'] as Date | null,
          embedding: row['embedding'] as number[] | null,
          embeddingModel: row['embedding_model'] as string | null,
          embeddingStatus: (row['embedding_status'] ?? 'pending') as
            'pending' | 'ready' | 'failed' | 'disabled',
          embeddedAt: row['embedded_at'] as Date | null,
          embedError: row['embed_error'] as Record<string, unknown> | null,
          contentHash: row['content_hash'] as string | null,
        };

        return toEntity(mappedRow);
      });
    },

    async delete(namespace, key) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const result = await tx
          .delete(memoryEntries)
          .where(and(eq(memoryEntries.namespace, namespace), eq(memoryEntries.key, key)))
          .returning({ id: memoryEntries.id });

        return result.length > 0;
      });
    },

    async deleteMany(filter) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const conditions: SQL[] = [];

        if (filter.namespace) {
          conditions.push(eq(memoryEntries.namespace, filter.namespace));
        }
        if (filter.keyPrefix) {
          conditions.push(sql`${memoryEntries.key} LIKE ${filter.keyPrefix + '%'}`);
        }
        if (filter.sessionId) {
          conditions.push(eq(memoryEntries.sessionId, filter.sessionId));
        }
        if (filter.userId) {
          conditions.push(eq(memoryEntries.userId, filter.userId));
        }
        if (filter.spaceId) {
          conditions.push(eq(memoryEntries.spaceId, filter.spaceId));
        }
        if (filter.agentId) {
          conditions.push(eq(memoryEntries.agentId, filter.agentId));
        }

        if (conditions.length === 0) {
          return 0; // Don't delete everything
        }

        const result = await tx
          .delete(memoryEntries)
          .where(and(...conditions))
          .returning({ id: memoryEntries.id });

        return result.length;
      });
    },

    async query(filter, options = {}) {
      const { limit = 100, offset = 0 } = options;

      return withTenantSchema(db, tenantContext, async (tx) => {
        const conditions: SQL[] = [
          or(isNull(memoryEntries.expiresAt), lt(sql`now()`, memoryEntries.expiresAt))!,
        ];

        if (filter.namespace) {
          conditions.push(eq(memoryEntries.namespace, filter.namespace));
        }
        if (filter.keyPrefix) {
          conditions.push(sql`${memoryEntries.key} LIKE ${filter.keyPrefix + '%'}`);
        }
        if (filter.sessionId) {
          conditions.push(eq(memoryEntries.sessionId, filter.sessionId));
        }
        if (filter.userId) {
          conditions.push(eq(memoryEntries.userId, filter.userId));
        }
        if (filter.spaceId) {
          conditions.push(eq(memoryEntries.spaceId, filter.spaceId));
        }
        if (filter.agentId) {
          conditions.push(eq(memoryEntries.agentId, filter.agentId));
        }

        const rows = await tx
          .select()
          .from(memoryEntries)
          .where(and(...conditions))
          .limit(limit)
          .offset(offset)
          .orderBy(memoryEntries.updatedAt);

        return rows.map(toEntity);
      });
    },

    async vectorSearch(namespace, embedding, options = {}) {
      const { limit = 10, threshold = 0.7 } = options;

      return withTenantSchema(db, tenantContext, async (tx) => {
        // Simple cosine similarity calculation
        // For production, use pgvector: SELECT * FROM entries ORDER BY embedding <=> $1 LIMIT $2
        // This is a basic implementation using JSON arrays with client-side similarity

        const rows = await tx
          .select()
          .from(memoryEntries)
          .where(
            and(
              eq(memoryEntries.namespace, namespace),
              sql`${memoryEntries.embedding} IS NOT NULL`,
              or(isNull(memoryEntries.expiresAt), lt(sql`now()`, memoryEntries.expiresAt)),
            ),
          )
          .limit(limit * 10); // Fetch more to filter client-side

        // Client-side similarity calculation (inefficient but works without pgvector)
        const results: Array<MemoryEntry & { similarity: number }> = [];

        for (const row of rows) {
          const rowEmbedding = row.embedding as number[] | null;
          if (!rowEmbedding) continue;

          const similarity = cosineSimilarity(embedding, rowEmbedding);
          if (similarity < threshold) continue;

          results.push({
            ...toEntity(row),
            similarity,
          });
        }

        // Sort by similarity descending and take top results
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
      });
    },

    async cleanupExpired() {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const result = await tx
          .delete(memoryEntries)
          .where(
            and(
              sql`${memoryEntries.expiresAt} IS NOT NULL`,
              lt(memoryEntries.expiresAt, sql`now()`),
            ),
          )
          .returning({ id: memoryEntries.id });

        return result.length;
      });
    },

    async list(options = {}) {
      const {
        namespace = 'default',
        prefix,
        depth: _depth = 1,
        limit = 100,
        offset = 0,
        spaceId,
        agentId,
        sessionId,
      } = options;

      return withTenantSchema(db, tenantContext, async (tx) => {
        const conditions: SQL[] = [
          or(isNull(memoryEntries.expiresAt), lt(sql`now()`, memoryEntries.expiresAt))!,
          eq(memoryEntries.namespace, namespace),
        ];

        if (prefix) {
          // For depth > 1, we'd need more complex logic, but for now simple prefix match
          conditions.push(sql`${memoryEntries.key} LIKE ${prefix + '%'}`);
        }
        if (spaceId) {
          conditions.push(eq(memoryEntries.spaceId, spaceId));
        }
        if (agentId) {
          conditions.push(eq(memoryEntries.agentId, agentId));
        }
        if (sessionId) {
          conditions.push(eq(memoryEntries.sessionId, sessionId));
        }

        const rows = await tx
          .select({
            key: memoryEntries.key,
            metadata: memoryEntries.metadata,
            contentType: memoryEntries.contentType,
            updatedAt: memoryEntries.updatedAt,
            value: memoryEntries.value,
          })
          .from(memoryEntries)
          .where(and(...conditions))
          .limit(limit)
          .offset(offset)
          .orderBy(memoryEntries.key);

        return rows.map((row) => {
          const metadata = row.metadata as Record<string, unknown> | null;
          const kindValue = metadata?.['kind'] as string | undefined;
          const valueSize = row.value ? JSON.stringify(row.value).length : 0;

          const result: {
            key: string;
            kind?: string;
            updatedAt: Date;
            sizeBytes?: number;
            contentType?: string;
          } = {
            key: row.key,
            updatedAt: row.updatedAt,
          };

          if (kindValue !== undefined) {
            result.kind = kindValue;
          }
          if (valueSize > 0) {
            result.sizeBytes = valueSize;
          }
          if (row.contentType) {
            result.contentType = row.contentType;
          }

          return result;
        });
      });
    },

    async grep(options) {
      const {
        namespace = 'default',
        query,
        prefix,
        limit = 20,
        spaceId,
        agentId,
        sessionId,
      } = options;

      return withTenantSchema(db, tenantContext, async (tx) => {
        const conditions: SQL[] = [
          or(isNull(memoryEntries.expiresAt), lt(sql`now()`, memoryEntries.expiresAt))!,
          eq(memoryEntries.namespace, namespace),
        ];

        if (prefix) {
          conditions.push(sql`${memoryEntries.key} LIKE ${prefix + '%'}`);
        }
        if (spaceId) {
          conditions.push(eq(memoryEntries.spaceId, spaceId));
        }
        if (agentId) {
          conditions.push(eq(memoryEntries.agentId, agentId));
        }
        if (sessionId) {
          conditions.push(eq(memoryEntries.sessionId, sessionId));
        }

        // Simple text search: check if query appears in value (as text) or metadata
        // For production, use Postgres FTS (tsvector) for better performance
        const searchPattern = `%${query}%`;
        conditions.push(
          or(
            sql`CAST(${memoryEntries.value} AS TEXT) ILIKE ${searchPattern}`,
            sql`CAST(${memoryEntries.metadata} AS TEXT) ILIKE ${searchPattern}`,
          )!,
        );

        const rows = await tx
          .select({
            key: memoryEntries.key,
            value: memoryEntries.value,
            metadata: memoryEntries.metadata,
            updatedAt: memoryEntries.updatedAt,
          })
          .from(memoryEntries)
          .where(and(...conditions))
          .limit(limit * 2) // Fetch more to generate snippets
          .orderBy(memoryEntries.updatedAt);

        // Generate snippets and scores
        const results = rows.map((row) => {
          const valueText = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
          const metadataText = row.metadata ? JSON.stringify(row.metadata) : '';

          // Find first occurrence of query (case-insensitive)
          const lowerQuery = query.toLowerCase();
          const lowerValue = valueText.toLowerCase();
          const matchIndex = lowerValue.indexOf(lowerQuery);

          let snippet = valueText.substring(0, 200);
          if (matchIndex >= 0) {
            const start = Math.max(0, matchIndex - 50);
            const end = Math.min(valueText.length, matchIndex + query.length + 50);
            snippet = valueText.substring(start, end);
            if (start > 0) snippet = '...' + snippet;
            if (end < valueText.length) snippet = snippet + '...';
          } else if (metadataText.toLowerCase().includes(lowerQuery)) {
            snippet = metadataText.substring(0, 200);
          }

          // Simple score: 1.0 if found in value, 0.5 if in metadata
          const score = matchIndex >= 0 ? 1.0 : 0.5;

          return {
            key: row.key,
            snippet: snippet.substring(0, 500),
            score,
            updatedAt: row.updatedAt,
          };
        });

        // Sort by score descending and limit
        results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        return results.slice(0, limit);
      });
    },

    async updateEmbeddingStatus(params) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const updateData: Partial<NewMemoryEntryRow> = {
          embeddingStatus: params.status,
          updatedAt: new Date(),
        };

        if (params.status === 'ready') {
          updateData.embeddedAt = new Date();
          updateData.embedError = null;
        } else if (params.status === 'failed') {
          updateData.embedError = params.embedError ?? null;
        }

        if (params.contentHash !== undefined) {
          updateData.contentHash = params.contentHash;
        }

        await tx.update(memoryEntries).set(updateData).where(eq(memoryEntries.id, params.entryId));
      });
    },

    async upsertEmbedding(params) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        // Check if embedding already exists with same content hash (idempotency check)
        const existingRows = await tx.execute(
          sql.raw(`
          SELECT content_hash FROM "${tenantContext.schemaName}".memory_entry_embeddings
          WHERE entry_id = '${params.entryId}' AND embedding_model = '${params.embeddingModel}'
        `),
        );

        const rows = existingRows as unknown as Array<{ content_hash: string }>;
        if (rows.length > 0 && rows[0]?.content_hash === params.contentHash) {
          // Idempotent: same content hash, no-op
          return;
        }

        // Convert embedding array to pgvector format: [1,2,3] -> '[1,2,3]'
        const embeddingStr = `[${params.embedding.join(',')}]`;

        // Upsert embedding (insert or update)
        // Use raw SQL for pgvector operations
        await tx.execute(
          sql.raw(`
          INSERT INTO "${tenantContext.schemaName}".memory_entry_embeddings (
            entry_id, embedding_model, dims, embedding, content_hash, embedded_at, updated_at
          )
          VALUES (
            '${params.entryId}'::uuid,
            '${params.embeddingModel}',
            ${params.dims},
            '${embeddingStr}'::vector,
            '${params.contentHash}',
            NOW(),
            NOW()
          )
          ON CONFLICT (entry_id, embedding_model)
          DO UPDATE SET
            embedding = EXCLUDED.embedding,
            dims = EXCLUDED.dims,
            content_hash = EXCLUDED.content_hash,
            updated_at = NOW()
        `),
        );
      });
    },

    async semanticSearch(params) {
      const {
        namespace,
        queryEmbedding,
        embeddingModel,
        spaceId,
        agentId,
        sessionId,
        topK = 20,
        threshold = 0.7,
      } = params;

      return withTenantSchema(db, tenantContext, async (tx) => {
        // Build scope condition SQL
        let scopeCondition = '';
        if (spaceId) {
          scopeCondition = `AND m.space_id = '${spaceId}'::uuid`;
        } else if (agentId) {
          scopeCondition = `AND m.agent_id = '${agentId}'`;
        } else if (sessionId) {
          scopeCondition = `AND m.session_id = '${sessionId}'::uuid`;
        }

        // Convert query embedding to pgvector format
        const queryEmbeddingStr = `[${queryEmbedding.join(',')}]`;

        // Use cosine similarity: 1 - (embedding <=> query_embedding)
        // <=> is cosine distance operator in pgvector
        const results = await tx.execute(
          sql.raw(`
          SELECT 
            e.entry_id,
            e.content_hash,
            m.key,
            m.namespace,
            m.metadata,
            m.content_ref,
            m.updated_at,
            1 - (e.embedding <=> '${queryEmbeddingStr}'::vector) as similarity
          FROM "${tenantContext.schemaName}".memory_entry_embeddings e
          INNER JOIN "${tenantContext.schemaName}".memory_entries m
            ON e.entry_id = m.id
          WHERE 
            e.embedding_model = '${embeddingModel}'
            AND m.namespace = '${namespace}'
            AND m.embedding_status = 'ready'
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
            ${scopeCondition}
            AND (1 - (e.embedding <=> '${queryEmbeddingStr}'::vector)) >= ${threshold}
          ORDER BY e.embedding <=> '${queryEmbeddingStr}'::vector
          LIMIT ${topK}
        `),
        );

        const rows = results as unknown as Array<{
          entry_id: string;
          key: string;
          namespace: string;
          metadata: Record<string, unknown> | null;
          content_ref: string | null;
          updated_at: Date;
          similarity: number;
        }>;

        return rows.map((row) => {
          const metadata = row.metadata;
          const kind = metadata?.['kind'] as string | undefined;
          // Generate snippet from metadata description or key
          const snippet = metadata?.['description']
            ? (typeof metadata['description'] === 'object' && metadata['description'] !== null
                ? JSON.stringify(metadata['description'])
                : String((metadata['description'] ?? '') as string | number | boolean)
              ).substring(0, 200)
            : undefined;

          const result: {
            entryId: string;
            key: string;
            namespace: string;
            kind?: string;
            updatedAt: Date;
            score: number;
            snippet?: string;
            contentRef?: string;
          } = {
            entryId: row.entry_id,
            key: row.key,
            namespace: row.namespace,
            updatedAt: row.updated_at,
            score: row.similarity,
          };

          if (kind !== undefined) {
            result.kind = kind;
          }
          if (snippet !== undefined) {
            result.snippet = snippet;
          }
          if (row.content_ref) {
            result.contentRef = row.content_ref;
          }

          return result;
        });
      });
    },
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
