const MAX_GENERIC_FIELDS = 10;

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Inspect a step output and return the list of accessible field paths.
 *
 * Examples:
 *   API output → ['data', 'body']
 *   Compute output → ['data', 'outputFiles/submission.csv']
 *   Memory get → ['data']
 *   MCP tool → ['content']
 *   Generic → top-level object keys (e.g. ['result', 'items'])
 */
export function detectOutputFields(output: unknown): string[] {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) return [];
  const obj = output as Record<string, unknown>;
  const fields: string[] = [];

  if ('data' in obj) {
    fields.push('data');
  }

  if ('body' in obj && obj['body'] != null) {
    fields.push('body');
  }

  if (
    'outputFiles' in obj &&
    obj['outputFiles'] != null &&
    typeof obj['outputFiles'] === 'object'
  ) {
    const outputFiles = obj['outputFiles'] as Record<string, unknown>;
    for (const filename of Object.keys(outputFiles)) {
      fields.push(`outputFiles/${filename}`);
    }
  }

  if (fields.length === 0) {
    for (const key of Object.keys(obj).slice(0, MAX_GENERIC_FIELDS)) {
      fields.push(escapePointerSegment(key));
    }
  }

  return fields;
}
