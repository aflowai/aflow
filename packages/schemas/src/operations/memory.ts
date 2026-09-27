/**
 * Memory v2 operation schemas.
 *
 * Repo-like memory store with 6 operations:
 * - memory.store.query (list / search / grep modes)
 * - memory.store.get   (stat / preview / content views, range reads)
 * - memory.store.put   (create / upsert documents)
 * - memory.store.patch  (partial updates via json_patch / text_patch)
 * - memory.store.delete (soft-delete documents or directories)
 * - memory.store.mkdir  (create directories explicitly)
 *
 * All docs are addressed by path within a tenant, with optional
 * scoping to space / user / flow / run.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { ActiveMemoryKindSchema, ActiveMemoryStatusSchema } from '../cybernetic/activeMemory.js';

const MEMORY_VIRTUAL_PREFIX = '/run/';

// ============================================================================
// Shared Types
// ============================================================================

export const MemoryDocTypeSchema = z.enum([
  'directory',
  'markdown',
  'text',
  'json',
  'ndjson',
  'code',
  'prompt',
  'report',
  'dataset',
  'artifact',
  'html_app',
  'image',
  'audio',
  'video',
  'schema',
  'objective',
  'plan',
  'ledger',
]);
export type MemoryDocType = z.infer<typeof MemoryDocTypeSchema>;

export const MemoryEmbeddingStatusSchema = z.enum(['disabled', 'pending', 'indexed', 'failed']);
export type MemoryEmbeddingStatus = z.infer<typeof MemoryEmbeddingStatusSchema>;

export const MemoryActorTypeSchema = z.enum(['api', 'orchestrator', 'executor', 'user']);
export type MemoryActorType = z.infer<typeof MemoryActorTypeSchema>;

/**
 * Wikilinks derived from a write, split by target liveness at write time. A
 * ghost is a link whose target does not exist yet — not an error.
 */
export const MemoryWriteLinksReportSchema = z
  .object({
    resolved: z.number().int().nonnegative().describe('Links whose target exists as a live doc.'),
    ghostCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Links whose target does not exist yet (write the target later, or fix the path).'),
    ghosts: z
      .array(z.string())
      .max(10)
      .describe('Up to 10 sample ghost target paths (ghostCount is the full total).'),
    clamped: z
      .boolean()
      .optional()
      .describe('True when the source exceeded the per-doc link cap and was truncated.'),
  })
  .describe('Wikilinks indexed from the content, split into resolved vs ghost targets.');
export type MemoryWriteLinksReport = z.infer<typeof MemoryWriteLinksReportSchema>;

/**
 * Frontmatter properties derived from a write plus a capped diagnostic sample.
 */
export const MemoryWritePropertiesReportSchema = z
  .object({
    derived: z
      .record(z.unknown())
      .describe('Frontmatter keys stored as queryable properties (filter via filters.properties).'),
    diagnosticCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z.object({
          key: z.string().optional(),
          reason: z.enum(['invalid_yaml', 'unsupported_value', 'clamped']),
          message: z.string().max(300),
        }),
      )
      .max(10)
      .describe('Up to 10 sample diagnostics (diagnosticCount is the full total).'),
  })
  .describe('Frontmatter parsed into queryable properties, with any parse diagnostics.');
export type MemoryWritePropertiesReport = z.infer<typeof MemoryWritePropertiesReportSchema>;

/**
 * Document stat (lightweight metadata always returned).
 *
 * `docType` is a free string here (not the write-time enum): platform writers
 * persist docTypes outside the agent-facing enum (e.g. workflow projections), so
 * read outputs must round-trip whatever is stored.
 */
export const MemoryDocStatSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  docType: z.string().max(64),
  mimeType: z.string().max(128),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string().optional(),
  tags: z.array(z.string()).default([]),
  semanticType: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Semantic type for specialized UI rendering (e.g. workflow_overview, compute_result). ' +
        'When set, viewers render the document with a dedicated card component instead of raw JSON.',
    ),
  version: z.number().int().positive(),
  embeddingStatus: MemoryEmbeddingStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  backlinkCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Incoming links from live source docs (any docType).'),
  linkCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Outgoing links whose target resolves to a live doc (link-source docTypes only).'),
  ghostLinkCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Outgoing links whose target does not exist yet (link-source docTypes only).'),
  properties: z
    .record(z.unknown())
    .optional()
    .describe('Frontmatter properties parsed from the body (filter via filters.properties).'),
  provenance: z
    .object({
      actor: z.string(),
      sessionId: z.string().uuid().optional(),
      stepExecutionId: z.string().uuid().optional(),
    })
    .optional(),
  derivation: z
    .object({
      linksClamped: z.boolean().optional(),
      linkScanTruncated: z.boolean().optional(),
      propertyWarnings: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type MemoryDocStat = z.infer<typeof MemoryDocStatSchema>;

/**
 * One direction of the link graph around a doc. `outgoing` is what this doc
 * references (resolved = target is a live doc); `backlinks` is what references
 * this doc, from live sources only.
 */
export const MemoryLinkOutgoingSchema = z.object({
  targetPath: z.string(),
  resolved: z.boolean(),
  occurrenceCount: z.number().int().positive(),
  context: z.string().max(240).optional(),
});
export type MemoryLinkOutgoing = z.infer<typeof MemoryLinkOutgoingSchema>;

export const MemoryBacklinkSchema = z.object({
  fromPath: z.string(),
  context: z.string().max(240).optional(),
  updatedAt: z.string().datetime(),
});
export type MemoryBacklink = z.infer<typeof MemoryBacklinkSchema>;

export const MemoryLinksBlockSchema = z.object({
  outgoing: z.array(MemoryLinkOutgoingSchema).max(100),
  backlinks: z.array(MemoryBacklinkSchema).max(100),
  outgoingTotal: z.number().int().nonnegative(),
  backlinkTotal: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
});
export type MemoryLinksBlock = z.infer<typeof MemoryLinksBlockSchema>;

/**
 * Search/grep hit metadata.
 */
export const MemoryHitSchema = z.object({
  score: z.number().min(0).max(1),
  snippet: z.string().max(500).optional(),
  chunkId: z.string().uuid().optional(),
});
export type MemoryHit = z.infer<typeof MemoryHitSchema>;

/** Upper bound on distinct property keys in a single filters.properties clause. */
export const MAX_PROPERTY_FILTER_KEYS = 8;

const PropertyFilterScalarSchema = z.union([z.string().max(512), z.number(), z.boolean()]);

/**
 * Filters for memory.store.query.
 */
export const MemoryFiltersSchema = z.object({
  docType: z.array(MemoryDocTypeSchema).optional(),
  tagsAny: z.array(z.string()).optional(),
  tagsAll: z.array(z.string()).optional(),
  updatedAfter: z.string().datetime().optional(),
  updatedBefore: z.string().datetime().optional(),
  maxSizeBytes: z.number().int().positive().optional(),
  properties: z
    .record(z.union([PropertyFilterScalarSchema, z.array(PropertyFilterScalarSchema).max(20)]))
    .refine((r) => Object.keys(r).length <= MAX_PROPERTY_FILTER_KEYS, {
      message: `At most ${MAX_PROPERTY_FILTER_KEYS} property filters per query`,
    })
    .optional()
    .describe(
      'Match on frontmatter properties. Keys are ANDed; a scalar matches when the property ' +
        'equals it or is an array containing it; an array of values is any-of (OR).',
    ),
});
export type MemoryFilters = z.infer<typeof MemoryFiltersSchema>;

/**
 * Budget controls to prevent context flooding.
 */
export const MemoryBudgetSchema = z.object({
  limit: z.number().int().positive().max(200).default(50),
  maxSnippetBytes: z.number().int().positive().max(2048).default(500),
  maxTotalBytes: z.number().int().positive().max(65536).default(32768),
  maxLinkedItems: z.number().int().positive().max(50).default(10),
});
export type MemoryBudget = z.infer<typeof MemoryBudgetSchema>;

// ============================================================================
// memory.store.query — unified list / search / grep
// ============================================================================

export const MemoryQueryInputSchema = z
  .object({
    mode: z.enum(['list', 'search', 'grep', 'links']).default('list'),
    pathPrefix: z.string().max(1024).optional(),
    query: z.string().max(10000).optional(),
    filters: MemoryFiltersSchema.optional(),
    budget: MemoryBudgetSchema.optional(),
    cursor: z.string().max(512).optional(),
    recursive: z.boolean().optional(),
    linkFilter: z
      .object({
        target: z
          .string()
          .max(1024)
          .optional()
          .describe('Restrict to edges pointing at this exact target path.'),
        unresolvedOnly: z
          .boolean()
          .optional()
          .describe('With no target: list only referenced-but-unwritten (ghost) targets.'),
      })
      .optional()
      .describe('Graph filter for mode="links".'),
    expand: z
      .object({
        links: z
          .literal(1)
          .describe('1-hop expansion. Depth stays at 1 — deeper traversal is a separate call.'),
        direction: z
          .enum(['out', 'both'])
          .default('out')
          .describe(
            "out = the seeds' own outgoing references (higher trust); both also pulls incoming referrers.",
          ),
      })
      .optional()
      .describe(
        'Opt-in 1-hop link expansion for mode="search": also return linked neighbors of the top hits.',
      ),
  })
  .refine((v) => v.linkFilter === undefined || v.mode === 'links', {
    message: 'linkFilter is only valid with mode="links"',
    path: ['linkFilter'],
  })
  .refine((v) => v.expand === undefined || v.mode === 'search', {
    message:
      'expand.links requires mode="search" — in other modes links are read via view="links" or mode="links"',
    path: ['expand'],
  })
  .refine((v) => v.mode !== 'links' || v.query === undefined, {
    message:
      'query is not used in links mode — filter with linkFilter.target / linkFilter.unresolvedOnly and pathPrefix',
    path: ['query'],
  });
export type MemoryQueryInput = z.infer<typeof MemoryQueryInputSchema>;

export const MemoryQueryItemSchema = z.object({
  entryType: z.enum(['directory', 'document']).optional(),
  path: z.string(),
  id: z.string().uuid(),
  name: z.string().optional(),
  docType: z.string().max(64),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  semanticType: z.string().max(64).optional(),
  updatedAt: z.string().datetime(),
  preview: z.string().max(500).optional(),
  description: z.string().optional(),
  childCount: z
    .object({
      dirs: z.number().int().nonnegative(),
      docs: z.number().int().nonnegative(),
    })
    .optional(),
  hit: MemoryHitSchema.optional(),
  via: z
    .object({
      kind: z.literal('link'),
      direction: z.enum(['out', 'in']),
      from: z.string(),
    })
    .optional()
    .describe(
      'Present only on link-expanded items (mode="search" with expand.links=1): this item came ' +
        'from the link graph — a 1-hop neighbor of the seed at `from` — not from text/vector similarity, ' +
        'so it carries no `hit`. direction="in" is an incoming referrer (the self-nomination channel).',
    ),
  spaceId: z.string().uuid().optional(),
  userId: z.string().max(256).optional(),
  flowId: z.string().max(128).optional(),
  runId: z.string().uuid().optional(),
});
export type MemoryQueryItem = z.infer<typeof MemoryQueryItemSchema>;

/** One referrer edge (mode="links" with linkFilter.target). */
export const MemoryLinkEdgeSchema = z.object({
  fromPath: z.string(),
  occurrenceCount: z.number().int().positive(),
  context: z.string().max(240).optional(),
  updatedAt: z.string().datetime(),
});
export type MemoryLinkEdge = z.infer<typeof MemoryLinkEdgeSchema>;

/** One aggregated target (mode="links" without a target — the hub/agenda view). */
export const MemoryLinkTargetSchema = z.object({
  targetPath: z.string(),
  resolved: z.boolean(),
  referenceCount: z.number().int().positive(),
  referrers: z
    .array(z.object({ path: z.string(), context: z.string().max(240).optional() }))
    .max(5),
  resolvedDoc: z
    .object({
      id: z.string().uuid(),
      docType: z.string().max(64),
      updatedAt: z.string().datetime(),
      summary: z.string().optional(),
    })
    .optional(),
});
export type MemoryLinkTarget = z.infer<typeof MemoryLinkTargetSchema>;

export const MemoryQueryOutputSchema = z.object({
  items: z.array(MemoryQueryItemSchema),
  nextCursor: z.string().optional(),
  totalEstimate: z.number().int().nonnegative().optional(),
  linkEdges: z.array(MemoryLinkEdgeSchema).optional(),
  linkTargets: z.array(MemoryLinkTargetSchema).optional(),
  truncatedByBudget: z
    .boolean()
    .optional()
    .describe(
      'The page was shortened to fit budget.maxTotalBytes — distinct from nextCursor (there is more), ' +
        'this reports the byte cap dropped rows. In list and links modes a nextCursor is returned to ' +
        'page the rest; grep and search are single-page top-K with no cursor, so recover there by ' +
        'narrowing the query or raising budget.maxTotalBytes.',
    ),
});
export type MemoryQueryOutput = z.infer<typeof MemoryQueryOutputSchema>;

// ============================================================================
// memory.store.get — stat / preview / content with range reads
// ============================================================================

/**
 * Shared read-options shape for the memory read ops. memory.store.get and
 * memory.run_output.get differ ONLY in how the target is addressed (a
 * document target vs. a /run/outputs path) and the default view — the range /
 * navigation options are identical, so they derive from one source rather
 * than being hand-mirrored (which silently drifts when one gains an option).
 * `view` is spread here with the store.get default and overridden per-op.
 */
const memoryReadOptionsShape = {
  view: z.enum(['stat', 'preview', 'content', 'outline', 'links']).default('stat'),
  maxBytes: z.number().int().positive().max(1048576).optional(),
  byteRange: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .optional(),
  lineRange: z
    .object({
      startLine: z.number().int().nonnegative(),
      endLine: z.number().int().positive(),
    })
    .optional(),
  jsonPath: z.string().max(512).optional(),
  itemRange: z
    .object({
      start: z.number().int().nonnegative(),
      count: z.number().int().positive().max(200),
    })
    .optional(),
} as const;

const PIN_FIELDS = ['version', 'expectedContentHash'] as const;

export const MemoryGetInputSchema = z.preprocess(
  (val, ctx) => {
    if (!val || typeof val !== 'object') return val;
    const obj = val as Record<string, unknown>;
    const nested = obj['target'];
    const hasTarget = typeof nested === 'object' && nested !== null;

    // Allow flat { path: "..." } or { id: "..." } instead of { target: { path: "..." } }
    if (!hasTarget && !obj['path'] && !obj['id']) return val;
    const target: Record<string, unknown> = hasTarget ? (nested as Record<string, unknown>) : {};
    if (!hasTarget) {
      if (obj['path']) {
        target['path'] = obj['path'];
        delete obj['path'];
      }
      if (obj['id']) {
        target['id'] = obj['id'];
        delete obj['id'];
      }
    }

    // A pin has to travel with the target it pins, whether or not the target is
    // already spelled out — dropping it would silently downgrade an exact read
    // to a current read, which is the failure the pin exists to prevent.
    for (const field of PIN_FIELDS) {
      const flat = obj[field];
      if (flat === undefined) continue;
      const inTarget = target[field];
      if (inTarget !== undefined && inTarget !== flat) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message:
            `${field} is set both at the top level (${JSON.stringify(flat)}) and inside target ` +
            `(${JSON.stringify(inTarget)}). Set it once, inside target.`,
        });
        continue;
      }
      target[field] = flat;
      delete obj[field];
    }
    obj['target'] = target;
    return val;
  },
  z.object({
    target: z
      .object({
        id: z.string().uuid().optional(),
        path: z.string().max(1024).optional(),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Read this exact version (stat.version) instead of the current one. Versions are ' +
              'immutable, so a pinned read returns the same bytes after the document is ' +
              'overwritten. Fails if that version does not exist — it never falls back to current.',
          ),
        expectedContentHash: z
          .string()
          .max(128)
          .optional()
          .describe(
            'The contentHash (stat.contentHash) this reference was pinned to. The read fails ' +
              'naming both hashes if the resolved content hashes differently, so a changed ' +
              'document surfaces as an error rather than as different bytes.',
          ),
      })
      .refine((t) => t.id !== undefined || t.path !== undefined, {
        message: 'Either id or path must be provided',
      }),
    ...memoryReadOptionsShape,
  }),
);
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;

/**
 * Input for memory.run_output.get — the run-scoped reread surface. The path
 * regex makes anything outside /run/outputs/ inexpressible: this operation
 * grants read-back of THIS run's tool outputs and nothing else, so it can be
 * floor-granted without opening general memory read. Read options derive from
 * the same source as memory.store.get; only the target (a path, not a
 * document) and the default view (outline — reread is usually a shape peek)
 * differ.
 */
export const MemoryRunOutputGetInputSchema = z.object({
  path: z
    .string()
    .max(1024)
    .regex(/^\/run\/outputs\/.+/, {
      message:
        'path must be a /run/outputs/<toolCallId>/... virtual path. ' +
        'General memory documents are read with memory.store.get.',
    }),
  ...memoryReadOptionsShape,
  view: z.enum(['stat', 'preview', 'content', 'outline']).default('outline'),
});
export type MemoryRunOutputGetInput = z.infer<typeof MemoryRunOutputGetInputSchema>;

const LineRangeMetaSchema = z.object({
  kind: z.literal('lines'),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
/**
 * Character-offset range metadata. Named 'chars' because JS string.length and
 * substring() operate on UTF-16 code units, not bytes. The input field is still
 * called 'byteRange' for backward compatibility, but the metadata is accurate.
 *
 * `jsonPath` marks a window over the SERIALIZED SUBTREE at that path (a
 * jsonPath read too large to return whole) — its offsets do NOT index the raw
 * document, so a byteRange continuation is not valid there; refine with a
 * deeper jsonPath or itemRange instead.
 */
const CharRangeMetaSchema = z.object({
  kind: z.literal('chars'),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  totalChars: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  jsonPath: z.string().optional(),
});
const ItemRangeMetaSchema = z.object({
  kind: z.literal('items'),
  start: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  totalItems: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  jsonPath: z.string().optional(),
});
/**
 * The range metadata attached to bounded memory reads. Exported so read-result
 * consumers (the orchestrator summary boundary) parse the SAME contract the
 * executor emits instead of hand-mirroring the fields.
 */
export const MemoryReadRangeMetaSchema = z.discriminatedUnion('kind', [
  LineRangeMetaSchema,
  CharRangeMetaSchema,
  ItemRangeMetaSchema,
]);
export type MemoryReadRangeMeta = z.infer<typeof MemoryReadRangeMetaSchema>;
const RangeMetaSchema = MemoryReadRangeMetaSchema;

export interface OutlineNode {
  /** Key (object member) or index (`[n]`) of this node in its parent. Absent at the root. */
  key?: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** Object: number of keys. Array: number of items. String: character length. */
  length?: number;
  /** Serialized JSON byte size of this subtree. */
  bytes: number;
  /** Child nodes for object/array within the depth budget. */
  children?: OutlineNode[];
  /** True when children were omitted (depth budget reached or breadth cap exceeded). */
  truncatedChildren?: boolean;
}
export const OutlineNodeSchema = z.lazy(() =>
  z.object({
    key: z.string().optional(),
    type: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null']),
    length: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative(),
    children: z.array(OutlineNodeSchema).optional(),
    truncatedChildren: z.boolean().optional(),
  }),
) as z.ZodType<OutlineNode>;

export const MemoryGetOutputSchema = z.object({
  stat: MemoryDocStatSchema,
  data: z
    .string()
    .optional()
    .describe(
      'The requested content. When `range` reports hasMore, continue reading from the SAME ' +
        'path (stat.path) with the next window derived from the returned range (e.g. ' +
        'lineRange starting at range.endLine, or itemRange starting at range.start + ' +
        "range.count) — never read this call's own output path.",
    ),
  dataJson: z.unknown().optional(),
  binary: z
    .literal(true)
    .optional()
    .describe(
      'Returned INSTEAD of `data` when the document body is stored as raw bytes (media, ' +
        'downloaded files, sandbox artifacts). The bytes are never inlined into a turn — read ' +
        '`stat` for mimeType/sizeBytes/contentHash, and hand `stat.path` to an operation that ' +
        'consumes a memory document to work with the file.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True only when `data` was cut BELOW a semantic unit (mid-line or mid-JSON-token). A ' +
        'window clamped to the read budget is NOT truncated — the returned range metadata ' +
        'describes exactly what came back; compare it to what you asked for.',
    ),
  range: RangeMetaSchema.optional(),
  outline: OutlineNodeSchema.optional(),
  links: MemoryLinksBlockSchema.optional().describe(
    'Both directions of the link graph around this doc (view="links").',
  ),
  backlinks: z
    .array(MemoryBacklinkSchema)
    .max(10)
    .optional()
    .describe('Up to 10 most-recent notes that reference this doc (content/preview views).'),
  backlinkTotal: z.number().int().nonnegative().optional(),
});
export type MemoryGetOutput = z.infer<typeof MemoryGetOutputSchema>;

// ============================================================================
// memory.store.put — create / upsert
// ============================================================================

/**
 * Preprocess memory.store.put input for ergonomic agent usage:
 * - content: "text" → content: { inlineText: "text" } (plain string shorthand)
 * - target: { path } → path (alias for consistency with get/patch)
 */
function preprocessPutInput(val: unknown): unknown {
  if (val == null || typeof val !== 'object') return val;
  const obj = val as Record<string, unknown>;

  // Hoist target.path → path (agents confuse put with get/patch pattern)
  if (
    !('path' in obj) &&
    'target' in obj &&
    typeof obj['target'] === 'object' &&
    obj['target'] !== null
  ) {
    const target = obj['target'] as Record<string, unknown>;
    if (typeof target['path'] === 'string') {
      obj['path'] = target['path'];
      delete obj['target'];
    }
  }

  // Coerce content: "string" → content: { inlineText: "string" }
  if (typeof obj['content'] === 'string') {
    obj['content'] = { inlineText: obj['content'] };
  }

  // Coerce content: { ...rawObject } → content: { inlineJson: rawObject }
  // When the agent passes a plain object without inlineText/inlineJson/fromPath keys,
  // auto-wrap it in inlineJson (mirrors the string → inlineText coercion above).
  if (
    typeof obj['content'] === 'object' &&
    obj['content'] !== null &&
    !Array.isArray(obj['content'])
  ) {
    const content = obj['content'] as Record<string, unknown>;
    const hasEnvelopeKey =
      'inlineText' in content || 'inlineJson' in content || 'fromPath' in content;
    if (!hasEnvelopeKey) {
      obj['content'] = { inlineJson: content };
    }
  }

  // Coerce top-level fromPath → content: { fromPath: "..." }
  if (typeof obj['fromPath'] === 'string' && !('content' in obj)) {
    obj['content'] = { fromPath: obj['fromPath'] };
    delete obj['fromPath'];
  }

  return obj;
}

export const MemoryPutInputSchema = z.preprocess(
  preprocessPutInput,
  z.object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !p.startsWith(MEMORY_VIRTUAL_PREFIX), {
        message:
          'Cannot write to virtual /run/ paths — use a persistent path like /data/... or copy via content.fromPath.',
      }),
    writeMode: z
      .enum(['upsert', 'create', 'overwrite'])
      .default('upsert')
      .describe(
        'upsert creates or updates; create fails if the path already exists; overwrite fails if it does not.',
      ),

    docType: MemoryDocTypeSchema.default('text'),
    mimeType: z.string().max(128).default('text/plain'),
    content: z
      .object({
        inlineText: z.string().optional().describe('Text content to store directly.'),
        inlineJson: z.unknown().optional().describe('JSON content (stored as JSON).'),
        fromPath: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Copy content from another memory path (including /run/outputs/... virtual paths). ' +
              'Use to persist run output to long-term memory. ' +
              'Example: fromPath: "/run/outputs/<toolCallId>/data" copies a step\'s output to this document.',
          ),
      })
      .refine(
        (c) => c.inlineText !== undefined || c.inlineJson !== undefined || c.fromPath !== undefined,
        {
          message: 'One of inlineText, inlineJson, or fromPath must be provided',
        },
      )
      .describe('Content to store. Accepts a plain string (coerced to {inlineText: "..."}).'),
    tags: z.array(z.string().max(128)).max(50).optional(),
    semanticType: z
      .string()
      .max(64)
      .optional()
      .describe(
        'Semantic type for specialized UI rendering (e.g. workflow_overview, compute_result). ' +
          'Set this when storing structured data that has a dedicated viewer.',
      ),
    summary: z.string().max(500).optional(),
    expectedHash: z.string().optional(),
    indexing: z.enum(['auto', 'disabled', 'force']).default('auto'),
  }),
);
export type MemoryPutInput = z.infer<typeof MemoryPutInputSchema>;

export const MemoryPutOutputSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  version: z.number().int().positive(),
  contentHash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  embeddingStatus: MemoryEmbeddingStatusSchema,
  data: z
    .string()
    .optional()
    .describe(
      'Stored content (full if small, preview if large). ' +
        'Full output accessible at /run/outputs/<toolCallId>/data.',
    ),
  links: MemoryWriteLinksReportSchema.optional(),
  properties: MemoryWritePropertiesReportSchema.optional(),
  incomingLinkCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('On create only: live links that already point at this new path.'),
});
export type MemoryPutOutput = z.infer<typeof MemoryPutOutputSchema>;

// ============================================================================
// memory.store.patch — partial update (json_patch or text_patch)
// ============================================================================

export const MemoryPatchInputSchema = z.object({
  target: z
    .object({
      id: z.string().uuid().optional(),
      path: z.string().max(1024).optional(),
    })
    .refine((t) => t.id !== undefined || t.path !== undefined, {
      message: 'Either id or path must be provided',
    })
    .refine((t) => !t.path?.startsWith(MEMORY_VIRTUAL_PREFIX), {
      message:
        'Cannot patch virtual /run/ paths — copy to a persistent path first (memory.store.put with fromPath).',
    }),
  patch: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('json_patch'),
      operations: z.array(
        z.object({
          op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
          path: z.string(),
          value: z.unknown().optional(),
          from: z.string().optional(),
        }),
      ),
    }),
    z.object({
      type: z.literal('text_patch'),
      lineRange: z.object({
        startLine: z.number().int().nonnegative(),
        endLine: z.number().int().positive(),
      }),
      replacement: z.string(),
    }),
  ]),
  expectedHash: z.string().optional(),
});
export type MemoryPatchInput = z.infer<typeof MemoryPatchInputSchema>;

export const MemoryPatchOutputSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  version: z.number().int().positive(),
  contentHash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  embeddingStatus: MemoryEmbeddingStatusSchema,
  links: MemoryWriteLinksReportSchema.optional(),
  properties: MemoryWritePropertiesReportSchema.optional(),
});
export type MemoryPatchOutput = z.infer<typeof MemoryPatchOutputSchema>;

// ============================================================================
// memory.store.delete — soft-delete documents or directories
// ============================================================================

export const MemoryDeleteInputSchema = z.object({
  target: z
    .object({
      id: z.string().uuid().optional(),
      path: z.string().min(1).max(1024).optional(),
    })
    .refine((t) => t.id !== undefined || t.path !== undefined, {
      message: 'Either id or path must be provided',
    })
    .refine((t) => !t.path?.startsWith(MEMORY_VIRTUAL_PREFIX), {
      message:
        'Cannot delete virtual /run/ paths — they are read-only and expire when the run ends.',
    }),
  recursive: z.boolean().default(false),
});
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteInputSchema>;

export const MemoryDeleteOutputSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  deleted: z.boolean(),
  entryType: z.enum(['directory', 'document']),
});
export type MemoryDeleteOutput = z.infer<typeof MemoryDeleteOutputSchema>;

// ============================================================================
// memory.store.mkdir — create directories explicitly
// ============================================================================

export const MemoryMkdirInputSchema = z.object({
  path: z.string().min(1).max(1024),
  description: z.string().max(1024).optional(),
  metadata: z.record(z.unknown()).optional(),

  parents: z.boolean().default(true),
  tags: z.array(z.string().max(128)).max(50).optional(),
});
export type MemoryMkdirInput = z.infer<typeof MemoryMkdirInputSchema>;

export const MemoryMkdirOutputSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  created: z.boolean(),
});
export type MemoryMkdirOutput = z.infer<typeof MemoryMkdirOutputSchema>;

// ============================================================================
// memory.context.* — active-memory register (Plan 251)
// ============================================================================

export const MemoryContextRememberInputSchema = z.object({
  kind: ActiveMemoryKindSchema.describe(
    'fact = a durable truth about this space; convention = how work is done here; working_context = a volatile note that expires (expiresAt required)',
  ),
  statement: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'One single-line sentence carrying the gist (≤512 bytes). Put depth in a memory doc and point to it via detailPath.',
    ),
  detailPath: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Optional absolute memory-doc path (like /notes/topic.md) holding the detail behind this statement.',
    ),
  expiresAt: z
    .string()
    .datetime()
    .optional()
    .describe('When this stops being true (ISO). Required for working_context.'),
});
export type MemoryContextRememberInput = z.infer<typeof MemoryContextRememberInputSchema>;

export const MemoryContextRememberOutputSchema = z.object({
  entryId: z.string(),
  status: ActiveMemoryStatusSchema.describe(
    'Always candidate on a fresh remember — a user must promote the entry before it enters your context.',
  ),
  noop: z.boolean().describe('True when an identical entry already existed.'),
  activeCount: z.number().int(),
  candidateCount: z.number().int(),
  note: z.string().describe('What happened and what (if anything) must happen next.'),
});
export type MemoryContextRememberOutput = z.infer<typeof MemoryContextRememberOutputSchema>;

export const MemoryContextForgetInputSchema = z.object({
  entryId: z.string().min(1),
});
export type MemoryContextForgetInput = z.infer<typeof MemoryContextForgetInputSchema>;

export const MemoryContextForgetOutputSchema = z.object({
  removed: z.boolean().describe('False when no entry with that id existed (idempotent no-op).'),
  activeCount: z.number().int(),
  candidateCount: z.number().int(),
});
export type MemoryContextForgetOutput = z.infer<typeof MemoryContextForgetOutputSchema>;

export const MemoryContextListInputSchema = z.object({});
export type MemoryContextListInput = z.infer<typeof MemoryContextListInputSchema>;

export const MemoryContextListEntrySchema = z.object({
  entryId: z.string().describe('Pass this to memory.context.forget to remove the entry.'),
  kind: ActiveMemoryKindSchema,
  statement: z.string(),
  status: ActiveMemoryStatusSchema.describe(
    'candidate = proposed, not in your context; active = promoted by the user, injected every turn; revoked = kept but not injected.',
  ),
  expired: z.boolean(),
});
export type MemoryContextListEntry = z.infer<typeof MemoryContextListEntrySchema>;

export const MemoryContextListOutputSchema = z.object({
  entries: z.array(MemoryContextListEntrySchema),
});
export type MemoryContextListOutput = z.infer<typeof MemoryContextListOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const MemoryOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'memory',
    group: 'store',
    verb: 'query',
    name: 'Query Memory',
    actionLabel: 'Searching memory…',
    semanticDescription:
      'Search, list, or grep memory documents. Use mode="list" to browse directories and files ' +
      'at a given path (like ls). By default lists immediate children; set recursive=true for all descendants. ' +
      'Use mode="search" for semantic/hybrid retrieval, mode="grep" for exact text search. ' +
      'Always start with list to explore the directory tree before fetching full documents.',
    tags: ['memory', 'storage', 'search', 'list', 'directory'],
    // These four are 85% of this op's emitted schema and none is mentioned in
    // the description above — the shape was already unexplained, it was just
    // expensive. Each keeps a description naming its keys and their types.
    agentCollapsedFields: {
      filters:
        'Narrow the result set. { docType?: string[], tagsAny?: string[], tagsAll?: string[], updatedAfter?: ISO date-time, updatedBefore?: ISO date-time, maxSizeBytes?: number, properties?: Record<string, scalar | scalar[]> (frontmatter match; keys ANDed, array value is any-of) }.',
      budget:
        'Result bounds. { limit?: number (<=200), maxSnippetBytes?: number (<=2048), maxTotalBytes?: number (<=65536), maxLinkedItems?: number (<=50) }.',
      linkFilter:
        'Only with mode="links". { target?: string (edges pointing at this exact path), unresolvedOnly?: boolean (referenced-but-unwritten targets) }.',
      expand:
        'Only with mode="search". { links: 1 (the literal 1 — depth is always 1), direction?: "out" | "both" }.',
    },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List, search, or grep memory documents within a scope.',
      whenToUse: [
        'Browsing the memory directory tree (mode="list")',
        'Semantic search for relevant documents (mode="search")',
        'Finding exact text matches across documents (mode="grep")',
        'Finding notes that reference a doc, or referenced-but-unwritten notes (mode="links", unresolvedOnly)',
      ],
      whenNotToUse: [
        'Need the full content of a known document — use memory.store.get instead',
        'Writing or updating a document — use memory.store.put or memory.store.patch',
      ],
      pitfalls: [
        'mode="search" requires an embedding index — newly-put docs may still be "pending"',
        'Use budget.limit to cap result count and avoid context flooding',
        'mode="links" ignores query — set linkFilter.target to list who references a path, omit it for the hub view (linkFilter.unresolvedOnly surfaces ghost targets); pathPrefix filters the referrer side.',
        'mode="search" with expand.links=1 also returns 1-hop linked neighbors of the top hits — items with `via` came from the link graph, not text similarity; direction defaults to outgoing (the seed\'s own references).',
      ],
      minimalExampleInput: { mode: 'list', pathPrefix: '/' },
    },
    accessMode: 'read',
    inputZod: MemoryQueryInputSchema,
    outputZod: MemoryQueryOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'store',
    verb: 'get',
    name: 'Get Memory Document',
    actionLabel: 'Reading memory…',
    semanticDescription:
      'Retrieve a memory document by path or ID. Use view="stat" for metadata only, ' +
      'view="preview" for a small preview, view="content" for the full body, ' +
      'view="outline" for the SHAPE of a large JSON object (keys/types/sizes — no data). ' +
      'view="links" returns both directions of the graph around one doc (any docType). ' +
      'For JSON, navigate with jsonPath (e.g. "ledgerSummary.recentEntries[3]") and window ' +
      'arrays with itemRange { start, count }. For text, use range reads (lineRange, byteRange). ' +
      'target.version reads an exact past version and target.expectedContentHash verifies the ' +
      'bytes are the ones that were pinned. ' +
      'Works the same over /run/outputs/<toolCallId>/data virtual paths.',
    tags: ['memory', 'storage', 'read'],
    // `target` and the three range readers are 79% of this op's schema. The
    // description above already names their keys, so collapsing them removes
    // nesting the model was never told to read, not information.
    agentCollapsedFields: {
      target:
        'Which document, and optionally which version. { path?: string, id?: string, version?: number (an exact past version — immutable), expectedContentHash?: string (the read fails if the bytes changed) }.',
      lineRange: 'Text window. { startLine: number, endLine: number }.',
      byteRange:
        'Character window — UTF-16 code units, NOT bytes, despite the field name (kept for compatibility). { start: number, end: number }.',
      itemRange: 'JSON array window. { start: number, count: number (max 200) }.',
    },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Retrieve a memory document by path or ID — content, range reads, or structural (JSON) navigation.',
      whenToUse: [
        'Reading the content of a specific known document',
        'Checking metadata/stat of a document before deciding to read it',
        'Exploring a large JSON object: view="outline" to see its shape, then jsonPath + itemRange to read one section',
        'Re-reading the exact bytes a reference was pinned to: target.version (+ target.expectedContentHash to verify)',
      ],
      whenNotToUse: [
        'Browsing or searching across multiple documents — use memory.store.query',
        'Need to write or update content — use memory.store.put or memory.store.patch',
      ],
      pitfalls: [
        'For large data files (CSVs, datasets): do NOT read content into context. Use inputPaths on compute.sandbox.exec to load files directly.',
        'Default view is "stat" (metadata only) — set view="content" to get the body',
        'Reads are bounded (about 15K chars by default) — use lineRange or byteRange for targeted reads',
        "To continue a bounded read, re-read the SAME path with the next window from the returned range metadata (lineRange from range.endLine, byteRange from range.end, itemRange from range.start + range.count) — never read this call's own output path",
        'For large JSON, do NOT shell out to compute to slice it — use view="outline" then jsonPath + itemRange to read just the section you need',
        'jsonPath is a small dotted/bracket subset (a.b[3].c), not full JSONPath — it drills, it does not query/filter',
        'To pipe a large body onward without reading it, use inputPaths (compute) or memory.store.put(content: {fromPath}) with the source path',
        'content view includes up to 10 backlinks (with the true total) — notes that reference this one; follow them for related context.',
        'Without target.version a read follows the document — a later write changes what you get back. Pin the version you were given if the bytes must not move.',
        'target.version and target.expectedContentHash apply to stored documents only, not to /run/outputs virtual paths.',
      ],
      minimalExampleInput: { target: { path: '/notes/meeting.md' }, view: 'content' },
    },
    accessMode: 'read',
    inputZod: MemoryGetInputSchema,
    outputZod: MemoryGetOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'run_output',
    verb: 'get',
    name: 'Read Run Output',
    actionLabel: 'Reading run output…',
    semanticDescription:
      'Re-read a tool result from this run by its /run/outputs/<toolCallId>/data path — the ' +
      'read-back for cleared or truncated tool outputs. Use view="outline" for the SHAPE of a ' +
      'large JSON result (keys/types/sizes), view="content" for the body. For JSON, navigate ' +
      'with jsonPath and window arrays with itemRange { start, count }; for text, use lineRange ' +
      "or byteRange. Reads this run's outputs only — general memory documents need memory.store.get.",
    tags: ['memory', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: "Re-read one of this run's tool outputs by its /run/outputs/<toolCallId> path.",
      whenToUse: [
        'A conversation note points at /run/outputs/<toolCallId>/data for a cleared tool result',
        'A tool result was truncated and you need a specific section of the full output',
      ],
      whenNotToUse: [
        'Reading a general memory document — use memory.store.get',
        'Re-running the tool would be cheaper than re-reading a small output you already saw',
      ],
      pitfalls: [
        'Do NOT re-run a non-idempotent tool to recover its output — re-read it here instead',
        'For large JSON, view="outline" first, then jsonPath + itemRange to read just the section you need',
        "To continue a bounded read, call again with the SAME path and the next window from the returned range metadata (lineRange from range.endLine, byteRange from range.end, itemRange from range.start + range.count) — never read the read call's own output path",
      ],
      minimalExampleInput: { path: '/run/outputs/abc123_0/data', view: 'outline' },
    },
    accessMode: 'read',
    inputZod: MemoryRunOutputGetInputSchema,
    outputZod: MemoryGetOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'store',
    verb: 'put',
    name: 'Put Memory Document',
    actionLabel: 'Saving to memory…',
    semanticDescription:
      'Save a document to memory, to persist it across runs (long-term storage). ' +
      'For passing data between steps within a run, use inputPaths instead — no memory write needed. ' +
      'Wikilinks ([[/path/doc.md]]) in markdown/text content are indexed automatically; ' +
      'YAML frontmatter becomes queryable properties.',
    tags: ['memory', 'storage', 'write'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Create or upsert a memory document at a stable path.',
      whenToUse: [
        'Storing a new document (notes, reports, data) in memory',
        'Updating an existing document with a full replacement',
        'Storing scripts for iterative compute execution via codePath (use docType="code")',
      ],
      whenNotToUse: [
        'Passing data between steps within a run — use inputPaths to pipe directly, no memory write needed',
        'Making a small edit to an existing document — use memory.store.patch instead',
        'Need to read first — use memory.store.get',
      ],
      pitfalls: [
        'To save step output: content: {fromPath: "/run/outputs/<toolCallId>/data"} copies the output to memory. The toolCallId is shown in the step result.',
        'Memory is persistent storage (survives across runs). For within-run data piping, use inputPaths on compute.sandbox.exec.',
        'writeMode="create" fails if the path already exists',
        "The output reports ghost links — targets that don't exist yet. A ghost is not an error: write the target later or fix the path.",
        'An extensionless link target means the .md path: [[/notes/foo]] links to /notes/foo.md.',
        'Frontmatter keys land in properties (filterable via filters.properties) — they do not set the tags/summary fields; pass those as op inputs.',
      ],
      minimalExampleInput: {
        path: '/reports/analysis.md',
        docType: 'markdown',
        content: { fromPath: '/run/outputs/<toolCallId>/data' },
      },
    },
    accessMode: 'write',
    inputZod: MemoryPutInputSchema,
    outputZod: MemoryPutOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'store',
    verb: 'patch',
    name: 'Patch Memory Document',
    actionLabel: 'Updating memory…',
    semanticDescription:
      'Partially update a memory document without rewriting the whole body. ' +
      'Supports json_patch (RFC 6902) for JSON docs and text_patch (line-range replacement) ' +
      'for text/markdown. Creates a new version preserving history.',
    tags: ['memory', 'storage', 'write', 'patch'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Partially update a memory document via JSON Patch or line-range replacement.',
      whenToUse: [
        'Making targeted edits to a JSON document (add/remove/replace fields)',
        'Replacing specific lines in a text or markdown document',
        'Editing stored scripts — patch specific functions instead of rewriting the entire file',
      ],
      whenNotToUse: [
        'Replacing the entire document content — use memory.store.put instead',
        'Document does not exist yet — use memory.store.put to create it first',
      ],
      pitfalls: [
        'Replaying a patch is not safe — it may apply the change twice',
        'Use expectedHash for conflict detection when concurrent edits are possible',
        'Links and properties re-derive from the patched content — removing a wikilink from the text removes it from the index.',
      ],
      minimalExampleInput: {
        target: { path: '/config/settings.json' },
        patch: {
          type: 'json_patch' as const,
          operations: [{ op: 'replace' as const, path: '/theme', value: 'dark' }],
        },
      },
    },
    accessMode: 'write',
    inputZod: MemoryPatchInputSchema,
    outputZod: MemoryPatchOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'store',
    verb: 'delete',
    name: 'Delete Memory Entry',
    actionLabel: 'Deleting from memory…',
    semanticDescription:
      'Delete a memory document or directory by path or ID. ' +
      'For directories, use recursive=true to delete all contents. ' +
      'Non-empty directories fail by default to prevent accidental data loss.',
    tags: ['memory', 'storage', 'delete'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete a memory document or directory by path or ID.',
      whenToUse: [
        'Removing outdated or obsolete documents',
        'Cleaning up temporary artifacts after a flow completes',
      ],
      whenNotToUse: [
        'Updating content — use memory.store.put or memory.store.patch instead',
        'Need to verify content before deleting — use memory.store.get first',
      ],
      pitfalls: [
        'Non-empty directories require recursive=true or the call will fail',
        'Delete is soft-delete — data may be recoverable depending on retention policy',
      ],
      minimalExampleInput: { target: { path: '/temp/scratch.txt' } },
    },
    accessMode: 'write',
    inputZod: MemoryDeleteInputSchema,
    outputZod: MemoryDeleteOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'store',
    verb: 'mkdir',
    name: 'Create Memory Directory',
    actionLabel: 'Creating directory…',
    semanticDescription:
      'Create a directory in the memory filesystem. Use to organize documents into ' +
      'a browsable hierarchy. Parent directories are created automatically (mkdir -p). ' +
      'Optionally set a description and metadata for the directory.',
    tags: ['memory', 'storage', 'directory', 'write'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Create a directory in the memory filesystem (mkdir -p semantics).',
      whenToUse: [
        'Organizing documents into a structured hierarchy before writing',
        'Creating a namespace or workspace directory for a flow or user',
      ],
      whenNotToUse: [
        'memory.store.put already creates parent directories implicitly — only use mkdir for empty dirs or adding metadata',
      ],
      pitfalls: ['If the directory already exists, the call succeeds with created=false'],
      minimalExampleInput: { path: '/projects/my-project' },
    },
    accessMode: 'write',
    inputZod: MemoryMkdirInputSchema,
    outputZod: MemoryMkdirOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'context',
    verb: 'remember',
    name: 'Remember Standing Note',
    actionLabel: 'Recording standing note…',
    semanticDescription:
      'Record a durable single-line statement (fact, convention, or expiring working context) as a CANDIDATE ' +
      "in the space's active-memory register. Candidates are not applied to your context — a user must promote " +
      'an entry before it becomes a standing reference note you see every turn. Available only in a space with no other members.',
    tags: ['memory', 'context', 'register', 'write'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Propose a standing reference note (candidate) for this solo space.',
      whenToUse: [
        'The user states a durable fact or convention worth carrying into future sessions',
        'You infer something stable about how this space works that future turns should know',
        'A volatile-but-useful note should survive the session (working_context with expiresAt)',
      ],
      whenNotToUse: [
        'Rich or multi-line content — write a memory doc via memory.store.put and reference it via detailPath',
        'Anything needed only within the current conversation — it is already in your history',
        'Hard rules or approvals — those belong to directives and guardrails, never memory',
      ],
      pitfalls: [
        'The entry is a candidate until a user promotes it — do not assume it will appear in your context',
        'Statements are single-line and ≤512 bytes; control characters are rejected',
        'working_context requires expiresAt; expired entries silently stop being listed',
        'Re-remembering an identical (kind, statement) is a no-op, not a duplicate',
      ],
      minimalExampleInput: {
        kind: 'convention',
        statement: 'Weekly summaries are for a non-expert audience.',
      },
    },
    accessMode: 'write',
    inputZod: MemoryContextRememberInputSchema,
    outputZod: MemoryContextRememberOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'context',
    verb: 'forget',
    name: 'Forget Standing Note',
    actionLabel: 'Removing standing note…',
    semanticDescription:
      "Remove any entry from the space's active-memory register by id — this is your own working " +
      'memory, so forget freely when a note is stale, wrong, or superseded. Permanent, non-removable ' +
      'rules live in directives, not here. Get the entryId from memory.context.list first — your ' +
      'injected standing notes do not carry ids.',
    tags: ['memory', 'context', 'register', 'write'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Remove a standing reference note you no longer want to hold.',
      whenToUse: [
        'A standing note in your context is stale, wrong, confusing, or contradicted by newer information',
        'Pruning candidates that were never worth promoting',
      ],
      whenNotToUse: [
        'Enforcing a hard, permanent rule — that belongs to directives/guardrails, which you cannot remove',
      ],
      pitfalls: [
        'You need the entryId — call memory.context.list to get it; the notes injected into your context do not show ids',
        'Forgetting an unknown id succeeds with removed=false (idempotent)',
      ],
      minimalExampleInput: { entryId: 'entry-id' },
    },
    accessMode: 'write',
    inputZod: MemoryContextForgetInputSchema,
    outputZod: MemoryContextForgetOutputSchema,
  },
  {
    stepType: 'memory',
    group: 'context',
    verb: 'list',
    name: 'List Standing Notes',
    actionLabel: 'Reading standing notes…',
    semanticDescription:
      "List every entry in the space's active-memory register with its entryId, kind, statement, and " +
      'status (candidate / active / revoked). Use this to see your candidates awaiting the user, to ' +
      'review what is active, and — crucially — to get the entryId you need to forget an entry.',
    tags: ['memory', 'context', 'register', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'See all your standing notes and their ids.',
      whenToUse: [
        'You want to forget a note — list first to get its entryId (injected notes carry no id)',
        'Checking whether a candidate you proposed is still pending or was promoted',
        'Reviewing everything you currently hold before adding more',
      ],
      whenNotToUse: [
        'You only need the active notes you already keep in mind — those are injected every turn',
      ],
      pitfalls: ['Returns [] in a multi-member space — the register is single-owner only'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: MemoryContextListInputSchema,
    outputZod: MemoryContextListOutputSchema,
  },
];
