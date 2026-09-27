/**
 * Pure content-packing helpers shared by the memory executor (range reads)
 * and the orchestrator's tool-result summary (bounded read display). Both
 * boundaries must cut on the same semantic units — complete lines for text,
 * complete serialized items for JSON arrays — so the range metadata and the
 * continuation a reader derives from it stay exact. Budgets are measured in
 * UTF-16 code units (`string.length`), matching the memory read ops' maxBytes
 * comparison semantics.
 */

/**
 * The one bounded-read budget (UTF-16 code units): the memory executor's
 * default read window and the summary boundary's display budget. One number so
 * a default read is displayed whole and the continuation the reader derives
 * matches what the executor will return. Sized to leave headroom for the
 * summary header/continuation under the 16,000-char tool-result envelope
 * ceiling (AiToolResult summary.text).
 */
export const MEMORY_READ_BUDGET_CHARS = 15_000;

export interface PackedLines {
  /** The kept lines joined with '\n' — always whole lines, never a cut one. */
  content: string;
  /** Number of complete lines included. 0 when the first line alone exceeds the budget. */
  lineCount: number;
  /** True when at least one line was dropped to fit the budget. */
  truncated: boolean;
}

/**
 * Keep the longest prefix of complete lines whose joined length fits the
 * budget. When even the first line alone exceeds the budget, nothing is kept
 * (`lineCount: 0`) — the caller decides how to bound a single oversized line.
 */
export function packCompleteLines(text: string, budgetChars: number): PackedLines {
  if (text.length <= budgetChars) {
    return {
      content: text,
      lineCount: text === '' ? 0 : text.split('\n').length,
      truncated: false,
    };
  }
  return packCompleteLineArray(text.split('\n'), budgetChars);
}

/** As packCompleteLines, over an already-split line array (no join/re-split). */
export function packCompleteLineArray(lines: string[], budgetChars: number): PackedLines {
  let total = 0;
  let kept = 0;
  for (const line of lines) {
    const separator = kept > 0 ? 1 : 0;
    if (total + separator + line.length > budgetChars) break;
    total += separator + line.length;
    kept += 1;
  }
  return {
    content: lines.slice(0, kept).join('\n'),
    lineCount: kept,
    truncated: kept < lines.length,
  };
}

export interface PackedItems {
  /** Serialized JSON array of the kept items — always valid JSON. */
  json: string;
  /** Number of complete items included. 0 when the first item alone exceeds the budget. */
  count: number;
  /** True when at least one item was dropped to fit the budget. */
  truncated: boolean;
  /** Serialized size of the first item when it alone exceeded the budget. */
  oversizedItemChars?: number;
}

/**
 * Keep the longest prefix of items whose serialized JSON array fits the
 * budget. Never cuts inside an item: the returned `json` always parses. When
 * the first item alone exceeds the budget, nothing is kept and
 * `oversizedItemChars` reports its serialized size so the caller can teach a
 * narrower read.
 */
// JSON.stringify's lib signature hides that undefined/function/symbol values
// serialize to undefined at runtime; inside an array they render as null.
function stringifyItem(item: unknown): string {
  const json: string | undefined = JSON.stringify(item);
  return json ?? 'null';
}

export function packCompleteItems(items: unknown[], budgetChars: number): PackedItems {
  const brackets = 2;
  let total = brackets;
  const serialized: string[] = [];
  for (const item of items) {
    const json = stringifyItem(item);
    const separator = serialized.length > 0 ? 1 : 0;
    if (total + separator + json.length > budgetChars) break;
    total += separator + json.length;
    serialized.push(json);
  }
  if (serialized.length === 0 && items.length > 0) {
    return {
      json: '[]',
      count: 0,
      truncated: true,
      oversizedItemChars: stringifyItem(items[0]).length,
    };
  }
  return {
    json: `[${serialized.join(',')}]`,
    count: serialized.length,
    truncated: serialized.length < items.length,
  };
}
