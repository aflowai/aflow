/**
 * What a command printed, streamed under its step rather than as its message.
 *
 * A command's output is the step's work, not anything the run said: on `text`
 * a reader renders it as the step speaking — a message with nobody's name on
 * it that no durable event ever replaces. So it travels on `activity`, one
 * `output` line per printed line, folded under the step as a harness's feed is.
 *
 * A read boundary falls wherever the pipe flushes, so a partial trailing line
 * is held until the chunk that completes it or until `flush` says nothing more
 * is coming.
 */
import { ACTIVITY_TEXT_MAX, type HarnessActivityLine, type LiveDeltaChannel } from '@aflow/schemas';

export interface LiveOutputFeed {
  push: (chunk: string) => void;
  flush: () => void;
}

/** A carriage return alone is how a progress counter redraws its line. */
const LINE_BREAK = /\r\n|\r|\n/;

export function createLiveOutputFeed(
  emit: (channel: LiveDeltaChannel, delta: string) => unknown,
  now: () => number = Date.now,
): LiveOutputFeed {
  const startedAt = now();
  let carry = '';

  const send = (lines: string[]): void => {
    const at = Math.max(0, now() - startedAt);
    const encoded = lines
      .filter((text) => text.trim() !== '')
      .map((text) => {
        const line: HarnessActivityLine = {
          kind: 'output',
          at,
          // Over the ceiling the fold refuses the whole line, not just its end.
          text: text.length > ACTIVITY_TEXT_MAX ? text.slice(0, ACTIVITY_TEXT_MAX) : text,
        };
        return `${JSON.stringify(line)}\n`;
      });
    // One delta per chunk, not per line: a test runner prints thousands.
    if (encoded.length > 0) void emit('activity', encoded.join(''));
  };

  return {
    push(chunk: string): void {
      if (chunk === '') return;
      const lines = (carry + chunk).split(LINE_BREAK);
      carry = lines.pop() ?? '';
      send(lines);
    },
    flush(): void {
      if (carry === '') return;
      const line = carry;
      carry = '';
      send([line]);
    },
  };
}
