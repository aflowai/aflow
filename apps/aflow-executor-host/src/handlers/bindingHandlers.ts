/**
 * What the operator declared about a connected folder, read from the policy
 * file on this machine.
 *
 * Read here rather than from the workspace's copy because some of it — the
 * push posture — is only ever declared here. Nothing in the folder is touched,
 * so a file-only binding answers it as readily as one that runs commands.
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
} from '@aflow/schemas';
import type { z } from 'zod';

import { HostBindingError, loadHostPolicy, requireBinding, requireSpace } from '../bindings.js';

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
      root: binding.root,
      mode: binding.mode,
      allowsExecution: binding.allowsExecution,
      ...(binding.branchPolicy !== undefined ? { branchPolicy: binding.branchPolicy } : {}),
      harnesses: [...policy.harnesses.values()]
        .map((profile) => ({
          id: profile.id,
          ...(profile.label !== undefined ? { label: profile.label } : {}),
          ...(profile.model !== undefined ? { model: profile.model } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
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
