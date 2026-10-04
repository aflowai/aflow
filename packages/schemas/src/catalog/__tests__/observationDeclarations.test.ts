/**
 * Contract: an operation that returns a look at a browser page declares the
 * facets of the page its result holds, so the agent turn reduces an earlier
 * look only in what a later one replaced. A new operation returning an
 * outline, a snapshot, text, console or network that forgets the declaration
 * would put every one of its results in context for the rest of the
 * conversation; one that names a path its output lacks would never be reduced.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OperationObservationSchema,
  observationKeyOf,
  toolResultObservationOf,
  withoutObservedFields,
  type OperationObservation,
} from '../../runtime/toolObservation.js';
import { getAllOperations, getOperation } from '../registry.js';

const OBSERVED_OUTPUTS = ['outline', 'snapshot', 'text', 'console', 'network'];

function unwrap(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current._def.innerType as z.ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

/** The schema at a dotted path of an operation's output, when every segment is a property. */
function outputSchemaAt(operationId: string, path: string): z.ZodTypeAny | undefined {
  let current: z.ZodTypeAny | undefined = getOperation(operationId)?.outputZod;
  for (const segment of path.split('.')) {
    const object = unwrap(current);
    if (!(object instanceof z.ZodObject)) return undefined;
    current = (object.shape as Record<string, z.ZodTypeAny>)[segment];
  }
  return current;
}

const declared = () =>
  [...getAllOperations().values()].flatMap((op) =>
    op.observation !== undefined ? [{ operationId: op.operationId, ...op.observation }] : [],
  );

describe('browser page observation declarations', () => {
  it('declares each operation by the facets of the page it holds', () => {
    const facetsOf = (operationId: string) =>
      getOperation(operationId)?.observation?.facets?.map((facet) => facet.facet);
    expect(facetsOf('browser.page.open')).toEqual(['outline']);
    expect(facetsOf('browser.page.navigate')).toEqual(['outline']);
    expect(facetsOf('browser.page.act')).toEqual(['outline']);
    expect(facetsOf('browser.page.handoff')).toEqual(['outline']);
    expect(facetsOf('browser.page.snapshot')).toEqual(['snapshot', 'outline']);
    expect(facetsOf('browser.page.read')).toEqual(['read']);
    expect(getOperation('browser.page.close')?.observation).toEqual({
      group: 'browser.page',
      ends: ['pageId'],
    });
  });

  it('moves the page on a navigation or an action whose receipt says the address changed', () => {
    const moving = declared()
      .filter((d) => d.moves !== undefined)
      .map((d) => [d.operationId, d.moves]);
    expect(moving).toEqual([
      ['browser.page.navigate', { keyPath: 'pageId', whenTrueAt: 'receipt.urlChanged' }],
      ['browser.page.act', { keyPath: 'pageId', whenTrueAt: 'receipt.urlChanged' }],
    ]);
  });

  it('ends the page a hand-off replaced', () => {
    expect(getOperation('browser.page.handoff')?.observation?.ends).toEqual(['previousPageId']);
  });

  it('declares a facet for every browser.page output that holds a look at the page', () => {
    const undeclared = [...getAllOperations().values()]
      .filter((op) => op.operationId.startsWith('browser.page.'))
      .flatMap((op) =>
        OBSERVED_OUTPUTS.filter((field) => outputSchemaAt(op.operationId, field) !== undefined)
          .filter((field) => !op.observation?.facets?.some((f) => f.fields.includes(field)))
          .map((field) => `${op.operationId}.${field}`),
      );
    expect(undeclared).toEqual([]);
  });

  it('names only paths the output has, and a move flag that is a boolean', () => {
    for (const d of declared()) {
      const paths = [
        ...(d.facets ?? []).flatMap((facet) => [
          ...facet.fields,
          facet.keyPath,
          ...(facet.partKeyPaths ?? []),
          ...(facet.onlyWhenAbsent !== undefined ? [facet.onlyWhenAbsent] : []),
          ...(facet.expires === 'on_covering_look' ? facet.withheldAt : []),
        ]),
        ...(d.moves !== undefined ? [d.moves.keyPath, d.moves.whenTrueAt] : []),
        ...(d.ends ?? []),
      ];
      for (const path of paths) {
        expect(outputSchemaAt(d.operationId, path), `${d.operationId} ${path}`).toBeDefined();
      }
      if (d.moves !== undefined) {
        expect(unwrap(outputSchemaAt(d.operationId, d.moves.whenTrueAt))).toBeInstanceOf(
          z.ZodBoolean,
        );
      }
      for (const facet of d.facets ?? []) {
        expect(getOperation(facet.currentStateOperation), d.operationId).toBeDefined();
      }
    }
  });

  it('lets a later look replace an outline or a snapshot, and a read only when it covers it', () => {
    const expiry = declared().flatMap((d) =>
      (d.facets ?? []).map((facet) => [
        d.operationId,
        facet.facet,
        facet.expires,
        ...(facet.expires === 'on_covering_look' ? [facet.withheldAt] : []),
      ]),
    );
    expect(expiry).toEqual([
      ['browser.page.open', 'outline', 'on_any_later_look'],
      ['browser.page.navigate', 'outline', 'on_any_later_look'],
      ['browser.page.act', 'outline', 'on_any_later_look'],
      ['browser.page.snapshot', 'snapshot', 'on_any_later_look'],
      ['browser.page.snapshot', 'outline', 'on_any_later_look'],
      ['browser.page.read', 'read', 'on_covering_look', ['withheld', 'notRetained']],
      ['browser.page.handoff', 'outline', 'on_any_later_look'],
    ]);
  });

  it('gives one facet of a group the same part keys, expiry and current-state operation everywhere', () => {
    const seen = new Map<string, string>();
    for (const d of declared()) {
      for (const facet of d.facets ?? []) {
        const shape = JSON.stringify([
          facet.partKeyPaths ?? [],
          facet.expires,
          facet.currentStateOperation,
        ]);
        const id = `${d.group} ${facet.facet}`;
        expect(seen.get(id) ?? shape, `${d.operationId} ${id}`).toBe(shape);
        seen.set(id, shape);
      }
    }
  });
});

const summarize = (shown: unknown) => JSON.stringify(shown);
const anyLaterLook = {
  keyPath: 'id',
  expires: 'on_any_later_look',
  currentStateOperation: 'op',
} as const;
const snapshot = getOperation('browser.page.snapshot')!.observation!;
const read = getOperation('browser.page.read')!.observation!;

describe('toolResultObservationOf', () => {
  it('stamps a whole-page snapshot as the page’s snapshot and its outline, with one receipt', () => {
    const output = {
      pageId: 'pg_1',
      url: 'u',
      snapshot: '- main',
      receipt: { lines: 1, cut: false },
    };
    const stamp = toolResultObservationOf(snapshot, output, summarize)!;
    expect(stamp.facets.map((f) => [f.facet, f.part, f.fields])).toEqual([
      ['snapshot', [{ path: 'receipt.ref', value: '' }], ['snapshot']],
      ['outline', [], ['snapshot']],
    ]);
    expect(stamp.receipts).toEqual([
      { without: ['snapshot'], text: summarize(withoutObservedFields(output, ['snapshot'])) },
    ]);
  });

  it('stamps a scoped snapshot as that element’s snapshot alone', () => {
    const output = {
      pageId: 'pg_1',
      snapshot: '- list',
      receipt: { ref: 'e40', lines: 1, cut: false },
    };
    const stamp = toolResultObservationOf(snapshot, output, summarize)!;
    expect(stamp.facets.map((f) => [f.facet, f.part])).toEqual([
      ['snapshot', [{ path: 'receipt.ref', value: 'e40' }]],
    ]);
  });

  it('keys a text read by kind, offset and filter, and a console read by kind and filter', () => {
    const text = toolResultObservationOf(
      read,
      { pageId: 'pg_1', what: 'text', contains: 'retry', text: 'abc', offset: 8000, withheld: 0 },
      summarize,
    )!;
    expect(text.facets[0]!.part.map((p) => p.value)).toEqual(['text', '8000', 'retry']);
    expect(text.facets[0]!.fields).toEqual(['text']);
    const console = toolResultObservationOf(
      read,
      { pageId: 'pg_1', what: 'console', contains: '', console: [], withheld: 0 },
      summarize,
    )!;
    expect(console.facets[0]!.part.map((p) => p.value)).toEqual(['console', '', '']);
  });

  it('stamps what a read does not show, its withheld and notRetained, and no count on an outline or a snapshot', () => {
    const stampOf = (declaration: OperationObservation, output: unknown) =>
      toolResultObservationOf(declaration, output, summarize)!.facets.map((f) =>
        f.expires === 'on_covering_look' ? [f.expires, f.withheld] : [f.expires],
      );
    const cutText = { pageId: 'pg_1', what: 'text', contains: '', text: 'a', offset: 0 };
    expect(stampOf(read, { ...cutText, withheld: 24_000, nextOffset: 8_000 })).toEqual([
      ['on_covering_look', 24_000],
    ]);
    expect(stampOf(read, { ...cutText, withheld: 0 })).toEqual([['on_covering_look', 0]]);
    const entries = { pageId: 'pg_1', what: 'console', contains: '', console: [], withheld: 0 };
    expect(stampOf(read, { ...entries, notRetained: 40 })).toEqual([['on_covering_look', 40]]);
    expect(stampOf(read, { ...entries, withheld: 3, notRetained: 40 })).toEqual([
      ['on_covering_look', 43],
    ]);
    const whole = { pageId: 'pg_1', snapshot: '- main', receipt: { lines: 1, cut: true } };
    expect(stampOf(snapshot, { ...whole, snapshotCensus: { link: 30, heading: 4 } })).toEqual([
      ['on_any_later_look'],
      ['on_any_later_look'],
    ]);
    const open = getOperation('browser.page.open')!.observation!;
    expect(stampOf(open, { pageId: 'pg_1', outline: '-', outlineCensus: { button: 2 } })).toEqual([
      ['on_any_later_look'],
    ]);
  });

  it('adds up counts by kind, at every path a covering facet names', () => {
    const declaration: OperationObservation = {
      group: 'thing',
      facets: [
        {
          facet: 'a',
          fields: ['x'],
          keyPath: 'id',
          expires: 'on_covering_look',
          withheldAt: ['census', 'dropped'],
          currentStateOperation: 'op',
        },
      ],
    };
    const withheld = (output: unknown) =>
      toolResultObservationOf(declaration, output, summarize)!.facets[0];
    expect(withheld({ id: 't', x: 1, census: { link: 30, heading: 4 } })).toMatchObject({
      withheld: 34,
    });
    expect(withheld({ id: 't', x: 1, census: { link: 30 }, dropped: 6 })).toMatchObject({
      withheld: 36,
    });
    expect(withheld({ id: 't', x: 1 })).toMatchObject({ withheld: 0 });
  });

  it('keeps a field another facet still holds, and stores one receipt per set that can go', () => {
    const declaration: OperationObservation = {
      group: 'thing',
      facets: [
        { ...anyLaterLook, facet: 'a', fields: ['x', 'y'] },
        { ...anyLaterLook, facet: 'b', fields: ['y', 'z'] },
      ],
    };
    const stamp = toolResultObservationOf(declaration, { id: 't', x: 1, y: 2, z: 3 }, summarize)!;
    expect(stamp.receipts.map((r) => r.without)).toEqual([['x'], ['z'], ['x', 'y', 'z']]);
  });

  it('stamps nothing for an output with no key, and moves only on true', () => {
    const act = getOperation('browser.page.act')!.observation!;
    expect(toolResultObservationOf(act, { outline: '- main' }, summarize)).toBeUndefined();
    const stayed = { pageId: 'pg_1', outline: '-', receipt: { urlChanged: false } };
    expect(toolResultObservationOf(act, stayed, summarize)!.moved).toEqual([]);
    const moved = { ...stayed, receipt: { urlChanged: true } };
    expect(toolResultObservationOf(act, moved, summarize)!.moved).toEqual(['pg_1']);
  });
});

describe('OperationObservationSchema', () => {
  const facet = {
    facet: 'outline',
    fields: ['outline'],
    keyPath: 'pageId',
    expires: 'on_any_later_look',
    currentStateOperation: 'op',
  };

  it('refuses a declaration with nothing in it, a field named twice, and a path that is not property names', () => {
    expect(OperationObservationSchema.safeParse({ group: 'g' }).success).toBe(false);
    expect(
      OperationObservationSchema.safeParse({
        group: 'g',
        facets: [{ ...facet, fields: ['a', 'a'] }],
      }).success,
    ).toBe(false);
    expect(
      OperationObservationSchema.safeParse({
        group: 'g',
        facets: [{ ...facet, keyPath: 'pages[].id' }],
      }).success,
    ).toBe(false);
    expect(OperationObservationSchema.safeParse({ group: 'g', ends: ['a.b'] }).success).toBe(true);
  });

  it('refuses a facet that does not say when it expires, and a covering one without its count', () => {
    const { expires: _expires, ...undeclared } = facet;
    expect(OperationObservationSchema.safeParse({ group: 'g', facets: [undeclared] }).success).toBe(
      false,
    );
    const covering = { ...facet, expires: 'on_covering_look' };
    expect(OperationObservationSchema.safeParse({ group: 'g', facets: [covering] }).success).toBe(
      false,
    );
    expect(
      OperationObservationSchema.safeParse({
        group: 'g',
        facets: [{ ...covering, withheldAt: [] }],
      }).success,
    ).toBe(false);
    expect(
      OperationObservationSchema.safeParse({
        group: 'g',
        facets: [{ ...covering, withheldAt: ['withheld'] }],
      }).success,
    ).toBe(true);
    expect(
      OperationObservationSchema.safeParse({
        group: 'g',
        facets: [{ ...facet, withheldAt: ['withheld'] }],
      }).success,
    ).toBe(false);
  });

  it('refuses more facets than it stores receipts for', () => {
    expect(
      OperationObservationSchema.safeParse({ group: 'g', facets: Array(5).fill(facet) }).success,
    ).toBe(false);
  });
});

describe('observationKeyOf', () => {
  it('reads the key at a dotted path, and nothing that is not a key', () => {
    expect(observationKeyOf({ pageId: 'pg_1' }, 'pageId')).toBe('pg_1');
    expect(observationKeyOf({ page: { id: 7 } }, 'page.id')).toBe('7');
    expect(observationKeyOf({ pageId: '' }, 'pageId')).toBeUndefined();
    expect(observationKeyOf({ pageId: { id: 'x' } }, 'pageId')).toBeUndefined();
    expect(observationKeyOf({}, 'pageId')).toBeUndefined();
  });
});
