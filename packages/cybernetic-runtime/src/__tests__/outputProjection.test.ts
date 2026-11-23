import { describe, expect, it, vi } from 'vitest';
import type { WorkflowTaskOutputProjection } from '@aflow/schemas';
import { loadProjectionSource, projectTaskOutput } from '../scheduling/outputProjection.js';

const KAGGLE_RAW = {
  status: 'COMPLETE',
  content: [{ type: 'text', text: '{"publicScore":"0.124","createUrl":"https://k/le"}' }],
};

describe('projectTaskOutput — path pipeline', () => {
  it('projects a plain path', () => {
    const result = projectTaskOutput(
      { status: { path: 'status', onMissing: 'error' } } as WorkflowTaskOutputProjection,
      KAGGLE_RAW,
      null,
    );
    expect(result).toEqual({ ok: true, value: { status: 'COMPLETE' } });
  });

  it('applies json → select → number in fixed order (Kaggle publicScore shape)', () => {
    const result = projectTaskOutput(
      {
        lbValue: {
          path: 'content[0].text',
          parse: ['json', 'number'],
          select: 'publicScore',
          onMissing: 'error',
        },
      } as WorkflowTaskOutputProjection,
      KAGGLE_RAW,
      null,
    );
    expect(result).toEqual({ ok: true, value: { lbValue: 0.124 } });
  });

  it('applies json → select without number (URL extraction)', () => {
    const result = projectTaskOutput(
      {
        createUrl: {
          path: 'content[0].text',
          parse: ['json'],
          select: 'createUrl',
          onMissing: 'error',
        },
      } as WorkflowTaskOutputProjection,
      KAGGLE_RAW,
      null,
    );
    expect(result).toEqual({ ok: true, value: { createUrl: 'https://k/le' } });
  });

  it('coerces a top-level numeric string with parse: [number]', () => {
    const result = projectTaskOutput(
      { n: { path: 'score', parse: ['number'], onMissing: 'error' } },
      { score: ' 42.5 ' },
      null,
    );
    expect(result).toEqual({ ok: true, value: { n: 42.5 } });
  });

  it('passes through an already-numeric value under parse: [number]', () => {
    const result = projectTaskOutput(
      { n: { path: 'score', parse: ['number'], onMissing: 'error' } },
      { score: 7 },
      null,
    );
    expect(result).toEqual({ ok: true, value: { n: 7 } });
  });
});

describe('projectTaskOutput — onMissing semantics', () => {
  it("onMissing: 'error' fails loud with field + source", () => {
    const result = projectTaskOutput(
      {
        lbValue: {
          path: 'content[0].text',
          parse: ['json', 'number'],
          select: 'publicScore',
          onMissing: 'error',
        },
      },
      { status: 'PENDING', content: [{ type: 'text', text: '{"status":"PENDING"}' }] },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.field).toBe('lbValue');
    expect(result.failures[0]!.source).toContain('content[0].text');
    expect(result.failures[0]!.source).toContain('publicScore');
  });

  it("onMissing: 'null' sets the field to null (legitimately-absent terminal value)", () => {
    const result = projectTaskOutput(
      {
        status: { path: 'status', onMissing: 'error' },
        lbValue: {
          path: 'content[0].text',
          parse: ['json', 'number'],
          select: 'publicScore',
          onMissing: 'null',
        },
      },
      { status: 'ERROR', content: [{ type: 'text', text: '{"status":"ERROR"}' }] },
      null,
    );
    expect(result).toEqual({ ok: true, value: { status: 'ERROR', lbValue: null } });
  });

  it('invalid JSON, non-numeric strings, and missing paths all take the onMissing route', () => {
    const projection: WorkflowTaskOutputProjection = {
      a: { path: 'notThere', onMissing: 'null' },
      b: { path: 'badJson', parse: ['json'], onMissing: 'null' },
      c: { path: 'notANumber', parse: ['number'], onMissing: 'null' },
    };
    const result = projectTaskOutput(projection, { badJson: '{nope', notANumber: 'abc' }, null);
    expect(result).toEqual({ ok: true, value: { a: null, b: null, c: null } });
  });

  it('collects ALL failures (allErrors), not just the first', () => {
    const result = projectTaskOutput(
      {
        a: { path: 'x', onMissing: 'error' },
        b: { path: 'y', onMissing: 'error' },
      },
      {},
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.field).sort()).toEqual(['a', 'b']);
  });

  it('an explicit null resolved from a plain path is kept as null (present value)', () => {
    const result = projectTaskOutput(
      { v: { path: 'maybe', onMissing: 'error' } },
      { maybe: null },
      null,
    );
    expect(result).toEqual({ ok: true, value: { v: null } });
  });
});

describe('projectTaskOutput — fromInput echo', () => {
  it('echoes a resolved input value into the output', () => {
    const result = projectTaskOutput(
      {
        submissionId: { fromInput: 'submissionId' },
        status: { path: 'status', onMissing: 'error' },
      },
      KAGGLE_RAW,
      { submissionId: 'sub-42' },
    );
    expect(result).toEqual({
      ok: true,
      value: { submissionId: 'sub-42', status: 'COMPLETE' },
    });
  });

  it('fails loud when the named input did not resolve', () => {
    const result = projectTaskOutput({ submissionId: { fromInput: 'submissionId' } }, KAGGLE_RAW, {
      other: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]!.source).toBe('fromInput:submissionId');
  });

  it('fails loud when the resolved input is unavailable entirely', () => {
    const result = projectTaskOutput(
      { submissionId: { fromInput: 'submissionId' } },
      KAGGLE_RAW,
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]!.reason).toContain('unavailable');
  });
});

describe('projectTaskOutput — offloaded api.http.call body', () => {
  const BODY_REF = 'gs://bucket/t/run/read-universe-bars/1/body.json';
  const FULL_BODY = {
    bars: { AAPL: [{ c: 190.1 }], MSFT: [{ c: 410.2 }] },
    next_page_token: null,
  };
  const OFFLOADED_RAW = {
    statusCode: 200,
    data: {
      _note: 'Shape sample only, not the response body. The full body is behind dataRef.',
      _type: 'object',
      _keys: ['bars', 'next_page_token'],
      _sample: { bars: '{Object(2 keys)}', next_page_token: null },
    },
    dataRef: BODY_REF,
    truncated: true,
    originalSizeBytes: 226_000,
  };
  const PROJECTION = {
    bars: { path: 'data.bars', onMissing: 'error' },
  } as WorkflowTaskOutputProjection;

  function storeOf(body: unknown) {
    return {
      retrieve: vi.fn((ref: string) =>
        ref === BODY_REF ? Promise.resolve(body) : Promise.reject(new Error('no payload')),
      ),
    };
  }

  it('resolves the path field against the dereferenced body, not the inline sample', async () => {
    const store = storeOf(FULL_BODY);
    const source = await loadProjectionSource(PROJECTION, OFFLOADED_RAW, store);
    expect(store.retrieve).toHaveBeenCalledWith(BODY_REF);
    expect(projectTaskOutput(PROJECTION, source, null)).toEqual({
      ok: true,
      value: { bars: FULL_BODY.bars },
    });
  });

  it('does not resolve the path on the inline sample alone', () => {
    const result = projectTaskOutput(PROJECTION, OFFLOADED_RAW, null);
    expect(result.ok).toBe(false);
  });

  it('leaves the raw output alone when no path field reads data', async () => {
    const store = storeOf(FULL_BODY);
    const projection = {
      status: { path: 'statusCode', onMissing: 'error' },
    } as WorkflowTaskOutputProjection;
    const source = await loadProjectionSource(projection, OFFLOADED_RAW, store);
    expect(source).toBe(OFFLOADED_RAW);
    expect(store.retrieve).not.toHaveBeenCalled();
  });

  it('leaves an inline output alone', async () => {
    const store = storeOf(FULL_BODY);
    const inline = { statusCode: 200, data: FULL_BODY };
    expect(await loadProjectionSource(PROJECTION, inline, store)).toBe(inline);
    expect(store.retrieve).not.toHaveBeenCalled();
  });

  it('throws when the offloaded body cannot be retrieved', async () => {
    const store = storeOf(FULL_BODY);
    await expect(
      loadProjectionSource(PROJECTION, { ...OFFLOADED_RAW, dataRef: 'gs://missing' }, store),
    ).rejects.toThrow('no payload');
  });
});
