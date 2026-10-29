/**
 * A connected folder's push posture, checks and sandbox posture, how many
 * coding agents its machine runs at once and whether it holds itself awake
 * while they run, read from the policy file on this machine — and the GitHub
 * repository its `origin` fetches from, read from its git config, with the
 * branch its HEAD names. Asked `ui`, which files touch the folder's UI and
 * whether a harness run there could have a browser (`folderUi.ts`).
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
  parsePayloadRef,
  resolveBranchPolicy,
} from '@aflow/schemas';
import type { z } from 'zod';

import { selectHarness } from './harnessHandlers.js';

import {
  type HostBinding,
  HostBindingError,
  loadHostPolicy,
  requireBinding,
  requireSpace,
} from '../bindings.js';
import { answerFolderUi, judgedBrowserGrant } from '../folderUi.js';
import { sandboxPostureOf } from '../sandboxPosture.js';
import {
  DIFF_CEILING_BYTES,
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
 * has GitHub to call. The default branch is read only for a caller that asks
 * for it, since a folder that never recorded `origin`'s HEAD asks `origin`
 * over the network; one `origin` cannot be asked for is left out rather than
 * guessed, so a caller names it instead.
 */
async function githubOrigin(
  binding: HostBinding,
  withDefaultBranch: boolean,
): Promise<HostFolderOrigin | undefined> {
  if (binding.singleFile || !(await isGitRepository(binding.root))) return undefined;
  if (!(await remoteNames(binding.root)).includes('origin')) return undefined;
  let repository: HostGitHubOrigin | undefined;
  try {
    repository = parseGitHubRemote(await remoteFetchUrl(binding.root, 'origin'));
  } catch {
    return undefined;
  }
  if (repository === undefined || !withDefaultBranch) return repository;
  const head = await readRemoteDefaultBranch(binding.root, 'origin');
  return 'branch' in head ? { ...repository, defaultBranch: head.branch } : repository;
}

/** What a folder's stored diff says, read through the job's own tenant; undefined where it is not one. */
async function storedDiff(ctx: ExecutorContext, ref: string): Promise<string | undefined> {
  const parsed = parsePayloadRef(ref);
  if (parsed?.form !== 'object' || parsed.payloadKind !== 'patch') return undefined;
  const stored = await ctx.readPayload(ref).catch(() => undefined);
  if (typeof stored !== 'string' || Buffer.byteLength(stored, 'utf8') > DIFF_CEILING_BYTES) {
    return undefined;
  }
  return stored;
}

async function inspect(
  ctx: ExecutorContext,
  policyPath: string,
  servesBrowser: boolean,
): Promise<StepResult> {
  try {
    const parsed = HostBindingInspectInputSchema.safeParse(await ctx.readPayload(ctx.job.inputRef));
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const policy = await loadHostPolicy(policyPath);
    const binding = requireBinding(policy.bindings, parsed.data.bindingId);
    requireSpace(binding, ctx.spaceId);
    const origin = await githubOrigin(binding, parsed.data.defaultBranch === true);
    const question = parsed.data.ui;
    const ui =
      question === undefined
        ? undefined
        : await answerFolderUi(binding, question, {
            servesBrowser,
            browserGranted: judgedBrowserGrant(ctx),
            harness: async () =>
              await selectHarness(
                policy.harnesses,
                question.harness,
                ctx.preferredHarness,
                policy.defaultHarness,
              )
                .then((selection) => selection.profile)
                .catch(() => undefined),
            readDiff: async (ref) => await storedDiff(ctx, ref),
          });

    const output: HostBindingInspectOutput = {
      id: binding.id,
      ...(origin !== undefined ? { origin } : {}),
      ...(binding.branchPolicy !== undefined
        ? { branchPolicy: resolveBranchPolicy(binding.branchPolicy) }
        : {}),
      sandbox: sandboxPostureOf(binding),
      maxConcurrentHarnessRuns: policy.maxConcurrentHarnessRuns,
      keepAwake: policy.keepAwake,
      ...(ui !== undefined ? { ui } : {}),
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

export function createHostBindingHandler(
  policyPath: string,
  options: { readonly servesBrowser: boolean } = { servesBrowser: false },
): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set(['host.binding.inspect']),
    execute: async (ctx: ExecutorContext): Promise<StepResult> =>
      await inspect(ctx, policyPath, options.servesBrowser),
  };
}
