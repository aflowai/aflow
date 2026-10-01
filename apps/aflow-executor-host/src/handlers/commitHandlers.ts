/**
 * Reading a connected repository's commits, before any of them leave the
 * machine.
 *
 * A read of the repository's objects alone, so a binding that only reads
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
import { HostCommitScanInputSchema } from '@aflow/schemas';

import {
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireSpace,
} from '../bindings.js';
import { scanCommitRange } from '../commitScan.js';
import { isGitRepository, WorktreeError } from '../worktree.js';

async function scan(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const parsed = HostCommitScanInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const binding = requireBinding(
      (await loadHostPolicy(policyPath)).bindings,
      parsed.data.bindingId,
    );
    requireSpace(binding, ctx.spaceId);
    requireDirectory(binding);
    if (!(await isGitRepository(binding.root))) {
      return await failureWithError(
        ctx,
        validationError(`${binding.root} is not a git repository, so it has no commits to scan.`),
      );
    }
    return await successWithData(ctx, await scanCommitRange(binding.root, parsed.data.range));
  } catch (error) {
    if (error instanceof HostBindingError) {
      return await failureWithError(ctx, permissionError(error.message));
    }
    if (error instanceof WorktreeError) {
      return await failureWithError(ctx, validationError(error.message));
    }
    return await failureWithError(
      ctx,
      internalError(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function createHostCommitHandler(policyPath: string): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set(['host.commit.scan']),
    execute: async (ctx: ExecutorContext): Promise<StepResult> => await scan(ctx, policyPath),
  };
}
