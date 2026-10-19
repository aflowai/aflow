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
import {
  type HostCommitDescribeOutput,
  HostCommitDescribeInputSchema,
  HostCommitScanInputSchema,
} from '@aflow/schemas';

import {
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireSpace,
} from '../bindings.js';
import { scanCommitRange, scanTexts } from '../commitScan.js';
import { composePullRequest, readRangeCommits } from '../pullRequestText.js';
import { receiptForScan } from '../scanReceipt.js';
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
  const output = await scanCommitRange(root, parsed.data.range, parsed.data.texts);
  const receipt = receiptForScan(parsed.data.bindingId, output);
  return await successWithData(ctx, receipt === undefined ? output : { ...output, receipt });
}

/**
 * The pull request the range goes out as. Its text is composed after the scan
 * read the range, from what the review and the checks returned as well, so it
 * is read again here: nothing leaves unread.
 */
async function describe(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  const parsed = HostCommitDescribeInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
  if (!parsed.success) {
    return await failureWithError(ctx, validationError(parsed.error.message));
  }
  const root = await repositoryRoot(ctx, policyPath, parsed.data.bindingId);
  const commits = await readRangeCommits(root, parsed.data.range);
  const { title, body, ...record } = composePullRequest(parsed.data, commits);
  const scanned = scanTexts({ 'pull request title': title, 'pull request body': body });
  if (!scanned.clean) {
    return await failureWithError(
      ctx,
      validationError(
        `${scanned.summary} A pull request's text goes out as it stands, so none of it was ` +
          'used: a line marked allowed is refused here too, since a pull request carries no fixture.',
      ),
    );
  }
  const output: HostCommitDescribeOutput = {
    title,
    body,
    commits: commits.map(({ sha, subject }) => ({ sha, subject })),
    ...record,
  };
  return await successWithData(ctx, output);
}

const OPERATIONS: Record<
  string,
  (ctx: ExecutorContext, policyPath: string) => Promise<StepResult>
> = {
  'host.commit.scan': scan,
  'host.commit.describe': describe,
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
