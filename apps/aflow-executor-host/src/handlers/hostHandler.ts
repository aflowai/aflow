/**
 * The host lane's single handler. The runtime addresses a lane by step type, so
 * the split between files, processes and coding harnesses is a module boundary
 * rather than a dispatch one — and it stays a real boundary, because a file-only binding must
 * never reach the half that spawns things.
 */
import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, validationError } from '@aflow/executor-runtime';

import { createHostBindingHandler } from './bindingHandlers.js';
import { createHostFileHandler } from './fileHandlers.js';
import { createHostHarnessHandler } from './harnessHandlers.js';
import { createHostMcpHandler } from './mcpHandlers.js';
import { createHostPatchHandler } from './patchHandlers.js';
import { createHostProcessHandler } from './processHandlers.js';
import { resolveHostTimeout } from './hostTimeout.js';

export function createHostHandler(policyPath: string): StepHandler {
  const files = createHostFileHandler(policyPath);
  const processes = createHostProcessHandler(policyPath);
  const harnesses = createHostHarnessHandler(policyPath);
  const patches = createHostPatchHandler(policyPath);
  const mcpServers = createHostMcpHandler(policyPath);
  const bindings = createHostBindingHandler(policyPath);

  return {
    stepType: 'host',
    resolveTimeoutMs: resolveHostTimeout,
    async execute(ctx: ExecutorContext): Promise<StepResult> {
      if (processes.handles.has(ctx.operationId)) {
        return await processes.execute(ctx);
      }
      if (harnesses.handles.has(ctx.operationId)) {
        return await harnesses.execute(ctx);
      }
      // Before the `host.file.` prefix, which would otherwise claim it.
      if (patches.handles.has(ctx.operationId)) {
        return await patches.execute(ctx);
      }
      if (mcpServers.handles.has(ctx.operationId)) {
        return await mcpServers.execute(ctx);
      }
      if (bindings.handles.has(ctx.operationId)) {
        return await bindings.execute(ctx);
      }
      if (ctx.operationId.startsWith('host.file.')) {
        return await files.execute(ctx);
      }
      return await failureWithError(
        ctx,
        validationError(`The host lane does not serve \`${ctx.operationId}\`.`),
      );
    },
  };
}
