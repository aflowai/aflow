/**
 * Contract: `memory.store.delete` with `expectedHash` deletes a document only
 * while it still holds exactly the content its caller read or wrote, and the
 * condition rides into the write itself; a document another writer changed
 * since is left as it is, and the step says so. Without it, a delete is as
 * it always was.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { OperationId, PayloadRef, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { handleDelete } from '../memory/handlers/delete.js';

const LEASE = {
  id: 'doc-1',
  path: '/shepherd/aflowai/aflow/aflow/x/lease.json',
  spaceId: 'space-1',
  contentHash: 'hash-of-the-new-holder',
};

function repo() {
  return {
    getByPath: vi.fn(async () => LEASE),
    getById: vi.fn(async () => LEASE),
    softDelete: vi.fn(async () => true),
    deleteChunksForDoc: vi.fn(async () => undefined),
  };
}

function ctx(): ExecutorContext {
  return {
    tenantId: 'tenant-1' as TenantId,
    runId: 'run-1' as SessionId,
    stepExecutionId: 'step-1' as StepExecutionId,
    attempt: 1,
    operationId: 'memory.store.delete' as OperationId,
    job: { spaceId: 'space-1' },
    writePayload: vi.fn(async () => 'payload:out' as PayloadRef),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

const dirRepo = { getDir: vi.fn(async () => null) } as never;

describe('memory.store.delete — conditional on the content its caller held', () => {
  it('leaves a document whose content changed since, and fails saying so', async () => {
    const docs = repo();
    const result = await handleDelete(
      ctx(),
      docs as never,
      dirRepo,
      { target: { path: LEASE.path }, recursive: false, expectedHash: 'hash-of-the-old-holder' },
      {} as never,
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toMatch(/MEMORY_HASH_MISMATCH/);
    expect(docs.softDelete).not.toHaveBeenCalled();
  });

  it('deletes a document that still holds it, with the condition in the write', async () => {
    const docs = repo();
    const result = await handleDelete(
      ctx(),
      docs as never,
      dirRepo,
      { target: { path: LEASE.path }, recursive: false, expectedHash: LEASE.contentHash },
      {} as never,
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(docs.softDelete).toHaveBeenCalledWith('doc-1', 'space-1', {
      expectedHash: LEASE.contentHash,
    });
  });

  it('fails where the write lost the race to another writer', async () => {
    const docs = repo();
    docs.softDelete.mockResolvedValueOnce(false);
    const result = await handleDelete(
      ctx(),
      docs as never,
      dirRepo,
      { target: { path: LEASE.path }, recursive: false, expectedHash: LEASE.contentHash },
      {} as never,
    );
    expect(result.status).toBe('FAILED');
  });

  it('deletes unconditionally without one', async () => {
    const docs = repo();
    const result = await handleDelete(
      ctx(),
      docs as never,
      dirRepo,
      { target: { path: LEASE.path }, recursive: false },
      {} as never,
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(docs.softDelete).toHaveBeenCalledWith('doc-1', 'space-1');
  });
});
