import { describe, expect, it } from 'vitest';
import { MemoryGetInputSchema, MemoryRunOutputGetInputSchema } from '../memory.js';

function refusal(input: Record<string, unknown>): string[] {
  const result = MemoryGetInputSchema.safeParse({
    target: { path: '/notes/ledger.json' },
    ...input,
  });
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

const GRAMMAR =
  `jsonPath names one value: keys and array indices joined by '.' or '[n]', ` +
  'e.g. "entries", "entries[3]", "ledger.entries[3].amount"';

describe('memory read jsonPath grammar', () => {
  it('refuses the slice 0:21 with the grammar and the itemRange that reads it', () => {
    expect(refusal({ jsonPath: '0:21' })).toEqual([
      `jsonPath '0:21' is a slice, and jsonPath does not take slices. ${GRAMMAR}. ` +
        'For a range of items, leave jsonPath out (the document itself is the array) and ' +
        'itemRange: { start: 0, count: 21 } (count at most 200).',
    ]);
  });

  it('names the array a bracketed slice was cut from', () => {
    expect(refusal({ jsonPath: 'ledger.entries[5:25]' })).toEqual([
      `jsonPath 'ledger.entries[5:25]' is a slice, and jsonPath does not take slices. ${GRAMMAR}. ` +
        'For a range of items, set jsonPath to the array ("ledger.entries") and ' +
        'itemRange: { start: 5, count: 20 } (count at most 200).',
    ]);
    expect(refusal({ jsonPath: 'entries.:10' })[0]).toContain(
      'set jsonPath to the array ("entries") and itemRange: { start: 0, count: 10 }',
    );
  });

  it('refuses wildcards, filters and unclosed brackets with the grammar', () => {
    expect(refusal({ jsonPath: 'entries[*].amount' })).toEqual([
      "jsonPath 'entries[*].amount' is not a path a read takes: [*] is neither an array index nor a quoted key. " +
        `${GRAMMAR} — no slices, wildcards or filters. ` +
        'For a range of items, point jsonPath at the array and set itemRange: { start, count }.',
    ]);
    expect(refusal({ jsonPath: 'entries[?(@.amount > 3)]' })).toHaveLength(1);
    expect(refusal({ jsonPath: 'entries.*' })).toHaveLength(1);
    expect(refusal({ jsonPath: 'entries[3' })).toHaveLength(1);
  });

  it('admits the dotted/bracket subset the read drills with', () => {
    for (const jsonPath of [
      '',
      '$',
      'entries',
      '$.entries[3].amount',
      'entries.3',
      'a["weird.key"]',
      "a['x:y']",
      'urn:ledger',
    ]) {
      expect(refusal({ jsonPath, itemRange: { start: 0, count: 21 } }), jsonPath).toEqual([]);
    }
  });

  it('holds for memory.run_output.get, which shares the read options', () => {
    const result = MemoryRunOutputGetInputSchema.safeParse({
      path: '/run/outputs/call-1/data',
      jsonPath: 'papers[0:21]',
    });
    expect(result.success).toBe(false);
  });
});
