/**
 * Shared content-detection utilities used by ContentRenderer, AgentChatHistory,
 * and AgentDecisionCard to detect and segment markdown, JSON, and plain text.
 */

/**
 * Heuristic: does the text look like it contains markdown formatting?
 * Checks for common markdown patterns that wouldn't appear in plain text.
 * Intentionally conservative — false negatives render as plain text which is still readable.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length < 4) return false;
  return (
    /(?:^|\n)(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|---|\|.+\|)/m.test(text) ||
    /(?:\*\*.+\*\*|__.+__|`.+`|\[.+\]\(.+\)|!\[)/.test(text)
  );
}

/**
 * Attempt to parse text as JSON. Returns the parsed value or null.
 * Only attempts parsing when text begins and ends with matching delimiters.
 */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A segment of mixed text+JSON content.
 */
export type ContentSegment = { kind: 'text'; text: string } | { kind: 'json'; data: unknown };

/**
 * Split a string that may contain interleaved prose and JSON blocks into
 * alternating text and json segments. JSON blocks are greedily detected
 * starting from lines that begin with `{` or `[`.
 */
export function splitTextAndJson(input: string): ContentSegment[] {
  if (!input) return [];

  const lines = input.split('\n');
  const segments: ContentSegment[] = [];
  let textLines: string[] = [];

  const flushText = () => {
    const joined = textLines.join('\n').trim();
    if (joined) segments.push({ kind: 'text', text: joined });
    textLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const trimmedLine = line.trimStart();

    if (trimmedLine.startsWith('{') || trimmedLine.startsWith('[')) {
      const candidate = lines.slice(i).join('\n').trim();
      try {
        const parsed = JSON.parse(candidate) as unknown;
        flushText();
        segments.push({ kind: 'json', data: parsed });
        break;
      } catch {
        let found = false;
        for (let j = i; j < lines.length; j++) {
          const sub = lines
            .slice(i, j + 1)
            .join('\n')
            .trim();
          const lastChar = sub[sub.length - 1];
          if (lastChar === '}' || lastChar === ']') {
            try {
              const parsed = JSON.parse(sub) as unknown;
              flushText();
              segments.push({ kind: 'json', data: parsed });
              i = j + 1;
              found = true;
              break;
            } catch {
              /* keep accumulating */
            }
          }
        }
        if (!found) {
          textLines.push(line);
          i++;
        }
      }
    } else {
      textLines.push(line);
      i++;
    }
  }

  flushText();
  return segments;
}
