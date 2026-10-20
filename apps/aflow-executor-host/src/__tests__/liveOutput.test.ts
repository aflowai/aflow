/**
 * Contract: what a command or a folder check prints streams on `activity`, as
 * `output` lines, and never on the channel that carries what a step says.
 *
 * On `text` the chat rendered a check's log as an assistant message under the
 * conversation's agent's name, and lost it on refresh.
 */
import {
  ACTIVITY_TEXT_MAX,
  HarnessActivityLineSchema,
  type HarnessActivityLine,
  type LiveDeltaChannel,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { createLiveOutputFeed } from '../liveOutput.js';

function capture(clock: { now: number } = { now: 0 }) {
  const frames: Array<{ channel: LiveDeltaChannel; delta: string }> = [];
  const feed = createLiveOutputFeed(
    (channel, delta) => {
      frames.push({ channel, delta });
    },
    () => clock.now,
  );
  const lines = (): HarnessActivityLine[] =>
    frames
      .flatMap((frame) => frame.delta.split('\n'))
      .filter((segment) => segment !== '')
      .map((segment) => HarnessActivityLineSchema.parse(JSON.parse(segment)));
  return { feed, frames, lines };
}

describe('a command’s live output', () => {
  it('is emitted on `activity`, one newline-terminated output line per printed line', () => {
    const { feed, frames, lines } = capture();
    feed.push('building @acme/a\nok   build');
    feed.push(' @acme/a\n');
    feed.flush();

    expect(frames.map((frame) => frame.channel)).toEqual(['activity', 'activity']);
    for (const frame of frames) expect(frame.delta.endsWith('\n')).toBe(true);
    expect(lines()).toEqual([
      { kind: 'output', at: 0, text: 'building @acme/a' },
      { kind: 'output', at: 0, text: 'ok   build @acme/a' },
    ]);
  });

  it('holds an unterminated line until flushed, then sends it', () => {
    const { feed, frames, lines } = capture();
    feed.push('no newline at the end');
    expect(frames).toEqual([]);
    feed.flush();
    expect(lines().map((line) => line.text)).toEqual(['no newline at the end']);
  });

  it('dates each line from when the feed began', () => {
    const clock = { now: 1_000 };
    const { feed, lines } = capture(clock);
    clock.now = 1_250;
    feed.push('first\n');
    clock.now = 4_000;
    feed.push('second\n');
    expect(lines().map((line) => line.at)).toEqual([250, 3_000]);
  });

  it('splits a progress counter’s carriage returns and drops blank lines', () => {
    const { feed, lines } = capture();
    feed.push('10%\r50%\r');
    feed.push('\n\n100%\r\n');
    expect(lines().map((line) => line.text)).toEqual(['10%', '50%', '100%']);
  });

  it('cuts a line over the ceiling rather than losing it to the fold', () => {
    const { feed, lines } = capture();
    feed.push(`${'x'.repeat(ACTIVITY_TEXT_MAX + 10)}\n`);
    expect(lines()[0]?.text).toHaveLength(ACTIVITY_TEXT_MAX);
  });
});
