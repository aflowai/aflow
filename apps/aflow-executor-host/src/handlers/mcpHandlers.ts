/**
 * The local-MCP half of the host lane.
 *
 * A server declared on the machine runs inside the binding the call names, and
 * is torn down when the call is answered. Nothing is pooled: a warm server
 * holding a boundary compiled from a binding the operator has since withdrawn
 * is the failure this lane has already had to fix twice elsewhere.
 *
 * The binding is required to permit execution. A server is a program the
 * operator's machine runs, and connecting a folder for its contents should not
 * become a way to run one.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  permissionError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import { HostMcpCallInputSchema, HostMcpListToolsInputSchema } from '@aflow/schemas';

import {
  type HostBinding,
  HostBindingError,
  executionPermitted,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireExecution,
  requireSpace,
} from '../bindings.js';
import { callLocalTool, listLocalTools } from '../localMcpClient.js';
import {
  LocalMcpServerError,
  requireLocalServer,
  type LocalMcpServer,
} from '../localMcpServers.js';
import { reapWithdrawn } from '../sandboxedRun.js';

async function failure(ctx: ExecutorContext, error: unknown): Promise<StepResult> {
  if (error instanceof HostBindingError) {
    return await failureWithError(ctx, permissionError(error.message));
  }
  if (error instanceof LocalMcpServerError) {
    // Never retryable. A server that would not start, or would not answer in
    // time, fails the same way on the next attempt — and each attempt starts
    // another one. These are declarations to fix, not weather to wait out.
    return await failureWithError(
      ctx,
      error.kind === 'protocol' ? validationError(error.message) : permissionError(error.message),
    );
  }
  return await failureWithError(
    ctx,
    internalError(error instanceof Error ? error.message : String(error)),
  );
}

/**
 * Resolve both halves. The binding a call names has to be the one the server
 * was declared under: a server configured for one folder must not be pointed at
 * another by a request, or the machine's own decision about where it runs would
 * be the appliance's to make.
 */
async function resolve(
  policyPath: string,
  bindingId: string,
  serverId: string,
  spaceId: string | undefined,
): Promise<{ binding: HostBinding; server: LocalMcpServer }> {
  const policy = await loadHostPolicy(policyPath);
  reapWithdrawn(executionPermitted(policy.bindings));

  const binding = requireBinding(policy.bindings, bindingId);
  requireSpace(binding, spaceId);
  requireDirectory(binding);
  requireExecution(binding);

  const server = requireLocalServer(policy.mcpServers, serverId);
  if (server.bindingId !== binding.id) {
    throw new LocalMcpServerError(
      `MCP server '${serverId}' is configured to run in \`${server.bindingId}\` on this machine, ` +
        `not \`${binding.id}\`. Where a server runs is the machine's decision.`,
      'no_binding',
    );
  }
  return { binding, server };
}

async function listTools(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const parsed = HostMcpListToolsInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const { binding, server } = await resolve(
      policyPath,
      parsed.data.bindingId,
      parsed.data.serverId,
      ctx.spaceId,
    );
    const tools = await listLocalTools(server, binding, ctx.runId, ctx.signal);
    return await successWithData(ctx, { serverId: server.id, tools });
  } catch (error) {
    return await failure(ctx, error);
  }
}

async function callTool(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const parsed = HostMcpCallInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const { binding, server } = await resolve(
      policyPath,
      parsed.data.bindingId,
      parsed.data.serverId,
      ctx.spaceId,
    );
    const result = await callLocalTool(
      server,
      binding,
      ctx.runId,
      ctx.signal,
      parsed.data.toolName,
      parsed.data.arguments,
    );
    return await successWithData(ctx, { content: result.content, isError: result.isError });
  } catch (error) {
    return await failure(ctx, error);
  }
}

export function createHostMcpHandler(policyPath: string): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set(['host.mcp.list_tools', 'host.mcp.call']),
    execute: async (ctx: ExecutorContext): Promise<StepResult> =>
      ctx.operationId === 'host.mcp.call'
        ? await callTool(ctx, policyPath)
        : await listTools(ctx, policyPath),
  };
}
