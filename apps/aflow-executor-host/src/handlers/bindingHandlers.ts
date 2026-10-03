/**
 * A connected folder's push posture, checks and sandbox posture, and how many
 * coding agents its machine runs at once, read from the policy file on this
 * machine.
 *
 * Read here rather than from the workspace's copy because both are only ever
 * declared here. Nothing in the folder is touched, so a file-only binding
 * answers it as readily as one that runs commands.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  failureWithError,
  internalError,
  permissionError,
  successWithData,
  validationError,
} from '@aflow/executor-runtime';
import {
  HostBindingInspectInputSchema,
  type HostBindingInspectOutputSchema,
  resolveBranchPolicy,
} from '@aflow/schemas';
import type { z } from 'zod';

import { HostBindingError, loadHostPolicy, requireBinding, requireSpace } from '../bindings.js';
import { sandboxPostureOf } from '../sandboxPosture.js';

type HostBindingInspectOutput = z.infer<typeof HostBindingInspectOutputSchema>;

async function inspect(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const parsed = HostBindingInspectInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const policy = await loadHostPolicy(policyPath);
    const binding = requireBinding(policy.bindings, parsed.data.bindingId);
    requireSpace(binding, ctx.spaceId);

    const output: HostBindingInspectOutput = {
      id: binding.id,
      ...(binding.branchPolicy !== undefined
        ? { branchPolicy: resolveBranchPolicy(binding.branchPolicy) }
        : {}),
      sandbox: sandboxPostureOf(binding),
      maxConcurrentHarnessRuns: policy.maxConcurrentHarnessRuns,
    };
    return await successWithData(ctx, output);
  } catch (error) {
    if (error instanceof HostBindingError) {
      return await failureWithError(ctx, permissionError(error.message));
    }
    return await failureWithError(
      ctx,
      internalError(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function createHostBindingHandler(policyPath: string): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set(['host.binding.inspect']),
    execute: async (ctx: ExecutorContext): Promise<StepResult> => await inspect(ctx, policyPath),
  };
}
