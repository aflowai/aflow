import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';

const mockFetch = vi.fn();
vi.mock('./providers/jina.js', () => ({
  JinaFetchProvider: class {
    name = 'jina';
    fetch = (...args: unknown[]) => mockFetch(...args);
  },
  JinaFetchError: class extends Error {
    retryable = false;
  },
}));

const mockSaveBytes = vi.fn();
vi.mock('@aflow/memory-store', () => ({
  saveBytesToMemoryDoc: (...args: unknown[]) => mockSaveBytes(...args),
  runOrigin: (ctx: { runId: string; stepExecutionId: string; job: { stepId?: string } }) => ({
    kind: 'run',
    runId: ctx.runId,
    stepExecutionId: ctx.stepExecutionId,
    stepId: ctx.job.stepId,
  }),
  MemoryWriteDeniedError: class extends Error {},
}));

const { SearchHandler } = await import('./SearchHandler.js');
const { MAX_EXTRACTED_CONTENT_CHARS } = await import('./providers/types.js');

const FULL_CONTENT = 'x'.repeat(120_000);

function makeCtx(operationId: string, input: Record<string, unknown>): ExecutorContext {
  return {
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepExecutionId: 'se-1',
    attempt: 1,
    operationId,
    job: {
      stepId: 'fetch-1',
      spaceId: 'space-1',
      tenantId: 'tenant-1',
      credentialOwnerId: 'user-1',
      inputRef: 'inline:e30=',
    },
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readPayload: async () => input,
    writePayload: async (_kind: unknown, data: unknown) =>
      `inline:${Buffer.from(JSON.stringify(data)).toString('base64')}`,
  } as unknown as ExecutorContext;
}

function makeHandler(withDeps = true) {
  return new SearchHandler({
    credentialResolver: { resolve: async () => null } as never,
    ...(withDeps ? { db: {} as never, payloadStore: {} as never } : {}),
  });
}

function decodeOutput(result: { outputRef?: string | undefined }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from((result.outputRef as string).replace(/^inline:/, ''), 'base64').toString(),
  ) as Record<string, unknown>;
}

describe('search.web.download', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockSaveBytes.mockReset();
    mockFetch.mockResolvedValue({
      content: FULL_CONTENT,
      url: 'https://example.com/spec',
      wordCount: 120_000,
      truncated: false,
      durationMs: 100,
    });
    mockSaveBytes.mockResolvedValue({ savedTo: '/refs/spec.md', sizeBytes: 120_000 });
  });

  it('saves the FULL content and returns metadata without inline content', async () => {
    const result = await makeHandler().execute(
      makeCtx('search.web.download', {
        url: 'https://example.com/spec',
        toMemoryPath: '/refs/spec.md',
      }),
    );

    // Provider asked for the extraction cap, not an inline/token budget.
    expect(mockFetch.mock.calls[0]![0]).toMatchObject({
      maxContentLength: MAX_EXTRACTED_CONTENT_CHARS,
    });

    // The saved content is the full text, vouched as text so a path named
    // after a binary-looking URL can never land on the binary lane.
    const saveArgs = mockSaveBytes.mock.calls[0]![0] as {
      content: { kind: string; text: string };
      path: string;
      tags: string[];
    };
    expect(saveArgs.path).toBe('/refs/spec.md');
    expect(saveArgs.content.kind).toBe('text');
    expect(saveArgs.content.text.length).toBe(FULL_CONTENT.length);
    expect(saveArgs.tags).toEqual(['web_fetch']);

    const output = decodeOutput(result);
    expect(output['savedTo']).toBe('/refs/spec.md');
    expect(output['sizeBytes']).toBe(120_000);
    expect(output['content']).toBeUndefined();
  });

  it('search.web.fetch never writes memory — a stray toMemoryPath is inert', async () => {
    const result = await makeHandler().execute(
      makeCtx('search.web.fetch', {
        url: 'https://example.com/page',
        toMemoryPath: '/refs/page.md',
      }),
    );
    expect(mockSaveBytes).not.toHaveBeenCalled();
    // Provider got the caller's inline budget (schema default 50000).
    expect(mockFetch.mock.calls[0]![0]).toMatchObject({ maxContentLength: 50_000 });
    const output = decodeOutput(result);
    expect(output['savedTo']).toBeUndefined();
    expect(typeof output['content']).toBe('string');
  });

  it('refuses to save a provider-truncated extraction instead of persisting a partial copy', async () => {
    mockFetch.mockResolvedValue({
      content: FULL_CONTENT,
      url: 'https://example.com/huge',
      wordCount: 1,
      truncated: true,
      durationMs: 100,
    });
    const result = await makeHandler().execute(
      makeCtx('search.web.download', {
        url: 'https://example.com/huge',
        toMemoryPath: '/refs/huge.md',
      }),
    );
    expect(result.status).toBe('FAILED');
    expect(mockSaveBytes).not.toHaveBeenCalled();
  });

  it('fails with a clear misconfiguration error when save deps are absent', async () => {
    const result = await makeHandler(false).execute(
      makeCtx('search.web.download', {
        url: 'https://example.com/spec',
        toMemoryPath: '/refs/spec.md',
      }),
    );
    expect(result.status).toBe('FAILED');
  });
});
