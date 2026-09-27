/**
 * Distills a coding-agent (Claude Code / OpenCode) stream-json transcript into a
 * flat, render-ready timeline.
 *
 * The harness emits one JSON object per line (JSONL). Most lines are
 * `thinking_tokens` token-count deltas — pure progress noise. This collapses the
 * stream down to what a reader actually wants: the human prompt, the agent's
 * messages, each tool call paired with its own result, optional reasoning, and
 * the final result. Kept free of React so the distillation can be unit-tested.
 */

export interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
}

export type TranscriptEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly name: string;
      readonly summary: string;
      readonly input: unknown;
      readonly result: ToolResult | undefined;
    }
  | {
      readonly kind: 'result';
      readonly text: string;
      readonly isError: boolean;
      readonly numTurns: number | undefined;
      readonly costUsd: number | undefined;
      readonly durationMs: number | undefined;
    };

export interface ParsedTranscript {
  readonly entries: TranscriptEntry[];
  /** Lines that did not parse as JSON — e.g. a leading partial line from tail-truncation. */
  readonly skippedLines: number;
  /** Reasoning entries, hidden by default; surfaced so the UI can offer a reveal. */
  readonly thinkingCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The single most identifying input field for a tool call, shown on the collapsed row. */
function toolSummary(input: unknown): string {
  if (!isRecord(input)) return '';
  return (
    asString(input['command']) ??
    asString(input['file_path']) ??
    asString(input['path']) ??
    asString(input['pattern']) ??
    asString(input['url']) ??
    asString(input['query']) ??
    asString(input['description']) ??
    ''
  );
}

/** A tool_result block's payload is either a plain string or an array of text parts. */
function toolResultFromBlock(block: Record<string, unknown>): ToolResult {
  const content = block['content'];
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        isRecord(part) ? (asString(part['text']) ?? '') : typeof part === 'string' ? part : '',
      )
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return { isError: block['is_error'] === true, text };
}

function contentArray(obj: Record<string, unknown>): unknown[] | undefined {
  const message = isRecord(obj['message']) ? obj['message'] : obj;
  const content = message['content'];
  return Array.isArray(content) ? content : undefined;
}

export function parseCodingTranscript(raw: string): ParsedTranscript {
  const objs: Array<Record<string, unknown>> = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) objs.push(parsed);
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }

  // Index tool results by their tool_use id so each call can show its own output
  // inline, rather than as a separate row far below the invocation.
  const resultsById = new Map<string, ToolResult>();
  for (const obj of objs) {
    if (asString(obj['type']) !== 'user') continue;
    for (const part of contentArray(obj) ?? []) {
      if (!isRecord(part) || asString(part['type']) !== 'tool_result') continue;
      const id = asString(part['tool_use_id']);
      if (id) resultsById.set(id, toolResultFromBlock(part));
    }
  }

  const entries: TranscriptEntry[] = [];
  let thinkingCount = 0;

  for (const obj of objs) {
    const type = asString(obj['type']);

    // `system` is only token-count deltas / session init — never reader-facing.
    if (type === 'system') continue;

    if (type === 'assistant' || type === 'message') {
      for (const part of contentArray(obj) ?? []) {
        if (!isRecord(part)) continue;
        const blockType = asString(part['type']);
        if (blockType === 'thinking') {
          const text = asString(part['thinking'])?.trim();
          if (text) {
            entries.push({ kind: 'thinking', text });
            thinkingCount += 1;
          }
        } else if (blockType === 'text') {
          const text = asString(part['text'])?.trim();
          if (text) entries.push({ kind: 'assistant', text });
        } else if (blockType === 'tool_use') {
          const name = asString(part['name']) ?? 'tool';
          const id = asString(part['id']);
          entries.push({
            kind: 'tool',
            name,
            summary: toolSummary(part['input']),
            input: part['input'],
            result: id ? resultsById.get(id) : undefined,
          });
        }
      }
      continue;
    }

    if (type === 'user') {
      const message = isRecord(obj['message']) ? obj['message'] : obj;
      const content = message['content'];
      if (typeof content === 'string') {
        const text = content.trim();
        if (text) entries.push({ kind: 'user', text });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          // tool_result blocks were folded into their tool call above.
          if (isRecord(part) && asString(part['type']) === 'text') {
            const text = asString(part['text'])?.trim();
            if (text) entries.push({ kind: 'user', text });
          }
        }
      }
      continue;
    }

    // Top-level harness forms (OpenCode / simpler streams).
    if (type === 'tool_use' || type === 'tool_call') {
      const name = asString(obj['name']) ?? asString(obj['tool']) ?? 'tool';
      entries.push({
        kind: 'tool',
        name,
        summary: toolSummary(obj['input']),
        input: obj['input'],
        result: undefined,
      });
      continue;
    }
    if (type === 'file_edit' || type === 'edit') {
      const path = asString(obj['path']) ?? asString(obj['file']) ?? '';
      entries.push({ kind: 'tool', name: 'edit', summary: path, input: obj, result: undefined });
      continue;
    }

    if (type === 'result') {
      entries.push({
        kind: 'result',
        text: asString(obj['result']) ?? '',
        isError: obj['is_error'] === true,
        numTurns: asNumber(obj['num_turns']),
        costUsd: asNumber(obj['total_cost_usd']),
        durationMs: asNumber(obj['duration_ms']),
      });
      continue;
    }
  }

  return { entries, skippedLines, thinkingCount };
}
