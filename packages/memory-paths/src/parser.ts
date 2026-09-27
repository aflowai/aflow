/** Prefix for all virtual run-scoped paths */
export const RUN_PREFIX = '/run/';
export const RUN_OUTPUTS_PREFIX = '/run/outputs/';

/**
 * Check if a path is a virtual run-scoped path (read-only).
 */
export function isVirtualPath(path: string): boolean {
  return path.startsWith(RUN_PREFIX);
}

/**
 * Check if a path is writable (all non-virtual paths are writable).
 */
export function isWritablePath(path: string): boolean {
  return !path.startsWith(RUN_PREFIX);
}

/**
 * Parsed virtual output path.
 */
export interface ParsedOutputPath {
  toolCallId: string;
  /** JSON Pointer-style field path (e.g., '/data', '/body', '/files/submission.csv') */
  fieldPointer?: string;
}

/**
 * Parse a /run/outputs/ path into its components.
 *
 * Returns null if the path doesn't match the expected format.
 *
 * Examples:
 *   '/run/outputs/call_abc' → { toolCallId: 'call_abc' }
 *   '/run/outputs/call_abc/data' → { toolCallId: 'call_abc', fieldPointer: '/data' }
 *   '/run/outputs/call_abc/files/name.csv' → { toolCallId: 'call_abc', fieldPointer: '/files/name.csv' }
 */
export function parseOutputPath(path: string): ParsedOutputPath | null {
  if (!path.startsWith(RUN_OUTPUTS_PREFIX)) return null;

  const rest = path.slice(RUN_OUTPUTS_PREFIX.length);
  if (rest.length === 0) return null; // Just '/run/outputs/' — no toolCallId

  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) {
    // Just the toolCallId, no field
    return { toolCallId: rest };
  }

  return {
    toolCallId: rest.slice(0, slashIndex),
    fieldPointer: '/' + rest.slice(slashIndex + 1),
  };
}
