import { applyJsonPointer, isResolutionError } from '@aflow/input-resolution';
import { detectOutputFields } from './detectOutputFields.js';
import { isVirtualPath, parseOutputPath, RUN_OUTPUTS_PREFIX } from './parser.js';
import { normalizeToolOutputEntry } from './types.js';
import type { PathResolveResult, PathListEntry, PathResolveContext } from './types.js';

// ============================================================================
// Errors
// ============================================================================

export class MemoryPathError extends Error {
  constructor(
    message: string,
    public readonly code:
      'NOT_FOUND' | 'READ_ONLY' | 'PAYLOAD_EXPIRED' | 'INVALID_PATH' | 'SPACE_MISMATCH',
  ) {
    super(message);
    this.name = 'MemoryPathError';
  }
}

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Resolve any memory path to its content.
 *
 * - Virtual paths (/run/outputs/...) → read from _tool_outputs index + PayloadStore
 * - Persistent paths → read from Postgres memory_docs + PayloadStore
 */
export async function resolveMemoryPath(
  path: string,
  ctx: PathResolveContext,
): Promise<PathResolveResult> {
  if (isVirtualPath(path)) {
    return resolveVirtualPath(path, ctx);
  }
  return resolvePersistentPath(path, ctx);
}

/**
 * List entries under a path prefix.
 *
 * - /run/outputs/ → list from enriched _tool_outputs index
 * - Other prefixes → delegate to memory doc listing (not handled here; callers
 *   should use the existing repo.list / dirRepo.listDir for persistent paths)
 */
export async function listVirtualOutputs(ctx: PathResolveContext): Promise<PathListEntry[]> {
  const index = await ctx.toolOutputIndexReader.readToolOutputIndex(ctx.tenantId, ctx.runId);
  if (!index) return [];

  const entries: PathListEntry[] = [];
  for (const [toolCallId, rawEntry] of Object.entries(index)) {
    const entry = normalizeToolOutputEntry(rawEntry, toolCallId);
    entries.push({
      path: `${RUN_OUTPUTS_PREFIX}${toolCallId}`,
      name: toolCallId,
      sizeBytes: 0, // Size not tracked in index
      entryType: 'directory',
      metadata: {
        operation: entry.operation,
        stepId: entry.stepId,
        fields: entry.fields,
      },
    });
  }

  return entries;
}

// ============================================================================
// Internal: virtual path resolution
// ============================================================================

async function resolveVirtualPath(
  path: string,
  ctx: PathResolveContext,
): Promise<PathResolveResult> {
  const parsed = parseOutputPath(path);
  if (!parsed) {
    throw new MemoryPathError(
      `Invalid virtual path: ${path}. Expected format: /run/outputs/<toolCallId>/<field>`,
      'INVALID_PATH',
    );
  }

  const index = await ctx.toolOutputIndexReader.readToolOutputIndex(ctx.tenantId, ctx.runId);
  if (!index) {
    throw new MemoryPathError(
      `Virtual path not found: ${path} (no tool outputs in this run)`,
      'NOT_FOUND',
    );
  }

  const rawEntry = index[parsed.toolCallId];
  if (!rawEntry) {
    throw new MemoryPathError(
      `Virtual path not found: ${path} (toolCallId '${parsed.toolCallId}' not in output index)`,
      'NOT_FOUND',
    );
  }

  const entry = normalizeToolOutputEntry(rawEntry, parsed.toolCallId);

  // Retrieve the full output from PayloadStore
  let output: unknown;
  try {
    output = await ctx.payloadStore.retrieve(entry.ref);
  } catch (error) {
    // The reason, not a guess at it. Reported as expiry alone this sent an
    // agent into a retry loop: the message said the payload had aged out, the
    // error said retry, and the real cause — a writer on a backend this reader
    // could not reach — would never change however many times it asked.
    throw new MemoryPathError(
      `Failed to retrieve virtual path ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The output may have expired, or been written by a backend this reader cannot reach.',
      'PAYLOAD_EXPIRED',
    );
  }

  // The `data` field of an API-shaped output carries the upstream body — its
  // declared content type (parsedMeta.contentType) is the honest MIME for a
  // /data read, so a reader sees e.g. application/atom+xml instead of the
  // octet-stream fallback. Other fields keep the existing fallback.
  const dataMimeType =
    parsed.fieldPointer === '/data' ? extractDeclaredContentType(output) : undefined;

  // Apply field pointer if present.
  if (parsed.fieldPointer) {
    const label = `output.${parsed.toolCallId}`;
    let content = await applyJsonPointer(output, parsed.fieldPointer, label, ctx.payloadStore);
    // Fallback: agents often reference outputFiles by filename directly
    // (e.g., /run/outputs/<id>/train.csv instead of /run/outputs/<id>/outputFiles/train.csv).
    // Try the outputFiles/ prefix if direct lookup fails.
    if (isResolutionError(content) && !parsed.fieldPointer.startsWith('/outputFiles/')) {
      content = await applyJsonPointer(
        output,
        '/outputFiles' + parsed.fieldPointer,
        label,
        ctx.payloadStore,
      );
    }
    if (isResolutionError(content)) {
      const available = detectOutputFields(output);
      const availableHint =
        available.length > 0 ? ` Available fields: ${available.join(', ')}.` : '';
      const rootHint = ` The full output is readable at /run/outputs/${parsed.toolCallId}.`;
      throw new MemoryPathError(
        `Virtual path not found: ${path} (field '${parsed.fieldPointer}' not in output).${availableHint}${rootHint}`,
        'NOT_FOUND',
      );
    }
    const str = stringify(content);
    return {
      content: str,
      sizeBytes: Buffer.byteLength(str, 'utf-8'),
      ...(dataMimeType !== undefined ? { mimeType: dataMimeType } : {}),
      sourceType: 'runOutput',
    };
  }

  // No field pointer — return the full output
  const str = stringify(output);
  return {
    content: str,
    sizeBytes: Buffer.byteLength(str, 'utf-8'),
    sourceType: 'runOutput',
  };
}

/**
 * Read `parsedMeta.contentType` from an API-shaped step output, stripped of
 * parameters (`; charset=...`).
 */
function extractDeclaredContentType(output: unknown): string | undefined {
  if (output == null || typeof output !== 'object') return undefined;
  const parsedMeta = (output as Record<string, unknown>)['parsedMeta'];
  if (parsedMeta == null || typeof parsedMeta !== 'object') return undefined;
  const contentType = (parsedMeta as Record<string, unknown>)['contentType'];
  if (typeof contentType !== 'string' || contentType === '') return undefined;
  const bare = contentType.split(';')[0]?.trim();
  return bare !== undefined && bare !== '' ? bare : undefined;
}

// ============================================================================
// Internal: persistent path resolution
// ============================================================================

async function resolvePersistentPath(
  path: string,
  ctx: PathResolveContext,
): Promise<PathResolveResult> {
  const doc = await ctx.memoryDocReader.getByPath(path, ctx.spaceId);
  if (!doc) {
    throw new MemoryPathError(`Memory document not found: ${path}`, 'NOT_FOUND');
  }

  // Resolve content: inline first, then PayloadStore
  if (doc.inlineContent !== null) {
    return {
      content: doc.inlineContent,
      sizeBytes: doc.sizeBytes,
      mimeType: doc.mimeType,
      sourceType: 'memoryDoc',
    };
  }

  if (doc.payloadRef) {
    let payload: unknown;
    try {
      payload = await ctx.payloadStore.retrieve(doc.payloadRef);
    } catch {
      throw new MemoryPathError(
        `Content for ${path} has expired from payload store. Re-upload via memory.store.put.`,
        'PAYLOAD_EXPIRED',
      );
    }
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      content,
      sizeBytes: doc.sizeBytes,
      mimeType: doc.mimeType,
      sourceType: 'memoryDoc',
    };
  }

  throw new MemoryPathError(`Memory document at ${path} has no content`, 'NOT_FOUND');
}

// ============================================================================
// Helpers
// ============================================================================

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}
