/**
 * Every `mcp.*` operation an agent can be handed must have something that runs
 * it. The MCP executor refuses everything outside `MCP_EXECUTOR_OPERATION_IDS`,
 * so an operation that is neither there nor claimed inline is a tool the
 * Helmsman can promote and call that fails on every call.
 */
import { describe, expect, it, vi } from 'vitest';
import { getAllOperations, MCP_EXECUTOR_OPERATION_IDS } from '@aflow/schemas';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('../../handlers/inlineOps/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function' ? vi.fn(() => Promise.resolve()) : value,
    ]),
  );
});

const { isInlineOperation } = await import('../inlineOperations.js');
const { dispatchInlineOp } = await import('../../handlers/dispatchInlineOp.js');
const inlineOps = (await import('../../handlers/inlineOps/index.js')) as unknown as Record<
  string,
  unknown
>;

const agentCallableMcpOperations = [...getAllOperations().values()]
  .filter((op) => op.operationId.startsWith('mcp.') && op.agentTool && !op.internal)
  .map((op) => op.operationId)
  .sort();

describe('mcp.* operations an agent can call', () => {
  it('are registered', () => {
    expect(agentCallableMcpOperations).toContain('mcp.server.upsert');
    expect(agentCallableMcpOperations).toContain('mcp.binding.upsert');
  });

  it('each run on the MCP executor or inline in the orchestrator — never neither', () => {
    const unhandled = agentCallableMcpOperations.filter(
      (id) => !MCP_EXECUTOR_OPERATION_IDS.includes(id) && !isInlineOperation(id),
    );
    expect(unhandled).toEqual([]);
  });

  it('never both, so the executor ops are not swallowed by an inline handler', () => {
    expect(MCP_EXECUTOR_OPERATION_IDS.filter((id) => isInlineOperation(id))).toEqual([]);
  });

  it.each(agentCallableMcpOperations.filter((id) => isInlineOperation(id)))(
    '%s reaches an inline handler rather than the unrouted fallback',
    async (operationId) => {
      mockAddStepResult.mockClear();
      const handlers = Object.values(inlineOps).filter((value): value is ReturnType<typeof vi.fn> =>
        vi.isMockFunction(value),
      );
      for (const handler of handlers) handler.mockClear();

      await dispatchInlineOp(
        {} as Parameters<typeof dispatchInlineOp>[0],
        {} as Parameters<typeof dispatchInlineOp>[1],
        {
          tenantId: 'tenant-1',
          runId: 'run-1',
          spaceId: 'space-1',
          traceId: 'trace-1',
        } as unknown as Parameters<typeof dispatchInlineOp>[2],
        {
          stepId: 'step-1',
          stepType: 'mcp',
          operation: operationId,
        } as unknown as Parameters<typeof dispatchInlineOp>[3],
        'se-1' as Parameters<typeof dispatchInlineOp>[4],
        'idem-1' as Parameters<typeof dispatchInlineOp>[5],
        'inline:e30=',
        1,
        Date.now(),
      );

      expect(mockAddStepResult).not.toHaveBeenCalled();
      expect(handlers.filter((handler) => handler.mock.calls.length > 0)).toHaveLength(1);
    },
  );
});
