/**
 * The coding-harness half of the host lane.
 *
 * A harness is a command, so it runs through the same sandboxed spawn path as
 * any other, under its folder's posture (Plan 315 D19), which decides the
 * network. Two things differ, and both are the operator's to grant rather than
 * this executor's to assume: the harness reads a credential under the home
 * region the boundary denies, and in a `confined` folder it reaches a provider
 * the boundary blocks. Its profile — in the machine's own policy file — is what
 * opens exactly those and nothing else.
 *
 * The run happens in a private clone of the folder, detached at its base, never
 * the operator's checkout. That is what lets a run start while they have
 * uncommitted work, and what makes the result a diff to review rather than an
 * edit already made. The clone's refs are nobody else's, so whatever git the
 * agent runs moves only those (Plan 315 F56). Nothing is committed, and the
 * clone is removed once its changes have been collected.
 */
import { lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

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
  buildOperationId,
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
import { seededSecrets, withSeededConfig } from '../configSeed.js';
import { fetchCredential, scrubSecrets } from '../credentialFetch.js';
import { executableResolves } from '../probeEnv.js';
import { runUnderFolderPosture } from '../folderRun.js';
import {
  noSandboxMessage,
  reapWithdrawn,
  sandboxReadiness,
  type SandboxedRunResult,
} from '../sandboxedRun.js';
import {
  describeRefusals,
  describeUnreachedRequiredHosts,
  extractEgressRefusals,
  refusedRequiredHosts,
} from '../egressRefusals.js';
import {
  assertTakesMcpConfig,
  buildHarnessArgv,
  buildSessionArgs,
  HarnessProfileError,
  mintsConversationId,
  requireProfile,
  supportsContinuation,
  takesTurnBudget,
  type HarnessMcpServer,
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
  sessionForRetry,
  type HarnessSession,
} from '../harnessSessions.js';
import { createChatterStripper } from '../egressRefusals.js';
import { createHarnessEventReader } from '../harnessEvents.js';
import { isRealDirectory } from '../checkoutDependencies.js';
import {
  borrowedReads,
  checkApplies,
  checkoutAt,
  checkoutOfGitDir,
  collectChanges,
  currentHead,
  DIFF_CEILING_BYTES,
  folderPrefix,
  INLINE_DIFF_CAP_BYTES,
  NO_REPLACE_OBJECTS_ENV,
  prepareWorktree,
  removeWorktree,
  resolveBase,
  resolveCommit,
  RUN_SCRATCH_DIR,
  utf8Prefix,
  WorktreeError,
  type Checkout,
  type PreparedWorktree,
} from '../worktree.js';
import { PUBLICATION_SCRATCH_PREFIX } from '../branchCommit.js';
import { CHECK_SCRATCH_PREFIX } from '../commitCheck.js';
import { isMarkedScratch, makeAgentScratch, makeScratch } from '../executorScratch.js';
import { checkoutWidening } from '../sandboxPolicy.js';
import { browserFailure, jobScopeOf } from './browserHandler.js';

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

/**
 * The files a repository states its own rules in. Every one present is named,
 * whatever the harness: one that discovers a file itself reads it twice, and
 * one that discovers neither would otherwise miss the rules (Plan 326 D8).
 */
const REPOSITORY_RULES_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** A repository rules file in a checkout, as the harness is told of it. */
export interface RepositoryRulesFile {
  /** Its path from where the harness works, the folder's place in the clone. */
  readonly path: string;
  /** Where it is, in the words the brief uses. */
  readonly where: string;
}

/**
 * The rules files in the checkout: at the folder's place in the clone and, for a
 * folder inside a repository, at the clone's top as well — a package is bound
 * by its repository's rules, and a harness started bare discovers neither.
 *
 * Asked of the isolated checkout, never of the operator's folder: what the
 * harness can read is what the checkout holds.
 */
export async function repositoryRulesFiles(
  checkout: Pick<Checkout, 'path' | 'workDir'>,
): Promise<RepositoryRulesFile[]> {
  const places =
    checkout.workDir === checkout.path
      ? [{ dir: checkout.path, where: 'at the root of this checkout' }]
      : [
          { dir: checkout.workDir, where: 'in this folder' },
          { dir: checkout.path, where: 'at the top level of the repository this folder is in' },
        ];
  const found: RepositoryRulesFile[] = [];
  for (const { dir, where } of places) {
    for (const name of REPOSITORY_RULES_FILES) {
      const file = join(dir, name);
      if ((await stat(file).catch(() => undefined))?.isFile() === true) {
        found.push({ path: relative(checkout.workDir, file), where });
      }
    }
  }
  return found;
}

/**
 * A harness starts the way its profile starts it, and a bare one skips rules
 * discovery, so a repository's own rules reach the harness only if the task
 * names them. Derived from the checkout rather than written into a
 * skill: the file is a fact about the folder, and every task over that folder is
 * bound by it, whatever the task is.
 */
export function repositoryRulesSentence(files: readonly RepositoryRulesFile[]): string {
  const named = files.map(({ path, where }) => `\`${path}\` ${where}`).join(' and ');
  return (
    `The repository's own instructions are in ${named}; read them first and treat them as ` +
    'binding for every change.'
  );
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
  rulesFiles: readonly RepositoryRulesFile[],
  merge?: Pick<BaseMerge, 'from' | 'conflicts'>,
): string {
  return [
    rulesFiles.length > 0 ? repositoryRulesSentence(rulesFiles) : undefined,
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

/**
 * The task for a retry of a run, added to the conversation the earlier attempt
 * left. The whole task again, since that attempt may have been ended before
 * the harness kept any of it; its work is the checkout.
 */
export function continuedAttemptTask(task: string): string {
  return (
    'An earlier attempt at this task ended before it was done. This checkout holds what it ' +
    `changed: continue from there rather than starting over.\n\n${task}`
  );
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
 * Which harness a run gets (Plan 326 D6, D12).
 *
 * A named harness is that harness or a refusal; it never silently becomes
 * another, because a caller that named one is comparing or relying on it. A
 * run that names none gets its space's preferred harness, then the machine's
 * default — the operator's choice, or the only harness configured — each only
 * where it is installed, and otherwise the first configured harness that is.
 * Installing a second harness therefore never turns a skill that names none
 * into a refusal, and a space preferring one a machine lacks still runs there.
 */
export type HarnessSelectedBy = 'named' | 'preferred' | 'default' | 'fallback';

export interface HarnessSelection {
  readonly profile: HarnessProfile;
  readonly selectedBy: HarnessSelectedBy;
  /** Why a preferred or default harness did not run, when one did not. */
  readonly passedOver?: string;
}

export async function selectHarness(
  profiles: ReadonlyMap<string, HarnessProfile>,
  requested: string | undefined,
  preferred: string | undefined,
  machineDefault: string | undefined,
  resolves: (executable: string) => Promise<boolean> = executableResolves,
): Promise<HarnessSelection> {
  if (requested !== undefined) {
    return { profile: requireProfile(profiles, requested), selectedBy: 'named' };
  }
  const offered = [...profiles.values()];
  if (offered.length === 0) {
    throw new HarnessProfileError(
      'No coding harness is configured on this machine. Add one to the host policy before ' +
        'running a harness task.',
      'unknown_profile',
    );
  }
  const defaultId = machineDefault ?? (offered.length === 1 ? offered[0]?.id : undefined);
  const candidates: Array<{ id: string; by: HarnessSelectedBy; what: string }> = [
    ...(preferred !== undefined
      ? [{ id: preferred, by: 'preferred' as const, what: "this space's coding agent" }]
      : []),
    ...(defaultId !== undefined && defaultId !== preferred
      ? [{ id: defaultId, by: 'default' as const, what: 'the default harness' }]
      : []),
  ];
  const reasons: string[] = [];
  const tried = new Set<HarnessProfile>();
  for (const { id, by, what } of candidates) {
    const profile = profiles.get(id);
    if (profile === undefined) {
      reasons.push(`${what} \`${id}\` is not configured on this machine`);
      continue;
    }
    tried.add(profile);
    if (await resolves(profile.executable)) {
      return {
        profile,
        selectedBy: by,
        ...(reasons.length > 0 ? { passedOver: reasons.join('; ') } : {}),
      };
    }
    reasons.push(`${what} \`${id}\` is not installed at ${profile.executable}`);
  }
  if (defaultId === undefined) reasons.push('no default harness is set on this machine');
  for (const profile of offered) {
    if (tried.has(profile)) continue;
    if (await resolves(profile.executable)) {
      return { profile, selectedBy: 'fallback', passedOver: reasons.join('; ') };
    }
  }
  // Nothing resolves: run the first candidate anyway, so the failure to start
  // names the program and where it was looked for.
  return { profile: [...tried][0] ?? offered[0]!, selectedBy: 'default' };
}

/**
 * Failures carry the credential out too, if nothing removes it. Everything the
 * step reports goes through the scrubber, not only the successful shape.
 */
async function failure(
  ctx: ExecutorContext,
  error: unknown,
  secrets: readonly string[],
): Promise<StepResult> {
  const message = scrubSecrets(error instanceof Error ? error.message : String(error), secrets);
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
  conversation: string | undefined,
  continued: boolean,
  mcp?: HarnessMcpServer,
): string[] {
  return buildHarnessArgv(
    profile,
    task,
    buildSessionArgs(profile, conversation, continued),
    effectiveMaxTurns(profile, input.maxTurns),
    input.model,
    mcp,
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
  let credential: string | undefined;
  // Everything the run holds that must not leave it: the credential, and the
  // tokens of a lent sign-in.
  let secrets: string[] = [];
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
    const spaceId = requireSpace(binding, ctx.spaceId);
    requireDirectory(binding);
    // A harness edits files and runs commands. It needs the grant that had to
    // be typed, not the one a folder gets by being connected.
    requireExecution(binding);
    // A base or a merge source that names a remote is fetched into the
    // repository's own `.git`, so the binding has to permit writes even though
    // the harness never uses that permission — its policy withholds it below.
    requireWritable(binding);
    const selection = await selectHarness(
      policy.harnesses,
      input.harness,
      ctx.preferredHarness,
      policy.defaultHarness,
    );
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
    const readiness = sandboxReadiness();
    if (!readiness.ready) {
      return await failureWithError(ctx, permissionError(noSandboxMessage(readiness.missing)));
    }

    // An abandoned session holds a checkout on disk, so expiry is collected
    // here rather than on a timer — the work is bounded by what is expired, and
    // arrives with a run that is already doing filesystem work.
    for (const stale of expiredSessions(Date.now())) {
      await removeWorktree(stale.worktreePath).catch(() => {});
      await discardScratch(stale);
    }

    const sessionOwner = ctx.startingConversationId ?? ctx.runId;
    let session: HarnessSession | undefined;
    let resuming = false;
    if (input.continueFrom !== undefined) {
      session = ownedSession(input.continueFrom, sessionOwner);
      if (session === undefined) {
        // The same answer a session that never existed would get: naming a
        // session as another conversation's confirms it exists. This
        // conversation's own session that idled out, was lost to a restart,
        // lost its checkout to a failed re-preparation or went with its
        // folder's grant reaches this branch too, so the rule states how a kept
        // session ends and guesses at none of those for this ref.
        return await failureWithError(
          ctx,
          validationError(
            'A kept session is owned by the conversation that started the run that made it, ' +
              `and no session \`${input.continueFrom}\` is held for the conversation that ` +
              'started this run, or for this run where no conversation started it. ' +
              '`continueFrom` can name a session made by any run that same conversation ' +
              'started; a run no conversation started owns the sessions it makes itself. ' +
              'A session owned by any ' +
              'other conversation or run is refused as one that does not exist. A kept session ' +
              'ends once it has been idle for an hour, once this executor has restarted since ' +
              "it was made, once a turn naming a new `base` has failed to prepare the session's " +
              'checkout again, or once the grant of its connected folder is withdrawn.',
          ),
        );
      }
      if (session.bindingId !== binding.id) {
        // Ownership alone would let a conversation holding two bindings resume
        // one session while naming the other: the sandbox would combine this
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

    const canContinue = supportsContinuation(profile);
    // A retry continues the conversation an earlier attempt at the same work
    // left, in the checkout as that attempt left it. Its base and its merge
    // were made there already; making them again would discard its work.
    let continuesAttempt = false;
    if (input.continueFrom === undefined && ctx.attempt > 1 && canContinue) {
      const earlier = sessionForRetry(ctx.runId, ctx.logicalExecutionId);
      if (
        earlier?.bindingId === binding.id &&
        earlier.harnessId === profile.id &&
        claimSession(earlier)
      ) {
        session = earlier;
        claimed = earlier;
        resuming = true;
        continuesAttempt = true;
      }
    }

    // A harness that names its own conversation reports the id during the
    // first turn, and it is recorded then (Plan 326 D2).
    let conversationId =
      session?.conversationId ?? (mintsConversationId(profile) ? newConversationId() : undefined);
    // A session whose harness never reported an id is started again in its
    // checkout, which is not a resumed conversation.
    const resumedConversation = resuming && conversationId !== undefined;

    const namedRef = continuesAttempt ? undefined : input.base;
    const mergeFrom = continuesAttempt ? undefined : input.mergeFrom;
    // Resolved before any checkout is touched, so an unknown ref is refused
    // with the session's checkout still intact.
    const namedBase =
      namedRef === undefined ? undefined : await resolveBase(binding.root, namedRef);
    const mergeIdentity =
      mergeFrom === undefined ? undefined : await mergeIdentityArgs(binding.root);
    const mergeSource =
      mergeFrom === undefined ? undefined : await fetchMergeSource(binding.root, mergeFrom);
    const borrowed = await borrowedReads(binding.root);
    // A turn that names none keeps the checkout its session's base made, and so
    // is judged against that base as well.
    const base = namedRef ?? session?.base;

    let worktree: PreparedWorktree;
    if (session !== undefined && namedBase === undefined) {
      scratch = session.scratchDir;
      worktree = {
        ...checkoutAt(session.worktreePath, await folderPrefix(binding.root)),
        baseSha: session.baseSha,
      };
      keepScratch = true;
    } else if (session !== undefined && namedBase !== undefined) {
      // The conversation continues in a fresh checkout at the named base: the
      // earlier checkout's work is the conversation's memory, not this turn's
      // starting point.
      scratch = session.scratchDir;
      keepScratch = true;
      await removeWorktree(session.worktreePath);
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
      scratch = await makeScratch(HARNESS_SCRATCH_PREFIX);
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
      merge = await mergeIntoCheckout(worktree, mergeSource, mergeIdentity);
      if (merge !== undefined && session !== undefined) {
        session = { ...session, merge };
        recordSession(session);
        claimed = session;
      }
    }

    // Fetched before the run and held only for its duration.
    credential = await fetchCredential(profile);
    secrets = [
      ...(credential !== undefined ? [credential] : []),
      ...(await seededSecrets(profile)),
    ];

    // Everything the harness writes outside its checkout goes here, and the
    // sandbox is granted this rather than the scratch holding the checkout.
    const agentScratch = await makeAgentScratch(scratch);

    // A configuration directory of the run's own, so a harness that keeps state
    // has somewhere to keep it that is not the operator's home. A session keeps
    // the same one across turns, which is where the conversation lives.
    let configDir: string | undefined;
    if (profile.configDirEnv !== undefined) {
      configDir = session?.configDir ?? join(agentScratch, 'harness-config');
      await mkdir(configDir, { recursive: true });
    }

    const scratchDir = scratch;
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
        scope: { ...jobScopeOf(ctx), spaceId },
        profile: input.browser.profile,
        reach: { allowedDomains: profile.allowedDomains, localPorts: profile.browserLocalPorts },
        scratchDir: agentScratch,
        stepExecutionId: ctx.stepExecutionId,
        storeScreenshot: async (image) => await browserService.storeScreenshot(tenantId, image),
        onActivity,
        startedAt,
      });
    }
    if (input.maxTurns !== undefined && !takesTurnBudget(profile)) {
      onActivity({
        kind: 'status',
        at: 0,
        text:
          `${profile.label ?? profile.id} takes no turn budget, so maxTurns ` +
          `${String(input.maxTurns)} is not applied; the run is bounded by its timeout.`,
      });
    }
    const runTurn = async (
      task: string,
      continued: boolean,
      conversation: string | undefined,
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
        return await withSeededConfig(
          profile,
          configDir,
          async () =>
            await runUnderFolderPosture({
              binding,
              argv: harnessTurnArgv(
                profile,
                input,
                task,
                conversation,
                continued && conversation !== undefined,
                browserTurn?.mcp,
              ),
              cwd: worktree.workDir,
              // The sandbox's proxy names the host it refused only when asked to, and
              // that name is the whole diagnosis for a harness that reached nothing.
              env: profile.env,
              trustedEnv: {
                SRT_DEBUG: '1',
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
              // Where the operator keeps their tools, as every command gets: a
              // harness installed under home, and the tools its agent runs, are
              // otherwise behind the standing denial of home.
              toolPaths: policy.toolPaths,
              scratchDir: agentScratch,
              journalScratchDir: scratchDir,
              widening: {
                authPaths: profile.authPaths,
                writePaths: profile.writePaths,
                allowedDomains: profile.allowedDomains,
                ...checkoutWidening(worktree, borrowed),
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
              ...(secrets.length > 0 ? { secrets } : {}),
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
            }),
        );
      } finally {
        // Whatever the last chunk left unterminated. A harness whose final line
        // carries no newline would otherwise have it held back for good.
        emit(visible.flush());
        events.flush();
        spoken = events.answer();
        const reported = events.conversationId();
        if (reported !== undefined) {
          conversationId = reported;
          if (session !== undefined && session.conversationId === undefined) {
            session.conversationId = reported;
          }
        }
        await browserTurn?.close();
      }
    };

    // Recorded before the first turn rather than after the last, so an attempt
    // ended part-way leaves its conversation and its checkout for a retry.
    if (canContinue && session === undefined) {
      session = {
        busy: true,
        id: nextSessionRef(),
        ownerId: sessionOwner,
        runId: ctx.runId,
        logicalExecutionId: ctx.logicalExecutionId,
        bindingId: binding.id,
        harnessId: profile.id,
        worktreePath: worktree.path,
        scratchDir,
        configDir: configDir ?? join(agentScratch, 'harness-config'),
        conversationId,
        baseSha: worktree.baseSha,
        ...(base !== undefined ? { base } : {}),
        ...(merge !== undefined ? { merge } : {}),
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      recordSession(session);
      claimed = session;
      // Kept for the next turn; expiry or withdrawal is what removes it.
      keepScratch = true;
    }

    const brief = composeHarnessTask(
      input.task,
      input.inputs,
      await repositoryRulesFiles(worktree),
      keptCheckout ? undefined : merge,
    );
    const task = continuesAttempt ? continuedAttemptTask(brief) : brief;
    let result: SandboxedRunResult;
    let check: HarnessResultCheck | undefined;
    if (expected === undefined) {
      result = await runTurn(task, resuming, conversationId);
    } else {
      const { schema, validate } = expected;
      const resultPath = join(worktree.workDir, RESULT_RELATIVE_PATH);
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
        const continued = canContinue && conversationId !== undefined;
        const conversation = continued
          ? conversationId
          : mintsConversationId(profile)
            ? newConversationId()
            : undefined;
        result = await runTurn(
          retryInstruction(task, schema, check.problem, continued),
          continued,
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
      changes = await collectChanges(worktree);
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
    // required, otherwise a valid result, a diff or an answer — because the same refusals on a
    // finished run are a note about its edges, and the blocking wording beside a
    // complete result tells the reader the outcome did not happen.
    const reached =
      result.exitCode === 0 &&
      !result.timedOut &&
      (check?.ok === true ||
        ((check === undefined || !input.resultRequired) &&
          (changes.filesChanged > 0 || (spoken ?? result.stdout) !== '')));
    const refusalNote = describeRefusals(
      scrubbed.refusals,
      reached ? 'reached_result' : 'produced_nothing',
      profile.id,
    );
    const note = scrubSecrets(
      collectFailure === undefined
        ? (refusalNote ?? '')
        : [collectFailure, refusalNote].filter(Boolean).join(' '),
      secrets,
    );
    // Asked of the binding, not the clone: the question is whether what the
    // harness produced can still be taken into the repository the operator has.
    // A named base is where a publication would append the diff, so the tree
    // that answers is that ref's head in the folder as it stands now, not the
    // folder's working tree; a base ref gone since the run started leaves the
    // commit the checkout started at to stand in.
    // A merged checkout is judged against its merge, which is where the
    // publication applies the diff once it has made that merge again; a branch
    // that moved since is the publication's `stale_base`, not this answer's.
    const judgedAt =
      merge !== undefined
        ? merge.commit
        : base === undefined
          ? undefined
          : await resolveCommit(binding.root, base).catch(() => worktree.baseSha);
    // A commit is judged through an index of its own, in the clone: the merge
    // commit exists only there, and the clone reads every object the folder has.
    // Reached through the git directory this lane made, never the checkout's
    // `.git`, which the harness could have pointed at a repository of its own.
    const applies = await checkApplies(
      judgedAt === undefined ? binding.root : worktree,
      changes.patch,
      judgedAt,
    );
    // A named base is judged against itself; the folder's HEAD was never the
    // starting point, so its distance from it says nothing about the run.
    const headMoved = base === undefined && (await currentHead(binding.root)) !== worktree.baseSha;

    const sessionRef = session?.id;

    // The feed was live while the run was; kept once, by reference, so the run
    // view has it after the live buffer is gone. Its own kind, because the
    // payload path is deterministic per (step, attempt, kind) and the step's
    // result already takes `output`.
    const activityRef =
      activity.length > 0 ? await ctx.writePayload('activity', activity) : undefined;

    // Stored whole whatever its size, because the inline copy is capped and a
    // publication has to take all of it.
    const patch = changes.patch === '' ? '' : scrubSecrets(changes.patch, secrets);
    const patchRef = patch === '' ? undefined : await ctx.writePayload('patch', patch);
    const patchTruncated = Buffer.byteLength(patch, 'utf8') > INLINE_DIFF_CAP_BYTES;
    const inlinePatch = patchTruncated ? utf8Prefix(patch, INLINE_DIFF_CAP_BYTES) : patch;

    const work: Record<string, unknown> = {
      runId: result.processId,
      harness: {
        id: profile.id,
        ...(profile.label !== undefined ? { label: profile.label } : {}),
        selectedBy: selection.selectedBy,
        ...(selection.passedOver !== undefined ? { passedOver: selection.passedOver } : {}),
      },
      ...(input.maxTurns !== undefined
        ? { budget: { maxTurns: input.maxTurns, applied: takesTurnBudget(profile) } }
        : {}),
      ...(sessionRef !== undefined ? { sessionRef } : {}),
      continued: resumedConversation,
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

    const unreached = refusedRequiredHosts(input.requiredHosts ?? [], scrubbed.refusals);
    if (unreached.length > 0) {
      return await failureWithError(
        ctx,
        permissionError(
          scrubSecrets(describeUnreachedRequiredHosts(unreached, profile.id), secrets),
          { ...failureDetails(), unreachedHosts: unreached },
        ),
      );
    }

    if (check !== undefined && !check.ok && input.resultRequired) {
      // The step fails, and the work still comes back: a check that rejects an
      // answer has said nothing about the files the harness edited, and an
      // operator who cannot see them has to pay for the run again to get them.
      const details = failureDetails();
      return await failureWithError(
        ctx,
        validationError(
          scrubSecrets(
            `The harness ended without a usable result: ${check.problem}. It exited ` +
              (result.exitCode === null ? 'without a code' : String(result.exitCode)) +
              `${result.timedOut ? ' after its time ran out' : ''}. Console output is ` +
              'diagnostics, not the result; what it changed is on this error.',
            secrets,
          ),
          details,
        ),
      );
    }

    return await successWithData(ctx, {
      ...work,
      ...(check === undefined
        ? {}
        : check.ok
          ? { result: check.value }
          : { resultProblem: scrubSecrets(check.problem, secrets) }),
    });
  } catch (error) {
    return await failure(ctx, error, secrets);
  } finally {
    await browser?.close();
    if (claimed !== undefined) releaseSession(claimed);
    if (!keepScratch) {
      if (worktreePath !== undefined) await removeWorktree(worktreePath);
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  }
}

export const HARNESS_RUN_OPERATION = buildOperationId('host', 'harness', 'run');

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
  /** Clones removed from the scratch directories below. */
  readonly checkouts: number;
  /** Scratch directories removed from the temp root. */
  readonly scratchDirs: number;
}

/**
 * Take away the checkouts no session owns.
 *
 * Sessions live in this executor's memory, so a restart forgets every one of
 * them while their scratch, and the clone in it, stays in the temp root with
 * nothing left that would ever expire it. Run at boot, before any job, when
 * every checkout this lane made is one of those.
 *
 * What is swept is marked scratch and nothing else: each directory under the
 * temp root named the way this executor names its scratch, owned by no session
 * and carrying the marker `makeScratch` leaves, whole. Whatever a run left in
 * it is the executor's, a clone killed before its checkout was detached
 * included, so what decides is the directory and never the shape of a checkout
 * in it. A directory without the marker is left, whatever it holds, and no
 * connected folder is read or written. Inside one, only a real directory is
 * treated as a checkout; a link is removed with the scratch and nothing it
 * leads to is walked.
 */
export async function removeOrphanedCheckouts(
  tempRoot: string = tmpdir(),
): Promise<OrphanedCheckouts> {
  const owned = new Set(allSessions().map((session) => basename(session.scratchDir)));
  const unowned = (name: string): boolean =>
    CHECKOUT_SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix)) && !owned.has(name);

  let checkouts = 0;
  let scratchDirs = 0;
  for (const name of await readdir(tempRoot).catch(() => [] as string[])) {
    if (!unowned(name)) continue;
    const scratchDir = join(tempRoot, name);
    if (!(await isRealDirectory(scratchDir)) || !(await isMarkedScratch(scratchDir))) continue;
    for (const checkout of await checkoutsIn(scratchDir)) {
      await removeWorktree(checkout);
      checkouts += 1;
    }
    await discardScratch({ scratchDir });
    scratchDirs += 1;
  }
  return { checkouts, scratchDirs };
}

/**
 * The checkouts in a scratch directory, made whole or in part: a directory
 * holding a `.git` of any kind, and one whose git directory alone was made.
 * Only a real directory counts, as the entry and as the checkout it names: the
 * sweep decides nothing by a scratch's shape, and a link standing in a
 * checkout's place would lead the removal into whatever the link points at.
 */
async function checkoutsIn(scratchDir: string): Promise<string[]> {
  const found = new Set<string>();
  for (const entry of await readdir(scratchDir).catch(() => [] as string[])) {
    const path = join(scratchDir, entry);
    if (!(await isRealDirectory(path))) continue;
    if ((await lstat(join(path, '.git')).catch(() => undefined)) !== undefined) {
      found.add(path);
      continue;
    }
    const checkout = checkoutOfGitDir(path);
    if (checkout === undefined) continue;
    const info = await lstat(checkout).catch(() => undefined);
    if (info === undefined || info.isDirectory()) found.add(checkout);
  }
  return [...found];
}

/**
 * Drop every session under a binding, removing what they left on disk. Used
 * when the binding is gone; the scratch holds the session's clone, so taking
 * the directory away takes the checkout with it.
 */
async function discardSessionsForBinding(bindingId: string): Promise<void> {
  for (const session of sessionsForBinding(bindingId)) {
    forgetSession(session.id);
    await discardScratch(session);
  }
}
