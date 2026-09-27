/**
 * Utilities for memory embedding operations.
 * Text normalization and hashing for embedding idempotency.
 */
import { createHash } from 'node:crypto';

// ============================================================================
// Text Normalization
// ============================================================================

/**
 * Normalize text for embedding.
 * Creates a stable, canonical representation for hashing and embedding.
 *
 * Rules:
 * - Normalize newlines to \n
 * - Trim trailing whitespace
 * - NFC unicode normalization (optional but recommended)
 */
export function normalizeTextForEmbedding(text: string): string {
  // Normalize newlines (CRLF -> LF, CR -> LF)
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Trim trailing whitespace from each line
  normalized = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

  // Trim overall leading/trailing whitespace
  normalized = normalized.trim();

  // Optional: NFC unicode normalization (keeps compatibility but normalizes variants)
  // This is safe to enable if you expect mixed unicode inputs
  // normalized = normalized.normalize("NFC");

  return normalized;
}

// ============================================================================
// Content Hashing
// ============================================================================

/**
 * Compute SHA256 hash of normalized text.
 * Used for embedding idempotency checks.
 */
export function hashContent(text: string): string {
  const normalized = normalizeTextForEmbedding(text);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Extract text content from a memory entry for embedding.
 * Handles both inline values and contentRef payloads.
 */
export function extractTextForEmbedding(entry: {
  value: unknown;
  contentType?: string | null;
  contentRef?: string | null;
}): string {
  // If contentRef is present, caller should fetch it separately
  // This function handles inline content only
  if (entry.contentRef) {
    throw new Error('ContentRef must be fetched separately before calling extractTextForEmbedding');
  }

  // Extract text based on content type
  const contentType = entry.contentType?.toLowerCase() ?? '';

  if (contentType.includes('json')) {
    // For JSON, stringify it
    return JSON.stringify(entry.value);
  } else if (typeof entry.value === 'string') {
    // Plain text or markdown
    return entry.value;
  } else {
    // Fallback: stringify any other type
    return String(entry.value);
  }
}
