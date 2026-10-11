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
import type { z } from 'zod';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  PayloadAccessError,
  permissionError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import { HostFilePatchInputSchema, parsePayloadRef, type AflowError } from '@aflow/schemas';

import {
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireSpace,
  requireWritable,
  resolveWithin,
} from '../bindings.js';
import { resolvePushBase } from '../pushBase.js';
import { branchAsItStands, commitPatchOnBranch } from '../branchCommit.js';
import {
  applyPatch,
  DIFF_CEILING_BYTES,
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

/** How a unified diff opens: git's own header, or a plain one. */
const UNIFIED_DIFF_START = /^(?:diff --git |--- )/;

/**
 * The diff the call names, as text: the bytes it carried, or the stored diff its
 * `patchRef` points at. A ref is read through the job's own tenant, so one
 * naming another tenant's payload is refused before anything is fetched.
 */
async function diffOf(
  ctx: ExecutorContext,
  input: z.infer<typeof HostFilePatchInputSchema>,
): Promise<string | AflowError> {
  if (input.patchRef === undefined) return input.patch ?? '';
  const notADiff = validationError(
    '`patchRef` names a payload that is not a diff. Pass the `patchRef` a ' +
      '`host.harness.run` result reports.',
    { patchRef: input.patchRef },
  );
  // The kind is in the ref itself, so another step's payload is refused
  // without reading it — and never reaches git to fail there in git's words.
  const ref = parsePayloadRef(input.patchRef);
  if (ref?.form !== 'object' || ref.payloadKind !== 'patch') return notADiff;
  let stored: unknown;
  try {
    stored = await ctx.readPayload(input.patchRef);
  } catch (error) {
    if (error instanceof PayloadAccessError) return error.toAflowError();
    return validationError(
      'The diff `patchRef` names could not be read — stored diffs expire, and this one is ' +
        'gone or was never stored. Commission the change again for a fresh `patchRef`.',
      { patchRef: input.patchRef },
    );
  }
  if (typeof stored !== 'string' || !UNIFIED_DIFF_START.test(stored)) return notADiff;
  if (Buffer.byteLength(stored, 'utf8') > DIFF_CEILING_BYTES) {
    return validationError(
      `The diff \`patchRef\` names is over the ${String(DIFF_CEILING_BYTES / (1024 * 1024))} MB ` +
        'a patch applies.',
      { patchRef: input.patchRef },
    );
  }
  return stored;
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

    // The input schema admits a commit with no message only for a branch
    // published as it stands.
    if (input.commit !== undefined && input.commit.message === undefined) {
      const commit = await branchAsItStands(
        binding.root,
        input.commit.branch,
        input.commit.baseSha,
        input.commit.pushBase === undefined
          ? undefined
          : await resolvePushBase(binding.root, input.commit.pushBase),
      );
      return await successWithData(ctx, {
        state: 'applied',
        filesChanged: 0,
        files: [],
        conflicts: [],
        commit,
      });
    }

    const diff = await diffOf(ctx, input);
    if (typeof diff !== 'string') return await failureWithError(ctx, diff);

    const files = diff.trim() === '' ? [] : await patchPaths(binding.root, diff);
    if (files.length === 0 && input.commit?.mergeFrom === undefined) {
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

    if (input.commit?.message !== undefined) {
      // Measured before anything is made, so a base that cannot be read
      // leaves no commit and no branch behind.
      const pushBaseSha =
        input.commit.pushBase === undefined
          ? undefined
          : await resolvePushBase(binding.root, input.commit.pushBase);
      const { apply, commit } = await commitPatchOnBranch(
        binding.root,
        diff,
        input.mode,
        input.commit.branch,
        input.commit.message,
        {
          ...(input.commit.baseSha !== undefined ? { baseSha: input.commit.baseSha } : {}),
          ...(pushBaseSha !== undefined ? { pushBaseSha } : {}),
          ...(input.commit.mergeFrom !== undefined ? { mergeFrom: input.commit.mergeFrom } : {}),
        },
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

    const outcome = await applyPatch(binding.root, diff, input.mode);
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
