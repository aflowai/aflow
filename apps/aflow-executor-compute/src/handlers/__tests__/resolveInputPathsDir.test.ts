/**
 * inputPaths directory expansion — when a persistent inputPath has no exact
 * memory doc, `resolveInputPaths` treats it as a directory prefix and mounts
 * every document directly under it (via `listDir`), recursing through the
 * single-file load + mount path. Motivating shape: a skill passes
 * a data-root prefix as `inputPaths`, which without expansion fails with
 * "Memory file not found".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';

const mockGetByPath = vi.fn();
const mockListDir = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    createTenantContext: () => ({}),
    createMemoryDocRepository: () => ({ getByPath: mockGetByPath }),
    createMemoryDirRepository: () => ({ listDir: mockListDir }),
  };
});

const { ComputeExecHandler } = await import('../computeExecHandler.js');

const SPACE = 'space-1';
const DIR = '/workflows/comp/data/';
const FILES: Record<string, string> = {
  '/workflows/comp/data/train.csv': 'Id,SalePrice\n1,200000',
  '/workflows/comp/data/test.csv': 'Id\n1461',
  '/workflows/comp/data/submission_template.csv': 'Id,SalePrice\n1461,0',
};

function makeCtx(): ExecutorContext {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readPayload: vi.fn(),
    writePayload: vi.fn(async () => 'inline:err'),
  } as unknown as ExecutorContext;
}

function resolve(handler: unknown, paths: string[]) {
  return (
    handler as {
      resolveInputPaths: (ctx: ExecutorContext, p: string[], s: string) => Promise<unknown>;
    }
  ).resolveInputPaths(makeCtx(), paths, SPACE);
}

beforeEach(() => {
  mockGetByPath.mockReset();
  mockListDir.mockReset();
  mockGetByPath.mockImplementation(async (path: string) => {
    if (path in FILES) return { inlineContent: FILES[path], payloadRef: null };
    return null; // the directory prefix (and anything unknown) resolves to no doc
  });
  mockListDir.mockResolvedValue(
    Object.keys(FILES).map((path) => ({ entryType: 'document', path, id: path, name: path })),
  );
});

describe('resolveInputPaths — directory expansion', () => {
  it('expands a directory prefix to all its files, mounted by full path', async () => {
    const handler = new ComputeExecHandler({ db: {} as never });
    const result = (await resolve(handler, [DIR])) as { files: Record<string, string> };

    expect('files' in result).toBe(true);
    expect(Object.keys(result.files).sort()).toEqual([
      'workflows/comp/data/submission_template.csv',
      'workflows/comp/data/test.csv',
      'workflows/comp/data/train.csv',
    ]);
    expect(result.files['workflows/comp/data/train.csv']).toBe(
      FILES['/workflows/comp/data/train.csv'],
    );
    expect(mockListDir).toHaveBeenCalledWith(DIR, { scope: { spaceId: SPACE } });
  });

  it('still resolves a single exact file without listing a directory (regression)', async () => {
    const handler = new ComputeExecHandler({ db: {} as never });
    const result = (await resolve(handler, ['/workflows/comp/data/train.csv'])) as {
      files: Record<string, string>;
    };

    expect(Object.keys(result.files)).toEqual(['workflows/comp/data/train.csv']);
    expect(mockListDir).not.toHaveBeenCalled();
  });

  it('returns a teaching validation error when a path is neither a file nor a non-empty directory', async () => {
    mockListDir.mockResolvedValue([]); // no documents under the prefix
    const handler = new ComputeExecHandler({ db: {} as never });
    const result = (await resolve(handler, ['/workflows/comp/missing/'])) as {
      stepResult: { error?: { message?: string }; status?: string };
    };

    expect('stepResult' in result).toBe(true);
    expect(JSON.stringify(result.stepResult)).toContain('inputPath not found');
  });
});
