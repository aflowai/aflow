/**
 * A connected folder's push posture, checks and sandbox posture, how many
 * coding agents its machine runs at once and whether it holds itself awake
 * while they run, read from the policy file on this machine — and the GitHub
 * repository its `origin` fetches from, read from its git config, with the
 * branch its HEAD names.
 *
 * Read here rather than from the workspace's copy because both are only ever
 * declared here. Nothing in the folder is written, so a file-only binding
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
  type HostFolderOrigin,
  type HostGitHubOrigin,
  parseGitHubRemote,
  resolveBranchPolicy,
} from '@aflow/schemas';
import type { z } from 'zod';

import {
  type HostBinding,
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireSpace,
} from '../bindings.js';
import { sandboxPostureOf } from '../sandboxPosture.js';
import {
  isGitRepository,
  readRemoteDefaultBranch,
  remoteFetchUrl,
  remoteNames,
} from '../worktree.js';

type HostBindingInspectOutput = z.infer<typeof HostBindingInspectOutputSchema>;

/**
 * The GitHub repository `origin` fetches from, where it is one, and the branch
 * its HEAD names. A folder that is no repository, has no `origin`, or fetches
 * from elsewhere has none, and says nothing more: the read is for a skill that
 * has GitHub to call. A default branch `origin` cannot be asked for is left
 * out rather than guessed, so a caller names it instead.
 */
async function githubOrigin(binding: HostBinding): Promise<HostFolderOrigin | undefined> {
  if (binding.singleFile || !(await isGitRepository(binding.root))) return undefined;
  if (!(await remoteNames(binding.root)).includes('origin')) return undefined;
  let repository: HostGitHubOrigin | undefined;
  try {
    repository = parseGitHubRemote(await remoteFetchUrl(binding.root, 'origin'));
  } catch {
    return undefined;
  }
  if (repository === undefined) return undefined;
  const head = await readRemoteDefaultBranch(binding.root, 'origin');
  return 'branch' in head ? { ...repository, defaultBranch: head.branch } : repository;
}

async function inspect(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const parsed = HostBindingInspectInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const policy = await loadHostPolicy(policyPath);
    const binding = requireBinding(policy.bindings, parsed.data.bindingId);
    requireSpace(binding, ctx.spaceId);
    const origin = await githubOrigin(binding);

    const output: HostBindingInspectOutput = {
      id: binding.id,
      ...(origin !== undefined ? { origin } : {}),
      ...(binding.branchPolicy !== undefined
        ? { branchPolicy: resolveBranchPolicy(binding.branchPolicy) }
        : {}),
      sandbox: sandboxPostureOf(binding),
      maxConcurrentHarnessRuns: policy.maxConcurrentHarnessRuns,
      keepAwake: policy.keepAwake,
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
