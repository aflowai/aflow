/**
 * What the coding agent's card reads off a feed.
 *
 * The rendering is thin; the judgements are not. A count that lies about how
 * much happened, a tool line that emphasises the wrong half, or a feed that
 * scrolls away from the reader are the three ways this card fails while
 * looking correct.
 */
import { describe, expect, it } from 'vitest';
import type { HarnessActivityLine } from '@aflow/schemas';

import {
  activityCounts,
  changedFiles,
  emptyFeedLine,
  foldHeaderText,
  isPinnedToBottom,
  lastToolLine,
  leadLine,
  leadingSection,
  lineNeedsExpansion,
  liveSummaryLabel,
  parseActivityFeed,
  resultMark,
  runElapsedMs,
  sinceActivityLabel,
  splitToolLine,
  toolDisclosureLabel,
} from './harness-activity-card.js';
import { harnessCardTitle, readHarnessId, readResultHarness } from '../lib/harness-title.js';

const FEED: HarnessActivityLine[] = [
  { kind: 'status', at: 0, text: 'Model claude-opus-5-5' },
  { kind: 'thought', at: 1_200, text: 'Looking at how the parser handles empty input.' },
  { kind: 'tool', at: 1_400, tool: 'Read', text: 'Read src/parser.ts' },
  { kind: 'tool_result', at: 2_000, tool: 'Read', ok: true, text: 'export function parse(' },
  { kind: 'tool', at: 2_100, tool: 'Bash', text: 'Bash yarn test:file parser.test.ts' },
  { kind: 'tool_result', at: 61_000, tool: 'Bash', ok: false, text: '1 failed' },
  { kind: 'thought', at: 61_500, text: 'The empty case throws. Adding the guard.' },
];

describe('what a feed says about itself', () => {
  it('counts the events, the turns it spoke on, and the calls it made', () => {
    expect(activityCounts(FEED)).toEqual({
      events: 7,
      turns: 2,
      toolCalls: 2,
      elapsedMs: 61_500,
    });
  });

  it('an empty feed measures zero rather than nothing', () => {
    expect(activityCounts([])).toEqual({ events: 0, turns: 0, toolCalls: 0, elapsedMs: 0 });
  });

  it('reads elapsed time off the last line, which is where the run has got to', () => {
    expect(liveSummaryLabel(activityCounts(FEED))).toBe('1.0m · 2 turns · 2 tool calls');
  });

  it('says nothing about turns or calls before either has happened', () => {
    expect(liveSummaryLabel(activityCounts(FEED.slice(0, 1)))).toBe('0ms');
  });

  it('folds to the two counts a reader decides on', () => {
    expect(foldHeaderText(activityCounts(FEED), true)).toBe('2 tool calls · 2 notes');
    expect(foldHeaderText({ events: 45, turns: 3, toolCalls: 42, elapsedMs: 900_000 }, true)).toBe(
      '42 tool calls · 3 notes',
    );
    expect(foldHeaderText({ events: 2, turns: 1, toolCalls: 1, elapsedMs: 10 }, true)).toBe(
      '1 tool call · 1 note',
    );
  });

  it('counts the events of a run that only reported facts about itself', () => {
    expect(foldHeaderText(activityCounts(FEED.slice(0, 1)), true)).toBe('1 event');
  });

  it('claims no count for a stored feed it has not read yet', () => {
    // Folded, the card has fetched nothing. A count of zero here would say the
    // run did nothing, which is the one thing a stored feed proves false.
    expect(foldHeaderText(activityCounts([]), true)).toBe('activity');
  });

  it('says plainly when a finished run recorded nothing', () => {
    expect(foldHeaderText(activityCounts([]), false)).toBe('no activity recorded');
  });
});

/**
 * Proof of life. A person watching a commission reads what the agent says it is
 * doing, how long since it did anything, and the files it is changing — the
 * calls are folded behind them.
 */
describe('what the card leads with', () => {
  it('leads with the last thing the agent said, never a tool call', () => {
    expect(leadLine(FEED)).toEqual({
      kind: 'thought',
      at: 61_500,
      text: 'The empty case throws. Adding the guard.',
    });
    const working: HarnessActivityLine[] = [
      ...FEED,
      { kind: 'intent', at: 62_000, text: 'Running the parser tests' },
      { kind: 'tool', at: 62_100, tool: 'Bash', text: 'Bash yarn test:file parser.test.ts' },
    ];
    expect(leadLine(working)).toMatchObject({ kind: 'intent', text: 'Running the parser tests' });
  });

  it('falls back to the last fact the run reported before the agent has spoken', () => {
    const lines: HarnessActivityLine[] = [
      { kind: 'status', at: 0, text: 'Model claude-opus-5-5' },
      { kind: 'tool', at: 300, tool: 'Read', text: 'Read src/parser.ts' },
    ];
    expect(leadLine(lines)).toMatchObject({ kind: 'status', text: 'Model claude-opus-5-5' });
  });

  it('has no lead line for a feed of calls alone', () => {
    expect(leadLine([{ kind: 'tool', at: 1, tool: 'Read', text: 'Read a.ts' }])).toBeUndefined();
  });

  it('lists the files changed once each, the most recent first', () => {
    const lines: HarnessActivityLine[] = [
      { kind: 'tool', at: 1, tool: 'Edit', text: 'Edit a.ts', changes: 'a.ts' },
      { kind: 'tool', at: 2, tool: 'Read', text: 'Read c.ts' },
      { kind: 'tool', at: 3, tool: 'Write', text: 'Write b.ts', changes: 'b.ts' },
      { kind: 'tool', at: 4, tool: 'Edit', text: 'Edit a.ts', changes: 'a.ts' },
    ];
    expect(changedFiles(lines)).toEqual(['a.ts', 'b.ts']);
    expect(changedFiles(FEED)).toEqual([]);
  });

  it('names the folded calls by their count and the one they end on', () => {
    expect(lastToolLine(FEED)?.text).toBe('Bash yarn test:file parser.test.ts');
    expect(toolDisclosureLabel(FEED)).toBe(
      '2 tool calls · last: Bash yarn test:file parser.test.ts',
    );
    expect(toolDisclosureLabel(FEED.slice(0, 2))).toBe('2 events');
  });

  it('reads the time since the harness last wrote anything', () => {
    expect(sinceActivityLabel(10_000, 9_500)).toBe('active now');
    expect(sinceActivityLabel(100_000, 88_000)).toBe('last active 12.0s ago');
  });

  it('counts a run from its start, not from a feed that has not reported', () => {
    // The F95 symptom: a run thirty minutes in reading `0ms` because its feed
    // was empty. The step's own start is the clock wherever it is known.
    const empty = activityCounts([]);
    expect(runElapsedMs({ counts: empty, nowMs: 1_800_000, startedAtMs: 0 })).toBe(1_800_000);
    expect(liveSummaryLabel(empty, 1_800_000)).toBe('30.0m');
  });

  it('keeps counting through a quiet spell where only the feed tells the time', () => {
    const counts = activityCounts(FEED);
    expect(runElapsedMs({ counts, nowMs: 50_000, lastActivityAtMs: 20_000 })).toBe(91_500);
    expect(runElapsedMs({ counts, nowMs: 50_000 })).toBe(61_500);
  });
});

/**
 * A command's exit status is not yet true inside a commission (Plan 315 F84):
 * a command that succeeded can still exit non-zero on a sandbox refusal. The
 * card shows no verdict for a command until the lane makes it true.
 */
describe("how a call's result is marked", () => {
  it("shows no verdict for a command's exit, either way", () => {
    expect(
      resultMark({ kind: 'tool_result', at: 1, tool: 'Bash', ok: false, command: true, text: '' }),
    ).toBe('unjudged');
    expect(
      resultMark({ kind: 'tool_result', at: 1, tool: 'Bash', ok: true, command: true, text: '' }),
    ).toBe('unjudged');
  });

  it("shows another tool's error, which is its own report", () => {
    expect(resultMark({ kind: 'tool_result', at: 1, tool: 'Read', ok: false, text: '' })).toBe(
      'failed',
    );
    expect(resultMark({ kind: 'tool_result', at: 1, tool: 'Read', ok: true, text: '' })).toBe('ok');
  });
});

/**
 * A finished run is read for its answer; a running one for what it is doing.
 * Leading with a transcript of how the answer was reached buries the answer.
 */
describe('which half of the card leads', () => {
  it('leads with the result once the step is done and has one', () => {
    expect(leadingSection({ running: false, hasResult: true })).toBe('result');
  });

  it('leads with the feed while the step is still working', () => {
    expect(leadingSection({ running: true, hasResult: false })).toBe('feed');
    expect(leadingSection({ running: true, hasResult: true })).toBe('feed');
  });

  it('leads with the feed where a finished step has no result to show', () => {
    expect(leadingSection({ running: false, hasResult: false })).toBe('feed');
  });
});

/**
 * A call and its answer get one row each, so a tool result the length of a file
 * cannot push the next twenty lines out of the box.
 */
describe('a row with more in it than fits', () => {
  const long = 'Bash '.concat('yarn test:file '.repeat(12));

  it('offers the whole of a line too long for its row', () => {
    expect(lineNeedsExpansion({ kind: 'tool', at: 1, tool: 'Bash', text: long })).toBe(true);
  });

  it('offers the whole of an answer that came back as several lines', () => {
    expect(
      lineNeedsExpansion({
        kind: 'tool_result',
        at: 2,
        tool: 'Read',
        ok: true,
        text: 'export function parse(\n  input: string,\n)',
      }),
    ).toBe(true);
  });

  it('leaves a line that already fits alone', () => {
    expect(
      lineNeedsExpansion({ kind: 'tool', at: 1, tool: 'Read', text: 'Read src/parser.ts' }),
    ).toBe(false);
  });

  it('never truncates the narration, which is written to be read', () => {
    expect(lineNeedsExpansion({ kind: 'thought', at: 1, text: long })).toBe(false);
    expect(lineNeedsExpansion({ kind: 'status', at: 0, text: long })).toBe(false);
  });
});

describe('a tool line', () => {
  it('separates the tool from what it was given', () => {
    expect(splitToolLine({ tool: 'Read', text: 'Read src/parser.ts' })).toEqual({
      tool: 'Read',
      detail: 'src/parser.ts',
    });
  });

  it('keeps a summary that does not begin with the tool name whole', () => {
    expect(splitToolLine({ tool: 'Grep', text: 'searched for parse(' })).toEqual({
      tool: 'Grep',
      detail: 'searched for parse(',
    });
  });

  it('leaves no detail when the call carried nothing telling', () => {
    expect(splitToolLine({ tool: 'TodoWrite', text: 'TodoWrite' })).toEqual({
      tool: 'TodoWrite',
      detail: '',
    });
  });
});

describe('the stored feed', () => {
  it('reads back the lines it was given', () => {
    expect(parseActivityFeed(FEED)).toEqual(FEED);
  });

  it('drops an entry the schema refuses and keeps the rest', () => {
    expect(parseActivityFeed([FEED[0], { kind: 'invented', at: 1 }, FEED[2]])).toEqual([
      FEED[0],
      FEED[2],
    ]);
  });

  it('reads anything that is not a list of lines as no feed', () => {
    expect(parseActivityFeed({ lines: FEED })).toEqual([]);
    expect(parseActivityFeed(null)).toEqual([]);
    expect(parseActivityFeed('[]')).toEqual([]);
  });
});

describe('following a running feed', () => {
  it('stays pinned while the reader is at the end', () => {
    expect(isPinnedToBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it('lets go the moment the reader scrolls back to read something', () => {
    // This is the jump-to-latest state: new lines keep arriving and the view
    // must not drag the reader off what they stopped on.
    expect(isPinnedToBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });

  it('treats a feed shorter than its box as pinned', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 288 })).toBe(true);
  });
});

/**
 * The card is named after what the operator installed, never after the lane:
 * `harness` is a word from the code, and a machine can offer several agents.
 */
describe('what the card is called', () => {
  it('prefers the label the result named over every id', () => {
    expect(
      harnessCardTitle({ reported: { id: 'claude', label: 'Claude Code' }, harness: 'claude' }),
    ).toEqual({ title: 'Claude Code', lane: 'coding agent' });
  });

  it('takes the id where nothing carries a label', () => {
    expect(harnessCardTitle({ reported: { id: 'opencode' }, harness: 'claude' })).toEqual({
      title: 'opencode',
      lane: 'coding agent',
    });
    expect(harnessCardTitle({ harness: 'claude' })).toEqual({
      title: 'claude',
      lane: 'coding agent',
    });
  });

  it('names the agent generically where nothing named it, and says so once', () => {
    expect(harnessCardTitle({})).toEqual({ title: 'Coding agent', lane: undefined });
    expect(harnessCardTitle({ harness: '   ' })).toEqual({
      title: 'Coding agent',
      lane: undefined,
    });
  });

  it('appends the folder to whatever the title is', () => {
    expect(harnessCardTitle({ harness: 'opencode', folder: 'phoenix' }).title).toBe(
      'opencode · phoenix',
    );
    expect(harnessCardTitle({ folder: 'phoenix' }).title).toBe('Coding agent · phoenix');
  });

  it('says a run picked up an existing conversation as the lane', () => {
    expect(harnessCardTitle({ harness: 'claude', continued: true })).toEqual({
      title: 'claude',
      lane: 'continued session',
    });
    expect(harnessCardTitle({ continued: true })).toEqual({
      title: 'Coding agent',
      lane: 'continued session',
    });
  });

  it('keeps the input id while the run has reported nothing', () => {
    expect(harnessCardTitle({ reported: undefined, harness: 'claude' }).title).toBe('claude');
  });

  it('steps past a blank half of what the result named', () => {
    expect(
      harnessCardTitle({ reported: { id: 'claude', label: '  ' }, harness: 'opencode' }).title,
    ).toBe('claude');
    expect(harnessCardTitle({ reported: { id: '  ' }, harness: 'opencode' }).title).toBe(
      'opencode',
    );
    expect(harnessCardTitle({ reported: {}, continued: true })).toEqual({
      title: 'Coding agent',
      lane: 'continued session',
    });
  });
});

describe('reading the harness off a step input', () => {
  it('takes the id the caller named', () => {
    expect(readHarnessId({ bindingId: 'b', harness: 'claude', task: 'review' })).toBe('claude');
  });

  it('reads nothing where the machine resolved the id itself', () => {
    expect(readHarnessId({ bindingId: 'b', task: 'review' })).toBeUndefined();
  });

  it('reads nothing from a payload that is not an input object', () => {
    expect(readHarnessId(null)).toBeUndefined();
    expect(readHarnessId('claude')).toBeUndefined();
    expect(readHarnessId({ harness: 7 })).toBeUndefined();
  });
});

describe('reading the harness off a finished result', () => {
  it('takes the id and the label the run reported', () => {
    expect(
      readResultHarness({ runId: 'r', harness: { id: 'claude', label: 'Claude Code' } }),
    ).toEqual({ id: 'claude', label: 'Claude Code' });
  });

  it('takes the id alone where the profile carries no label', () => {
    expect(readResultHarness({ harness: { id: 'opencode' } })).toEqual({ id: 'opencode' });
  });

  it('reads nothing from a result that names no harness', () => {
    expect(readResultHarness({ runId: 'r', exitCode: 0 })).toBeUndefined();
    expect(readResultHarness({ harness: 'claude' })).toBeUndefined();
    expect(readResultHarness({ harness: null })).toBeUndefined();
    expect(readResultHarness({ harness: { id: 7, label: false } })).toBeUndefined();
    expect(readResultHarness({ harness: { id: '  ' } })).toBeUndefined();
    expect(readResultHarness(undefined)).toBeUndefined();
    expect(readResultHarness('claude')).toBeUndefined();
  });
});

/**
 * An empty feed under a running step has two causes that read the same and mean
 * opposite things: the agent has said nothing, or this tab is not listening.
 */
describe('an open card with nothing in it', () => {
  it('says the agent has not spoken while the channel is up', () => {
    expect(emptyFeedLine(true, true)).toBe('The coding agent has not reported yet.');
  });

  it('blames the connection while the channel is down', () => {
    expect(emptyFeedLine(true, false)).toBe('Waiting for the connection.');
  });

  it('says a finished run recorded nothing, whatever the channel is doing', () => {
    expect(emptyFeedLine(false, true)).toBe('No activity was recorded for this run.');
    expect(emptyFeedLine(false, false)).toBe('No activity was recorded for this run.');
  });
});
