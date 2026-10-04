import { describe, expect, it, vi } from 'vitest';
import type { PayloadStore } from '@aflow/payload-store';
import {
  MEMORY_READ_OPERATION_ID,
  estimateMessageTokens,
  getOperation,
  textMessage,
  toolResultMessage,
  toolResultObservationOf,
  withoutObservedFields,
  type AiConversationStateV1,
  type AiMessageAtomV1,
  type AiMessageV1,
  type AiToolResultEnvelopeV1,
} from '@aflow/schemas';
import { aiMessageToChatMessage } from './ai/handlers/agentMessageConversion.js';
import { ConversationStateStore } from './conversationStateStore.js';
import { RETENTION_POLICY } from './retentionPolicy.js';
import { renderToolObservations } from './toolObservations.js';

type Output = Record<string, unknown>;

const OPEN = 'browser.page.open';
const ACT = 'browser.page.act';
const READ = 'browser.page.read';
const SNAPSHOT = 'browser.page.snapshot';
const CLOSE = 'browser.page.close';
const HANDOFF = 'browser.page.handoff';

const PAGE_URL = 'https://example.com/pulls';

const OUTLINE_REPLACED = (pageId: string) =>
  `A later outline of ${pageId} replaced this result's; browser.page.snapshot returns the current one.`;
const MOVED = (pageId: string, current: string) =>
  `browser.page.act moved ${pageId} to another address after this result, so nothing this ` +
  `result observed of ${pageId} is kept; ${current} returns it as it is now.`;
const ENDED = (operation: string, pageId: string) =>
  `${operation} ended ${pageId} after this result, so nothing this result observed of ${pageId} is kept.`;

/** Outline lines of the shape the browser driver returns, to `chars` characters. */
function outlineOf(chars: number): string {
  const rows = [
    '- banner [ref=e1]:',
    '  - link "Home" [ref=e2]',
    '  - navigation "Primary" [ref=e3]:',
    '    - link "Issues" [ref=e4]',
    '    - link "Pull requests" [ref=e5]',
    '- main [ref=e6]:',
    '  - heading "Pull requests" [level=1] [ref=e7]',
    '  - textbox "Search all pull requests" [ref=e8]',
    '  - button "Filters" [ref=e9]',
  ];
  for (let i = 10; rows.join('\n').length < chars; i += 3) {
    rows.push(
      `  - link "Fix the scheduler's retry window #${String(4000 + i)}" [ref=e${String(i)}]`,
    );
    rows.push(`  - button "Assign reviewer" [ref=e${String(i + 1)}]`);
    rows.push(
      `  - heading "Opened by someone ${String(i)} minutes ago" [level=3] [ref=e${String(i + 2)}]`,
    );
  }
  return rows.join('\n').slice(0, chars);
}

/** Page prose, to `chars` characters. */
function proseOf(chars: number, from = 0): string {
  let text = '';
  for (let i = from; text.length < chars; i += 1) {
    text += `Pull request ${String(4000 + i)} moves the scheduler's retry window to the next hour. `;
  }
  return text.slice(0, chars);
}

const outlineReceipt = { outlineElements: 120, outlineCut: false, settled: true };

function openOutput(pageId: string): Output {
  return {
    outcome: 'performed',
    pageId,
    url: PAGE_URL,
    title: 'Pull requests',
    outline: outlineOf(600),
    receipt: { profileId: 'default', requestedUrl: PAGE_URL, redirected: false, ...outlineReceipt },
  };
}

function actOutput(
  pageId: string,
  step: number,
  { urlChanged = false, outline = outlineOf(600) }: { urlChanged?: boolean; outline?: string } = {},
): Output {
  return {
    outcome: 'performed',
    pageId,
    url: urlChanged ? `${PAGE_URL}?page=${String(step)}` : PAGE_URL,
    title: 'Pull requests',
    outline,
    receipt: {
      action: 'click',
      ref: `e${String(10 + step)}`,
      element: { role: 'link', name: 'Next' },
      urlChanged,
      titleChanged: false,
      outlineChanged: true,
      ...outlineReceipt,
    },
  };
}

function readTextOutput(
  pageId: string,
  offset: number,
  text: string,
  nextOffset?: number,
  contains = '',
): Output {
  return {
    pageId,
    url: PAGE_URL,
    what: 'text',
    contains,
    text,
    offset,
    withheld: nextOffset === undefined ? 0 : 5_000,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

function readEntriesOutput(pageId: string, what: 'console' | 'network', contains = ''): Output {
  const at = '2026-10-03T10:00:00.000Z';
  return {
    pageId,
    url: PAGE_URL,
    what,
    contains,
    ...(what === 'console'
      ? { console: [{ level: 'error', text: 'Failed to load resource', at }] }
      : {
          network: [
            {
              method: 'GET',
              url: `${PAGE_URL}?page=redacted`,
              status: 200,
              resourceType: 'fetch',
              at,
            },
          ],
        }),
    withheld: 0,
    notRetained: 0,
  };
}

function snapshotOutput(pageId: string, ref?: string, continueRef?: string): Output {
  return {
    pageId,
    url: PAGE_URL,
    title: 'Pull requests',
    snapshot: outlineOf(900),
    ...(continueRef !== undefined ? { snapshotCensus: { link: 30 } } : {}),
    receipt: {
      ...(ref !== undefined ? { ref } : {}),
      lines: 20,
      cut: continueRef !== undefined,
      ...(continueRef !== undefined ? { continueRef } : {}),
    },
  };
}

/** A text read from the start of a page `pageChars` long, bounded at `chars`. */
function boundedReadOutput(pageId: string, chars: number, pageChars: number): Output {
  const shown = Math.min(chars, pageChars);
  return {
    ...readTextOutput(pageId, 0, proseOf(shown), shown < pageChars ? shown : undefined),
    withheld: pageChars - shown,
  };
}

/** A whole-page snapshot that left `leftOut` elements out of its census. */
function boundedSnapshotOutput(pageId: string, chars: number, leftOut: number): Output {
  return {
    pageId,
    url: PAGE_URL,
    title: 'Pull requests',
    snapshot: outlineOf(chars),
    ...(leftOut > 0 ? { snapshotCensus: { link: leftOut - 1, heading: 1 } } : {}),
    receipt: {
      lines: Math.round(chars / 40),
      cut: leftOut > 0,
      ...(leftOut > 0 ? { continueRef: 'e900' } : {}),
    },
  };
}

function handoffOutput(pageId: string, previousPageId?: string): Output {
  return {
    outcome: 'completed',
    pageId,
    ...(previousPageId !== undefined ? { previousPageId } : {}),
    url: PAGE_URL,
    title: 'Pull requests',
    outline: outlineOf(600),
    receipt: {
      reason: 'sign_in',
      waitedSeconds: 40,
      restarted: previousPageId !== undefined,
      ...outlineReceipt,
    },
  };
}

/** The envelope the orchestrator builds, stamped from the operation's own declaration. */
function envelopeFor(
  base: string,
  operationId: string,
  output: Output,
  stamped = true,
): AiToolResultEnvelopeV1 {
  const declaration = getOperation(operationId)?.observation;
  const observation =
    stamped && declaration !== undefined
      ? toolResultObservationOf(declaration, output, (shown) => JSON.stringify(shown))
      : undefined;
  return {
    kind: 'tool_result',
    toolCallId: `${base}_0`,
    toolName: operationId,
    operationId,
    status: 'SUCCEEDED',
    completedAtMs: 1_700_000_000_000,
    outputPath: `/run/outputs/${base}_0`,
    summary: JSON.stringify(output),
    ...(observation !== undefined ? { observation } : {}),
  };
}

function exchange(base: string, envelope: AiToolResultEnvelopeV1): [AiMessageV1, AiMessageV1] {
  return [
    {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_step', toolId: envelope.toolName } }],
      toolCalls: [{ toolCallId: `${base}_0`, name: envelope.toolName, argumentsJson: {} }],
    },
    toolResultMessage(envelope),
  ];
}

const call = (base: string, operationId: string, output: Output, stamped = true) =>
  exchange(base, envelopeFor(base, operationId, output, stamped));

const act = (base: string, pageId: string, step: number, urlChanged = false) =>
  call(base, ACT, actOutput(pageId, step, { urlChanged }));

function summaryOf(message: AiMessageV1): string | undefined {
  const part = message.parts[0];
  return part?.kind === 'json' ? (part.json as AiToolResultEnvelopeV1).summary : undefined;
}

function toolSummaries(messages: AiMessageV1[]): Array<string | undefined> {
  return messages.filter((m) => m.role === 'tool').map(summaryOf);
}

function isFull(summary: string | undefined): boolean {
  return summary?.startsWith('{') === true && summary.includes('"outline"');
}

/** Each tool result as shown: `full`, or the first line of its reduced form. */
function forms(messages: AiMessageV1[]): string[] {
  const rendered = renderToolObservations(messages);
  return messages.flatMap((message, i) => {
    if (message.role !== 'tool') return [];
    const shown = summaryOf(rendered[i]!)!;
    return [shown === summaryOf(message) ? 'full' : shown.split('\n')[0]!];
  });
}

describe('renderToolObservations — reduced facet by facet', () => {
  it('shows the newest of three outlines of a page in full, the first two as receipts', () => {
    const messages = [
      textMessage('user', 'Merge it'),
      ...act('a1', 'pg_1', 1),
      ...act('a2', 'pg_1', 2),
      ...act('a3', 'pg_1', 3),
    ];
    const stored = JSON.stringify(messages);
    const summaries = toolSummaries(renderToolObservations(messages));

    expect(forms(messages)).toEqual([OUTLINE_REPLACED('pg_1'), OUTLINE_REPLACED('pg_1'), 'full']);
    for (const [i, summary] of summaries.slice(0, 2).entries()) {
      expect(JSON.parse(summary!.split('\n')[1]!)).toEqual(
        withoutObservedFields(actOutput('pg_1', i + 1), ['outline', 'outlineCensus']),
      );
    }
    expect(JSON.stringify(renderToolObservations(messages))).not.toContain('"observation"');
    expect(JSON.stringify(messages)).toBe(stored);
  });

  it('keeps each page’s newest outline in full when two pages interleave', () => {
    const messages = [
      ...act('a1', 'pg_1', 1),
      ...act('b1', 'pg_2', 1),
      ...act('a2', 'pg_1', 2),
      ...act('b2', 'pg_2', 2),
    ];
    expect(forms(messages)).toEqual([
      OUTLINE_REPLACED('pg_1'),
      OUTLINE_REPLACED('pg_2'),
      'full',
      'full',
    ]);
  });

  it('keeps a text read and its continuation from nextOffset in full', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800), 800)),
      ...call('r2', READ, readTextOutput('pg_1', 800, proseOf(800, 20))),
    ];
    expect(forms(messages)).toEqual(['full', 'full', 'full']);
  });

  it('reduces the first of two text reads at the same offset', () => {
    const messages = [
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...call('r2', READ, readTextOutput('pg_1', 0, proseOf(800))),
    ];
    expect(forms(messages)).toEqual([
      "A later read (what text, offset 0) of pg_1 replaced this result's; " +
        'browser.page.read returns the current one.',
      'full',
    ]);
  });

  it('keeps a console read and a network read in full, and reduces a console read read again', () => {
    const messages = [
      ...call('r1', READ, readEntriesOutput('pg_1', 'console')),
      ...call('r2', READ, readEntriesOutput('pg_1', 'network')),
      ...call('r3', READ, readEntriesOutput('pg_1', 'console')),
    ];
    expect(forms(messages)).toEqual([
      "A later read (what console) of pg_1 replaced this result's; " +
        'browser.page.read returns the current one.',
      'full',
      'full',
    ]);
  });

  it('keeps two reads filtered for different things in full, and reduces one filtered again alike', () => {
    const messages = [
      ...call('r1', READ, readEntriesOutput('pg_1', 'console', 'error')),
      ...call('r2', READ, readEntriesOutput('pg_1', 'console', 'warning')),
      ...call('r3', READ, readTextOutput('pg_1', 0, proseOf(800), undefined, 'retry')),
      ...call('r4', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...call('r5', READ, readEntriesOutput('pg_1', 'console', 'error')),
    ];
    expect(forms(messages)).toEqual([
      "A later read (what console, contains error) of pg_1 replaced this result's; " +
        'browser.page.read returns the current one.',
      'full',
      'full',
      'full',
      'full',
    ]);
  });

  it('keeps a read after an action that stayed at the address, and reduces the earlier outline', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...act('a1', 'pg_1', 1),
    ];
    expect(forms(messages)).toEqual([OUTLINE_REPLACED('pg_1'), 'full', 'full']);
  });

  it('reduces every earlier read, snapshot and outline once an action moved the page', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...call('s1', SNAPSHOT, snapshotOutput('pg_1', 'e40')),
      ...call('s2', SNAPSHOT, snapshotOutput('pg_1')),
      ...act('a1', 'pg_1', 1, true),
      ...call('r2', READ, readTextOutput('pg_2', 0, proseOf(800))),
    ];
    const rendered = renderToolObservations(messages);
    expect(forms(messages)).toEqual([
      OUTLINE_REPLACED('pg_1'),
      MOVED('pg_1', 'browser.page.read'),
      MOVED('pg_1', 'browser.page.snapshot'),
      MOVED('pg_1', 'browser.page.snapshot'),
      'full',
      'full',
    ]);
    expect(JSON.parse(summaryOf(rendered[3]!)!.split('\n')[1]!)).toEqual({
      pageId: 'pg_1',
      url: PAGE_URL,
      what: 'text',
      contains: '',
      offset: 0,
      withheld: 0,
    });
  });

  it('keeps a scoped snapshot through a whole-page snapshot and an outline', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('s1', SNAPSHOT, snapshotOutput('pg_1', 'e40', 'e90')),
      ...call('s2', SNAPSHOT, snapshotOutput('pg_1', 'e90')),
      ...call('s3', SNAPSHOT, snapshotOutput('pg_1')),
      ...act('a1', 'pg_1', 1),
    ];
    expect(forms(messages)).toEqual([OUTLINE_REPLACED('pg_1'), 'full', 'full', 'full', 'full']);

    const again = [
      ...messages,
      ...call('s4', SNAPSHOT, snapshotOutput('pg_1', 'e40')),
      ...call('s5', SNAPSHOT, snapshotOutput('pg_1')),
    ];
    const rendered = renderToolObservations(again);
    expect(forms(again)).toEqual([
      OUTLINE_REPLACED('pg_1'),
      "A later snapshot (ref e40) of pg_1 replaced this result's; " +
        'browser.page.snapshot returns the current one.',
      'full',
      "A later snapshot of pg_1 replaced this result's; browser.page.snapshot returns the current one.",
      OUTLINE_REPLACED('pg_1'),
      'full',
      'full',
    ]);
    expect(summaryOf(rendered[7]!)!.split('\n').slice(0, 2)).toEqual([
      "A later snapshot of pg_1 replaced this result's; browser.page.snapshot returns the current one.",
      OUTLINE_REPLACED('pg_1'),
    ]);
  });

  it('reduces every observation of a page once it is closed', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...call('s1', SNAPSHOT, snapshotOutput('pg_1', 'e40')),
      ...call('r2', READ, readEntriesOutput('pg_1', 'network')),
      ...call('c1', CLOSE, { pageId: 'pg_1', state: 'closed' }),
    ];
    const rendered = renderToolObservations(messages);
    expect(forms(messages)).toEqual([...Array<string>(4).fill(ENDED(CLOSE, 'pg_1')), 'full']);
    expect(JSON.stringify(rendered)).not.toContain('"observation"');
  });

  it('reduces the observations of a page a hand-off replaced with a new one', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...call('h1', HANDOFF, handoffOutput('pg_2', 'pg_1')),
      ...call('r2', READ, readTextOutput('pg_2', 0, proseOf(800))),
    ];
    expect(forms(messages)).toEqual([
      ENDED(HANDOFF, 'pg_1'),
      ENDED(HANDOFF, 'pg_1'),
      'full',
      'full',
    ]);
  });

  it('reduces only the outline before a hand-off that kept the page', () => {
    const messages = [
      ...call('o1', OPEN, openOutput('pg_1')),
      ...call('r1', READ, readTextOutput('pg_1', 0, proseOf(800))),
      ...call('h1', HANDOFF, handoffOutput('pg_1')),
    ];
    expect(forms(messages)).toEqual([OUTLINE_REPLACED('pg_1'), 'full', 'full']);
  });

  it('leaves a result whose operation declares nothing exactly as stored', () => {
    const undeclared = call('h1', 'api.http.call', { pageId: 'pg_1', outline: outlineOf(300) });
    const messages = [...act('a1', 'pg_1', 1), ...undeclared, ...act('a2', 'pg_1', 2)];
    const rendered = renderToolObservations(messages);
    expect(rendered[2]).toBe(messages[2]);
    expect(rendered[3]).toBe(messages[3]);
    expect(toolSummaries(rendered).map(isFull)).toEqual([false, true, true]);
  });

  it('shows a result whose stamp does not parse in full, without the stamp', () => {
    const envelope = { ...envelopeFor('a1', ACT, actOutput('pg_1', 1)), observation: 'stale' };
    const messages = [
      toolResultMessage(envelope as unknown as AiToolResultEnvelopeV1),
      ...act('a2', 'pg_1', 2),
    ];
    const rendered = renderToolObservations(messages);
    expect(summaryOf(rendered[0]!)).toBe(JSON.stringify(actOutput('pg_1', 1)));
    expect(JSON.stringify(rendered[0])).not.toContain('"observation"');
  });

  it('keeps the tool call id and name of a reduced result, and none of its images', () => {
    const image = {
      ref: 'gs://aflow-payloads/x/body.json',
      contentType: 'image/png' as const,
      sizeBytes: 10,
      width: 10,
      height: 10,
    };
    const first = toolResultMessage({
      ...envelopeFor('a1', ACT, actOutput('pg_1', 1)),
      images: [image],
    });
    const rendered = renderToolObservations([first, ...act('a2', 'pg_1', 2)]);
    expect(first.parts.some((p) => p.kind === 'image')).toBe(true);
    expect(rendered[0]).toMatchObject({ role: 'tool', toolCallId: 'a1_0', name: ACT });
    expect(rendered[0]!.parts.map((p) => p.kind)).toEqual(['json']);
    expect(JSON.stringify(rendered[0])).not.toContain('"images"');
  });
});

const READ_REPLACED =
  "A later read (what text, offset 0) of pg_1 replaced this result's; " +
  'browser.page.read returns the current one.';
const SNAPSHOT_REPLACED =
  "A later snapshot of pg_1 replaced this result's; browser.page.snapshot returns the current one.";

describe('renderToolObservations — a later look replaces one of the same part only when it covers it', () => {
  const PAGE_CHARS = 40_000;
  const read = (base: string, chars: number) =>
    call(base, READ, boundedReadOutput('pg_1', chars, PAGE_CHARS));
  const snapshot = (base: string, chars: number, leftOut: number) =>
    call(base, SNAPSHOT, boundedSnapshotOutput('pg_1', chars, leftOut));

  it('keeps a larger read in full, text past the smaller bound and all, after a smaller one', () => {
    const messages = [...read('r1', 32_000), ...read('r2', 8_000)];
    const rendered = renderToolObservations(messages);
    expect(forms(messages)).toEqual(['full', 'full']);
    expect(JSON.parse(summaryOf(rendered[1]!)!)).toMatchObject({
      text: proseOf(32_000),
      withheld: 8_000,
      nextOffset: 32_000,
    });
  });

  it('reduces a smaller read once a larger one follows', () => {
    const messages = [...read('r1', 8_000), ...read('r2', 32_000)];
    expect(forms(messages)).toEqual([READ_REPLACED, 'full']);
  });

  it('reduces the earlier of two reads that withheld the same', () => {
    const messages = [...read('r1', 8_000), ...read('r2', 8_000)];
    expect(forms(messages)).toEqual([READ_REPLACED, 'full']);
  });

  it('reduces a cut read once a later one returned all of the part', () => {
    const messages = [...read('r1', 32_000), ...read('r2', PAGE_CHARS)];
    expect(forms(messages)).toEqual([READ_REPLACED, 'full']);
  });

  it('keeps a larger snapshot in full, as the page’s snapshot and its outline, after a smaller one', () => {
    const messages = [...snapshot('s1', 30_000, 40), ...snapshot('s2', 8_000, 300)];
    const rendered = renderToolObservations(messages);
    expect(forms(messages)).toEqual(['full', 'full']);
    expect(JSON.parse(summaryOf(rendered[1]!)!)).toMatchObject({ snapshot: outlineOf(30_000) });
  });

  it('reduces a smaller snapshot once a larger one follows', () => {
    const messages = [...snapshot('s1', 8_000, 300), ...snapshot('s2', 30_000, 40)];
    const rendered = renderToolObservations(messages);
    expect(forms(messages)).toEqual([SNAPSHOT_REPLACED, 'full']);
    expect(summaryOf(rendered[1]!)!.split('\n').slice(0, 2)).toEqual([
      SNAPSHOT_REPLACED,
      OUTLINE_REPLACED('pg_1'),
    ]);
  });

  it('reduces the earlier of two snapshots whose census counts the same', () => {
    const messages = [...snapshot('s1', 8_000, 300), ...snapshot('s2', 8_000, 300)];
    expect(forms(messages)).toEqual([SNAPSHOT_REPLACED, 'full']);
  });

  it('reduces a larger look by the first later one that covers it, past a smaller one between', () => {
    const messages = [
      ...read('r1', 32_000),
      ...read('r2', 8_000),
      ...read('r3', 16_000),
      ...read('r4', 32_000),
    ];
    const rendered = renderToolObservations(messages);
    expect(forms(messages)).toEqual([READ_REPLACED, READ_REPLACED, READ_REPLACED, 'full']);
    for (const i of [1, 3, 5]) {
      expect(summaryOf(rendered[i]!)!).not.toContain('"text":');
    }
  });

  it('changes each result once, at the turn a look that covers it arrives', () => {
    const messages = [
      ...read('r1', 32_000),
      ...snapshot('s1', 30_000, 40),
      ...read('r2', 8_000),
      ...snapshot('s2', 8_000, 300),
      ...read('r3', 8_000),
      ...snapshot('s3', 8_000, 300),
      ...read('r4', 32_000),
      ...snapshot('s4', 30_000, 40),
    ];
    const formsAt = (n: number) => forms(messages.slice(0, n));
    const changedAt = new Map<number, number>();
    let previous = formsAt(2);
    for (let n = 4; n <= messages.length; n += 2) {
      const now = formsAt(n);
      for (const [i, form] of previous.entries()) {
        if (now[i] === form) continue;
        expect(changedAt.has(i), `result ${String(i)}`).toBe(false);
        changedAt.set(i, n / 2 - 1);
      }
      previous = now;
    }
    expect(Object.fromEntries(changedAt)).toEqual({ 0: 6, 1: 7, 2: 4, 3: 5, 4: 6, 5: 7 });
  });
});

/** A long run of every kind of browser call on two pages, from a fixed seed. */
function mixedRun(calls: number): AiMessageV1[] {
  let seed = 20_261_003;
  const next = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % n;
  };
  const messages: AiMessageV1[] = [];
  for (let t = 0; t < calls; t += 1) {
    const page = next(2) === 0 ? 'pg_1' : 'pg_2';
    const base = `m${String(t)}`;
    const kind = next(9);
    if (kind === 0) messages.push(...call(base, OPEN, openOutput(page)));
    if (kind === 1) messages.push(...act(base, page, t));
    if (kind === 2) messages.push(...act(base, page, t, true));
    if (kind === 3) {
      const offset = next(3) * 800;
      const read = readTextOutput(page, offset, proseOf(800), offset + 800);
      messages.push(...call(base, READ, { ...read, withheld: [2_000, 5_000][next(2)] }));
    }
    if (kind === 4) {
      messages.push(
        ...call(base, READ, readEntriesOutput(page, next(2) === 0 ? 'console' : 'network')),
      );
    }
    if (kind === 5 || kind === 6) {
      const ref = ['e40', 'e90', undefined][next(3)];
      const cut = next(2) === 0;
      messages.push(...call(base, SNAPSHOT, snapshotOutput(page, ref, cut ? 'e120' : undefined)));
    }
    if (kind === 7) messages.push(...call(base, HANDOFF, handoffOutput(page)));
    if (kind === 8 && next(4) === 0) {
      messages.push(...call(base, CLOSE, { pageId: page, state: 'closed' }));
    }
  }
  return messages;
}

describe('renderToolObservations — a pure function that changes a result once per facet', () => {
  it('changes no result more often than it has facets, across every prefix of a long run', () => {
    const messages = mixedRun(120);
    const stored = JSON.stringify(messages);
    const changes = new Array<number>(messages.length).fill(0);
    let previous: string[] = [];
    for (let n = 1; n <= messages.length; n += 1) {
      const now = renderToolObservations(messages.slice(0, n)).map((m) => JSON.stringify(m));
      expect(now).toEqual(
        renderToolObservations(messages.slice(0, n)).map((m) => JSON.stringify(m)),
      );
      for (const [i, form] of previous.entries()) if (now[i] !== form) changes[i]! += 1;
      previous = now;
    }
    const facetsOf = (message: AiMessageV1) => {
      const part = message.parts[0];
      const envelope = part?.kind === 'json' ? (part.json as AiToolResultEnvelopeV1) : undefined;
      return envelope?.observation?.facets.length ?? 0;
    };
    for (const [i, message] of messages.entries()) {
      expect(changes[i], `message ${String(i)}`).toBeLessThanOrEqual(facetsOf(message));
    }
    expect(changes.filter((c) => c > 0).length).toBeGreaterThan(20);
    expect(JSON.stringify(messages)).toBe(stored);
  });
});

// ============================================================================
// Assembly
// ============================================================================

function atomsOf(turns: Array<{ turn: number; messages: AiMessageV1[] }>): AiMessageAtomV1[] {
  const atoms: AiMessageAtomV1[] = [];
  for (const { turn, messages } of turns) {
    for (const [i, message] of messages.entries()) {
      atoms.push({
        schemaVersion: 1,
        atomId: `atom-${String(turn)}-${String(i)}`,
        role: message.role,
        sourceId: message.toolCallId ?? `turn:${String(turn)}:${String(i)}`,
        sourceKind:
          message.role === 'tool'
            ? 'tool_result'
            : message.role === 'assistant'
              ? 'assistant_turn'
              : 'user_input',
        message,
        createdAtMs: turn * 1000 + i,
        turnNumber: turn,
      });
    }
  }
  return atoms;
}

function storeFor(atoms: AiMessageAtomV1[], turnNumber: number) {
  const state: AiConversationStateV1 = {
    schemaVersion: 1,
    conversationId: 'c1',
    turnNumber,
    context: {},
    seenSourceIds: {},
    history: {
      maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural,
      atoms: atoms.map((a) => ({
        atomId: a.atomId,
        ref: 'batch:1',
        role: a.role,
        sourceKind: a.sourceKind,
        hash: 'h',
        createdAtMs: a.createdAtMs,
        turnNumber: a.turnNumber,
      })),
    },
  };
  const payloadStore = {
    retrieve: vi.fn().mockResolvedValue(atoms),
    store: vi.fn().mockResolvedValue('ref:new'),
  } as unknown as PayloadStore;
  return new ConversationStateStore(
    {
      payloadStore,
      tenantId: 'tenant-1',
      runId: 'run-1',
      stepId: 'agent',
      stepExecutionId: 'step-exec-uuid',
      attempt: 1,
    },
    state,
  );
}

async function assemble(
  turns: Array<{ turn: number; messages: AiMessageV1[] }>,
  turnNumber: number,
) {
  const store = storeFor(atomsOf(turns), turnNumber);
  return { store, request: await store.assembleRequest('sys', []) };
}

const opener = { turn: 0, messages: [textMessage('user', 'Merge the open pull request')] };

describe('ConversationStateStore.assembleRequest — observations', () => {
  it('sends turn N+1 the same bytes as turn N for every message before the newly reduced one', async () => {
    const turnN = [
      opener,
      { turn: 1, messages: act('a1', 'pg_1', 1) },
      { turn: 2, messages: act('a2', 'pg_1', 2) },
    ];
    const turnN1 = [...turnN, { turn: 3, messages: act('a3', 'pg_1', 3) }];
    const before = (await assemble(turnN, 3)).request.messages;
    const after = (await assemble(turnN1, 4)).request.messages;

    const newlyReduced = before.findIndex((m) => m.toolCallId === 'a2_0');
    expect(isFull(summaryOf(before[newlyReduced]!))).toBe(true);
    expect(isFull(summaryOf(after[newlyReduced]!))).toBe(false);
    expect(after.slice(0, newlyReduced).map((m) => JSON.stringify(m))).toEqual(
      before.slice(0, newlyReduced).map((m) => JSON.stringify(m)),
    );

    const turnN2 = [...turnN1, { turn: 4, messages: act('a4', 'pg_1', 4) }];
    const later = (await assemble(turnN2, 5)).request.messages;
    expect(JSON.stringify(later[newlyReduced])).toBe(JSON.stringify(after[newlyReduced]));
  });

  it('changes from one turn to the next only the results that just went stale', async () => {
    const run = mixedRun(40);
    const turns: Turn[] = [opener];
    for (let i = 0; i < run.length; i += 2) {
      turns.push({ turn: turns.length, messages: run.slice(i, i + 2) });
    }
    let previous = (await assemble(turns.slice(0, 2), 2)).request.messages;
    let changed = 0;
    for (let n = 3; n <= turns.length; n += 1) {
      const now = (await assemble(turns.slice(0, n), n)).request.messages;
      for (const [i, message] of previous.entries()) {
        if (message.role === 'system' || JSON.stringify(now[i]) === JSON.stringify(message)) {
          continue;
        }
        changed += 1;
        expect(message.role).toBe('tool');
        expect(summaryOf(message)!.startsWith('{')).toBe(true);
        expect(summaryOf(now[i]!)!).toMatch(/^(A later |browser\.page\.\w+ (moved|ended) )/);
        expect(now[i]!.toolCallId).toBe(message.toolCallId);
      }
      previous = now;
    }
    expect(changed).toBeGreaterThan(5);
  });

  it('counts the reduced form in the history estimate', async () => {
    const turns = [
      opener,
      { turn: 1, messages: act('a1', 'pg_1', 1) },
      { turn: 2, messages: act('a2', 'pg_1', 2) },
    ];
    const { request } = await assemble(turns, 3);
    const sent = request.messages.filter((m) => m.role !== 'system');
    const stored = atomsOf(turns).map((a) => a.message);
    const estimate = (messages: AiMessageV1[]) =>
      messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    expect(request.tokenBreakdown.history).toBe(estimate(sent));
    expect(request.tokenBreakdown.history).toBeLessThan(estimate(stored));
  });

  it('still clears a reduced observation under pressure, and the newest stays in full', async () => {
    const turns = [opener];
    for (const t of [1, 2, 3, 4, 5, 6, 7, 18]) {
      turns.push({ turn: t, messages: act(`ob${String(t).padStart(2, '0')}`, 'pg_1', t) });
    }
    const { store } = await assemble(turns, 20);
    const result = await store.clearUnderPressure({
      pressureTokens: 9_500,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });

    expect(store.getState().clearing?.clearedExchanges).toContain('ob01');
    expect(result?.clearedExchangeCount).toBeGreaterThan(0);
    const ids = new Set(store.getState().history.atoms.map((a) => a.atomId));
    expect(ids.has('atom-1-1')).toBe(false);
    expect(ids.has('atom-18-1')).toBe(true);
  });
});

// ============================================================================
// Measurements
// ============================================================================

type Turn = { turn: number; messages: AiMessageV1[] };

/** The same calls with and without their stamps, one call per turn after the opener. */
function runOf(calls: Array<[string, Output]>): { stamped: Turn[]; unstamped: Turn[] } {
  const stamped: Turn[] = [opener];
  const unstamped: Turn[] = [opener];
  for (const [i, [operationId, output]] of calls.entries()) {
    const base = `run${String(i + 1).padStart(2, '0')}`;
    stamped.push({ turn: i + 1, messages: call(base, operationId, output) });
    unstamped.push({ turn: i + 1, messages: call(base, operationId, output, false) });
  }
  return { stamped, unstamped };
}

async function measure(run: { stamped: Turn[]; unstamped: Turn[] }) {
  const size = (messages: AiMessageV1[]) =>
    messages
      .map(aiMessageToChatMessage)
      .reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const turnNumber = run.stamped.length;
  const before = (await assemble(run.unstamped, turnNumber)).request;
  const after = (await assemble(run.stamped, turnNumber)).request;
  return {
    after: after.messages,
    report: {
      beforeChars: size(before.messages),
      afterChars: size(after.messages),
      beforeHistoryTokens: before.tokenBreakdown.history,
      afterHistoryTokens: after.tokenBreakdown.history,
    },
  };
}

describe('ten actions on one page with an 8,000-character outline', () => {
  it('reports the request before and after reduction', async () => {
    const outline = outlineOf(8_000);
    const calls = Array.from({ length: 10 }, (_, i): [string, Output] => [
      ACT,
      actOutput('pg_1', i + 1, { urlChanged: true, outline }),
    ]);
    const { after, report } = await measure(runOf(calls));
    console.info('ten actions', JSON.stringify({ outlineChars: outline.length, ...report }));

    expect(toolSummaries(after).map(isFull)).toEqual([...Array<boolean>(9).fill(false), true]);
    expect(report.afterChars).toBeLessThan(report.beforeChars / 4);
  });
});

describe('open, three continued text reads, an action, then a move', () => {
  const chunk = 8_000;
  const reads: Array<[string, Output]> = [0, 1, 2].map((i) => [
    READ,
    readTextOutput('pg_1', i * chunk, proseOf(chunk, i * 100), i < 2 ? (i + 1) * chunk : undefined),
  ]);
  const open: [string, Output] = [OPEN, { ...openOutput('pg_1'), outline: outlineOf(7_000) }];
  const stay: [string, Output] = [ACT, actOutput('pg_1', 1, { outline: outlineOf(7_000) })];
  const move: [string, Output] = [
    ACT,
    actOutput('pg_1', 2, { urlChanged: true, outline: outlineOf(7_000) }),
  ];
  const textShown = (messages: AiMessageV1[]) =>
    messages
      .filter((m) => m.role === 'tool')
      .map((m) => summaryOf(m)!)
      .filter((s) => s.includes('"what":"text"'))
      .map((s) => (s.includes('"text":') ? 'full' : s.split('\n')[0]!));

  it('keeps all three chunks in full through an action that stayed at the address', async () => {
    const { after, report } = await measure(runOf([open, ...reads, stay]));
    console.info('three chunks, then an action', JSON.stringify(report));

    expect(textShown(after)).toEqual(['full', 'full', 'full']);
    expect(toolSummaries(after).map(isFull)).toEqual([false, false, false, false, true]);
  });

  it('reduces all three chunks once the page moves', async () => {
    const { after, report } = await measure(runOf([open, ...reads, stay, move]));
    console.info('three chunks, an action, then a move', JSON.stringify(report));

    expect(textShown(after)).toEqual(Array<string>(3).fill(MOVED('pg_1', 'browser.page.read')));
    expect(report.afterChars).toBeLessThan(report.beforeChars / 4);
  });
});
