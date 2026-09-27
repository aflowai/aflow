import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';

const mockWithTenantSchema = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    createTenantContext: () => ({}),
    withTenantSchema: (..._args: unknown[]) => mockWithTenantSchema(),
  };
});

const { ComputeExecHandler } = await import('../computeExecHandler.js');

const SPACE = 'space-1';

function makeCtx(input: unknown): { ctx: ExecutorContext; errored: () => boolean } {
  let wroteError = false;
  const ctx = {
    job: { spaceId: SPACE, inputRef: 'inline:input' },
    tenantId: '00000000-0000-0000-0000-000000000001',
    runId: '00000000-0000-0000-0000-000000000002',
    stepExecutionId: 'step-policy',
    attempt: 0,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readPayload: vi.fn(async (ref: string) => (ref === 'inline:input' ? input : undefined)),
    writePayload: vi.fn(async (kind: string) => {
      if (kind === 'error') wroteError = true;
      return `inline:${kind}`;
    }),
  } as unknown as ExecutorContext;
  return { ctx, errored: () => wroteError };
}

describe('compute workspace policy gate (one-shot)', () => {
  beforeEach(() => {
    mockWithTenantSchema.mockReset();
  });

  it('rejects a one-shot workspace exec when sessions.workspace.enabled is false', async () => {
    mockWithTenantSchema.mockResolvedValue([
      { computePolicy: { enabled: true, sessions: { workspace: { enabled: false } } } },
    ]);

    // workspaceManager is present (truthy) so the not-configured guard does not
    // fire first; the policy gate must reject before any hydrate happens.
    const handler = new ComputeExecHandler({
      db: {} as never,
      workspaceManager: {} as never,
      runner: {} as never,
    });

    const input = {
      runtime: 'python3-ml',
      code: 'print(1)',
      workspace: { inputs: ['/data/'] },
    };
    const { ctx, errored } = makeCtx(input);

    const result = (await handler.execute(ctx)) as {
      status: string;
      error?: { message?: string };
    };

    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toContain('disabled by the space compute policy');
    expect(errored()).toBe(true);
  });
});
