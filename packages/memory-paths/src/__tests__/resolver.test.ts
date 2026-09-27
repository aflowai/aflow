import { describe, it, expect } from 'vitest';
import { resolveMemoryPath, listVirtualOutputs, MemoryPathError } from '../resolver.js';
import type { PathResolveContext, ToolOutputIndex, MemoryDocRecord } from '../types.js';

function makeCtx(
  overrides: {
    index?: ToolOutputIndex | null;
    docs?: Record<string, MemoryDocRecord>;
    payloads?: Record<string, unknown>;
  } = {},
): PathResolveContext {
  const { index = null, docs = {}, payloads = {} } = overrides;
  return {
    tenantId: 'tenant-1',
    runId: 'run-1',
    spaceId: 'space-1',
    payloadStore: {
      retrieve: async (ref: string) => {
        const payload = payloads[ref];
        if (payload === undefined) throw new Error(`Not found: ${ref}`);
        return payload;
      },
    },
    memoryDocReader: {
      getByPath: async (path: string, spaceId: string) => {
        const doc = docs[path];
        if (!doc) return null;
        // Respect space isolation — only return if spaceId matches
        if (doc.spaceId && doc.spaceId !== spaceId) return null;
        return doc;
      },
    },
    toolOutputIndexReader: {
      readToolOutputIndex: async () => index,
    },
  };
}

describe('resolveMemoryPath — virtual paths', () => {
  it('resolves /run/outputs/<id>/data from enriched index', async () => {
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'gs://bucket/output.json',
          stepId: 'api-call',
          operation: 'api.http.call',
          fields: ['data', 'body'],
        },
      },
      payloads: {
        'gs://bucket/output.json': { data: 'hello world', statusCode: 200 },
      },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/data', ctx);
    expect(result.content).toBe('hello world');
    expect(result.sourceType).toBe('runOutput');
  });

  it('resolves from legacy (string) index entries', async () => {
    const ctx = makeCtx({
      index: { call_1: 'gs://bucket/output.json' },
      payloads: {
        'gs://bucket/output.json': { data: 'legacy content', statusCode: 200 },
      },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/data', ctx);
    expect(result.content).toBe('legacy content');
  });

  it('returns full output when no field pointer', async () => {
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'gs://bucket/output.json',
          stepId: 'api',
          operation: 'api.http.call',
          fields: ['data'],
        },
      },
      payloads: { 'gs://bucket/output.json': { data: 'test', statusCode: 200 } },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1', ctx);
    expect(result.content).toBe('{"data":"test","statusCode":200}');
  });

  it('resolves nested field pointer (outputFiles)', async () => {
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'ref-1',
          stepId: 'compute',
          operation: 'compute.sandbox.exec',
          fields: ['data', 'outputFiles/sub.csv'],
        },
      },
      payloads: { 'ref-1': { data: 'stdout', outputFiles: { 'sub.csv': 'a,b\n1,2' } } },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/outputFiles/sub.csv', ctx);
    expect(result.content).toBe('a,b\n1,2');
  });

  it('throws NOT_FOUND for unknown toolCallId', async () => {
    const ctx = makeCtx({ index: {} });
    await expect(resolveMemoryPath('/run/outputs/unknown/data', ctx)).rejects.toThrow(
      MemoryPathError,
    );
  });

  it('throws NOT_FOUND for unknown field with available-field hint', async () => {
    const ctx = makeCtx({
      index: { call_1: { ref: 'ref-1', stepId: 's', operation: 'o', fields: ['content'] } },
      payloads: { 'ref-1': { content: [{ type: 'text', text: 'hello' }] } },
    });
    await expect(resolveMemoryPath('/run/outputs/call_1/data', ctx)).rejects.toMatchObject({
      name: 'MemoryPathError',
      code: 'NOT_FOUND',
      message: expect.stringMatching(
        /field '\/data' not in output.*Available fields: content.*readable at \/run\/outputs\/call_1/s,
      ),
    });
  });
});

describe('resolveMemoryPath — /data MIME propagation', () => {
  function apiOutputCtx(parsedMeta: unknown): PathResolveContext {
    return makeCtx({
      index: {
        call_1: {
          ref: 'gs://bucket/output.json',
          stepId: 'api-call',
          operation: 'api.http.call',
          fields: ['data'],
        },
      },
      payloads: {
        'gs://bucket/output.json': {
          statusCode: 200,
          data: '<feed>…</feed>',
          headers: { server: 'x' },
          ...(parsedMeta !== undefined ? { parsedMeta } : {}),
        },
      },
    });
  }

  it('carries parsedMeta.contentType into mimeType for a /data read, stripping parameters', async () => {
    const ctx = apiOutputCtx({ contentType: 'application/atom+xml; charset=UTF-8' });
    const result = await resolveMemoryPath('/run/outputs/call_1/data', ctx);
    expect(result.mimeType).toBe('application/atom+xml');
  });

  it('leaves mimeType unset without parsedMeta', async () => {
    const ctx = apiOutputCtx(undefined);
    const result = await resolveMemoryPath('/run/outputs/call_1/data', ctx);
    expect(result.mimeType).toBeUndefined();
  });

  it('does not attach the body content type to non-data fields', async () => {
    const ctx = apiOutputCtx({ contentType: 'application/atom+xml' });
    const result = await resolveMemoryPath('/run/outputs/call_1/headers', ctx);
    expect(result.mimeType).toBeUndefined();
  });
});

describe('resolveMemoryPath — payload-aware pointer (Plan 186 §5.A)', () => {
  it('(a) follows a sibling <field>Ref to the FULL body (api.http.call split-value shape)', async () => {
    // api.http.call truncates the inline `data` to a preview and keeps the full
    // body in `dataRef`. The resolver must return the full body, not the preview.
    const fullBody =
      'col_a,col_b\n' + Array.from({ length: 500 }, (_, i) => `${i},${i * 2}`).join('\n');
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'gs://bucket/api-output.json',
          stepId: 'api-call',
          operation: 'api.http.call',
          fields: ['data'],
        },
      },
      payloads: {
        'gs://bucket/api-output.json': {
          data: fullBody.slice(0, 1024) + '…[truncated]',
          dataRef: 'gs://bucket/full-body.txt',
          statusCode: 200,
        },
        'gs://bucket/full-body.txt': fullBody,
      },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/data', ctx);
    expect(result.content).toBe(fullBody);
    expect(result.content).not.toContain('…[truncated]');
    expect(result.sizeBytes).toBe(Buffer.byteLength(fullBody, 'utf-8'));
  });

  it('(b) dereferences a field whose VALUE is itself a PayloadRef (outputFiles)', async () => {
    const fileBody = 'id,prediction\n1,0.9\n2,0.1';
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'gs://bucket/compute-output.json',
          stepId: 'compute',
          operation: 'compute.sandbox.exec',
          fields: ['outputFiles/submission.csv'],
        },
      },
      payloads: {
        'gs://bucket/compute-output.json': {
          outputFiles: { 'submission.csv': 'gs://bucket/submission.csv' },
        },
        'gs://bucket/submission.csv': fileBody,
      },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/outputFiles/submission.csv', ctx);
    expect(result.content).toBe(fileBody);
  });

  it('(b2) outputFiles filename fallback also derefs a PayloadRef value', async () => {
    const fileBody = 'a,b\n1,2';
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'ref-out',
          stepId: 'compute',
          operation: 'compute.sandbox.exec',
          fields: [],
        },
      },
      payloads: {
        'ref-out': { outputFiles: { 'sub.csv': 'gs://bucket/sub.csv' } },
        'gs://bucket/sub.csv': fileBody,
      },
    });

    // No `/outputFiles/` prefix — the resolver retries with it, then derefs the value.
    const result = await resolveMemoryPath('/run/outputs/call_1/sub.csv', ctx);
    expect(result.content).toBe(fileBody);
  });

  it('(c) falls back to a generic dataRef when the field is absent inline', async () => {
    const ctx = makeCtx({
      index: {
        call_1: { ref: 'ref-1', stepId: 's', operation: 'compute.sandbox.exec', fields: ['items'] },
      },
      payloads: {
        'ref-1': { dataRef: 'gs://bucket/full.json' },
        'gs://bucket/full.json': { items: [1, 2, 3], note: 'full' },
      },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/items', ctx);
    expect(result.content).toBe('[1,2,3]');
  });

  it('non-regression: a plain inline field with no sibling ref resolves verbatim', async () => {
    const ctx = makeCtx({
      index: {
        call_1: { ref: 'ref-1', stepId: 's', operation: 'api.http.call', fields: ['data'] },
      },
      payloads: { 'ref-1': { data: 'small inline body', statusCode: 200 } },
    });

    const result = await resolveMemoryPath('/run/outputs/call_1/data', ctx);
    expect(result.content).toBe('small inline body');
  });

  it('non-regression: still throws NOT_FOUND when neither field nor any ref resolves', async () => {
    const ctx = makeCtx({
      index: { call_1: { ref: 'ref-1', stepId: 's', operation: 'o', fields: ['data'] } },
      payloads: { 'ref-1': { data: 'test' } },
    });
    await expect(resolveMemoryPath('/run/outputs/call_1/nope', ctx)).rejects.toThrow(
      MemoryPathError,
    );
  });
});

describe('resolveMemoryPath — persistent paths', () => {
  it('resolves inline content from memory doc', async () => {
    const ctx = makeCtx({
      docs: {
        '/data/train.csv': {
          id: 'doc-1',
          path: '/data/train.csv',
          mimeType: 'text/csv',
          sizeBytes: 10,
          inlineContent: 'a,b\n1,2',
          payloadRef: null,
          spaceId: 'space-1',
        },
      },
    });

    const result = await resolveMemoryPath('/data/train.csv', ctx);
    expect(result.content).toBe('a,b\n1,2');
    expect(result.sourceType).toBe('memoryDoc');
    expect(result.mimeType).toBe('text/csv');
  });

  it('resolves PayloadStore content from memory doc', async () => {
    const ctx = makeCtx({
      docs: {
        '/data/big.csv': {
          id: 'doc-2',
          path: '/data/big.csv',
          mimeType: 'text/csv',
          sizeBytes: 100000,
          inlineContent: null,
          payloadRef: 'gs://bucket/big.csv',
          spaceId: 'space-1',
        },
      },
      payloads: { 'gs://bucket/big.csv': 'lots of data here' },
    });

    const result = await resolveMemoryPath('/data/big.csv', ctx);
    expect(result.content).toBe('lots of data here');
  });

  it('throws NOT_FOUND for missing doc', async () => {
    const ctx = makeCtx();
    await expect(resolveMemoryPath('/data/missing.csv', ctx)).rejects.toThrow(MemoryPathError);
  });

  it('throws NOT_FOUND for doc in different space', async () => {
    const ctx = makeCtx({
      docs: {
        '/data/other.csv': {
          id: 'doc-3',
          path: '/data/other.csv',
          mimeType: 'text/csv',
          sizeBytes: 10,
          inlineContent: 'data',
          payloadRef: null,
          spaceId: 'different-space',
        },
      },
    });
    await expect(resolveMemoryPath('/data/other.csv', ctx)).rejects.toThrow(MemoryPathError);
  });
});

describe('listVirtualOutputs', () => {
  it('lists enriched tool outputs', async () => {
    const ctx = makeCtx({
      index: {
        call_1: {
          ref: 'ref-1',
          stepId: 'api-step',
          operation: 'api.http.call',
          fields: ['data', 'body'],
        },
        call_2: {
          ref: 'ref-2',
          stepId: 'compute-step',
          operation: 'compute.sandbox.exec',
          fields: ['data', 'outputFiles/sub.csv'],
        },
      },
    });

    const entries = await listVirtualOutputs(ctx);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe('call_1');
    expect(entries[0]!.metadata?.operation).toBe('api.http.call');
    expect(entries[1]!.metadata?.fields).toContain('outputFiles/sub.csv');
  });

  it('returns empty array when no index', async () => {
    const ctx = makeCtx();
    const entries = await listVirtualOutputs(ctx);
    expect(entries).toHaveLength(0);
  });
});
