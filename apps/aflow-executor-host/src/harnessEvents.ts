/**
 * Reading a harness's output stream as activity rather than as prose.
 *
 * A harness that prints an event stream is telling the executor what it is
 * doing while it does it — which tool, on what, and how the call came back.
 * That is the whole of the wait made legible, and it is thrown away by any
 * reader that waits for the final block of text.
 *
 * The reader is stateful for the same reason the chatter stripper is: a chunk
 * boundary falls wherever the pipe flushes, mid-object as easily as between
 * lines, and a parser applied per chunk would fail on exactly the long lines
 * the stream is made of. A partial line is held until the chunk that completes
 * it, or until `flush` says nothing more is coming.
 *
 * Nothing here is fatal. An event type this does not know is ignored, and a
 * line that is not JSON is passed through as narration — a harness that prints
 * plain text, or one whose stream went wrong mid-run, still shows something
 * rather than going silent.
 */
import type { HarnessActivityLine } from '@aflow/schemas';

import type { HarnessOutputFormat } from './harnessProfiles.js';

/** One line of a feed a person reads, not a transcript of a tool's output. */
const SUMMARY_MAX = 300;
/** The harness's own narration, capped where the schema caps it. */
const NARRATION_MAX = 8_000;

export interface HarnessEventReader {
  /** Feed a chunk of standard output. Emits whatever lines it completes. */
  push(chunk: string): void;
  /** Whatever the last chunk left unterminated. */
  flush(): void;
  /**
   * What the harness said, as opposed to what it did. The result event when
   * there was one; otherwise the last thing it wrote, so a run that was cut
   * short still reports an answer rather than nothing.
   */
  answer(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The field of a tool's input that tells a reader what the call is about.
 *
 * A preference order rather than a table from tool name to field: the names
 * change with every harness release, the fields do not, and a table that has
 * fallen behind reads as a tool call with nothing attached.
 */
const TELLING_FIELDS = [
  'file_path',
  'command',
  'pattern',
  'url',
  'path',
  'query',
  'notebook_path',
  'description',
  'prompt',
] as const;

export function summarizeToolUse(name: string, input: unknown): string {
  if (!isRecord(input)) return name;
  for (const field of TELLING_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') {
      return `${name} ${clip(value, SUMMARY_MAX)}`;
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') {
      return `${name} ${clip(value, SUMMARY_MAX)}`;
    }
  }
  return name;
}

/**
 * The file a call changes, when it changes one.
 *
 * Fields again, not names: a call that names a path and carries what to put
 * there is a change, whatever the harness calls the tool. A call naming a path
 * alone is a read.
 */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;
const CONTENT_FIELDS = ['content', 'new_string', 'edits', 'new_source'] as const;

export function changedFileOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (!CONTENT_FIELDS.some((field) => input[field] !== undefined)) return undefined;
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') return clip(value, SUMMARY_MAX);
  }
  return undefined;
}

/** A call that hands the shell a command line. */
export function isCommandCall(input: unknown): boolean {
  return isRecord(input) && typeof input['command'] === 'string';
}

/**
 * What the agent says it is doing: the item of its plan it marked in progress.
 *
 * A harness that keeps a plan rewrites the whole of it on every change, so the
 * call carries every item and the one in progress is the news. Its present-tense
 * wording is preferred where the harness writes one.
 */
export function intentOf(input: unknown): string | undefined {
  if (!isRecord(input) || !Array.isArray(input['todos'])) return undefined;
  for (const item of input['todos']) {
    if (!isRecord(item) || item['status'] !== 'in_progress') continue;
    for (const field of ['activeForm', 'content'] as const) {
      const value = item[field];
      if (typeof value === 'string' && value.trim() !== '') return clip(value, SUMMARY_MAX);
    }
  }
  return undefined;
}

/** A tool result arrives as a string or as content blocks; both read as text. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((text) => text !== '')
    .join('\n');
}

export function summarizeToolResult(content: unknown): string {
  const lines = textOfContent(content)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const first = lines[0];
  if (first === undefined) return 'No output';
  if (lines.length === 1) return clip(first, SUMMARY_MAX);
  return `${clip(first, SUMMARY_MAX)} (+${String(lines.length - 1)} more lines)`;
}

function describeResult(event: Record<string, unknown>): string {
  const parts: string[] = [];
  const duration = event['duration_ms'];
  if (typeof duration === 'number') parts.push(`${(duration / 1000).toFixed(1)}s`);
  const turns = event['num_turns'];
  if (typeof turns === 'number') parts.push(`${String(turns)} turns`);
  const cost = event['total_cost_usd'];
  if (typeof cost === 'number') parts.push(`$${cost.toFixed(4)}`);
  return parts.length === 0 ? 'Finished' : `Finished in ${parts.join(' · ')}`;
}

export function createHarnessEventReader(
  output: HarnessOutputFormat,
  onLine: (line: HarnessActivityLine) => void,
  startedAt: number,
): HarnessEventReader {
  let carry = '';
  let resultText: string | undefined;
  let lastSaid = '';
  const passedThrough: string[] = [];
  // A tool result names the call it answers, not the tool that made it, so the
  // name is carried across from the call. Without it a feed says a result came
  // back and never which of five in-flight calls it belongs to. Whether the
  // call ran a command travels with it for the same reason.
  const toolCalls = new Map<string, { name: string; command: boolean }>();
  let lastIntent = '';

  const at = (): number => Math.max(0, Date.now() - startedAt);

  const plain = (line: string): void => {
    const text = line.trim();
    if (text === '') return;
    lastSaid = text;
    passedThrough.push(text);
    onLine({ kind: 'thought', at: at(), text: text.slice(0, NARRATION_MAX) });
  };

  const readAssistant = (message: Record<string, unknown>): void => {
    const content = message['content'];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        const text = block['text'].trim();
        if (text === '') continue;
        lastSaid = text;
        onLine({ kind: 'thought', at: at(), text: text.slice(0, NARRATION_MAX) });
        continue;
      }
      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const name = block['name'];
        const input = block['input'];
        const id = block['id'];
        if (typeof id === 'string') toolCalls.set(id, { name, command: isCommandCall(input) });
        const changes = changedFileOf(input);
        onLine({
          kind: 'tool',
          at: at(),
          tool: name,
          text: summarizeToolUse(name, input),
          ...(changes !== undefined ? { changes } : {}),
        });
        // A plan rewritten without moving on says nothing new, and repeating
        // the same intent would date it as fresh news.
        const intent = intentOf(input);
        if (intent !== undefined && intent !== lastIntent) {
          lastIntent = intent;
          onLine({ kind: 'intent', at: at(), text: intent });
        }
      }
    }
  };

  const readUser = (message: Record<string, unknown>): void => {
    const content = message['content'];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const id = block['tool_use_id'];
      const call = typeof id === 'string' ? toolCalls.get(id) : undefined;
      onLine({
        kind: 'tool_result',
        at: at(),
        tool: call?.name ?? 'tool',
        ok: block['is_error'] !== true,
        text: summarizeToolResult(block['content']),
        ...(call?.command === true ? { command: true } : {}),
      });
    }
  };

  const readEvent = (event: Record<string, unknown>): void => {
    switch (event['type']) {
      case 'system': {
        // Only the opening one. A harness prints system events for its own
        // lifecycle throughout, and narrating those says nothing about the work.
        if (event['subtype'] !== 'init') return;
        const model = event['model'];
        onLine({
          kind: 'status',
          at: at(),
          text: typeof model === 'string' ? `Model ${model}` : 'Harness started',
        });
        return;
      }
      case 'assistant': {
        const message = event['message'];
        if (isRecord(message)) readAssistant(message);
        return;
      }
      case 'user': {
        const message = event['message'];
        if (isRecord(message)) readUser(message);
        return;
      }
      case 'result': {
        const text = event['result'];
        if (typeof text === 'string') resultText = text;
        onLine({ kind: 'status', at: at(), text: describeResult(event) });
        return;
      }
      default:
        return;
    }
  };

  const readLine = (line: string): void => {
    if (output !== 'claude-stream-json') {
      plain(line);
      return;
    }
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      plain(line);
      return;
    }
    if (!isRecord(parsed)) {
      plain(line);
      return;
    }
    readEvent(parsed);
  };

  return {
    push(chunk: string): void {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) readLine(line);
    },
    flush(): void {
      if (carry === '') return;
      const line = carry;
      carry = '';
      readLine(line);
    },
    answer(): string {
      if (resultText !== undefined) return resultText;
      return output === 'claude-stream-json' ? lastSaid : passedThrough.join('\n');
    },
  };
}
