/**
 * A connected folder's checks, run on one commit before it is pushed.
 *
 * The command is read from the folder's policy on this machine and from
 * nowhere else: the input names a folder and two commits, and no field of it
 * can say what runs. A folder that declares nothing is answered before
 * anything is touched; one that declares checks needs the grant to run
 * commands, since a check runs the repository's own code. Checks that ran
 * answer with a receipt, passed or failed, that a push of the commit carries.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  failureWithError,
  internalError,
  notFoundError,
  permissionError,
  successWithData,
  validationError,
} from '@aflow/executor-runtime';
import { HostCommitCheckInputSchema } from '@aflow/schemas';

import {
  executionPermitted,
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireExecution,
  requireSpace,
  requireWritable,
} from '../bindings.js';
import { issueCheckReceipt } from '../checkReceipt.js';
import { checkOutcome, runFolderChecks, skippedCheck } from '../commitCheck.js';
import { checksOf } from '../folderChecks.js';
import { noSandboxMessage, reapWithdrawn, sandboxReadiness } from '../sandboxedRun.js';
import { isGitRepository, resolveCommit, WorktreeError } from '../worktree.js';

async function check(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  const parsed = HostCommitCheckInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
  if (!parsed.success) {
    return await failureWithError(ctx, validationError(parsed.error.message));
  }
  const input = parsed.data;
  const policy = await loadHostPolicy(policyPath);
  reapWithdrawn(executionPermitted(policy));
  const binding = requireBinding(policy.bindings, input.bindingId);
  requireSpace(binding, ctx.spaceId);
  requireDirectory(binding);
  if (!(await isGitRepository(binding.root))) {
    throw new WorktreeError(
      `${binding.root} is not a git repository, so it has no commit to check.`,
      'not_a_repository',
    );
  }
  const sha = await resolveCommit(binding.root, input.sha);
  const base = await resolveCommit(binding.root, input.base);

  const { argv, timeoutMs } = checksOf(binding);
  if (argv === undefined) return await successWithData(ctx, skippedCheck(binding.id, sha));

  requireExecution(binding);
  // The checkout is recorded under the repository's own `.git`, as a
  // commission's is; the check itself is never given the folder to write.
  requireWritable(binding);
  const readiness = sandboxReadiness();
  if (!readiness.ready) {
    return await failureWithError(ctx, permissionError(noSandboxMessage(readiness.missing)));
  }

  const run = await runFolderChecks({
    binding,
    argv,
    timeoutMs,
    sha,
    base,
    toolPaths: policy.toolPaths,
    ownerRunId: ctx.runId,
    signal: ctx.signal,
    onDelta: (text) => {
      void ctx.emitLiveDelta('text', text);
    },
    onOutput: () => ctx.reportProgress?.(),
  });
  const outputRef = await ctx.writePayload('logs', run.output);
  const outcome = checkOutcome({ bindingId: binding.id, argv, timeoutMs, sha, run, outputRef });
  const receipt = issueCheckReceipt({
    bindingId: binding.id,
    sha,
    base,
    argv,
    outcome: outcome.passed ? 'passed' : 'failed',
    sandbox: run.sandbox,
    ...(run.skippedListenerTests !== undefined
      ? { skippedListenerTests: run.skippedListenerTests }
      : {}),
  });
  return await successWithData(ctx, { ...outcome, receipt });
}

export function createHostCommitCheckHandler(policyPath: string): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set(['host.commit.check']),
    execute: async (ctx: ExecutorContext): Promise<StepResult> => {
      try {
        return await check(ctx, policyPath);
      } catch (error) {
        if (error instanceof HostBindingError) {
          return await failureWithError(
            ctx,
            error.kind === 'unknown_binding'
              ? notFoundError(error.message)
              : permissionError(error.message),
          );
        }
        if (error instanceof WorktreeError) {
          return await failureWithError(ctx, validationError(error.message));
        }
        return await failureWithError(
          ctx,
          internalError(error instanceof Error ? error.message : String(error)),
        );
      }
    },
  };
}
