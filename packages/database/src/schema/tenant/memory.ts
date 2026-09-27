import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from 'drizzle-orm/pg-core';

/**
 * Result metadata from the link/property scan run at write time. Advisory —
 * the resolved state of any link is recomputed at read against live docs.
 */
export interface MemoryDerivation {
  schemaVersion: number;
  sourceHash: string;
  sourceVersion?: number;
  linksClamped?: boolean;
  linkScanTruncated?: boolean;
  propertyWarnings?: number;
  indexEntries?: Array<{ path: string; hook: string }>;
  omittedEntries?: number;
}

// ============================================================================
// Memory Store (v1 — kept for backward compatibility during migration)
// ============================================================================

/**
 * Memory entries - key-value storage for flow state and agent memory.
 * @deprecated Use memoryDocs (v2) for new code.
 */
export const memoryEntries = pgTable('memory_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  namespace: text('namespace').notNull().default('default'),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  metadata: jsonb('metadata'),
  sessionId: uuid('session_id'),
  userId: text('user_id'),
  spaceId: uuid('space_id'),
  agentId: uuid('agent_id'),
  contentRef: text('content_ref'),
  contentType: text('content_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  embedding: jsonb('embedding'),
  embeddingModel: text('embedding_model'),
  embeddingStatus: text('embedding_status')
    .notNull()
    .default('pending')
    .$type<'pending' | 'ready' | 'failed' | 'disabled'>(),
  embeddedAt: timestamp('embedded_at', { withTimezone: true }),
  embedError: jsonb('embed_error'),
  contentHash: text('content_hash'),
});

export type MemoryEntryRow = typeof memoryEntries.$inferSelect;
export type NewMemoryEntryRow = typeof memoryEntries.$inferInsert;

/** @deprecated Use memoryChunks (v2) for new code. */
export const memoryEntryEmbeddings = pgTable('memory_entry_embeddings', {
  entryId: uuid('entry_id').notNull(),
  embeddingModel: text('embedding_model').notNull(),
  dims: integer('dims').notNull(),
  embedding: text('embedding').notNull(),
  contentHash: text('content_hash').notNull(),
  embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MemoryEntryEmbeddingRow = typeof memoryEntryEmbeddings.$inferSelect;
export type NewMemoryEntryEmbeddingRow = typeof memoryEntryEmbeddings.$inferInsert;

// ============================================================================
// Memory v2 — Repo-like Document Store
// ============================================================================

/**
 * Memory documents — path-indexed, versioned, scoped documents.
 * Latest version pointer; full history in memory_doc_versions.
 */
export const memoryDocs = pgTable('memory_docs', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Filesystem-like path (unique per space within tenant schema) */
  path: text('path').notNull(),

  /** Document type discriminator */
  docType: text('doc_type').notNull(),

  /** MIME type */
  mimeType: text('mime_type').notNull().default('text/plain'),

  /** Size of the current version's content in bytes */
  sizeBytes: integer('size_bytes').notNull().default(0),

  /** SHA-256 hash of canonical content bytes */
  contentHash: text('content_hash'),

  /** Small inline text body (NULL for large docs stored via payloadRef) */
  inlineContent: text('inline_content'),

  /** PayloadRef for large content stored in blob store */
  payloadRef: text('payload_ref'),

  /** Short preview string (first ~200 chars for listing) */
  preview: text('preview'),

  /** Tags for filtering (GIN-indexed JSONB array) */
  tags: jsonb('tags').notNull().default([]).$type<string[]>(),

  /** Optional summary written by the author */
  summary: text('summary'),

  /** Optional semantic type for specialized UI rendering (e.g. 'workflow_overview', 'compute_result') */
  semanticType: text('semantic_type'),

  /** Structured front-matter properties parsed from the doc body (GIN-indexed). */
  properties: jsonb('properties').notNull().default({}).$type<Record<string, unknown>>(),

  /** Derivation metadata from the link/property scan (NULL until first scanned). */
  derivation: jsonb('derivation').$type<MemoryDerivation>(),

  /** Space scope (mandatory isolation boundary); the finer scopes are optional refinements. */
  spaceId: uuid('space_id').notNull(),
  userId: text('user_id'),
  agentId: uuid('agent_id'),
  sessionId: uuid('session_id'),

  /** Provenance */
  createdByActor: text('created_by_actor'),
  createdBySessionId: uuid('created_by_session_id'),
  createdByStepId: text('created_by_step_id'),
  createdByStepExecutionId: uuid('created_by_step_execution_id'),

  /** Current (latest) version number */
  currentVersion: integer('current_version').notNull().default(1),

  /** Embedding/indexing status */
  embeddingStatus: text('embedding_status')
    .notNull()
    .default('disabled')
    .$type<'disabled' | 'pending' | 'indexed' | 'failed'>(),

  /** Indexing mode inherited from directory policy or explicit */
  indexingMode: text('indexing_mode')
    .notNull()
    .default('auto')
    .$type<'auto' | 'disabled' | 'force'>(),

  /** Optional TTL (NULL = permanent) */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  /** Soft delete flag */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MemoryDocRow = typeof memoryDocs.$inferSelect;
export type NewMemoryDocRow = typeof memoryDocs.$inferInsert;

/**
 * Immutable document version snapshots.
 * Created on every put/patch for full version history.
 */
export const memoryDocVersions = pgTable(
  'memory_doc_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Parent document */
    docId: uuid('doc_id').notNull(),

    /** Monotonic version number within the doc */
    version: integer('version').notNull(),

    /** Content — inline for small docs */
    inlineContent: text('inline_content'),

    /** Content — payloadRef for large docs */
    payloadRef: text('payload_ref'),

    /** Content hash for this version */
    contentHash: text('content_hash').notNull(),

    /** Size in bytes */
    sizeBytes: integer('size_bytes').notNull().default(0),

    /** Who created this version */
    createdByActor: text('created_by_actor'),
    createdBySessionId: uuid('created_by_session_id'),
    createdByStepExecutionId: uuid('created_by_step_execution_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (_table) => [],
);

export type MemoryDocVersionRow = typeof memoryDocVersions.$inferSelect;
export type NewMemoryDocVersionRow = typeof memoryDocVersions.$inferInsert;

/**
 * Embedding chunks for hybrid search.
 * Each doc version can have multiple chunks with individual embeddings.
 */
export const memoryChunks = pgTable('memory_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Parent document */
  docId: uuid('doc_id').notNull(),

  /** Version this chunk belongs to */
  docVersionId: uuid('doc_version_id').notNull(),

  /** Sequential chunk index within the version */
  chunkIndex: integer('chunk_index').notNull(),

  /** Chunk text content */
  text: text('text').notNull(),

  /** Byte offsets within the source content */
  startOffset: integer('start_offset').notNull().default(0),
  endOffset: integer('end_offset').notNull().default(0),

  /** Embedding model used */
  embeddingModel: text('embedding_model'),

  /** Embedding dimensions */
  dims: integer('dims'),

  /** Named embedding columns — one per supported dimension (migration 6) */
  embedding1536: text('embedding_1536'),
  embedding3072: text('embedding_3072'),

  /**
   * Generated tsvector for full-text search (migration 5).
   * GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED
   * Typed as text in Drizzle since there's no native tsvector type.
   */
  chunkTsv: text('chunk_tsv'),

  skipEmbedding: boolean('skip_embedding').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MemoryChunkRow = typeof memoryChunks.$inferSelect;
export type NewMemoryChunkRow = typeof memoryChunks.$inferInsert;

// ============================================================================
// Memory Embedding Config (per-scope model selection)
// ============================================================================

/**
 * Per-scope embedding model configuration.
 * Resolution order: path_prefix (longest match) → space → flow → global default.
 */
export const memoryEmbedConfig = pgTable('memory_embed_config', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Scope type: 'global' | 'space' | 'flow' | 'path_prefix' */
  scopeType: text('scope_type').notNull(),

  /** Scope value: NULL for global, spaceId/flowId/pathPrefix for others */
  scopeValue: text('scope_value'),

  /** Embedding model identifier (e.g. 'openai:text-embedding-3-small') */
  embeddingModel: text('embedding_model').notNull(),

  /** Vector dimensions for this model */
  dims: integer('dims').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MemoryEmbedConfigRow = typeof memoryEmbedConfig.$inferSelect;
export type NewMemoryEmbedConfigRow = typeof memoryEmbedConfig.$inferInsert;

// ============================================================================
// Memory Directories (explicit filesystem-like directory entities)
// ============================================================================

/**
 * Explicit directory entries for filesystem-like navigation.
 * Auto-created on memory.store.put (mkdir -p) or explicitly via memory.mkdir.
 */
export const memoryDirs = pgTable('memory_dirs', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Canonical directory path (unique per space, no trailing / except root '/') */
  path: text('path').notNull(),

  /** Last path segment (directory name) */
  name: text('name').notNull(),

  /** Parent directory path (NULL for root '/') */
  parentPath: text('parent_path'),

  /** Human/agent description of the directory's purpose */
  description: text('description'),

  /** Arbitrary key-value metadata */
  metadata: jsonb('metadata').notNull().default({}).$type<Record<string, unknown>>(),

  /** Tags for filtering */
  tags: jsonb('tags').notNull().default([]).$type<string[]>(),

  /** Space scope (mandatory isolation boundary); the finer scopes are optional refinements. */
  spaceId: uuid('space_id').notNull(),
  userId: text('user_id'),
  agentId: uuid('agent_id'),
  sessionId: uuid('session_id'),

  /** Provenance */
  createdByActor: text('created_by_actor'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  /** Soft delete flag */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type MemoryDirRow = typeof memoryDirs.$inferSelect;
export type NewMemoryDirRow = typeof memoryDirs.$inferInsert;

// ============================================================================
// Memory Links (link graph — one row per distinct target referenced by a doc)
// ============================================================================

/**
 * Outgoing links parsed from a source doc's body. One row per distinct
 * canonicalized target path referenced by `from_doc_id`. Resolution
 * (whether the target points at a live doc) is NEVER stored — it is computed
 * at read against live docs in the same space.
 */
export const memoryLinks = pgTable('memory_links', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Space scope — carried directly so link queries never join to resolve isolation. */
  spaceId: uuid('space_id').notNull(),

  /** Source document this link originates from. */
  fromDocId: uuid('from_doc_id').notNull(),

  /** Canonicalized target path (stored literal). */
  targetPath: text('target_path').notNull(),

  /** First-occurrence document order of this target within the source doc. */
  ordinal: integer('ordinal').notNull(),

  /** How many times this target is referenced by the source doc. */
  occurrenceCount: integer('occurrence_count').notNull().default(1),

  /** Short surrounding context of the first occurrence (<=240 chars). */
  firstContext: text('first_context'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MemoryLinkRow = typeof memoryLinks.$inferSelect;
export type NewMemoryLinkRow = typeof memoryLinks.$inferInsert;
