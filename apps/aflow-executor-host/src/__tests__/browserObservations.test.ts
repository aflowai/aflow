import { BROWSER_SNAPSHOT_DEFAULT_CHARS } from '@aflow/schemas';

import { encodedLength } from '../browser/encodedLength.js';
import { describe, expect, it } from 'vitest';

import {
  boundEntries,
  boundText,
  CONSOLE_BUFFER_ENTRIES,
  CONSOLE_TEXT_MAX_CHARS,
  NETWORK_BUFFER_ENTRIES,
  PageObservations,
  redactUrl,
  RingBuffer,
} from '../browser/observations.js';
import { boundSnapshot } from '../browser/outline.js';

describe('ring buffers', () => {
  it('keep the newest entries up to their capacity and count what they dropped', () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i += 1) ring.push(i);
    expect(ring.entries()).toEqual([3, 4, 5]);
    expect(ring.notRetained).toBe(2);
  });

  it('bound what one page keeps', () => {
    const observations = new PageObservations(() => 0);
    for (let i = 0; i < CONSOLE_BUFFER_ENTRIES + 10; i += 1)
      observations.recordConsole('log', `m${String(i)}`);
    for (let i = 0; i < NETWORK_BUFFER_ENTRIES + 5; i += 1) {
      observations.recordRequest({
        method: 'GET',
        url: `https://example.com/${String(i)}`,
        status: 200,
        resourceType: 'image',
      });
    }
    expect(observations.console.entries()).toHaveLength(CONSOLE_BUFFER_ENTRIES);
    expect(observations.console.notRetained).toBe(10);
    expect(observations.network.entries()).toHaveLength(NETWORK_BUFFER_ENTRIES);
    expect(observations.network.notRetained).toBe(5);

    observations.recordConsole('log', 'x'.repeat(CONSOLE_TEXT_MAX_CHARS * 3));
    expect(observations.console.entries().at(-1)?.text.length).toBe(CONSOLE_TEXT_MAX_CHARS + 1);
  });
});

describe('an address as it is kept', () => {
  it('keeps query keys and replaces every value, and drops credentials and fragment', () => {
    expect(
      redactUrl(
        'https://user:pw@api.example.com/v1/x?token=abc&token=def&lang=en#access_token=zzz',
      ),
    ).toBe('https://api.example.com/v1/x?token=redacted&token=redacted&lang=redacted');
    expect(redactUrl('https://example.com/plain')).toBe('https://example.com/plain');
    expect(redactUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,…');
    expect(redactUrl('not a url?secret=1')).toBe('not a url');
  });
});

describe('what a read returns', () => {
  it('keeps the newest matching entries and counts the rest as withheld', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      text: `${i % 2 === 0 ? 'error' : 'info'} ${String(i)}`,
    }));
    const { kept, withheld } = boundEntries(entries, 'ERROR', (e) => e.text, 3);
    expect(kept.map((e) => e.text)).toEqual(['error 4', 'error 6', 'error 8']);
    expect(withheld).toBe(2);
  });

  it('bounds entries by size as well as count', () => {
    const entries = Array.from({ length: 5 }, () => ({ text: 'y'.repeat(100) }));
    const { kept, withheld } = boundEntries(entries, undefined, (e) => e.text, 100, 250);
    expect(kept).toHaveLength(2);
    expect(withheld).toBe(3);
  });

  it('cuts text at its bound and says how much was left', () => {
    // A line break is two characters as the result carries it.
    expect(boundText('a\nb\nc', undefined, { maxChars: 4 })).toEqual({
      text: 'a\nb',
      offset: 0,
      withheld: 2,
      nextOffset: 3,
    });
    expect(boundText('a\nb\nc', undefined, { offset: 3, maxChars: 4 })).toEqual({
      text: '\nc',
      offset: 3,
      withheld: 0,
    });
    expect(boundText('Alpha\nbeta\nALPHABET', 'alpha')).toEqual({
      text: 'Alpha\nALPHABET',
      offset: 0,
      withheld: 0,
    });
  });
});

describe('a full snapshot', () => {
  it('is cut at the outline bound with a census of what was left out', () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, i) => `- link "Item ${String(i)}" [ref=e${String(i)}]`,
    );
    const cut = boundSnapshot({
      text: lines.join('\n'),
      maskedRefs: new Set(),
      holdsCredentialField: false,
    });
    expect(encodedLength(cut?.text ?? '')).toBeLessThanOrEqual(BROWSER_SNAPSHOT_DEFAULT_CHARS);
    expect(cut?.census?.['link']).toBe(4_000 - (cut?.lines ?? 0));
    expect(cut?.text.split('\n').at(-1)).toMatch(
      /^# Snapshot cut at 8000 characters\. Not shown: link \d+\. To read on, snapshot with `ref: e\d+`, or raise `maxChars`\.$/,
    );
  });
});
