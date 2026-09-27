// ============================================================================
// Resolver result types
// ============================================================================

export interface PathResolveResult {
  /** The resolved content as a string */
  content: string;
  /** Size of the content in bytes */
  sizeBytes: number;
  /** Optional MIME type */
  mimeType?: string;
  /** Where the content was resolved from */
  sourceType: 'memoryDoc' | 'runOutput';
}

export interface PathListEntry {
  /** Full virtual path */
  path: string;
  /** Display name (filename or toolCallId) */
  name: string;
  /** Size in bytes (0 for directories) */
  sizeBytes: number;
  /** Entry type */
  entryType: 'file' | 'directory';
  /** Source-specific metadata */
  metadata?: {
    /** For run outputs: the operation that produced this output */
    operation?: string;
    /** For run outputs: the step ID */
    stepId?: string;
    /** For run outputs: available sub-fields (e.g., ['data', 'body', 'files/submission.csv']) */
    fields?: string[];
  };
}

// ============================================================================

/**
 * Legacy format: just a PayloadRef string.
 * New format: enriched entry with metadata for listing.
 */
export interface ToolOutputEntry {
  /** PayloadStore reference for the full output */
  ref: string;
  /** Human-readable step label */
  stepId: string;
  /** Operation ID (e.g., 'api.http.call') */
  operation: string;
  /** Available field names for virtual path access */
  fields: string[];
}

/** The _tool_outputs index can contain both legacy strings and enriched entries */
export type ToolOutputIndex = Record<string, string | ToolOutputEntry>;

/**
 * Normalize a tool output index entry to the enriched format.
 * Handles both legacy (plain PayloadRef string) and new (enriched object) entries.
 */
export function normalizeToolOutputEntry(
  entry: string | ToolOutputEntry,
  toolCallId: string,
): ToolOutputEntry {
  if (typeof entry === 'string') {
    // Legacy format: just a PayloadRef
    return {
      ref: entry,
      stepId: toolCallId,
      operation: 'unknown',
      fields: [],
    };
  }
  return entry;
}

// ============================================================================
// Context interfaces — consumers provide these
// ============================================================================

/**
 * Minimal interface for retrieving payloads.
 * Same as PayloadRetriever in @aflow/input-resolution.
 */
export interface PayloadRetriever {
  retrieve(ref: string): Promise<unknown>;
}

/**
 * Minimal interface for reading a memory document by path.
 * Matches the subset of MemoryDocRepository used by the resolver.
 */
export interface MemoryDocReader {
  getByPath(path: string, spaceId: string): Promise<MemoryDocRecord | null>;
}

/**
 * Minimal memory document record — fields the resolver needs.
 */
export interface MemoryDocRecord {
  id: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  inlineContent: string | null;
  payloadRef: string | null;
  spaceId: string | null;
}

/**
 * Minimal interface for reading the _tool_outputs index from Redis hot state.
 */
export interface ToolOutputIndexReader {
  readToolOutputIndex(tenantId: string, runId: string): Promise<ToolOutputIndex | null>;
}

/**
 * Context for path resolution — provided by the caller.
 */
export interface PathResolveContext {
  tenantId: string;
  runId: string;
  spaceId: string;
  payloadStore: PayloadRetriever;
  memoryDocReader: MemoryDocReader;
  toolOutputIndexReader: ToolOutputIndexReader;
}
