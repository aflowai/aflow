/**
 * Deterministic text chunker for memory v2 documents.
 *
 * Produces stable, citeable chunks with byte offsets.
 * - Text/Markdown: paragraph-based (double-newline split)
 * - JSON: stringified and paragraph-chunked
 * - Dataset/CSV: header chunk (embeddable) + row batch chunks (FTS-only)
 *
 * Target chunk size: 800-1200 tokens (~3200-4800 chars).
 * Hard cap: 6000 chars per chunk.
 */

export interface ContentChunk {
  chunkIndex: number;
  text: string;
  startOffset: number;
  endOffset: number;
  /** When true, the embedder should skip vector embedding for this chunk (FTS-only). */
  skipEmbedding?: boolean;
}

/** Summary metadata produced by the CSV chunker for dataset documents. */
export interface CsvChunkMeta {
  columns: string[];
  rowCount: number;
  sampleRows: string[][];
}

const TARGET_CHARS = 4000;
const HARD_CAP_CHARS = 6000;
const MIN_CHUNK_CHARS = 100;

/** Number of rows to batch per FTS-only chunk for CSV data. */
const CSV_ROW_BATCH_SIZE = 50;

/** Binary doc types that should never be chunked or embedded. */
const BINARY_DOC_TYPES = new Set(['image', 'audio', 'video']);

/**
 * Check if a doc type is binary (image/audio/video).
 * Binary docs should have embedding disabled entirely.
 */
export function isBinaryDocType(docType: string): boolean {
  return BINARY_DOC_TYPES.has(docType);
}

/**
 * Chunk text content into paragraph-based segments.
 */
export function chunkText(content: string): ContentChunk[] {
  if (content.length <= TARGET_CHARS) {
    return [{ chunkIndex: 0, text: content, startOffset: 0, endOffset: content.length }];
  }

  const paragraphs = splitParagraphs(content);
  const chunks: ContentChunk[] = [];
  let currentText = '';
  let currentStart = 0;
  let offset = 0;

  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length > TARGET_CHARS) {
      chunks.push({
        chunkIndex: chunks.length,
        text: currentText,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
      currentStart = offset;
      currentText = '';
    }

    currentText += para;
    offset += para.length;

    if (currentText.length >= HARD_CAP_CHARS) {
      chunks.push({
        chunkIndex: chunks.length,
        text: currentText,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
      currentStart = offset;
      currentText = '';
    }
  }

  if (currentText.length > 0) {
    if (currentText.length < MIN_CHUNK_CHARS && chunks.length > 0) {
      const last = chunks[chunks.length - 1]!;
      last.text += currentText;
      last.endOffset = currentStart + currentText.length;
    } else {
      chunks.push({
        chunkIndex: chunks.length,
        text: currentText,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
    }
  }

  return chunks;
}

/**
 * Chunk JSON content by walking the object tree and emitting chunks
 * with JSONPath-like prefixes to preserve structure context.
 *
 * Strategy:
 * - Walk the tree depth-first
 * - For each leaf value or small sub-tree, emit: "$.path.to.key: <value>"
 * - Accumulate into chunks up to TARGET_CHARS, flush when full
 * - Large arrays emit per-element chunks: "$.items[3]: {...}"
 * - Primitive leaves, base64/binary-looking strings are skipped
 */
export function chunkJson(content: unknown): ContentChunk[] {
  let parsed: unknown;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return chunkText(content);
    }
  } else {
    parsed = content;
  }

  if (parsed === null || typeof parsed !== 'object') {
    const text = JSON.stringify(parsed, null, 2);
    return chunkText(text);
  }

  const fragments: string[] = [];
  walkJson(parsed, '$', fragments);

  if (fragments.length === 0) {
    const fallback = JSON.stringify(parsed, null, 2);
    return chunkText(fallback);
  }

  // Pack fragments into chunks respecting TARGET_CHARS
  const chunks: ContentChunk[] = [];
  let currentText = '';
  let byteOffset = 0;
  let currentStart = 0;

  for (const frag of fragments) {
    if (currentText.length > 0 && currentText.length + frag.length + 1 > TARGET_CHARS) {
      chunks.push({
        chunkIndex: chunks.length,
        text: currentText,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
      currentStart = byteOffset;
      currentText = '';
    }

    if (currentText.length > 0) currentText += '\n';
    currentText += frag;
    byteOffset += frag.length + 1;

    if (currentText.length >= HARD_CAP_CHARS) {
      chunks.push({
        chunkIndex: chunks.length,
        text: currentText,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
      currentStart = byteOffset;
      currentText = '';
    }
  }

  if (currentText.length > 0) {
    if (currentText.length < MIN_CHUNK_CHARS && chunks.length > 0) {
      const last = chunks[chunks.length - 1]!;
      last.text += '\n' + currentText;
      last.endOffset = currentStart + currentText.length;
    } else {
      chunks.push({
        chunkIndex: chunks.length,
        text: currentText,
        startOffset: currentStart,
        endOffset: currentStart + currentText.length,
      });
    }
  }

  return chunks;
}

const SMALL_SUBTREE_CHARS = 500;
const SKIP_VALUE_PATTERN = /^(?:data:|[A-Za-z0-9+/]{100,}={0,2}$)/;

function walkJson(value: unknown, path: string, out: string[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    if (SKIP_VALUE_PATTERN.test(value)) return;
    if (value.length <= SMALL_SUBTREE_CHARS) {
      out.push(`${path}: ${JSON.stringify(value)}`);
    } else {
      // Long string — emit with truncation marker + full content
      out.push(`${path}: ${value}`);
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(`${path}: ${String(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return;

    // Check if the whole array is small enough to emit as one fragment
    const serialized = JSON.stringify(value, null, 2);
    if (serialized.length <= SMALL_SUBTREE_CHARS) {
      out.push(`${path}: ${serialized}`);
      return;
    }

    for (let i = 0; i < value.length; i++) {
      walkJson(value[i], `${path}[${String(i)}]`, out);
    }
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return;

    // Check if the whole object is small enough to emit as one fragment
    const serialized = JSON.stringify(obj, null, 2);
    if (serialized.length <= SMALL_SUBTREE_CHARS) {
      out.push(`${path}: ${serialized}`);
      return;
    }

    for (const key of keys) {
      const childPath = /^[a-zA-Z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}["${key}"]`;
      walkJson(obj[key], childPath, out);
    }
  }
}

// ============================================================================

/**
 * Parse a simple CSV line respecting quoted fields.
 * Returns an array of field values with surrounding quotes stripped.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        const next = i + 1 < line.length ? line[i + 1] : undefined;
        if (next === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Chunk CSV/dataset content into a header chunk (for embedding) and
 * batched row chunks (FTS-only, skipEmbedding: true).
 *
 * Returns the chunks plus summary metadata (column names, row count, samples).
 */
export function chunkCsv(content: string): { chunks: ContentChunk[]; meta: CsvChunkMeta } {
  const lines = content.split('\n');
  const headerLine = lines[0];
  if (!headerLine || headerLine.trim().length === 0) {
    // No header — fall back to text chunking (all embeddable)
    return { chunks: chunkText(content), meta: { columns: [], rowCount: 0, sampleRows: [] } };
  }

  const columns = parseCsvLine(headerLine);
  const dataLines = lines.slice(1).filter((l) => l.trim().length > 0);

  // Collect sample rows (first 3)
  const sampleRows: string[][] = [];
  for (let i = 0; i < Math.min(3, dataLines.length); i++) {
    const line = dataLines[i];
    if (line !== undefined) {
      sampleRows.push(parseCsvLine(line));
    }
  }

  const chunks: ContentChunk[] = [];

  // Build header chunk text with summary metadata
  const summaryParts = [`Columns: ${columns.join(', ')}`, `Rows: ${String(dataLines.length)}`];
  if (sampleRows.length > 0) {
    summaryParts.push('Sample data:');
    for (const row of sampleRows) {
      const pairs = columns
        .map((col, idx) => {
          const val = idx < row.length ? row[idx] : '';
          return `${col}=${val ?? ''}`;
        })
        .join(', ');
      summaryParts.push(`  ${pairs}`);
    }
  }
  const headerText = summaryParts.join('\n');

  chunks.push({
    chunkIndex: 0,
    text: headerText,
    startOffset: 0,
    endOffset: headerLine.length,
    // Header chunk IS embeddable (no skipEmbedding flag)
  });

  // Batch data rows into FTS-only chunks
  let batchStart = 0;
  const headerBytes = headerLine.length + 1; // +1 for newline

  for (let i = 0; i < dataLines.length; i += CSV_ROW_BATCH_SIZE) {
    const batchLines = dataLines.slice(i, i + CSV_ROW_BATCH_SIZE);
    const batchText = batchLines.join('\n');

    // Compute approximate byte offsets into the original content
    const startOffset = headerBytes + batchStart;
    const endOffset = startOffset + batchText.length;

    chunks.push({
      chunkIndex: chunks.length,
      text: batchText,
      startOffset,
      endOffset,
      skipEmbedding: true,
    });

    // Track offset for next batch (each line + newline separator)
    for (const line of batchLines) {
      batchStart += line.length + 1;
    }
  }

  const meta: CsvChunkMeta = {
    columns,
    rowCount: dataLines.length,
    sampleRows,
  };

  return { chunks, meta };
}

// ============================================================================

/**
 * Conservative token estimate: ~3 chars per token.
 * OpenAI text-embedding-3-* has an 8192 token limit.
 * We split at ~7000 estimated tokens (21000 chars) to leave margin.
 */
const MAX_EMBED_CHARS = 21_000;

/**
 * Split a text into sub-chunks if it exceeds the token-safe limit.
 * Returns the original text in an array if within limits.
 */
export function splitForTokenSafety(text: string): string[] {
  if (text.length <= MAX_EMBED_CHARS) {
    return [text];
  }

  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    // Try to split at a newline near the boundary for cleaner chunks
    let end = offset + MAX_EMBED_CHARS;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > offset + MAX_EMBED_CHARS / 2) {
        end = lastNewline + 1;
      }
    } else {
      end = text.length;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

/**
 * Dispatch chunking based on doc type.
 */
export function chunkContent(content: string, docType: string): ContentChunk[] {
  if (docType === 'json' || docType === 'ndjson') {
    return chunkJson(content);
  }
  if (docType === 'dataset') {
    return chunkCsv(content).chunks;
  }
  return chunkText(content);
}

function splitParagraphs(text: string): string[] {
  const parts = text.split(/(\n\s*\n)/);
  const result: string[] = [];

  for (const part of parts) {
    if (part !== undefined) {
      result.push(part);
    }
  }

  return result;
}
