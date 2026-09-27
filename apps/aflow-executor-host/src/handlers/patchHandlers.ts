/**
 * Taking a diff into a connected folder.
 *
 * A patch is a third way to write files, alongside `host.file.put` and a
 * command, so it is held to the same containment: every path the diff claims is
 * resolved through the binding before anything is applied. Git refuses `.git`
 * and `../` paths on its own, but a check that exists in one implementation is
 * a check that a flag or a version can remove — and the thing it prevents is a
 * planted hook running unconfined on the next checkout.
 *
 * There is no push here, and there is no plan for one on this path. Producing a
 * change and publishing it are separate decisions, and a step that could do
 * both would collapse them. A commit is as far as this reaches: it is made in a
 * checkout of the executor's own and leaves a branch behind — a new one, or one
 * commit further along the branch the patch was made on — which is a thing the
 * operator can read, push or reset rather than a change already published.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  permissionError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import { HostFilePatchInputSchema } from '@aflow/schemas';

import {
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireSpace,
  requireWritable,
  resolveWithin,
} from '../bindings.js';
import {
  applyPatch,
  commitPatchOnBranch,
  isGitRepository,
  patchPaths,
  WorktreeError,
} from '../worktree.js';

async function failure(ctx: ExecutorContext, error: unknown): Promise<StepResult> {
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

async function applyHostPatch(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  const raw = await ctx.readPayload(ctx.job.inputRef);
  const parsed = HostFilePatchInputSchema.safeParse(raw);
  if (!parsed.success) {
    return await failureWithError(ctx, validationError(parsed.error.message));
  }
  const input = parsed.data;

  try {
    const binding = requireBinding((await loadHostPolicy(policyPath)).bindings, input.bindingId);
    requireSpace(binding, ctx.spaceId);
    requireDirectory(binding);
    requireWritable(binding);

    if (!(await isGitRepository(binding.root))) {
      return await failureWithError(
        ctx,
        validationError(
          `${binding.root} is not a git repository, so there is nothing to apply a diff against.`,
        ),
      );
    }

    const files = input.patch.trim() === '' ? [] : await patchPaths(binding.root, input.patch);
    if (files.length === 0) {
      return await successWithData(ctx, {
        state: 'empty',
        filesChanged: 0,
        files: [],
        conflicts: [],
      });
    }

    // Every claimed path, through the same gate a written file goes through.
    // `mustExist` is false because a diff may add files that are not there yet.
    for (const file of files) {
      await resolveWithin(binding, file, false);
    }

    if (input.commit !== undefined) {
      const { apply, commit } = await commitPatchOnBranch(
        binding.root,
        input.patch,
        input.mode,
        input.commit.branch,
        input.commit.message,
        input.commit.base,
      );
      return await successWithData(ctx, {
        state: apply.state,
        // A conflict in this mode leaves nothing at all — no commit, no branch
        // moved, and an operator folder that was never a party to the apply.
        filesChanged: commit === undefined ? 0 : files.length,
        files,
        conflicts: apply.conflicts,
        ...(apply.detail !== undefined ? { detail: apply.detail } : {}),
        ...(commit !== undefined ? { commit } : {}),
      });
    }

    const outcome = await applyPatch(binding.root, input.patch, input.mode);
    // A three-way apply that conflicted still wrote the tree. Reporting zero
    // changed files over a modified working copy would send the operator to
    // look at a folder that is not in the state they were told it is in.
    const changed = outcome.state === 'applied' || outcome.wroteTree === true ? files.length : 0;
    return await successWithData(ctx, {
      state: outcome.state,
      filesChanged: changed,
      files,
      conflicts: outcome.conflicts,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    });
  } catch (error) {
    return await failure(ctx, error);
  }
}

export function createHostPatchHandler(policyPath: string): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set(['host.file.patch']),
    execute: async (ctx: ExecutorContext): Promise<StepResult> =>
      await applyHostPatch(ctx, policyPath),
  };
}
