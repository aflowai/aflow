import { HarnessActivityLineSchema, type HarnessActivityLine } from '@aflow/schemas';
import type { HarnessActivityState, LiveDeltaAction, RunViewState } from '../state.js';

/**
 * What a harness step is doing, folded under the step rather than into a message.
 *
 * The `activity` channel carries one JSON line per event, newline-terminated,
 * appended to the same byte buffer the text channels use. So the fold has the
 * same two obligations as the text one and one more: a frame's `offset` says
 * where its bytes begin, and a chunk boundary falls wherever the writer
 * flushed — mid-object as easily as between lines — so the tail that is not yet
 * a whole line is held until the frame that completes it.
 *
 * Nothing here is fatal. A line that does not parse, or parses to something the
 * schema refuses, is dropped: a feed is a live value superseded by the step's
 * own result, and a reader losing one line of narration costs less than a view
 * that throws.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Drop bytes a previous frame already folded in, so a resend adds only its tail. */
function dropLeadingBytes(text: string, bytes: number): string {
  const encoded = encoder.encode(text);
  if (bytes >= encoded.length) return '';
  return decoder.decode(encoded.subarray(bytes));
}

function readLines(buffer: string): { lines: HarnessActivityLine[]; partial: string } {
  const segments = buffer.split('\n');
  const partial = segments.pop() ?? '';
  const lines: HarnessActivityLine[] = [];
  for (const segment of segments) {
    if (segment.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment) as unknown;
    } catch {
      continue;
    }
    const result = HarnessActivityLineSchema.safeParse(parsed);
    if (result.success) lines.push(result.data);
  }
  return { lines, partial };
}

const EMPTY: HarnessActivityState = {
  lines: [],
  partial: '',
  consumedBytes: 0,
  lastActivityAtMs: 0,
};

export function applyActivityDelta(state: RunViewState, action: LiveDeltaAction): RunViewState {
  const { stepExecutionId, offset, delta } = action;
  // An offset-0 frame is the whole buffer, not an increment — the case on a
  // mid-step reconnect, and on the retry of a step whose buffer was dropped.
  // Folding it from empty makes a replay produce the feed it produced before.
  const held = offset === 0 ? undefined : state.harnessActivity[stepExecutionId];
  const base = held ?? EMPTY;

  const deltaBytes = byteLength(delta);
  const alreadyFolded = base.consumedBytes - offset;
  if (alreadyFolded >= deltaBytes) return state;
  const fresh = alreadyFolded > 0 ? dropLeadingBytes(delta, alreadyFolded) : delta;

  const { lines, partial } = readLines(base.partial + fresh);
  const foldedLines = lines.length > 0 ? [...base.lines, ...lines] : base.lines;
  // The mark says the harness wrote something, not that a frame arrived: a
  // reconnect re-sends the whole buffer, and dating that as activity would
  // restart the silence clock on a step that has said nothing for ten minutes.
  // So it moves only where the feed itself grew — a whole line, or the partial
  // line the harness is still writing. Measured against the entry that was
  // already held, not against the base a replay folds from.
  const prior = state.harnessActivity[stepExecutionId];
  const grew =
    foldedLines.length > (prior?.lines.length ?? 0) || partial !== (prior?.partial ?? '');
  const framedAtMs = Date.parse(action.timestamp);
  const marked = grew && !Number.isNaN(framedAtMs) ? framedAtMs : undefined;
  const entry: HarnessActivityState = {
    lines: foldedLines,
    partial,
    consumedBytes: Math.max(base.consumedBytes, offset + deltaBytes),
    lastActivityAtMs: marked ?? prior?.lastActivityAtMs ?? base.lastActivityAtMs,
  };

  return { ...state, harnessActivity: { ...state.harnessActivity, [stepExecutionId]: entry } };
}
