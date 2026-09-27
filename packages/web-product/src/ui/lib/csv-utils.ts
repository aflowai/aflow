/**
 * Shared CSV parsing utilities used by markdown-renderer and DocumentPane.
 */

/** Maximum number of CSV rows to render in table previews. */
export const MAX_CSV_ROWS = 200;

/**
 * Parse a single CSV row respecting quoted fields (RFC 4180).
 * Handles escaped quotes ("") and trims trailing \r for CRLF line endings.
 */
export function parseCsvRow(line: string): string[] {
  // Trim trailing \r for CRLF line endings
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < trimmed.length; i++) {
    // Bounded by the loop; the fallback cannot be reached.
    const ch = trimmed[i] ?? '';
    if (inQuotes) {
      if (ch === '"' && trimmed[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
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
