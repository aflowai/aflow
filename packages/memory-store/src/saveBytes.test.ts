import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import { saveBytesToMemoryDoc, workspacePathToMemoryPath } from './saveBytes.js';
import { MemoryWriteDeniedError } from './writeDoc.js';

describe('workspacePathToMemoryPath', () => {
  it('strips the /workspace/ mount prefix', () => {
    expect(workspacePathToMemoryPath('/workspace/refs/spec.md')).toBe('/refs/spec.md');
    expect(workspacePathToMemoryPath('/workspace')).toBe('/');
  });

  it('treats a prefix-less path as a direct memory path', () => {
    expect(workspacePathToMemoryPath('/refs/spec.md')).toBe('/refs/spec.md');
  });

  it('canonicalizes slashes, relative segments, and dot-dot escapes', () => {
    expect(workspacePathToMemoryPath('//refs//spec.md')).toBe('/refs/spec.md');
    expect(workspacePathToMemoryPath('refs/spec.md')).toBe('/refs/spec.md');
    expect(workspacePathToMemoryPath('/workspace/refs/../data/x.csv')).toBe('/data/x.csv');
  });
});

describe('saveBytesToMemoryDoc — virtual-path guard', () => {
  function attemptSave(path: string) {
    return saveBytesToMemoryDoc({
      db: {} as PostgresJsDatabase,
      payloadStore: {} as PayloadStore,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      tenantId: 'tenant-1' as never,
      origin: { kind: 'run', runId: 'run-1' as never, stepExecutionId: 'se-1' as never },
      spaceId: 'space-1',
      path,
      tags: [],
      content: { kind: 'text', text: 'hello' },
      contentType: null,
    });
  }

  it.each([
    '/run/outputs/x',
    '//run/outputs/x',
    'run/outputs/x',
    '/workspace/../run/outputs/x',
    '/workspace/run/../../run/outputs/x',
    '/run',
  ])('rejects every spelling that canonicalizes into /run: %s', async (path) => {
    await expect(attemptSave(path)).rejects.toThrow(MemoryWriteDeniedError);
  });

  it('does not reject persistent paths that merely start with "run"', async () => {
    // Fails later on the empty db stub — proving the guard let it through.
    await expect(attemptSave('/runbook.md')).rejects.not.toThrow(MemoryWriteDeniedError);
  });
});
