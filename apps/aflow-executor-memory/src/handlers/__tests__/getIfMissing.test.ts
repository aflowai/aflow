/**
 * Contract: memory.store.get under `ifMissing: 'absent'` tells a read that
 * found no document apart from one that could not be read. No document at the
 * target succeeds as `{ found: false }`; a read that throws still fails, and
 * so does a read with no space to search. Without it, no document fails
 * MEMORY_NOT_FOUND as it always has.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type {
  MemoryGetInput,
  OperationId,
  PayloadRef,
  SessionId,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import { handleGet } from '../memory/handlers/get.js';

const PATH = '/shepherd/aflowai/aflow/pulls/12.json';

function ctx(): ExecutorContext {
  return {
    tenantId: 'tenant-1' as TenantId,
    runId: 'run-1' as SessionId,
    stepExecutionId: 'step-1' as StepExecutionId,
    attempt: 1,
    operationId: 'memory.store.get' as OperationId,
    job: { spaceId: 'space-1' },
    writePayload: vi.fn(async () => 'payload:out' as PayloadRef),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

function written(context: ExecutorContext): unknown {
  const calls = (context.writePayload as ReturnType<typeof vi.fn>).mock.calls;
  return calls.find((call) => call[0] === 'output')?.[1];
}

function input(ifMissing: MemoryGetInput['ifMissing']): MemoryGetInput {
  return { target: { path: PATH }, view: 'content', ifMissing } as MemoryGetInput;
}

const noDocument = { getByPath: vi.fn(async () => null), getById: vi.fn(async () => null) };

describe("memory.store.get — ifMissing: 'absent' answers a missing document, never a failed read", () => {
  it('succeeds as found: false where the space holds no document at the target', async () => {
    const context = ctx();
    const result = await handleGet(context, noDocument as never, input('absent'), {
      spaceId: 'space-1',
    } as never);
    expect(result.status).toBe('SUCCEEDED');
    expect(written(context)).toEqual({ found: false });
  });

  it('still fails where the read itself fails', async () => {
    const failing = {
      getByPath: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    };
    await expect(
      handleGet(ctx(), failing as never, input('absent'), { spaceId: 'space-1' } as never),
    ).rejects.toThrow('connection terminated');
  });

  it('still fails where there is no space to search', async () => {
    const result = await handleGet(ctx(), noDocument as never, input('absent'), {} as never);
    expect(result.status).toBe('FAILED');
  });

  it('fails MEMORY_NOT_FOUND without it', async () => {
    const result = await handleGet(ctx(), noDocument as never, input('fail'), {
      spaceId: 'space-1',
    } as never);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toMatch(/MEMORY_NOT_FOUND/);
  });
});
