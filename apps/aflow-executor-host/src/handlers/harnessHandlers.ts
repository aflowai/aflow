/**
 * The coding-harness half of the host lane.
 *
 * A harness runs under its folder's sandbox posture (Plan 315 D19). In an
 * `open` folder it is the operator's own tool run as the operator. In a
 * `confined` one it goes through the same confined spawn path as any command,
 * and two things differ, both the operator's to grant rather than this
 * executor's to assume: the harness reads a credential under the home region
 * the boundary denies, and it reaches a provider the boundary blocks. Its
 * profile — in the machine's own policy file — is what opens exactly those and
 * nothing else.
 *
 * The run happens in a detached worktree, never the operator's checkout. That
 * is what lets a run start while they have uncommitted work, and what makes the
 * result a diff to review rather than an edit already made. Nothing is
 * committed, the agent's ordinary git is refused a branch or tag move
 * (`refGuard.ts` names the calls that are not), and the worktree is removed once its changes have been collected.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';

import AjvModule from 'ajv';
import type { z } from 'zod';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  permissionError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import {
  HOST_HARNESS_MAX_TURNS_DEFAULT,
  HostHarnessRunInputSchema,
  MAX_INLINE_PAYLOAD_BYTES,
  type HarnessActivityLine,
  type PayloadRef,
} from '@aflow/schemas';

import {
  HostBindingError,
  executionPermitted,
  loadHostPolicy,
  requireBinding,
  requireDirectory,
  requireExecution,
  requireSpace,
  requireWritable,
} from '../bindings.js';
import {
  fetchMergeSource,
  mergeIdentityArgs,
  mergeIntoCheckout,
  type BaseMerge,
  type MergeConflict,
} from '../baseMerge.js';
import type { BrowserDriver } from '../browser/driver.js';
import { BrowserDriverError } from '../browser/errors.js';
import {
  browserLogText,
  EPHEMERAL_PROFILE_SCRATCH_PREFIX,
  openHarnessBrowser,
  type HarnessBrowser,
} from '../browser/harnessBrowser.js';
import { fetchCredential, scrubSecret } from '../credentialFetch.js';
import { folderRunReadiness, runUnderFolderPosture } from '../folderRun.js';
import { sandboxPostureOf } from '../sandboxPosture.js';
import { noSandboxMessage, reapWithdrawn, type SandboxedRunResult } from '../sandboxedRun.js';
import { describeRefusals, extractEgressRefusals } from '../egressRefusals.js';
import {
  assertTakesMcpConfig,
  buildHarnessArgv,
  buildSessionArgs,
  HarnessProfileError,
  requireProfile,
  supportsContinuation,
  type HarnessProfile,
} from '../harnessProfiles.js';
import {
  allSessions,
  claimSession,
  discardScratch,
  expiredSessions,
  forgetSession,
  HARNESS_SCRATCH_PREFIX,
  releaseSession,
  sessionsForBinding,
  withdrawnSessions,
  newConversationId,
  nextSessionRef,
  ownedSession,
  recordSession,
  type HarnessSession,
} from '../harnessSessions.js';
import { createChatterStripper } from '../egressRefusals.js';
import { createHarnessEventReader } from '../harnessEvents.js';
import {
  changedRefs,
  checkApplies,
  collectChanges,
  currentHead,
  DIFF_CEILING_BYTES,
  fetchRemoteBase,
  INLINE_DIFF_CAP_BYTES,
  linkedWorktrees,
  NO_REPLACE_OBJECTS_ENV,
  prepareWorktree,
  removeWorktree,
  resolveCommit,
  RUN_SCRATCH_DIR,
  snapshotRefs,
  utf8Prefix,
  WorktreeError,
  type LinkedWorktree,
} from '../worktree.js';
import { PUBLICATION_SCRATCH_PREFIX } from '../branchCommit.js';
import { CHECK_SCRATCH_PREFIX } from '../commitCheck.js';
import { installRefGuard, noRefGuardMessage, refGuardReadiness } from '../refGuard.js';
import { browserFailure } from './browserHandler.js';

/**
 * Where a task that declared an output schema leaves its answer. It is inside
 * the isolated checkout because that is the one place the harness may write,
 * and it is removed before the diff is collected so the answer never reads as a
 * change to the operator's folder.
 */
const RESULT_RELATIVE_PATH = `${RUN_SCRATCH_DIR}/result.json`;
/**
 * The directories under the temp root this executor adds checkouts in — a
 * harness run's scratch, a publication's and a check's. Nothing else named
 * `aflow-` there is known to be its own.
 */
const CHECKOUT_SCRATCH_PREFIXES = [
  HARNESS_SCRATCH_PREFIX,
  PUBLICATION_SCRATCH_PREFIX,
  CHECK_SCRATCH_PREFIX,
  EPHEMERAL_PROFILE_SCRATCH_PREFIX,
] as const;
/** A result is an answer, not a dataset; past this it is a mistake, not a big one. */
const RESULT_CAP_BYTES = 1_000_000;

interface ResultValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}
type AjvConstructor = new (opts: { allErrors?: boolean; strict?: boolean }) => {
  compile(schema: Record<string, unknown>): ResultValidator;
};
const Ajv = ((AjvModule as unknown as { default?: AjvConstructor }).default ??
  AjvModule) as unknown as AjvConstructor;

export type HarnessResultCheck =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string };

/**
 * One instance per schema: Ajv keeps every compiled schema by its `$id`, so a
 * shared instance refuses the second run that sends the same id.
 */
export function compileResultValidator(schema: Record<string, unknown>): ResultValidator {
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

/** The file a repository states its own rules in. */
const REPOSITORY_RULES_FILE = 'CLAUDE.md';

/**
 * A harness starts the way its profile starts it, and a bare Claude Code skips
 * `CLAUDE.md` auto-discovery, so a repository's own rules reach the harness only
 * if the task names them. Derived from the checkout rather than written into a
 * skill: the file is a fact about the folder, and every task over that folder is
 * bound by it, whatever the task is.
 */
export const REPOSITORY_RULES_SENTENCE =
  `The repository's own instructions are in \`${REPOSITORY_RULES_FILE}\` at the root of this ` +
  'checkout; read them first and treat them as binding for every change.';

/**
 * Asked of the isolated checkout, never of the operator's folder: what the
 * harness can read is what the checkout holds.
 */
export async function hasRepositoryRules(checkoutRoot: string): Promise<boolean> {
  try {
    return (await stat(join(checkoutRoot, REPOSITORY_RULES_FILE))).isFile();
  } catch {
    return false;
  }
}

/** The task with its structured inputs attached, so the prose can name them. */
export function taskWithInputs(task: string, inputs: Record<string, unknown> | undefined): string {
  if (inputs === undefined || Object.keys(inputs).length === 0) return task;
  return `${task}\n\nInputs for this task, as JSON:\n${JSON.stringify(inputs)}`;
}

function resolvingConflict({ path, kind }: MergeConflict, from: string): string {
  const named = `\`${path}\` (${kind})`;
  switch (kind) {
    case 'content':
      return (
        `${named}: both sides changed it, and it holds conflict markers. Replace them with ` +
        'the resolution.'
      );
    case 'add-add':
      return (
        `${named}: both sides added it differently, and it holds both between conflict ` +
        'markers. Replace them with the resolution.'
      );
    case 'modify-delete':
      return (
        `${named}: this branch changed it and \`${from}\` deleted it. It is deleted in the ` +
        'merge; restore it with the changes it needs, or leave it deleted. The version this ' +
        `branch had is \`HEAD^1:${path}\`.`
      );
    case 'delete-modify':
      return (
        `${named}: this branch deleted it and \`${from}\` changed it. It is deleted in the ` +
        'merge; restore it with the changes it needs, or leave it deleted. The version ' +
        `\`${from}\` has is \`HEAD^2:${path}\`.`
      );
  }
}

/**
 * What the agent is told of a merge that conflicted. Its checkout's last
 * commit is that merge, so nothing in the tree alone says the markers are the
 * merge's rather than the repository's, or that a file missing from it was
 * changed on one side.
 */
export function mergeConflictSentence(merge: Pick<BaseMerge, 'from' | 'conflicts'>): string {
  return [
    `The last commit of this checkout merges \`${merge.from}\` into it, with its conflicts ` +
      'committed: markers in a file both sides wrote, and a file one side deleted left ' +
      'deleted. Resolve every one of them as part of this task; your change is measured from ' +
      'that merge commit, and a publication refuses a file that still holds the markers ' +
      'the merge left:',
    ...merge.conflicts.map((conflict) => `- ${resolvingConflict(conflict, merge.from)}`),
  ].join('\n');
}

/** The task as the harness receives it: the repository's rules, a merge's conflicts, the prose, the inputs. */
export function composeHarnessTask(
  task: string,
  inputs: Record<string, unknown> | undefined,
  repositoryRules: boolean,
  merge?: Pick<BaseMerge, 'from' | 'conflicts'>,
): string {
  return [
    repositoryRules ? REPOSITORY_RULES_SENTENCE : undefined,
    merge !== undefined && merge.conflicts.length > 0 ? mergeConflictSentence(merge) : undefined,
    taskWithInputs(task, inputs),
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');
}

/** What the task tells the harness about where its answer goes and what shape it takes. */
export function resultInstruction(schema: Record<string, unknown>): string {
  return (
    `\n\nWrite your final result as JSON to \`${RESULT_RELATIVE_PATH}\`, relative to the root ` +
    `of this checkout, matching this JSON Schema:\n${JSON.stringify(schema)}\n` +
    'Write that file even when you changed nothing else — it is the only thing read as the ' +
    'result, and console output is not.'
  );
}

/**
 * The task for a further turn. A harness that can be resumed already holds the
 * work, so it is told only what was wrong with the answer; one that cannot is
 * starting over and needs the whole task again.
 */
export function retryInstruction(
  task: string,
  schema: Record<string, unknown>,
  problem: string,
  continued: boolean,
): string {
  if (continued) {
    return (
      `The result could not be used: ${problem}. Write it again at ` +
      `\`${RESULT_RELATIVE_PATH}\`, as JSON matching this JSON Schema:\n${JSON.stringify(schema)}`
    );
  }
  return `${task}${resultInstruction(schema)}\n\nAn earlier attempt failed: ${problem}.`;
}

export function validateResultText(text: string, validate: ResultValidator): HarnessResultCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `\`${RESULT_RELATIVE_PATH}\` is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
  if (validate(parsed)) return { ok: true, value: parsed };
  const detail = (validate.errors ?? [])
    .map(
      (e) =>
        `${e.instancePath === undefined || e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`,
    )
    .join('; ');
  return {
    ok: false,
    problem: `the JSON at \`${RESULT_RELATIVE_PATH}\` does not match the schema: ${detail}`,
  };
}

export async function readHarnessResult(
  resultPath: string,
  validate: ResultValidator,
): Promise<HarnessResultCheck> {
  let text: string;
  try {
    const info = await stat(resultPath);
    if (info.size > RESULT_CAP_BYTES) {
      return {
        ok: false,
        problem:
          `\`${RESULT_RELATIVE_PATH}\` is ${String(info.size)} bytes, over the ` +
          `${String(RESULT_CAP_BYTES)}-byte limit. Write a shorter result`,
      };
    }
    text = await readFile(resultPath, 'utf8');
  } catch {
    return { ok: false, problem: `no result file was written at \`${RESULT_RELATIVE_PATH}\`` };
  }
  return validateResultText(text, validate);
}

/**
 * Which harness a run gets when it did not name one.
 *
 * A machine offering exactly one has nothing to choose between, and asking for
 * the id costs a round trip to the operator for a fact the machine already
 * holds — the id is not in anything the caller reads until the space context
 * carries it. Several is a real choice, so the refusal names them instead of
 * picking; it is a validation refusal rather than a permission one because
 * resending with an id is exactly the remedy.
 */
export type HarnessSelection =
  | { readonly kind: 'profile'; readonly profile: HarnessProfile }
  | { readonly kind: 'ambiguous'; readonly problem: string };

export function selectHarness(
  profiles: ReadonlyMap<string, HarnessProfile>,
  requested: string | undefined,
): HarnessSelection {
  if (requested !== undefined) {
    return { kind: 'profile', profile: requireProfile(profiles, requested) };
  }
  const offered = [...profiles.values()];
  const only = offered.length === 1 ? offered[0] : undefined;
  if (only !== undefined) return { kind: 'profile', profile: only };
  if (offered.length === 0) {
    throw new HarnessProfileError(
      'No coding harness is configured on this machine. Add one to the host policy before ' +
        'running a harness task.',
      'unknown_profile',
    );
  }
  // The id first, because it is the only spelling `harness` accepts; the label
  // after it, because a choice between two ids is one an operator has to be able
  // to read.
  const ids = offered
    .map((p) => (p.label === undefined ? p.id : `${p.id} (${p.label})`))
    .sort()
    .join(', ');
  return {
    kind: 'ambiguous',
    problem: `This machine offers more than one coding harness: ${ids}. Name one in \`harness\`.`,
  };
}

/**
 * Failures carry the credential out too, if nothing removes it. Everything the
 * step reports goes through the scrubber, not only the successful shape.
 */
async function failure(
  ctx: ExecutorContext,
  error: unknown,
  secret: string | undefined,
): Promise<StepResult> {
  const message = scrubSecret(error instanceof Error ? error.message : String(error), secret);
  if (error instanceof HarnessProfileError) {
    // A request the machine's harness cannot take is answered as a validation
    // refusal: sending the task again without it is the remedy, where a missing
    // or unknown profile is the operator's to grant.
    return await failureWithError(
      ctx,
      error.kind === 'unsupported_request' ? validationError(message) : permissionError(message),
    );
  }
  if (error instanceof HostBindingError) {
    return await failureWithError(ctx, permissionError(message));
  }
  if (error instanceof BrowserDriverError) {
    return await failureWithError(ctx, browserFailure(error));
  }
  if (error instanceof WorktreeError) {
    return await failureWithError(ctx, validationError(message));
  }
  return await failureWithError(ctx, internalError(message));
}

/**
 * The turn budget a run gets: its own, else the operation's default where the
 * harness can take one. A harness with no turn argument runs without a budget
 * rather than refusing a run that never asked for one.
 */
export function effectiveMaxTurns(
  profile: HarnessProfile,
  maxTurns: number | undefined,
): number | undefined {
  if (maxTurns !== undefined) return maxTurns;
  return profile.turnsArgs.length > 0 ? HOST_HARNESS_MAX_TURNS_DEFAULT : undefined;
}

/** The argv one turn of a harness run starts with. */
export function harnessTurnArgv(
  profile: HarnessProfile,
  input: Pick<z.output<typeof HostHarnessRunInputSchema>, 'maxTurns' | 'model'>,
  task: string,
  conversation: string,
  continued: boolean,
  mcpConfig?: string,
): string[] {
  return buildHarnessArgv(
    profile,
    task,
    buildSessionArgs(profile, conversation, continued),
    effectiveMaxTurns(profile, input.maxTurns),
    input.model,
    mcpConfig,
  );
}

/** What a harness run that asks for a browser is served with. */
export interface HarnessBrowserService {
  readonly driver: BrowserDriver;
  /** Keeps one screenshot under the run's tenant, each a payload of its own. */
  storeScreenshot(tenantId: string, image: { data: string; mimeType: string }): Promise<PayloadRef>;
}

async function runHarness(
  ctx: ExecutorContext,
  policyPath: string,
  browserService: HarnessBrowserService | undefined,
): Promise<StepResult> {
  const raw = await ctx.readPayload(ctx.job.inputRef);
  const parsed = HostHarnessRunInputSchema.safeParse(raw);
  if (!parsed.success) {
    return await failureWithError(ctx, validationError(parsed.error.message));
  }
  const input = parsed.data;

  let expected: { schema: Record<string, unknown>; validate: ResultValidator } | undefined;
  if (input.outputSchema !== undefined) {
    try {
      expected = {
        schema: input.outputSchema,
        validate: compileResultValidator(input.outputSchema),
      };
    } catch (error) {
      return await failureWithError(
        ctx,
        validationError(
          `\`outputSchema\` is not a usable JSON Schema: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  let scratch: string | undefined;
  let worktreePath: string | undefined;
  let bindingRoot: string | undefined;
  let credential: string | undefined;
  let claimed: HarnessSession | undefined;
  let browser: HarnessBrowser | undefined;
  // A session's checkout outlives the run, so the teardown below must not take
  // it away. Set only when this run owns the scratch it made.
  let keepScratch = false;
  try {
    const policy = await loadHostPolicy(policyPath);

    // A running harness holds the provider credential in its environment and
    // writes into a checkout of the operator's code. Withdrawal has to reach it
    // whichever binding this call happens to name, so reconciliation runs
    // against the whole policy rather than the one being asked about.
    const permitted = executionPermitted(policy);
    reapWithdrawn(permitted);
    for (const gone of withdrawnSessions(permitted.bindings)) {
      if (!gone.busy) await discardScratch(gone);
    }

    let binding;
    try {
      binding = requireBinding(policy.bindings, input.bindingId);
    } catch (error) {
      // A withdrawn binding takes its sessions with it. A checkout left behind
      // under a grant that no longer exists is the access the operator just
      // removed, still sitting on disk.
      if (error instanceof HostBindingError) await discardSessionsForBinding(input.bindingId);
      throw error;
    }
    requireSpace(binding, ctx.spaceId);
    requireDirectory(binding);
    // A harness edits files and runs commands. It needs the grant that had to
    // be typed, not the one a folder gets by being connected.
    requireExecution(binding);
    // Creating a worktree records it under the repository's own `.git`, so the
    // binding has to permit writes even though the harness never uses that
    // permission — its policy withholds it below.
    requireWritable(binding);
    const selection = selectHarness(policy.harnesses, input.harness);
    if (selection.kind === 'ambiguous') {
      return await failureWithError(ctx, validationError(selection.problem));
    }
    const profile = selection.profile;
    if (input.browser !== undefined) {
      assertTakesMcpConfig(profile);
      if (browserService === undefined) {
        return await failureWithError(
          ctx,
          validationError(
            'This executor serves no browser, so the run cannot be given one. Send the task ' +
              'without `browser`.',
          ),
        );
      }
    }
    bindingRoot = binding.root;

    const confined = sandboxPostureOf(binding) === 'confined';
    const readiness = folderRunReadiness(binding);
    if (!readiness.ready) {
      return await failureWithError(ctx, permissionError(noSandboxMessage(readiness.missing)));
    }
    const refGuard = await refGuardReadiness();
    if (!refGuard.ready) {
      return await failureWithError(ctx, permissionError(noRefGuardMessage(refGuard.missing)));
    }

    // An abandoned session holds a checkout on disk, so expiry is collected
    // here rather than on a timer — the work is bounded by what is expired, and
    // arrives with a run that is already doing filesystem work.
    for (const stale of expiredSessions(Date.now())) {
      await removeWorktree(stale.bindingRoot, stale.worktreePath).catch(() => {});
      await discardScratch(stale);
    }

    let session: HarnessSession | undefined;
    let resuming = false;
    if (input.continueFrom !== undefined) {
      session = ownedSession(input.continueFrom, ctx.runId);
      if (session === undefined) {
        // The same answer a session that never existed would get: naming a
        // session as another run's confirms it exists.
        return await failureWithError(
          ctx,
          validationError(
            `No session \`${input.continueFrom}\` belongs to this run. It may have expired, or ` +
              'this executor may have restarted since it was made.',
          ),
        );
      }
      if (session.bindingId !== binding.id) {
        // Ownership by run alone let a run holding two bindings resume one
        // session while naming the other: the sandbox would combine this
        // binding's root with that session's worktree, and a permission change
        // on the session's own binding would not apply. Process handles are
        // scoped both ways; a session is a longer-lived handle and needs it more.
        return await failureWithError(
          ctx,
          validationError(
            `Session \`${input.continueFrom}\` belongs to a different connected folder.`,
          ),
        );
      }
      if (session.harnessId !== profile.id) {
        return await failureWithError(
          ctx,
          validationError(
            `Session \`${input.continueFrom}\` belongs to harness \`${session.harnessId}\`, ` +
              `not \`${profile.id}\`. A conversation cannot change harness part-way.`,
          ),
        );
      }
      if (!claimSession(session)) {
        return await failureWithError(
          ctx,
          validationError(
            `Session \`${input.continueFrom}\` already has a turn running. Two turns would ` +
              "share one checkout and one conversation, and each would report the other's work.",
          ),
        );
      }
      claimed = session;
      resuming = true;
    }

    const conversationId = session?.conversationId ?? newConversationId();
    const canContinue = supportsContinuation(profile);

    // Resolved before any checkout is touched, so an unknown ref is refused
    // with the session's checkout still intact.
    if (input.base !== undefined) await fetchRemoteBase(binding.root, input.base);
    const namedBase =
      input.base === undefined ? undefined : await resolveCommit(binding.root, input.base);
    const mergeIdentity =
      input.mergeFrom === undefined ? undefined : await mergeIdentityArgs(binding.root);
    const mergeSource =
      input.mergeFrom === undefined
        ? undefined
        : await fetchMergeSource(binding.root, input.mergeFrom);
    // A turn that names none keeps the checkout its session's base made, and so
    // is judged against that base as well.
    const base = input.base ?? session?.base;

    let worktree: { path: string; baseSha: string };
    if (session !== undefined && namedBase === undefined) {
      scratch = session.scratchDir;
      worktree = { path: session.worktreePath, baseSha: session.baseSha };
      keepScratch = true;
    } else if (session !== undefined && namedBase !== undefined) {
      // The conversation continues in a fresh checkout at the named base: the
      // earlier checkout's work is the conversation's memory, not this turn's
      // starting point.
      scratch = session.scratchDir;
      keepScratch = true;
      await removeWorktree(session.bindingRoot, session.worktreePath);
      try {
        worktree = await prepareWorktree(binding.root, scratch, 'work', { at: namedBase });
      } catch (error) {
        forgetSession(session.id);
        keepScratch = false;
        throw error;
      }
      const { merge: _earlierMerge, ...earlier } = session;
      const moved: HarnessSession = {
        ...earlier,
        worktreePath: worktree.path,
        baseSha: worktree.baseSha,
        ...(base !== undefined ? { base } : {}),
      };
      recordSession(moved);
      session = moved;
      claimed = moved;
    } else {
      scratch = await mkdtemp(join(tmpdir(), HARNESS_SCRATCH_PREFIX));
      worktree = await prepareWorktree(
        binding.root,
        scratch,
        'work',
        namedBase === undefined ? {} : { at: namedBase },
      );
    }
    worktreePath = worktree.path;

    const keptCheckout = session !== undefined && namedBase === undefined;
    let merge: BaseMerge | undefined = keptCheckout ? session?.merge : undefined;
    if (mergeSource !== undefined && mergeIdentity !== undefined) {
      merge = await mergeIntoCheckout(worktree.path, mergeSource, mergeIdentity);
      if (merge !== undefined && session !== undefined) {
        session = { ...session, merge };
        recordSession(session);
        claimed = session;
      }
    }

    const refsBefore = await snapshotRefs(binding.root);

    // Fetched before the run and held only for its duration.
    credential = await fetchCredential(profile);

    // A configuration directory of the run's own, so a harness that keeps state
    // has somewhere to keep it that is not the operator's home. A session keeps
    // the same one across turns, which is where the conversation lives.
    let configDir: string | undefined;
    if (profile.configDirEnv !== undefined) {
      configDir = session?.configDir ?? join(scratch, 'harness-config');
      await mkdir(configDir, { recursive: true });
    }

    const scratchDir = scratch;
    const refGuardEnv = await installRefGuard(scratchDir, binding.root);
    // What the harness said, as opposed to what it printed. Set per turn, so
    // the last turn's answer is the one that comes back — the same rule the
    // run result itself follows.
    let spoken: string | undefined;
    const startedAt = Date.now();
    // The feed of the whole run, across every turn: a retry is more of the same
    // step, and a reader watching one card should not have the earlier turns
    // disappear out from under it.
    const activity: HarnessActivityLine[] = [];
    const onActivity = (line: HarnessActivityLine): void => {
      activity.push(line);
      // Newline-terminated: the live buffer is bytes appended in order, so the
      // terminator is the only thing that makes one line recoverable from the
      // next.
      void ctx.emitLiveDelta('activity', `${JSON.stringify(line)}\n`);
    };
    if (input.browser !== undefined && browserService !== undefined) {
      const tenantId = ctx.tenantId;
      browser = await openHarnessBrowser({
        driver: browserService.driver,
        scope: {
          tenantId,
          runId: ctx.runId,
          ...(ctx.spaceId !== undefined ? { spaceId: ctx.spaceId } : {}),
        },
        profile: input.browser.profile,
        reach: { allowedDomains: profile.allowedDomains, localPorts: profile.browserLocalPorts },
        scratchDir,
        stepExecutionId: ctx.stepExecutionId,
        storeScreenshot: async (image) => await browserService.storeScreenshot(tenantId, image),
        onActivity,
        startedAt,
      });
    }
    const runTurn = async (
      task: string,
      continued: boolean,
      conversation: string,
    ): Promise<SandboxedRunResult> => {
      // One per turn, because it holds the line a chunk ended part-way
      // through. Shared across turns it would join the end of one run's output
      // to the start of the next.
      const visible = createChatterStripper();
      // Everything the harness prints is read as activity — an event stream as
      // typed lines, plain text as narration — so nothing it prints ever reaches
      // a viewer as if it were the agent's message.
      const events = createHarnessEventReader(profile.output, onActivity, startedAt);
      const emit = (text: string): void => {
        events.push(text);
      };
      // Pipes of the turn's own: a turn killed mid-call leaves its answer, or
      // half a request, in them, and the next turn's relay numbers its calls
      // from 1 again.
      const browserTurn = await browser?.openTurn();
      try {
        return await runUnderFolderPosture({
          binding,
          argv: harnessTurnArgv(
            profile,
            input,
            task,
            conversation,
            continued,
            browserTurn?.mcpConfigPath,
          ),
          cwd: worktree.path,
          env: {},
          trustedEnv: {
            // The sandbox's proxy names the host it refused only when asked to,
            // and that name is the whole diagnosis for a harness that reached
            // nothing.
            ...(confined ? { SRT_DEBUG: '1' } : {}),
            ...refGuardEnv,
            // Commissions see the stored objects too, as the checkout they run
            // in does: a review reads the range with its own git, and the
            // verdict that can stand in for the operator's approval has to be
            // about the commits a push sends — never what a `refs/replace/` ref
            // the folder holds shows in their place. A coding agent likewise
            // reads the history its commit will be pushed on top of.
            ...NO_REPLACE_OBJECTS_ENV,
            ...(configDir !== undefined && profile.configDirEnv !== undefined
              ? { [profile.configDirEnv]: configDir }
              : {}),
            ...(credential !== undefined && profile.credential
              ? { [profile.credential.env]: credential }
              : {}),
          },
          timeoutMs: input.timeoutMs,
          scratchDir,
          widening: {
            authPaths: profile.authPaths,
            writePaths: profile.writePaths,
            allowedDomains: profile.allowedDomains,
            writableRoot: worktree.path,
            withholdBindingWrite: true,
          },
          idPrefix: 'hr',
          ownerRunId: ctx.runId,
          signal: ctx.signal,
          // A harness reads its task from argv and its prompt from nowhere: left
          // open, it spends the first seconds of every run waiting on a pipe this
          // executor never writes to.
          closeStdin: true,
          // Handed to the spawn path so captured output and live deltas are both
          // scrubbed there, per stream, before either leaves it.
          ...(credential !== undefined ? { secret: credential } : {}),
          // What streams is the harness talking. The spawn path already holds
          // standard error back as diagnostics; this takes out anything the
          // adapter managed to write on the other descriptor, because a viewer
          // reading the executor's own noise as the harness's words cannot tell
          // a working run from a stuck one.
          onDelta: (text) => {
            emit(visible.push(text));
          },
          // Anything the harness wrote, on either descriptor and whether or not
          // it is narrated. A turn that thinks in silence on standard output
          // while the sandbox logs its work is still a turn in progress, and
          // the idle deadline is minutes, not hours.
          onOutput: () => ctx.reportProgress?.(),
        });
      } finally {
        // Whatever the last chunk left unterminated. A harness whose final line
        // carries no newline would otherwise have it held back for good.
        emit(visible.flush());
        events.flush();
        spoken = events.answer();
        await browserTurn?.close();
      }
    };

    const task = composeHarnessTask(
      input.task,
      input.inputs,
      await hasRepositoryRules(worktree.path),
      keptCheckout ? undefined : merge,
    );
    let result: SandboxedRunResult;
    let check: HarnessResultCheck | undefined;
    if (expected === undefined) {
      result = await runTurn(task, resuming, conversationId);
    } else {
      const { schema, validate } = expected;
      const resultPath = join(worktree.path, RESULT_RELATIVE_PATH);
      // A session's checkout still holds the answer to its last turn, and a
      // stale one reads exactly like a fresh one.
      await rm(resultPath, { force: true });
      result = await runTurn(task + resultInstruction(schema), resuming, conversationId);
      check = await readHarnessResult(resultPath, validate);
      let retriesLeft = input.resultRetries;
      while (!check.ok && retriesLeft > 0 && !ctx.signal.aborted) {
        retriesLeft -= 1;
        await rm(resultPath, { force: true });
        // A harness that cannot be resumed gets a conversation of its own: the
        // id that named the first one is taken.
        const conversation = canContinue ? conversationId : newConversationId();
        result = await runTurn(
          retryInstruction(task, schema, check.problem, canContinue),
          canContinue,
          conversation,
        );
        check = await readHarnessResult(resultPath, validate);
      }
      // Taken out of the checkout before the diff is read: the answer is a
      // result, not a change to the operator's folder.
      await rm(resultPath, { force: true });
    }

    // Ended before anything is reported, so the log holds every call the harness made.
    let browserLog: PayloadRef | undefined;
    if (browser !== undefined) {
      await browser.close();
      const records = browser.records();
      if (records.length > 0) browserLog = await ctx.writePayload('logs', browserLogText(records));
    }

    // Changes are collected before the worktree goes away, and regardless of how
    // the harness ended: a run that timed out or was stopped has still done work,
    // and discarding it because the exit code was wrong would be the worst
    // possible answer.
    // A run that produced output has done work even if reading the diff fails.
    // Failing the step here would throw away everything the harness reported.
    let changes: Awaited<ReturnType<typeof collectChanges>> = {
      patch: '',
      filesChanged: 0,
      overCeiling: false,
    };
    let collectFailure: string | undefined;
    try {
      changes = await collectChanges(worktree.path);
    } catch (error) {
      collectFailure = error instanceof Error ? error.message : String(error);
    }
    if (changes.overCeiling) {
      collectFailure =
        `The diff is over the ${String(DIFF_CEILING_BYTES / (1024 * 1024))} MB a run keeps, so ` +
        'it was not kept and cannot be published; `filesChanged` counts what the harness ' +
        'changed. A change that size is usually generated output the task should not have ' +
        'written.';
    }
    const scrubbed = extractEgressRefusals(result.stderr);
    // A refused host stopped the run only if the run reached nothing. Asked of
    // the exit code and of what came back — the validated result where one was
    // asked for, otherwise a diff or an answer — because the same refusals on a
    // finished run are a note about its edges, and the blocking wording beside a
    // complete result tells the reader the outcome did not happen.
    const reached =
      result.exitCode === 0 &&
      !result.timedOut &&
      (check === undefined
        ? changes.filesChanged > 0 || (spoken ?? result.stdout) !== ''
        : check.ok);
    const refusalNote = describeRefusals(
      scrubbed.refusals,
      reached ? 'reached_result' : 'produced_nothing',
      profile.id,
    );
    const note = scrubSecret(
      collectFailure === undefined
        ? (refusalNote ?? '')
        : [collectFailure, refusalNote].filter(Boolean).join(' '),
      credential,
    );
    const refChanges = changedRefs(refsBefore, await snapshotRefs(binding.root));
    // Asked of the binding, not the worktree: the question is whether what the
    // harness produced can still be taken into the repository the operator has.
    // A named base is where a publication would append the diff, so the tree
    // that answers is that ref's head as it stands now, not the folder's working
    // tree. A base ref gone since the run started is refused below as a ref
    // change, and the commit the checkout started at stands in until then.
    // A merged checkout is judged against its merge, which is where the
    // publication applies the diff once it has made that merge again; a branch
    // that moved since is the publication's `stale_base`, not this answer's.
    const judgedAt =
      merge !== undefined
        ? merge.commit
        : base === undefined
          ? undefined
          : await resolveCommit(binding.root, base).catch(() => worktree.baseSha);
    const applies = await checkApplies(binding.root, changes.patch, judgedAt);
    // A named base is judged against itself; the folder's HEAD was never the
    // starting point, so its distance from it says nothing about the run.
    const headMoved = base === undefined && (await currentHead(binding.root)) !== worktree.baseSha;

    let sessionRef = session?.id;
    if (canContinue) {
      if (session === undefined) {
        sessionRef = nextSessionRef();
        recordSession({
          busy: false,
          id: sessionRef,
          ownerRunId: ctx.runId,
          bindingId: binding.id,
          bindingRoot: binding.root,
          harnessId: profile.id,
          worktreePath: worktree.path,
          scratchDir: scratch,
          configDir: configDir ?? join(scratch, 'harness-config'),
          conversationId,
          baseSha: worktree.baseSha,
          ...(base !== undefined ? { base } : {}),
          ...(merge !== undefined ? { merge } : {}),
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        });
      }
      // Kept for the next turn; expiry or withdrawal is what removes it.
      keepScratch = true;
    }

    // The feed was live while the run was; kept once, by reference, so the run
    // view has it after the live buffer is gone. Its own kind, because the
    // payload path is deterministic per (step, attempt, kind) and the step's
    // result already takes `output`.
    const activityRef =
      activity.length > 0 ? await ctx.writePayload('activity', activity) : undefined;

    // Stored whole whatever its size, because the inline copy is capped and a
    // publication has to take all of it.
    const patch = changes.patch === '' ? '' : scrubSecret(changes.patch, credential);
    const patchRef = patch === '' ? undefined : await ctx.writePayload('patch', patch);
    const patchTruncated = Buffer.byteLength(patch, 'utf8') > INLINE_DIFF_CAP_BYTES;
    const inlinePatch = patchTruncated ? utf8Prefix(patch, INLINE_DIFF_CAP_BYTES) : patch;

    const work: Record<string, unknown> = {
      runId: result.processId,
      harness: {
        id: profile.id,
        ...(profile.label !== undefined ? { label: profile.label } : {}),
      },
      ...(sessionRef !== undefined ? { sessionRef } : {}),
      continued: resuming,
      baseSha: worktree.baseSha,
      ...(merge !== undefined
        ? {
            merge: {
              from: merge.from,
              conflicts: merge.conflicts.map(({ path, kind }) => ({ path, kind })),
            },
          }
        : {}),
      ...(patchRef !== undefined ? { patchRef, patch: inlinePatch } : {}),
      filesChanged: changes.filesChanged,
      patchTruncated,
      applies: applies.state,
      ...(applies.state === 'conflict' ? { applyConflict: applies.detail } : {}),
      headMoved,
      refChanges,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      // An event stream is neither the answer nor diagnostics — it is the feed,
      // and it was already emitted as one. What the result carries is what the
      // harness said.
      stdout: spoken ?? result.stdout,
      ...(activityRef !== undefined ? { activityRef } : {}),
      ...(browserLog !== undefined ? { browserLog } : {}),
      stderr: scrubbed.text,
      truncated: result.truncated,
      blockedDomains: [...new Set(scrubbed.refusals.map((r) => r.host))],
      ...(note !== '' ? { boundaryNote: note } : {}),
    };

    // A failure carries the work too, but the error travels inline on the
    // result stream: an inline copy too large for it is dropped, and
    // `patchRef` still names the whole diff.
    const failureDetails = (): Record<string, unknown> => {
      const details = { ...work };
      const body = details['patch'];
      if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') > MAX_INLINE_PAYLOAD_BYTES) {
        delete details['patch'];
      }
      return details;
    };

    if (check !== undefined && !check.ok) {
      // The step fails, and the work still comes back: a check that rejects an
      // answer has said nothing about the files the harness edited, and an
      // operator who cannot see them has to pay for the run again to get them.
      const details = failureDetails();
      return await failureWithError(
        ctx,
        validationError(
          scrubSecret(
            `The harness ended without a usable result: ${check.problem}. It exited ` +
              (result.exitCode === null ? 'without a code' : String(result.exitCode)) +
              `${result.timedOut ? ' after its time ran out' : ''}. Console output is ` +
              'diagnostics, not the result; what it changed is on this error.',
            credential,
          ),
          details,
        ),
      );
    }

    return await successWithData(ctx, {
      ...work,
      ...(check?.ok === true ? { result: check.value } : {}),
    });
  } catch (error) {
    return await failure(ctx, error, credential);
  } finally {
    await browser?.close();
    if (claimed !== undefined) releaseSession(claimed);
    if (!keepScratch) {
      if (worktreePath !== undefined && bindingRoot !== undefined) {
        await removeWorktree(bindingRoot, worktreePath);
      }
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  }
}

export const HARNESS_RUN_OPERATION = 'host.harness.run';

export function createHostHarnessHandler(
  policyPath: string,
  browser?: HarnessBrowserService,
): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set([HARNESS_RUN_OPERATION]),
    execute: async (ctx: ExecutorContext): Promise<StepResult> =>
      await runHarness(ctx, policyPath, browser),
  };
}

export interface OrphanedCheckouts {
  /** Checkouts taken off each connected folder, by the folder's root. */
  readonly removed: ReadonlyMap<string, number>;
  /** Scratch directories removed from the temp root. */
  readonly scratchDirs: number;
}

/**
 * Take away the checkouts no session owns.
 *
 * Sessions live in this executor's memory, so a restart forgets every one of
 * them while their checkouts stay registered in the operator's repository and
 * their scratch stays in the temp root, with nothing left that would ever
 * expire them. Run at boot, before any job, when every checkout this lane made
 * is one of those.
 *
 * Only a detached checkout under the temp root, in a directory named the way
 * this executor names its own, is taken: a checkout with a branch in it, or
 * anywhere else, is the operator's.
 *
 * `roots` undefined means the connected folders could not be read, and then
 * nothing is taken. A scratch directory holds a checkout registered in one of
 * those folders, and removing it first leaves that registration behind in the
 * operator's repository as a stale entry.
 */
export async function removeOrphanedCheckouts(
  roots: readonly string[] | undefined,
  tempRoot: string = tmpdir(),
): Promise<OrphanedCheckouts> {
  if (roots === undefined) return { removed: new Map(), scratchDirs: 0 };

  const owned = new Set(allSessions().map((session) => basename(session.scratchDir)));
  const unowned = (name: string): boolean =>
    CHECKOUT_SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix)) && !owned.has(name);
  // git records a checkout by its resolved path, and the temp root is commonly
  // reached through a link (`/var` on macOS), so both spellings are asked.
  const tempRoots = new Set([tempRoot, await realpath(tempRoot).catch(() => tempRoot)]);
  const underUnownedScratch = (path: string): boolean => {
    for (const under of tempRoots) {
      if (!path.startsWith(under + sep)) continue;
      return unowned(path.slice(under.length + 1).split(sep)[0] ?? '');
    }
    return false;
  };

  const removed = new Map<string, number>();
  for (const root of new Set(roots)) {
    let checkouts: LinkedWorktree[];
    let rootReal: string;
    try {
      checkouts = await linkedWorktrees(root);
      rootReal = await realpath(root);
    } catch {
      // Not a repository, or not there: nothing of this lane's is registered.
      continue;
    }
    for (const checkout of checkouts) {
      // A folder connected from inside a checkout lists itself among them.
      if (checkout.path === rootReal || !checkout.detached) continue;
      if (!underUnownedScratch(checkout.path)) continue;
      await removeWorktree(root, checkout.path);
      removed.set(root, (removed.get(root) ?? 0) + 1);
    }
  }

  let scratchDirs = 0;
  for (const name of await readdir(tempRoot).catch(() => [] as string[])) {
    if (!unowned(name)) continue;
    const scratchDir = join(tempRoot, name);
    // A checkout still in it is registered in a repository the loop above did
    // not take it from, and is left for that repository to account for.
    if (await holdsCheckout(scratchDir)) continue;
    await discardScratch({ scratchDir });
    scratchDirs += 1;
  }
  return { removed, scratchDirs };
}

async function holdsCheckout(scratchDir: string): Promise<boolean> {
  for (const entry of await readdir(scratchDir).catch(() => [] as string[])) {
    if (
      await stat(join(scratchDir, entry, '.git')).then(
        () => true,
        () => false,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Drop every session under a binding, removing what they left on disk. Used
 * when the binding is gone, so `removeWorktree` has no repository to prune
 * against and the directory itself is what gets taken away.
 */
async function discardSessionsForBinding(bindingId: string): Promise<void> {
  for (const session of sessionsForBinding(bindingId)) {
    forgetSession(session.id);
    await discardScratch(session);
  }
}
