/**
 * Contract: memory.store.collect reads every named document whole and marks
 * each one the space cannot give as missing, and the read still succeeds. A
 * JSON document arrives parsed. Only a store that cannot be reached fails it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  MemoryCollectInputSchema,
  type OperationId,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import { handleCollect } from '../memory/handlers/collect.js';

function ctx(): ExecutorContext {
  return {
    tenantId: 'tenant-1' as TenantId,
    runId: 'run-1' as SessionId,
    stepExecutionId: 'step-1' as StepExecutionId,
    attempt: 1,
    operationId: 'memory.store.collect' as OperationId,
    job: { spaceId: 'space-1' },
    writePayload: vi.fn(async () => 'payload:out' as PayloadRef),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

function written(context: ExecutorContext): unknown {
  const calls = (context.writePayload as ReturnType<typeof vi.fn>).mock.calls;
  return calls.find((call) => call[0] === 'output')?.[1];
}

const doc = (path: string, docType: string, inlineContent: string | null, payloadRef?: string) => ({
  path,
  docType,
  mimeType: docType === 'json' ? 'application/json' : 'text/markdown',
  inlineContent,
  payloadRef: payloadRef ?? null,
});

const DOCS = [
  doc('/cycles/2026-07-14-after_close.json', 'json', '{"slot":"after_close"}'),
  doc('/cycles/2026-07-14-open.json', 'json', '{"slot":"open"}'),
  doc('/cycles/2026-07-140-other.json', 'json', '{"slot":"none"}'),
  doc('/journal/2026-07-13.md', 'markdown', '# 13'),
  doc('/journal/2026-07-10.md', 'markdown', null, 'payload:expired'),
];

interface ListCall {
  pathPrefix: string;
  pathStartsWith?: string;
  pathBefore?: string;
  order?: 'asc' | 'desc';
  limit: number;
}

/** The repository's listing: pathPrefix canonicalized as the database does, then the exact bounds. */
function repo(docs = DOCS) {
  return {
    list: vi.fn(async (call: ListCall) => {
      const rows = docs
        .filter((d) => d.path.startsWith(call.pathPrefix.replace(/\/$/, '')))
        .filter((d) => call.pathStartsWith === undefined || d.path.startsWith(call.pathStartsWith))
        .filter((d) => call.pathBefore === undefined || d.path < call.pathBefore)
        .sort((a, b) => a.path.localeCompare(b.path));
      if (call.order === 'desc') rows.reverse();
      return rows.slice(0, call.limit);
    }),
    getByPath: vi.fn(async (path: string) => docs.find((d) => d.path === path) ?? null),
  };
}

const payloadStore = {
  exists: vi.fn(async () => false),
  retrieve: vi.fn(async () => {
    throw new Error('payload not found');
  }),
};

const INPUT = MemoryCollectInputSchema.parse({
  sources: [
    { key: 'cycles', pathPrefix: '/cycles/2026-07-14-' },
    { key: 'snapshot', path: '/snapshots/2026-07-14-after_close.json' },
    { key: 'journal', pathPrefix: '/journal/', order: 'desc', limit: 5 },
  ],
});

describe('memory.store.collect — the day read by code', () => {
  it('reads every named document whole and marks the ones the space cannot give', async () => {
    const context = ctx();
    const result = await handleCollect(context, repo() as never, INPUT, {
      spaceId: 'space-1',
      payloadStore,
    } as never);
    expect(result.status).toBe('SUCCEEDED');
    const output = written(context) as Record<string, unknown>;
    expect(output['docs']).toEqual({
      cycles: [
        {
          path: '/cycles/2026-07-14-after_close.json',
          docType: 'json',
          content: { slot: 'after_close' },
        },
        { path: '/cycles/2026-07-14-open.json', docType: 'json', content: { slot: 'open' } },
      ],
      snapshot: {
        path: '/snapshots/2026-07-14-after_close.json',
        missing: true,
        reason: 'No document at this path.',
      },
      journal: [
        { path: '/journal/2026-07-13.md', docType: 'markdown', content: '# 13' },
        {
          path: '/journal/2026-07-10.md',
          missing: true,
          reason: expect.stringContaining('MEMORY_PAYLOAD_EXPIRED') as unknown as string,
        },
      ],
    });
    expect(output['found']).toEqual({ cycles: 2, snapshot: 0, journal: 1 });
    expect(output['missing']).toEqual([
      '/snapshots/2026-07-14-after_close.json',
      '/journal/2026-07-10.md',
    ]);
  });

  it('fails where the store cannot be reached', async () => {
    const failing = {
      list: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
      getByPath: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    };
    await expect(
      handleCollect(ctx(), failing as never, INPUT, { spaceId: 'space-1', payloadStore } as never),
    ).rejects.toThrow('connection terminated');
  });

  it('fails where the payload store holding a body does not answer, never marking it missing', async () => {
    const outage = {
      exists: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      }),
      retrieve: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      }),
    };
    const context = ctx();
    const result = await handleCollect(context, repo() as never, INPUT, {
      spaceId: 'space-1',
      payloadStore: outage,
    } as never);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toMatch(
      /^MEMORY_PAYLOAD_UNREACHABLE: .*\/journal\/2026-07-10\.md/,
    );
    expect(result.error?.retryable).toBe(true);
    expect(written(context)).toBeUndefined();
  });

  it('asks the repository for the bounded, ordered prefix, so the scan holds only its own paths', async () => {
    const store = repo();
    const context = ctx();
    await handleCollect(
      context,
      store as never,
      MemoryCollectInputSchema.parse({
        sources: [
          {
            key: 'journal',
            pathPrefix: '/journal/',
            before: '/journal/2026-07-13',
            updatedSince: '2026-07-14T00:00:00Z',
            order: 'desc',
          },
        ],
      }),
      { spaceId: 'space-1', payloadStore } as never,
    );
    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({
        pathPrefix: '/journal/',
        pathStartsWith: '/journal/',
        pathBefore: '/journal/2026-07-13',
        order: 'desc',
        filters: { updatedAfter: '2026-07-14T00:00:00Z' },
        limit: 1001,
      }),
    );
    const output = written(context) as { docs: { journal: Array<{ path: string }> } };
    expect(output.docs.journal.map((d) => d.path)).toEqual(['/journal/2026-07-10.md']);
  });

  it('fails where there is no space to read', async () => {
    const result = await handleCollect(ctx(), repo() as never, INPUT, {} as never);
    expect(result.status).toBe('FAILED');
  });
});
