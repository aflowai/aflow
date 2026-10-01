/**
 * Reading a connected repository's commits, before any of them leave the
 * machine.
 *
 * It moves no branch of the folder's own, so a binding that only reads
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

/** The repository a commit operation reads, or a refusal saying why it cannot. */
async function repositoryRoot(
  ctx: ExecutorContext,
  policyPath: string,
  bindingId: string,
): Promise<string> {
  const binding = requireBinding((await loadHostPolicy(policyPath)).bindings, bindingId);
  requireSpace(binding, ctx.spaceId);
  requireDirectory(binding);
  if (!(await isGitRepository(binding.root))) {
    throw new WorktreeError(
      `${binding.root} is not a git repository, so it has no commits to read.`,
      'not_a_repository',
    );
  }
  return binding.root;
}

async function scan(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  const parsed = HostCommitScanInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
  if (!parsed.success) {
    return await failureWithError(ctx, validationError(parsed.error.message));
  }
  const root = await repositoryRoot(ctx, policyPath, parsed.data.bindingId);
  return await successWithData(
    ctx,
    await scanCommitRange(root, parsed.data.range, parsed.data.texts),
  );
}

const OPERATIONS: Record<
  string,
  (ctx: ExecutorContext, policyPath: string) => Promise<StepResult>
> = {
  'host.commit.scan': scan,
};

async function execute(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const operation = OPERATIONS[ctx.operationId];
    if (operation === undefined) {
      return await failureWithError(
        ctx,
        validationError(`${ctx.operationId} is not a commit operation.`),
      );
    }
    return await operation(ctx, policyPath);
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
    handles: new Set(Object.keys(OPERATIONS)),
    execute: async (ctx: ExecutorContext): Promise<StepResult> => await execute(ctx, policyPath),
  };
}
