/**
 * Contract: an operation that returns a look at a browser page declares it as
 * an observation of that page, so the agent turn keeps only the newest look
 * per page in full. A new operation returning an outline or a snapshot that
 * forgets the declaration would put every one of its results in context for
 * the rest of the conversation.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OperationObservationSchema,
  observationKeyOf,
  withoutObservedFields,
} from '../../runtime/toolObservation.js';
import { getAllOperations, getOperation } from '../registry.js';

const PAGE_OBSERVATION = {
  role: 'observes',
  group: 'browser.page',
  keyPath: 'pageId',
  observedFields: [
    'outline',
    'outlineCensus',
    'snapshot',
    'snapshotCensus',
    'text',
    'console',
    'network',
  ],
  currentStateOperation: 'browser.page.snapshot',
};

function outputFieldsOf(operationId: string): string[] {
  const output = getOperation(operationId)?.outputZod;
  return output instanceof z.ZodObject ? Object.keys(output.shape as Record<string, unknown>) : [];
}

describe('browser page observation declarations', () => {
  it.each([
    'browser.page.open',
    'browser.page.navigate',
    'browser.page.act',
    'browser.page.snapshot',
    'browser.page.read',
    'browser.page.handoff',
  ])('%s observes the page at pageId', (operationId) => {
    expect(getOperation(operationId)?.observation).toEqual(PAGE_OBSERVATION);
  });

  it('browser.page.close ends the page at pageId', () => {
    expect(getOperation('browser.page.close')?.observation).toEqual({
      role: 'ends',
      group: 'browser.page',
      keyPath: 'pageId',
    });
  });

  it('every browser.page operation returning an outline or a snapshot declares it', () => {
    const undeclared = [...getAllOperations().values()]
      .filter((op) => op.operationId.startsWith('browser.page.'))
      .filter((op) => {
        const fields = outputFieldsOf(op.operationId);
        return fields.includes('outline') || fields.includes('snapshot');
      })
      .filter((op) => op.observation?.role !== 'observes')
      .map((op) => op.operationId);
    expect(undeclared).toEqual([]);
  });

  it('every declaration names a key and observed fields its output has', () => {
    for (const op of getAllOperations().values()) {
      if (op.observation === undefined) continue;
      const fields = outputFieldsOf(op.operationId);
      expect(fields, op.operationId).toContain(op.observation.keyPath.split('.')[0]);
      if (op.observation.role === 'observes') {
        expect(
          op.observation.observedFields.some((field) => fields.includes(field)),
          op.operationId,
        ).toBe(true);
        expect(getOperation(op.observation.currentStateOperation), op.operationId).toBeDefined();
      }
    }
  });
});

describe('OperationObservationSchema', () => {
  it('refuses an observed field named twice and a path that is not property names', () => {
    expect(
      OperationObservationSchema.safeParse({ ...PAGE_OBSERVATION, observedFields: ['a', 'a'] })
        .success,
    ).toBe(false);
    expect(
      OperationObservationSchema.safeParse({ ...PAGE_OBSERVATION, keyPath: 'pages[].id' }).success,
    ).toBe(false);
    expect(
      OperationObservationSchema.safeParse({ role: 'ends', group: 'g', keyPath: 'a.b' }).success,
    ).toBe(true);
  });
});

describe('observationKeyOf and withoutObservedFields', () => {
  it('reads the key at a dotted path, and nothing that is not a key', () => {
    expect(observationKeyOf({ pageId: 'pg_1' }, 'pageId')).toBe('pg_1');
    expect(observationKeyOf({ page: { id: 7 } }, 'page.id')).toBe('7');
    expect(observationKeyOf({ pageId: '' }, 'pageId')).toBeUndefined();
    expect(observationKeyOf({ pageId: { id: 'x' } }, 'pageId')).toBeUndefined();
    expect(observationKeyOf({}, 'pageId')).toBeUndefined();
  });

  it('drops only the observed top-level fields, in place', () => {
    expect(
      withoutObservedFields({ pageId: 'pg_1', outline: '- main', url: 'u', receipt: { a: 1 } }, [
        'outline',
        'snapshot',
      ]),
    ).toEqual({ pageId: 'pg_1', url: 'u', receipt: { a: 1 } });
  });
});
