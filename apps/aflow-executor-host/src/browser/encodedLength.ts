/**
 * Text measured as a result carries it.
 *
 * Whether a result reaches the agent inline is decided on its JSON, where a
 * quote or a line break takes two characters and a control character six. A
 * bound counted in the text's own characters lets a page of short lines or
 * quoted names land well over the inline limit, so every browser bound counts
 * this way.
 */

function encodedCost(char: string): number {
  if (char === '"' || char === '\\') return 2;
  if (char.charCodeAt(0) >= 0x20) return char.length;
  return char === '\n' || char === '\r' || char === '\t' || char === '\b' || char === '\f' ? 2 : 6;
}

/** Characters `text` takes inside a JSON string, quotes excluded. */
export function encodedLength(text: string): number {
  let total = 0;
  for (const char of text) total += encodedCost(char);
  return total;
}

/** The longest start of `text` whose encoded length fits `maxEncoded`, never splitting a character. */
export function encodedPrefix(text: string, maxEncoded: number): string {
  let used = 0;
  let end = 0;
  for (const char of text) {
    const cost = encodedCost(char);
    if (used + cost > maxEncoded) break;
    used += cost;
    end += char.length;
  }
  return text.slice(0, end);
}
