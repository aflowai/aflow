import AjvModule from 'ajv';
import { describe, it, expect } from 'vitest';
import {
  computeReadyTasksWithWhen,
  failedChildRunOf,
  decideByRules,
  computeRejectedApprovalSkipSet,
  materializeAndValidateSkillConfig,
  projectTaskOutput,
  renderParentInputsValidationFailure,
  resolvePromotedRunMetrics,
  selectFirstTaskForParentInputs,
  taskOutputFromCompletedRun,
  validateParentTaskInputs,
} from '@aflow/cybernetic-runtime';
import {
  AfterReviewOverrideSchema,
  HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_KEEP_AWAKE_DEFAULT,
  HOST_MERGE_POSTURE_DEFAULT,
  HOST_PUSH_APPROVAL_DEFAULT,
  HOST_SANDBOX_POSTURE_DEFAULT,
  HostApprovedPushSchema,
  HostBindingInspectOutputSchema,
  HostProcessExecInputSchema,
  HostCommitCheckInputSchema,
  HostCommitCheckOutputSchema,
  HostCommitScanInputSchema,
  HostCommitScanOutputSchema,
  type HostPushApproval,
  type WorkflowTask,
  WorkflowRunDecideInputSchema,
  WorkflowRunDetailInputSchema,
  WorkflowRunListInputSchema,
  WorkflowRunListOutputSchema,
  WorkflowRunStartInputSchema,
  WorkflowRunWakeupEnvelopeSchema,
  HostCommitDescribeInputSchema,
  HostCommitDescribeOutputSchema,
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  isEvalPlaneOperation,
  LoopPullRequestsSchema,
  ShepherdHandoffReadSchema,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  MAX_WORKFLOW_RUN_DEPTH,
  PAUSE_INSTRUCTION_MAX_CHARS,
  HANDED_ON_FINDINGS_MAX_COUNT,
  PullRequestFindingsSchema,
  PullRequestGapsSchema,
  pullRequestReviewRecord,
  RUN_PULL_REQUEST_URL_OUTPUT,
  substituteTemplateBinds,
  toJsonSchemaSync,
} from '@aflow/schemas';
import { COMMISSION_CHANGE, COMMISSION_RESULT_SCHEMA } from './commissionChange.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import { PUSH_GATE_OTHERWISE, PUSH_GATE_RULES } from './publishLocalChangesGate.js';
import { PUBLISH_AS_IT_STANDS } from './publishLocalChangesProse.js';
import { REPOSITORY_UNKNOWN_FAILURE } from './publishLocalChangesRepository.js';
import { AFTER_REVIEW_QUESTION, AFTER_REVIEW_ROUTES } from './publishLocalChangesDecisions.js';
import { SKILL_CATALOG } from './index.js';
import { LOCAL_PR_SHEPHERD } from './localPrShepherd.js';
import { HANDOFF_PIN_PATH } from './localPrShepherdHandoff.js';
import {
  AFTER_FIX_ROUND_REASON,
  AFTER_REVIEW_SETTLE_OTHERWISE,
  AFTER_REVIEW_SETTLE_RULES,
  FIRST_ROUND_REASON,
  NITS_ONLY_REASON,
  NOT_APPROVED_REASON,
} from './publishLocalChangesAfterReview.js';
import {
  REVIEW_FINDINGS_MAX,
  REVIEW_LOCAL_CHANGES,
  REVIEW_SEVERITIES,
} from './reviewLocalChanges.js';
import { skillGuidance } from '../__tests__/skillGuidance.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;

const wf = PUBLISH_LOCAL_CHANGES.bundle.workflow;
const taskById = new Map(wf.tasks.map((task) => [task.taskId, task]));

const BASE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
/** Where `origin/<base>` is, behind `BASE` by the folder's own unpushed commits. */
const ORIGIN_BASE = 'e'.repeat(40);

/** The commit an applied patch reports, as `host.file.patch` returns it. */
const COMMIT = {
  branch: 'aflow/x',
  sha: HEAD,
  message: 'The change',
  baseSha: BASE,
  appended: false,
  range: `${BASE}..${HEAD}`,
  pushRange: `${ORIGIN_BASE}..${HEAD}`,
  pushBaseSha: ORIGIN_BASE,
  pushRefspec: `${HEAD}:refs/heads/aflow/x`,
};

/** A commit an earlier publication made on `aflow/x` and never pushed. */
const STRANDED = 'd'.repeat(40);

/** The run of the review a publication starts. */
/** The repository and base as every task after the folder read binds them. */
const SETTLED_OWNER = {
  kind: 'task_output',
  taskId: 'resolve-repository',
  path: 'repository.owner',
};
const SETTLED_REPO = { kind: 'task_output', taskId: 'resolve-repository', path: 'repository.repo' };
const SETTLED_BASE = { kind: 'task_output', taskId: 'resolve-repository', path: 'repository.base' };

const REVIEW_RUN_ID = '0a0b0c0d-1111-4222-8333-444455556666';

/** The branch's head as `host.file.patch` reports it when published as it stands. */
const AS_IT_STANDS = {
  branch: 'aflow/x',
  sha: STRANDED,
  message: 'The change\n\nWhat it does.',
  body: 'What it does.',
  baseSha: HEAD,
  appended: false,
  asItStands: true,
  range: `${HEAD}..${STRANDED}`,
  pushRange: `${ORIGIN_BASE}..${STRANDED}`,
  pushBaseSha: ORIGIN_BASE,
  pushRefspec: `${STRANDED}:refs/heads/aflow/x`,
};

function taskOrThrow(taskId: string) {
  const task = taskById.get(taskId);
  if (!task) throw new Error(`task "${taskId}" must exist`);
  return task;
}

function runInputOrThrow(id: string) {
  const input = (wf.runInputs ?? []).find((i) => i.id === id);
  if (!input) throw new Error(`run input "${id}" must exist`);
  return input;
}

/** Every command argv any task hands to a shell, after substitution. */
function materializedCommands(): string[][] {
  const commands: string[][] = [];
  for (const task of wf.tasks) {
    const template = task.inputTemplate;
    if (template === undefined || !('command' in template)) continue;
    const declared = new Set(Object.keys(task.inputBindings ?? {}));
    const resolved: Record<string, unknown> = {
      bindingId: 'folder-1',
      refspec: COMMIT.pushRefspec,
      base: 'main',
    };
    const substituted = substituteTemplateBinds(template, resolved, declared);
    commands.push(substituted['command'] as string[]);
  }
  return commands;
}

describe('Publish Local Changes — the patch becomes a branch, then a pull request', () => {
  it('has a valid contract', () => {
    const bundle = PUBLISH_LOCAL_CHANGES.bundle;
    const { validity } = materializeAndValidateSkillConfig({
      tasks: wf.tasks,
      stateVariables: wf.stateVariables,
      output: wf.output,
      runInputs: wf.runInputs,
      mode: wf.mode,
      bundle: {
        uiOutput: bundle.manifest.uiOutput,
        taskCriteria: bundle.evalSuite?.taskCriteria,
        evalSuite: bundle.evalSuite,
      },
      campaign: {
        contract: bundle.manifest.campaign,
        goal: bundle.manifest.goal,
        outcomes: wf.outcomes,
        goalCriteria: bundle.evalSuite?.goalCriteria,
      },
    });
    expect(validity.diagnostics.map((d) => `${d.code}: ${d.detail}`)).toEqual([]);
    expect(validity.status).toBe('valid');
  });

  it('is thirty-three tasks — where the commit message comes from, the commission found, a named one checked against it and the stop on one that differs, its summary read, the folder read, the repository settled and the stop where none is, commit, check, the stop on a failed check, scan, what decides the approval, the review, its findings decided by the rounds rule, the check of an override and the stop on its refusal, the pull request composed, the push gate, the fix round handed its branch, approve, push, the pull request found, rewritten or opened, and the review read back', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual([
      'message-from',
      'find-commission',
      'check-commission',
      'commission-refused',
      'read-commission',
      'read-folder',
      'resolve-repository',
      'repository-unknown',
      'commit',
      'check-commit',
      'checks-failed',
      'recheck-commit',
      'scan-commit',
      'read-repository',
      'read-push-approval',
      'review-commit',
      'settle-after-review',
      'claim-override',
      'read-override-pr',
      'read-override-pin',
      'read-override-handoff',
      'verify-override',
      'override-refused',
      'describe-pr',
      'decide-push',
      'hand-fix-round',
      'hand-fix-round-merging',
      'approve-push',
      'push',
      'find-pr',
      'update-pr',
      'open-pr',
      'read-review',
    ]);
    expect(wf.tasks.filter((t) => t.type !== 'operation').map((t) => t.taskId)).toEqual([
      'approve-push',
    ]);
    expect(Object.fromEntries(wf.tasks.map((t) => [t.taskId, t.dependsOn ?? []]))).toEqual({
      'message-from': [],
      'find-commission': ['message-from'],
      'check-commission': ['message-from', 'find-commission'],
      'commission-refused': ['check-commission'],
      'read-commission': [
        'message-from',
        'find-commission',
        'check-commission',
        'commission-refused',
      ],
      'read-folder': ['message-from'],
      'resolve-repository': ['read-folder'],
      'repository-unknown': ['resolve-repository'],
      commit: [
        'message-from',
        'find-commission',
        'read-commission',
        'resolve-repository',
        'repository-unknown',
      ],
      'check-commit': ['commit'],
      'checks-failed': ['check-commit'],
      'recheck-commit': ['commit', 'check-commit'],
      'scan-commit': ['commit', 'check-commit', 'recheck-commit'],
      'read-repository': ['commit', 'check-commit', 'recheck-commit'],
      'read-push-approval': ['commit', 'scan-commit'],
      'review-commit': ['read-push-approval', 'scan-commit'],
      'settle-after-review': ['review-commit'],
      'claim-override': ['review-commit', 'settle-after-review'],
      'read-override-pr': ['claim-override', 'read-push-approval'],
      'read-override-pin': ['read-override-pr'],
      'read-override-handoff': ['read-override-pr', 'read-override-pin'],
      'verify-override': [
        'claim-override',
        'read-override-pr',
        'read-override-pin',
        'read-override-handoff',
      ],
      'override-refused': ['verify-override'],
      'describe-pr': [
        'commit',
        'check-commit',
        'recheck-commit',
        'scan-commit',
        'review-commit',
        'settle-after-review',
        'verify-override',
      ],
      'decide-push': [
        'read-repository',
        'scan-commit',
        'read-push-approval',
        'review-commit',
        'verify-override',
        'describe-pr',
      ],
      'hand-fix-round': ['commit', 'review-commit', 'describe-pr', 'decide-push'],
      'hand-fix-round-merging': ['commit', 'review-commit', 'describe-pr', 'decide-push'],
      'approve-push': ['read-repository', 'scan-commit', 'decide-push'],
      push: [
        'approve-push',
        'decide-push',
        'scan-commit',
        'check-commit',
        'recheck-commit',
        'describe-pr',
      ],
      'find-pr': ['push', 'decide-push'],
      'update-pr': ['find-pr', 'describe-pr'],
      'open-pr': ['find-pr', 'describe-pr'],
      'read-review': ['review-commit', 'push'],
    });
    // Only the repository read asks for the default branch, which may ask
    // `origin` over the network; the posture read stays a local one.
    expect(
      wf.tasks
        .filter((t) => t.operation === 'host.binding.inspect')
        .map((t) => [t.taskId, (t.inputTemplate as { defaultBranch?: unknown }).defaultBranch]),
    ).toEqual([
      ['read-folder', true],
      ['read-push-approval', undefined],
    ]);
    expect(Object.fromEntries(wf.tasks.map((t) => [t.taskId, t.operation]))).toEqual({
      'message-from': 'workflow.run.decide',
      'find-commission': 'workflow.run.list',
      'check-commission': 'workflow.run.decide',
      'commission-refused': 'workflow.run.fail',
      'read-commission': 'workflow.run.detail',
      'read-folder': 'host.binding.inspect',
      'resolve-repository': 'workflow.run.decide',
      'repository-unknown': 'workflow.run.fail',
      commit: 'host.file.patch',
      'check-commit': 'host.commit.check',
      'checks-failed': 'workflow.run.fail',
      'recheck-commit': 'host.commit.check',
      'scan-commit': 'host.commit.scan',
      'read-repository': 'api.http.call',
      'read-push-approval': 'host.binding.inspect',
      'review-commit': 'workflow.run.start',
      'settle-after-review': 'workflow.run.decide',
      'claim-override': 'workflow.run.decide',
      'read-override-pr': 'api.http.call',
      'read-override-pin': 'memory.store.get',
      'read-override-handoff': 'api.http.call',
      'verify-override': 'workflow.run.decide',
      'override-refused': 'workflow.run.fail',
      'describe-pr': 'host.commit.describe',
      'decide-push': 'workflow.run.decide',
      'hand-fix-round': 'workflow.run.decide',
      'hand-fix-round-merging': 'workflow.run.decide',
      'approve-push': undefined,
      push: 'host.process.exec',
      'find-pr': 'api.http.call',
      'update-pr': 'api.http.call',
      'open-pr': 'api.http.call',
      'read-review': 'workflow.run.detail',
    });
  });

  it('reads the repository on the same GitHub binding the pull request uses, before the approval', () => {
    const read = taskOrThrow('read-repository');
    const openPr = taskOrThrow('open-pr');
    expect(read.inputTemplate).toEqual({
      apiId: 'github',
      endpointId: 'getRepository',
      params: { owner: { $bind: 'owner' }, repo: { $bind: 'repo' } },
      response: { format: 'json' },
    });
    const openPrParams = (openPr.inputTemplate as { params: Record<string, unknown> }).params;
    expect(openPrParams['owner']).toEqual({ $bind: 'owner' });
    expect(openPrParams['repo']).toEqual({ $bind: 'repo' });
    expect(read.inputBindings).toEqual({
      owner: SETTLED_OWNER,
      repo: SETTLED_REPO,
    });
    const kinds = Object.values(read.inputBindings ?? {}).map((b) => b.kind);
    expect(kinds).not.toContain('connection_binding');
    // Only once the checks cleared the commit: a failed check reads nothing more.
    expect(read.when).toEqual({
      anyOf: [
        'tasks.check-commit.output.passed == true',
        'tasks.recheck-commit.output.passed == true',
      ],
      onMissingRef: 'skip',
    });
  });

  it('fails the run at the read when the repository cannot be seen, saying what to check', () => {
    const read = taskOrThrow('read-repository');
    // A 404 comes back as a call that answered: the projection is what fails,
    // and with one attempt and no output contract there is nothing to resume.
    expect(read.outputProjection).toEqual({
      repository: { path: 'data.full_name', onMissing: 'error' },
    });
    expect(read.outputContract).toBeUndefined();
    expect(read.maxAttempts).toBe(1);
    // The failure path reads the task's failure instruction, never its goal.
    const failure = read.failureInstruction ?? '';
    expect(failure).toContain(
      'The GitHub credential bound to this space cannot see `owner`/`repo`',
    );
    expect(failure).toContain(
      'GitHub answers 404 for a private repository the token has no access to',
    );
    expect(failure).toContain("that credential's repository access is the thing to check");
    expect(failure).toContain('Nothing has been pushed');
    expect(read.goal).not.toContain('credential');
    for (const prose of [
      skillGuidance(PUBLISH_LOCAL_CHANGES),
      taskOrThrow('approve-push').pauseInstruction ?? '',
      wf.output?.guidance ?? '',
    ]) {
      expect(prose).not.toContain('404');
    }
  });

  it('commits the patch onto its branch, carrying the base it was made against', () => {
    const commit = taskOrThrow('commit');
    expect(commit.inputTemplate).toEqual({
      bindingId: { $bind: 'bindingId' },
      patchRef: { $bind: 'patchRef' },
      patch: { $bind: 'patch' },
      mode: 'clean',
      commit: {
        branch: { $bind: 'branch' },
        message: {
          $firstOf: [
            { $bind: 'commitMessage' },
            { $concat: [{ $bind: 'summaryTitle' }, '\n\n', { $bind: 'summaryParagraph' }] },
          ],
        },
        baseSha: { $bind: 'baseSha' },
        mergeFrom: { $bind: 'mergeFrom' },
        pushBase: { $bind: 'base' },
      },
    });
    expect(commit.inputBindings?.['base']).toEqual(SETTLED_BASE);
    // A commit is not replayable — after the first attempt the branch exists
    // or has moved, and the operation refuses what no longer matches.
    expect(commit.retryability).toBe('unsafe');
  });

  it('binds the base only when the caller passed one, and names how a branch is reused', () => {
    const commit = taskOrThrow('commit');
    const template = commit.inputTemplate;
    if (template === undefined) throw new Error('the commit task must carry a template');
    const declared = new Set(Object.keys(commit.inputBindings ?? {}));
    const inputs = {
      bindingId: 'folder-1',
      patch: 'diff',
      branch: 'feat/x',
      commitMessage: 'm',
      base: 'main',
    };
    const fresh = substituteTemplateBinds(template, inputs, declared);
    expect(fresh['commit']).toEqual({ branch: 'feat/x', message: 'm', pushBase: 'main' });
    const appended = substituteTemplateBinds(
      template,
      { ...inputs, baseSha: 'a'.repeat(40) },
      declared,
    );
    expect(appended['commit']).toEqual({
      branch: 'feat/x',
      message: 'm',
      baseSha: 'a'.repeat(40),
      pushBase: 'main',
    });
    expect(HostFilePatchInputSchema.safeParse({ ...appended, mode: 'clean' }).success).toBe(true);

    const baseSha = (wf.runInputs ?? []).find((i) => i.id === 'baseSha');
    expect(baseSha?.required).toBe(false);
    // Refused at the start as it would be at the commit: a branch name is not a sha.
    const shaPattern = new RegExp((baseSha?.schema as { pattern: string }).pattern);
    expect(shaPattern.test('a'.repeat(40))).toBe(true);
    expect(shaPattern.test('feat/x')).toBe(false);
    expect(
      HostFilePatchInputSchema.safeParse({
        ...appended,
        mode: 'clean',
        commit: { ...(appended['commit'] as object), baseSha: 'feat/x' },
      }).success,
    ).toBe(false);
    expect(taskOrThrow('message-from').inputContract?.bindings['baseSha']?.schema).toEqual(
      baseSha?.schema,
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'a branch is reused only that way, and a fresh change takes a fresh branch',
    );
  });

  it("briefs a fix round from the branch's head, by its name, never from the earlier baseSha", () => {
    const description = skillGuidance(PUBLISH_LOCAL_CHANGES);
    expect(description).toContain(
      "`commissionInputs` — `base` the branch's name, and `mergeFrom: origin/<base>` where the base moved",
    );
    expect(description).toContain(
      "never `base: origin/main` or the earlier commission's `baseSha`: the branch was never pushed, so a checkout of `origin/main` cannot reach it and the fix comes back with no files changed",
    );
    expect(description).toContain('then publish again with its `patchRef`, `baseSha`');
    expect(description).toContain("the commission's `baseSha` — the branch's head — as `baseSha`");
    expect(wf.output?.guidance).toContain(
      'start Commission Change with fixRound.commissionInputs as they stand — never base origin/main',
    );
    const afterReview = wf.stateVariables.find((v) => v.variableId === 'afterReview');
    expect(afterReview?.description).toContain('takes `fixRound`');
    const fixRound = wf.stateVariables.find((v) => v.variableId === 'fixRound');
    expect(fixRound?.description).toContain('Never base it on `origin/main`');
    expect(
      PUSH_GATE_RULES.find(
        (rule) =>
          'expression' in rule.when &&
          rule.when.expression === "state.afterReview == 'fix_before_merge'",
      )?.reason,
    ).toContain("`base` the branch's name, never `origin/main`");
    // The commit still refuses a patch made against anything but the branch's head.
    const baseSha = (wf.runInputs ?? []).find((i) => i.id === 'baseSha');
    expect(baseSha?.description).toContain("it must be that branch's head");
  });

  it('carries the commit a commission merged in, only when the caller passed one', () => {
    const commit = taskOrThrow('commit');
    const template = commit.inputTemplate;
    if (template === undefined) throw new Error('the commit task must carry a template');
    const declared = new Set(Object.keys(commit.inputBindings ?? {}));
    expect(commit.inputBindings?.['mergeFrom']).toEqual({ kind: 'run_input', path: 'mergeFrom' });
    const inputs = {
      bindingId: 'folder-1',
      patch: 'diff',
      branch: 'feat/x',
      commitMessage: 'm',
      base: 'main',
      baseSha: 'a'.repeat(40),
    };
    expect(substituteTemplateBinds(template, inputs, declared)['commit']).not.toHaveProperty(
      'mergeFrom',
    );
    const merged = substituteTemplateBinds(
      template,
      { ...inputs, mergeFrom: 'b'.repeat(40) },
      declared,
    );
    expect(merged['commit']).toEqual({
      branch: 'feat/x',
      message: 'm',
      baseSha: 'a'.repeat(40),
      mergeFrom: 'b'.repeat(40),
      pushBase: 'main',
    });
    expect(HostFilePatchInputSchema.safeParse({ ...merged, mode: 'clean' }).success).toBe(true);

    const mergeFrom = (wf.runInputs ?? []).find((i) => i.id === 'mergeFrom');
    expect(mergeFrom?.required).toBe(false);
    const shaPattern = new RegExp((mergeFrom?.schema as { pattern: string }).pattern);
    expect(shaPattern.test('b'.repeat(40))).toBe(true);
    expect(shaPattern.test('origin/main')).toBe(false);
    expect(taskOrThrow('message-from').inputContract?.bindings['mergeFrom']?.schema).toEqual(
      mergeFrom?.schema,
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'is commissioned with `mergeFrom: origin/<base>` as well',
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'published with the sha the commission reported in `merge.from` as `mergeFrom`: the branch then carries one merge commit holding the fix',
    );
  });

  it("takes a commission's change by reference, and the commit takes exactly one of the pair", () => {
    const commit = taskOrThrow('commit');
    const template = commit.inputTemplate;
    if (template === undefined) throw new Error('the commit task must carry a template');
    const declared = new Set(Object.keys(commit.inputBindings ?? {}));
    const ref = 'gs://file-store/tenants/t_1/runs/r_1/steps/s_1/attempt/1/patch.json';
    const inputs = { bindingId: 'folder-1', branch: 'feat/x', commitMessage: 'm' };

    const byRef = substituteTemplateBinds(template, { ...inputs, patchRef: ref }, declared);
    expect(byRef['patchRef']).toBe(ref);
    expect(byRef).not.toHaveProperty('patch');
    expect(HostFilePatchInputSchema.safeParse(byRef).success).toBe(true);

    const byText = substituteTemplateBinds(template, { ...inputs, patch: 'diff' }, declared);
    expect(byText).not.toHaveProperty('patchRef');
    expect(HostFilePatchInputSchema.safeParse(byText).success).toBe(true);

    // Neither and both reach the commit and are refused there, with a message
    // that says which to pass.
    const neither = HostFilePatchInputSchema.safeParse(
      substituteTemplateBinds(template, inputs, declared),
    );
    expect(neither.success).toBe(false);
    expect(neither.error?.issues[0]?.message).toContain('`patchRef` for the change a commission');
    const both = HostFilePatchInputSchema.safeParse(
      substituteTemplateBinds(template, { ...inputs, patch: 'diff', patchRef: ref }, declared),
    );
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toContain('not both');
    // A merge alone is a change: published with `mergeFrom` and neither.
    const mergeOnly = substituteTemplateBinds(
      template,
      { ...inputs, baseSha: 'a'.repeat(40), mergeFrom: 'b'.repeat(40) },
      declared,
    );
    expect(mergeOnly).not.toHaveProperty('patchRef');
    expect(mergeOnly).not.toHaveProperty('patch');
    expect(HostFilePatchInputSchema.safeParse(mergeOnly).success).toBe(true);
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'it is published with `mergeFrom` and neither `patchRef` nor `patch`',
    );

    const runInput = (id: string) => (wf.runInputs ?? []).find((i) => i.id === id);
    expect(runInput('patchRef')?.required).toBe(false);
    expect(runInput('patch')?.required).toBe(false);
    for (const id of ['patchRef', 'patch']) {
      expect(taskOrThrow('message-from').inputContract?.bindings[id]?.schema, id).toEqual(
        runInput(id)?.schema,
      );
    }
    // A stored ref only: an inline one is the diff's bytes in the run input again.
    const refPattern = new RegExp((runInput('patchRef')?.schema as { pattern: string }).pattern);
    expect(refPattern.test(ref)).toBe(true);
    expect(refPattern.test('inline:ZGlmZg==')).toBe(false);
    // The operation holds the same line, so the skill and a direct call agree.
    const inline = HostFilePatchInputSchema.safeParse({ ...byRef, patchRef: 'inline:ZGlmZg==' });
    expect(inline.success).toBe(false);
    expect(inline.error?.issues[0]?.message).toContain('A stored reference only');
    expect(runInput('patchRef')?.description).toContain('the `patchRef` its result reports');
    expect(runInput('patch')?.description).toContain('must stay small');
    // Text can be no longer than the run's inputs carry together, and the
    // schema says so where a refused value is reported.
    const patchSchema = runInput('patch')?.schema as { maxLength: number; description: string };
    expect(patchSchema.maxLength).toBe(MAX_PARENT_INPUTS_SERIALIZED_BYTES);
    expect(patchSchema.description).toContain("32 KB a run's inputs carry together");
    expect(patchSchema.description).toContain('`patchRef`');
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      "Never pass a commission's `patch` text.",
    );
  });

  it('takes the owner and the repository as names, never a URL or `owner/repo`', () => {
    const entry = taskOrThrow('message-from').inputContract?.bindings ?? {};
    for (const id of ['owner', 'repo']) {
      const declared = (wf.runInputs ?? []).find((i) => i.id === id);
      const schema = declared?.schema as { pattern?: string; description?: string } | undefined;
      expect(schema?.pattern, id).toBeDefined();
      // The entry task's contract is what a start is checked against.
      expect(entry[id]?.schema, id).toEqual(declared?.schema);
      expect(schema?.description, id).toContain('not a URL or `owner/repo`');
      expect(declared?.description, id).toContain('not a URL or `owner/repo`');

      const accepts = new RegExp(schema?.pattern ?? '');
      for (const name of ['aflowai', 'aflow', 'my-repo-2']) {
        expect(accepts.test(name), `${id} ${name}`).toBe(true);
      }
      for (const name of [
        'https://github.com/aflowai/aflow',
        'github.com/aflowai/aflow',
        'aflowai/aflow',
        'git@github.com:aflowai/aflow.git',
        'two words',
      ]) {
        expect(accepts.test(name), `${id} ${name}`).toBe(false);
      }
    }
  });

  it("holds the owner and the repository to GitHub's own naming rules", () => {
    const schemaOf = (id: string) =>
      (wf.runInputs ?? []).find((i) => i.id === id)?.schema as {
        pattern: string;
        maxLength: number;
        description: string;
      };
    const owner = schemaOf('owner');
    const repo = schemaOf('repo');
    const ownerOk = (name: string) =>
      new RegExp(owner.pattern).test(name) && name.length <= owner.maxLength;
    const repoOk = (name: string) =>
      new RegExp(repo.pattern).test(name) && name.length <= repo.maxLength;

    for (const name of ['a', 'aflowai', 'aflow-ai', 'a1-b2-c3', 'x'.repeat(39)]) {
      expect(ownerOk(name), `owner ${name}`).toBe(true);
    }
    for (const name of ['-aflow', 'aflow-', 'af--low', 'af.low', 'af_low', '.', 'x'.repeat(40)]) {
      expect(ownerOk(name), `owner ${name}`).toBe(false);
    }
    expect(owner.maxLength).toBe(39);
    expect(owner.description).toContain('single hyphens between them, 1 to 39 characters');

    for (const name of ['a', '.github', 'my.repo', '..x', '-repo', 'my_repo', 'x'.repeat(100)]) {
      expect(repoOk(name), `repo ${name}`).toBe(true);
    }
    for (const name of ['.', '..', 'x'.repeat(101), 'a b']) {
      expect(repoOk(name), `repo ${name}`).toBe(false);
    }
    expect(repo.maxLength).toBe(100);
    expect(repo.description).toContain('1 to 100 characters, and neither `.` nor `..`');
  });

  it('pushes the commit by its sha onto its branch, never the branch by name', () => {
    const push = taskOrThrow('push');
    expect(push.inputBindings).toEqual({
      bindingId: { kind: 'run_input', path: 'bindingId' },
      refspec: { kind: 'task_output', taskId: 'commit', path: 'commit.pushRefspec' },
      base: SETTLED_BASE,
      receipt: { kind: 'task_output', taskId: 'scan-commit', path: 'receipt' },
      checkReceipt: { kind: 'task_output', taskId: 'check-commit', path: 'receipt' },
      recheckReceipt: { kind: 'task_output', taskId: 'recheck-commit', path: 'receipt' },
    });
    const [pushCommand, ...rest] = materializedCommands();
    expect(rest).toEqual([]);
    // No `--set-upstream`: it tracks a local branch named as the source, and
    // the source here is a sha.
    // Tags and submodule commits are left behind whatever the operator's
    // `push.followTags` and `push.recurseSubmodules` say: neither was scanned.
    expect(pushCommand).toEqual([
      'git',
      'push',
      '--no-follow-tags',
      '--no-recurse-submodules',
      'origin',
      `${HEAD}:refs/heads/aflow/x`,
    ]);
    // The source side is the sha the commit task reported, so a branch that
    // moved after the commit sends nothing it gained since.
    expect(pushCommand?.at(-1)?.split(':')[0]).toBe(HEAD);
  });

  it('carries no force anywhere in any command it runs', () => {
    for (const command of materializedCommands()) {
      for (const argument of command) {
        expect(argument).not.toMatch(/^(-f|--force|--force-with-lease|--mirror|--delete)$/);
        expect(argument).not.toContain('+');
      }
    }
  });

  it('puts the approval between the commit and anything leaving the machine', () => {
    const approve = taskOrThrow('approve-push');
    expect(approve.type).toBe('human');
    expect(approve.intent).toBe('approve');
    expect(approve.approves).toEqual(['commit']);
    expect(taskOrThrow('push').maxAttempts).toBe(1);
    expect(approve.pauseInstruction).toContain('nothing has left the machine');
    expect(approve.actionPreview?.op).toBe('host.process.exec');
  });

  it('shows the commit being approved, read from the commit task', () => {
    expect(taskOrThrow('approve-push').actionPreview?.inputBindings).toEqual({
      bindingId: { kind: 'run_input', path: 'bindingId' },
      branch: { kind: 'run_input', path: 'branch' },
      unscanned: { kind: 'task_output', taskId: 'scan-commit', path: 'unscanned' },
      allowed: { kind: 'task_output', taskId: 'scan-commit', path: 'allowed' },
      scanSummary: { kind: 'task_output', taskId: 'scan-commit', path: 'summary' },
      commitSha: { kind: 'task_output', taskId: 'commit', path: 'commit.sha' },
      receipt: { kind: 'task_output', taskId: 'scan-commit', path: 'receipt' },
      refspec: { kind: 'task_output', taskId: 'commit', path: 'commit.pushRefspec' },
      pushRange: { kind: 'task_output', taskId: 'commit', path: 'commit.pushRange' },
      commitBranch: { kind: 'task_output', taskId: 'commit', path: 'commit.branch' },
      commitMessage: { kind: 'task_output', taskId: 'commit', path: 'commit.message' },
      filesChanged: { kind: 'task_output', taskId: 'commit', path: 'filesChanged' },
    });
    // Every path is one the patch operation returns for an applied commit, so
    // the preview resolves — an unresolved one refuses the approval itself.
    // Nothing binds the review, which a folder that always asks never runs,
    // nor the posture, which is not read over a range the scan did not clear.
    const applied = HostFilePatchOutputSchema.parse({
      state: 'applied',
      filesChanged: 2,
      files: ['a.ts', 'b.ts'],
      conflicts: [],
      commit: COMMIT,
    });
    expect(applied.commit?.message).toBe('The change');
    expect(applied.commit?.pushRefspec).toBe(`${HEAD}:refs/heads/aflow/x`);
    expect(applied.commit?.pushRange).toBe(`${ORIGIN_BASE}..${HEAD}`);
    expect(applied.filesChanged).toBe(2);
  });

  it('lets any number of publications wait at their approvals at once', () => {
    expect(PUBLISH_LOCAL_CHANGES.bundle.manifest.concurrency?.maxConcurrentRuns).toBe('unlimited');
  });

  it('opens the pull request on the space’s own GitHub connection, only where the pushed branch has none', () => {
    const findPr = taskOrThrow('find-pr');
    const openPr = taskOrThrow('open-pr');
    expect(findPr.when).toEqual({
      allOf: [
        'tasks.push.output.exitCode == 0',
        "tasks.decide-push.output.decision != 'keep_local'",
      ],
      onMissingRef: 'skip',
    });
    expect(openPr.when).toEqual({
      allOf: [
        'tasks.find-pr.output.prNumber == null',
        "tasks.decide-push.output.decision != 'keep_local'",
      ],
      onMissingRef: 'skip',
    });
    expect(openPr.inputTemplate).toEqual({
      apiId: 'github',
      endpointId: 'createPullRequest',
      params: {
        owner: { $bind: 'owner' },
        repo: { $bind: 'repo' },
        body: {
          title: { $bind: 'title' },
          head: { $bind: 'branch' },
          base: { $bind: 'base' },
          body: { $bind: 'body' },
          draft: false,
        },
      },
      response: { format: 'json' },
    });
    // No `connection_binding`: that binding resolves the connection a coding
    // run pinned from its repo designation, and this skill designates no repo
    // — it would throw at dispatch on every run. The space's GitHub binding
    // resolves the call instead, which is what the capability hint asks the
    // operator to create.
    for (const task of [findPr, openPr, taskOrThrow('update-pr')]) {
      const kinds = Object.values(task.inputBindings ?? {}).map((b) => b.kind);
      expect(kinds, task.taskId).not.toContain('connection_binding');
    }
    for (const task of [findPr, openPr]) {
      expect(task.promoteOutputs?.map((p) => ('toState' in p ? p.toState : ''))).toEqual([
        'prUrl',
        'prNumber',
      ]);
    }
    expect(PUBLISH_LOCAL_CHANGES.capabilityHints?.[0]?.requiredEndpoints).toEqual([
      'getRepository',
      'listPullRequests',
      // The shepherd's pinned record, read only to verify an override by its rule.
      'getIssueComment',
      'createPullRequest',
      'updatePullRequest',
    ]);
    expect(wf.output?.primary).toBe('prUrl');
  });

  it('promotes its pull request under the output a run serving a plan node is linked by', () => {
    // The harness links the pull request to the node from this output when the
    // run ends (Plan 322 D5); a rename here would end those links silently.
    expect(wf.stateVariables.map((v) => v.variableId)).toContain(RUN_PULL_REQUEST_URL_OUTPUT);
    const promoters = wf.tasks.filter((task) =>
      task.promoteOutputs?.some((p) => 'toState' in p && p.toState === RUN_PULL_REQUEST_URL_OUTPUT),
    );
    expect(promoters.map((task) => task.taskId).sort()).toEqual(['find-pr', 'open-pr']);
    expect(
      wf.stateVariables.find((v) => v.variableId === RUN_PULL_REQUEST_URL_OUTPUT)?.sensitive,
    ).toBe(false);
  });

  it("asks GitHub for the branch's open pull request by `owner:branch` and the base", () => {
    const findPr = taskOrThrow('find-pr');
    const template = findPr.inputTemplate;
    if (template === undefined) throw new Error('find-pr must carry a template');
    const declared = new Set(Object.keys(findPr.inputBindings ?? {}));
    expect(findPr.inputBindings?.['base']).toEqual(SETTLED_BASE);
    expect(
      substituteTemplateBinds(
        template,
        { owner: 'aflowai', repo: 'aflow', branch: 'aflow/x', base: 'main' },
        declared,
      ),
    ).toEqual({
      apiId: 'github',
      endpointId: 'listPullRequests',
      params: {
        owner: 'aflowai',
        repo: 'aflow',
        head: 'aflowai:aflow/x',
        base: 'main',
        state: 'open',
      },
      response: { format: 'json' },
    });
    // A read: a second attempt asks again and changes nothing.
    expect(findPr.retryability).toBe('safe');
    expect(findPr.failureInstruction).toContain('The push went through');
  });

  it('opens and rewrites the pull request only with the text composed from the whole range', () => {
    const describe = taskOrThrow('describe-pr');
    expect(describe.inputBindings?.['range']).toEqual({
      kind: 'task_output',
      taskId: 'commit',
      path: 'commit.pushRange',
    });
    const composed = { kind: 'task_output', taskId: 'describe-pr' };
    expect(taskOrThrow('open-pr').inputBindings).toMatchObject({
      title: { ...composed, path: 'title' },
      body: { ...composed, path: 'body' },
    });
    expect(taskOrThrow('update-pr').inputBindings).toMatchObject({
      body: { ...composed, path: 'body' },
      prNumber: { kind: 'task_output', taskId: 'find-pr', path: 'prNumber' },
    });
    // What a brief passes reaches GitHub only through the composition, which
    // reads it for secrets with the rest — the title of an existing pull
    // request apart, rewritten only where a person passed one.
    const briefInputs = new Set(['summary', 'findings', 'gaps']);
    for (const taskId of ['find-pr', 'update-pr', 'open-pr']) {
      const fromBrief = Object.values(taskOrThrow(taskId).inputBindings ?? {}).filter(
        (b) => b.kind === 'run_input' && briefInputs.has(b.path),
      );
      expect(fromBrief, taskId).toEqual([]);
    }
    expect(taskOrThrow('update-pr').inputBindings?.['title']).toEqual({
      kind: 'run_input',
      path: 'title',
    });
    expect(runInputOrThrow('title').required).toBe(false);
    expect(runInputOrThrow('summary').required).toBe(false);
  });

  it('can be passed every run input it declares', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: wf.tasks,
      stateVariables: wf.stateVariables,
      output: wf.output,
      runInputs: wf.runInputs,
    });
    const unreachable = [...validity.diagnostics, ...validity.advisories]
      .filter((d) => d.code === 'run_input_unreachable')
      .map((d) => d.detail);
    expect(unreachable).toEqual([]);
    const required = (wf.runInputs ?? []).filter((i) => i.required).map((i) => i.id);
    // The commit message is a change's: a branch published as it stands keeps its head's.
    // The pull request's title is the slice's unless a person gives their own.
    // The repository and the base are the folder's, unless the caller overrides them.
    expect(required).toEqual(['bindingId', 'branch']);
  });

  it('references no eval-plane operation', () => {
    const operations = wf.tasks.flatMap((t) => [
      ...(t.operation ? [t.operation] : []),
      ...(t.context?.capabilities?.operations ?? []),
    ]);
    expect(operations.filter((op) => isEvalPlaneOperation(op))).toEqual([]);
  });
});

// ── The push approval, run through the scheduler's own predicates ──────────

/**
 * What the review this run starts comes back with: a verdict, a run that did
 * not complete, or — `not-started` — no run at all, the task itself failing
 * (the review missing, edited or refused, or its waiter not registered).
 */
type Review =
  'approve' | 'request_changes' | 'comment' | 'failed' | 'cancelled' | 'paused' | 'not-started';
type Decision = 'approved' | 'declined';

/**
 * The review run's ending as the waiter delivers it to the task: the run's
 * promoted output only when it completed.
 */
function reviewEnding(
  review: Exclude<Review, 'not-started'>,
  findings: readonly Finding[] = [],
): Record<string, unknown> {
  const completed = review !== 'failed' && review !== 'cancelled' && review !== 'paused';
  return WorkflowRunWakeupEnvelopeSchema.parse({
    runId: REVIEW_RUN_ID,
    outcome: completed ? 'completed' : review,
    waiterId: 'waiter-1',
    ...(completed
      ? { result: { output: { verdict: review, reviewSummary: summaryOf(findings), findings } } }
      : {}),
  });
}

/** The review's summary, which names every finding inline, as the review skill asks it to. */
function summaryOf(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'Read.';
  return findings
    .map(
      (f) =>
        `${f.severity} ${f.file}${f.line === undefined ? '' : `:${String(f.line)}`} — ${f.claim}`,
    )
    .join('\n');
}

/** A finding as Local Code Review returns it. */
interface Finding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file: string;
  line?: number;
  claim: string;
  evidence: string;
}

type Scan = 'clean' | 'finding' | 'unscanned' | 'allowed';

/** What `host.commit.scan` returns for each scan, before the task's own projection. */
/** What the executor that scanned returns for each range it found no secret in. */
const RECEIPT = {
  clean: 'receipt-clean',
  unscanned: 'receipt-unscanned',
  allowed: 'receipt-allowed',
} as const;

function scanResult(scan: Scan): Record<string, unknown> {
  switch (scan) {
    case 'finding':
      return HostCommitScanOutputSchema.parse({
        clean: false,
        findings: [{ file: 'a.ts', line: 3, pattern: 'github-token' }],
        unscanned: [],
        allowed: [],
        summary: 'What looks like a secret is in 1 place: a.ts line 3 (github-token).',
      });
    case 'unscanned':
      return HostCommitScanOutputSchema.parse({
        clean: false,
        findings: [],
        unscanned: [{ file: 'bundle.js', reason: 'too-large' }],
        allowed: [],
        summary: 'No secret found in the lines read, but not every file was read.',
        unflaggedRange: COMMIT.pushRange,
        receipt: RECEIPT.unscanned,
      });
    case 'allowed':
      return HostCommitScanOutputSchema.parse({
        clean: false,
        findings: [],
        unscanned: [],
        allowed: [{ file: 'fixture.ts', line: 4, pattern: 'secret-assignment' }],
        summary: 'No secret found, apart from lines marked allowed.',
        unflaggedRange: COMMIT.pushRange,
        receipt: RECEIPT.allowed,
      });
    case 'clean':
      return HostCommitScanOutputSchema.parse({
        clean: true,
        findings: [],
        unscanned: [],
        allowed: [],
        summary: 'No secret found.',
        unflaggedRange: COMMIT.pushRange,
        clearedRange: COMMIT.pushRange,
        receipt: RECEIPT.clean,
      });
  }
}

/**
 * How the folder's checks end: `timed-out` stopped at the folder's own time,
 * `test-timeouts` exiting on their own with nothing failed but tests that ran
 * out of theirs.
 */
type Check = 'passed' | 'failed' | 'timed-out' | 'test-timeouts' | 'skipped';

const CHECK_ARGV = ['node', 'scripts/verify-commit.mjs'];

/** The receipt `host.commit.check` returns where the checks ran, by how they ended. */
const CHECK_RECEIPT = {
  passed: 'check-receipt-passed',
  failed: 'check-receipt-failed',
} as const;
/** The test a check under load names as having run out of its time. */
const TIMED_OUT_TEST =
  'apps/aflow-executor-api/src/handlers/api/saveResponse.test.ts › a saveTo download allows a body above the inline default';
const CHECK_TAIL =
  'ok   large-files guard (2.0 s)\nFAIL tsc apps/aflow-executor-host/tsconfig.json (41.3 s)\n';

/** What `host.commit.check` returns for each ending, before the task's own projection. */
function checkResult(check: Check): Record<string, unknown> {
  switch (check) {
    case 'skipped':
      return HostCommitCheckOutputSchema.parse({
        passed: true,
        skipped: true,
        exitCode: null,
        durationMs: 0,
        tail: '',
        summary: '`hb_app` declares no checks, so none ran.',
        clearedSha: HEAD,
      });
    case 'passed':
      return HostCommitCheckOutputSchema.parse({
        passed: true,
        checks: CHECK_ARGV,
        exitCode: 0,
        durationMs: 90_000,
        outputRef: 'payload:check-output',
        tail: 'ok   prettier (3 files) (1.2 s)\n',
        summary: '`node scripts/verify-commit.mjs` passed.',
        clearedSha: HEAD,
        receipt: CHECK_RECEIPT.passed,
      });
    case 'failed':
      return HostCommitCheckOutputSchema.parse({
        passed: false,
        checks: CHECK_ARGV,
        exitCode: 1,
        durationMs: 45_000,
        outputRef: 'payload:check-output',
        tail: CHECK_TAIL,
        summary: `\`node scripts/verify-commit.mjs\` exited 1: the check failed. The last of what it printed:\n${CHECK_TAIL}`,
        receipt: CHECK_RECEIPT.failed,
      });
    case 'test-timeouts':
      return HostCommitCheckOutputSchema.parse({
        passed: false,
        checks: CHECK_ARGV,
        exitCode: 1,
        durationMs: 570_000,
        outputRef: 'payload:check-output',
        tail: CHECK_TAIL,
        summary:
          '`node scripts/verify-commit.mjs` exited 1, and nothing failed but 1 test running out of time.',
        testTimeouts: [TIMED_OUT_TEST],
        receipt: CHECK_RECEIPT.failed,
      });
    case 'timed-out':
      return HostCommitCheckOutputSchema.parse({
        passed: false,
        checks: CHECK_ARGV,
        timedOut: true,
        exitCode: null,
        durationMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
        outputRef: 'payload:check-output',
        tail: CHECK_TAIL,
        summary:
          "`node scripts/verify-commit.mjs` was still running when the folder's `checksTimeoutMs` ran out.",
        receipt: CHECK_RECEIPT.failed,
      });
  }
}

interface Scenario {
  pushApproval: HostPushApproval | 'no-prefix';
  /**
   * The `origin` the folder's inspection reports; absent is `FOLDER_ORIGIN`, and
   * null a folder whose `origin` is not on GitHub.
   */
  folderOrigin?: Record<string, unknown> | null;
  review: Review;
  decision: Decision;
  committed?: boolean;
  /** How the folder's checks ended on the commit; absent is passed. */
  check?: Check;
  /** How their second run ends, where the first lost only to time; absent is passed. */
  recheck?: Check;
  /** What the scan of the commit found; absent is clean. */
  scan?: Scan;
  /**
   * How a decline is recorded: `skip`, as the harness does, skipping the gated
   * branch; or `answer`, the decision alone, so the push's own predicate is
   * what refuses it.
   */
  declineAs?: 'skip' | 'answer';
  /**
   * Whether `origin`'s base moved on from where the scanned range starts: the
   * push then scans the range it sends and goes ahead where the commit still
   * merges into the moved base cleanly, and is refused where it conflicts.
   */
  baseMoved?: 'cleanly' | 'conflicting';
  /** A publication of the branch as it stands: no change, its head as `baseSha`. */
  asItStands?: boolean;
  /** The receipt the approval records, where not the one its preview resolves to. */
  approvalOf?: string;
  /** The base of the pull request the branch already has open when the push lands, where it has one. */
  existingPrInto?: string;
  /** The commit as `host.file.patch` reports it, where not `COMMIT`. */
  commit?: Record<string, unknown>;
  /** Run inputs beside the ones every publication is started with. */
  inputs?: Record<string, unknown>;
  /** The composed text holds what looks like a secret, so the composition is refused. */
  describeRefused?: boolean;
  /** The findings a completed review returns; absent is none. */
  findings?: readonly Finding[];
  /** What an override's checks read of the branch's pull request; absent is an unlabelled one with no shepherd record. */
  onGitHub?: OnGitHub;
  /** The Commission Change that made the change, as its run holds it; absent is none to be found. */
  commission?: { runId: string; patchRef: string; summary: unknown; bindingId?: string };
  /**
   * How the review run stands when the publication reads it back, where not as
   * it first ended — a review that failed and was retried in place.
   */
  reviewNow?: Review;
}

/**
 * The branch's pull request as an override's checks read it: GitHub's answer
 * for the loop's open pull request of the branch, its `hands-off` label, the
 * handoff the shepherd pinned for it, the decision that record holds and the
 * login it was written as.
 */
interface OnGitHub {
  /** GitHub refusing the read of the pull request. */
  refused?: boolean;
  /** The branch has no open pull request of the loop's into the base. */
  noPullRequest?: boolean;
  handsOff?: boolean;
  /** Whether the shepherd pinned a handoff for it; absent is pinned. */
  pinned?: boolean;
  /** The decision the shepherd's record holds; absent is no record. */
  shepherdDecision?: string;
  /** The login the record was written as; absent is the one it was pinned as. */
  recordAuthor?: string;
}

/** The login the shepherd's handoff was pinned as, and so the only author whose record is trusted. */
const PINNED_AUTHOR = 'aflow-pr-agent[bot]';

/** `listPullRequests` for the branch, shaped by the `loop_pulls` preset. */
function overridePullRequest(onGitHub: OnGitHub | undefined): Record<string, unknown> {
  if (onGitHub?.refused === true) return { statusCode: 502, data: { message: 'Bad gateway' } };
  const pullRequests =
    onGitHub?.noPullRequest === true
      ? []
      : [
          {
            number: 5,
            title: SLICE_TITLE,
            headRef: 'aflow/x',
            headSha: HEAD,
            baseRef: 'main',
            updatedAt: '2026-10-18T12:00:00Z',
            handsOff: onGitHub?.handsOff === true,
          },
        ];
  return {
    statusCode: 200,
    data: LoopPullRequestsSchema.parse({ pullRequests, count: pullRequests.length }),
  };
}

/**
 * `getIssueComment` on the pinned comment, shaped by the `loop_handoff` preset
 * the task names: a record is taken only from the login it names.
 */
function overrideHandoff(
  onGitHub: OnGitHub | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const preset = String((input['response'] as { transformPresetId?: unknown }).transformPresetId);
  const trusted = preset.split(':')[1];
  const decision = onGitHub?.shepherdDecision;
  const found = decision !== undefined && (onGitHub?.recordAuthor ?? PINNED_AUTHOR) === trusted;
  return {
    statusCode: 200,
    data: ShepherdHandoffReadSchema.parse(
      found
        ? {
            found,
            commentId: 41,
            attemptCount: 3,
            nextAttemptCount: 4,
            decision,
            trust: 'verified',
          }
        : { found, attemptCount: 0, nextAttemptCount: 1, trust: 'verified' },
    ),
  };
}

interface Outcome {
  asked: boolean;
  pushed: boolean;
  ran: string[];
  /** What each task that ran was handed, its template resolved. */
  inputs: Map<string, Record<string, unknown>>;
  /** The run's state as its tasks' promoted outputs make it. */
  state: Record<string, unknown>;
  /** How each task ended, and what each that succeeded recorded. */
  statuses: Map<string, string>;
  outputs: Map<string, Record<string, unknown>>;
}

/** The subject of the branch's first commit: the slice's title. */
const SLICE_TITLE = 'The slice';

/**
 * What `host.commit.describe` returns, standing in for the composition the
 * host executor's own tests prove: the title given or the slice's, a body
 * naming the range it was composed from, so a test can tell whose it is, and
 * the review record the executor computes, through the same function.
 */
function describedPullRequest(input: Record<string, unknown>): Record<string, unknown> {
  const { title, summary, range } = input;
  return HostCommitDescribeOutputSchema.parse({
    title: typeof title === 'string' ? title : SLICE_TITLE,
    body: typeof summary === 'string' ? summary : `Composed from \`${String(range)}\`.`,
    commits: [{ sha: HEAD, subject: SLICE_TITLE }],
    ...pullRequestReviewRecord(HostCommitDescribeInputSchema.parse(input)),
  });
}

/**
 * What each operation returns in a scenario, before the task's own projection,
 * given the input the task's template resolved to.
 */
function rawOutput(
  taskId: string,
  scenario: Scenario,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (taskId) {
    case 'commit':
      if (scenario.asItStands === true) {
        return HostFilePatchOutputSchema.parse({
          state: 'applied',
          filesChanged: 0,
          files: [],
          conflicts: [],
          commit: AS_IT_STANDS,
        });
      }
      return scenario.committed === false
        ? { state: 'conflict', filesChanged: 0, files: [], conflicts: ['a.ts'] }
        : {
            state: 'applied',
            filesChanged: 1,
            files: ['a.ts'],
            conflicts: [],
            commit: scenario.commit ?? COMMIT,
          };
    case 'check-commit':
      return checkResult(scenario.check ?? 'passed');
    case 'recheck-commit':
      return checkResult(scenario.recheck ?? 'passed');
    case 'scan-commit':
      return scanResult(scenario.scan ?? 'clean');
    case 'read-folder':
      return HostBindingInspectOutputSchema.parse({
        id: 'hb_app',
        sandbox: HOST_SANDBOX_POSTURE_DEFAULT,
        maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
        keepAwake: HOST_KEEP_AWAKE_DEFAULT,
        ...(scenario.folderOrigin === null
          ? {}
          : { origin: scenario.folderOrigin ?? FOLDER_ORIGIN }),
      });
    case 'read-repository':
      return { statusCode: 200, data: { full_name: 'aflowai/aflow' } };
    case 'read-push-approval':
      return HostBindingInspectOutputSchema.parse({
        id: 'hb_app',
        sandbox: HOST_SANDBOX_POSTURE_DEFAULT,
        maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
        keepAwake: HOST_KEEP_AWAKE_DEFAULT,
        ...(scenario.pushApproval === 'no-prefix'
          ? {}
          : {
              branchPolicy: {
                branchPrefix: 'aflow/',
                pushApproval: scenario.pushApproval,
                mergePosture: HOST_MERGE_POSTURE_DEFAULT,
                checksTimeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
              },
            }),
      });
    case 'review-commit':
      if (scenario.review === 'not-started')
        throw new Error('a review that did not start has no output');
      return reviewEnding(scenario.review, scenario.findings);
    case 'push':
      return { exitCode: 0 };
    case 'find-pr': {
      // As GitHub filters: a `base` the request names excludes a pull request into any other.
      const { base } = input['params'] as { base?: unknown };
      const open =
        scenario.existingPrInto !== undefined &&
        (base === undefined || base === scenario.existingPrInto);
      return {
        statusCode: 200,
        data: open ? [{ number: 5, html_url: 'https://github.com/aflowai/aflow/pull/5' }] : [],
      };
    }
    case 'describe-pr':
      return scenario.describeRefused === true ? {} : describedPullRequest(input);
    // The rules each decision is handed, decided as the orchestrator decides them.
    case 'message-from':
    case 'resolve-repository':
    case 'check-commission':
    case 'settle-after-review':
    case 'claim-override':
    case 'verify-override':
    case 'decide-push':
    case 'hand-fix-round':
    case 'hand-fix-round-merging':
      return { ...decideByRules(WorkflowRunDecideInputSchema.parse(input)) };
    case 'find-commission': {
      const query = WorkflowRunListInputSchema.parse(input);
      const recorded = query.succeeded?.[0]?.output?.equals;
      const found =
        scenario.commission !== undefined &&
        recorded === scenario.commission.patchRef &&
        query.input?.equals === (scenario.commission.bindingId ?? RUN_INPUTS['bindingId']);
      return WorkflowRunListOutputSchema.parse({
        runs: found
          ? [
              {
                id: scenario.commission?.runId,
                status: 'completed',
                startedAt: '2026-10-25T09:00:00.000Z',
                own: true,
              },
            ]
          : [],
        hasMore: false,
      });
    }
    case 'read-commission': {
      const { runId } = WorkflowRunDetailInputSchema.parse(input);
      const named = scenario.commission !== undefined && runId === scenario.commission.runId;
      return {
        run: { runId, workflowSlug: 'commission-change', status: 'completed' },
        ...(named ? { result: { output: { summary: scenario.commission?.summary } } } : {}),
      };
    }
    // The review run as it stands when the publication reads it back.
    case 'read-review': {
      const { runId } = WorkflowRunDetailInputSchema.parse(input);
      const now = scenario.reviewNow ?? scenario.review;
      const completed = now === 'approve' || now === 'request_changes' || now === 'comment';
      return {
        run: { runId, workflowSlug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug, status: now },
        ...(completed ? { result: { output: { verdict: now } } } : {}),
      };
    }
    case 'read-override-pr':
      return overridePullRequest(scenario.onGitHub);
    case 'read-override-pin':
      return scenario.onGitHub?.pinned === false
        ? { found: false }
        : { found: true, dataJson: { commentId: 41, author: PINNED_AUTHOR } };
    case 'read-override-handoff':
      return overrideHandoff(scenario.onGitHub, input);
    case 'update-pr': {
      const { pull_number: number } = input['params'] as { pull_number?: unknown };
      return {
        statusCode: 200,
        data: { number, html_url: `https://github.com/aflowai/aflow/pull/${String(number)}` },
      };
    }
    case 'open-pr':
      return {
        statusCode: 201,
        data: { number: 7, html_url: 'https://github.com/aflowai/aflow/pull/7' },
      };
    default:
      return {};
  }
}

/** A dot path into a task's output, as a binding reads it — `[n]` an index into an array. */
function readOutput(
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  taskId: string,
  path: string | undefined,
): unknown {
  let value: unknown = outputs.get(taskId);
  for (const key of path?.replace(/\[(\d+)\]/g, '.$1').split('.') ?? []) {
    value =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

/** The repository the folder's `origin` fetches from, and the branch its HEAD names. */
const FOLDER_ORIGIN = { owner: 'aflowai', repo: 'aflow', defaultBranch: 'main' };

/** The run's own inputs, as a publication is started with them: the repository and base are the folder's. */
const RUN_INPUTS: Readonly<Record<string, unknown>> = {
  bindingId: 'folder-1',
  branch: 'aflow/x',
};

/** A publication of the branch as it stands: its head named, and no change, merge or message. */
const AS_IT_STANDS_INPUTS: Readonly<Record<string, unknown>> = {
  ...RUN_INPUTS,
  baseSha: STRANDED,
  title: 'The change',
  owner: 'aflowai',
  repo: 'aflow',
};

/** What a task's run-input and `task_output` bindings resolve to, absent ones left out. */
function boundOutputs(
  bindings: WorkflowTask['inputBindings'],
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  runInputs: Readonly<Record<string, unknown>> = RUN_INPUTS,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    const value =
      binding.kind === 'task_output'
        ? readOutput(outputs, binding.taskId, binding.path)
        : binding.kind === 'run_input'
          ? runInputs[binding.path]
          : undefined;
    if (value !== undefined) bound[name] = value;
  }
  return bound;
}

/** The push a grant is minted for: the hash's three fields, standing in for the hash. */
function grantKey(push: unknown): string | undefined {
  const parsed = HostApprovedPushSchema.safeParse(push);
  return parsed.success
    ? JSON.stringify([parsed.data.bindingId, parsed.data.refspec, parsed.data.receipt])
    : undefined;
}

/**
 * The executor's gate on the push, over what the push's bindings carry: the
 * base it measures from and the scan's receipt always; the receipt of the
 * checks passing where the folder declares checks, and none where it does not;
 * and for a range the scan did not clear a grant the operator's approval
 * minted for exactly this push. Nothing the push's own input says stands in
 * for the grant.
 */
function receiptAccepted(
  push: WorkflowTask,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  grants: ReadonlySet<string>,
  runInputs: Readonly<Record<string, unknown>>,
): boolean {
  const bound = boundOutputs(push.inputBindings, outputs, runInputs);
  const { bindingId, refspec, base, receipt } = bound;
  if (typeof receipt !== 'string' || typeof base !== 'string') return false;
  const checksDeclared = outputs.get('check-commit')?.['skipped'] !== true;
  // The check receipt as the push's own template carries it.
  const sent = substituteTemplateBinds(
    push.inputTemplate ?? {},
    bound,
    new Set(Object.keys(push.inputBindings ?? {})),
  );
  const carried = (sent['check'] as { receipt?: unknown } | undefined)?.receipt ?? undefined;
  if (carried !== (checksDeclared ? CHECK_RECEIPT.passed : undefined)) return false;
  if (outputs.get('scan-commit')?.['clean'] === true) return true;
  const key = grantKey({ bindingId, refspec, receipt });
  return key !== undefined && grants.has(key);
}

/**
 * Drive the graph the way the harness does: ready tasks run, false predicates
 * skip, a declined approval skips its gated branch, a projection that does not
 * resolve fails its task, and a failed task satisfies its dependents only where
 * it is optional. Only the outputs are scripted;
 * every decision is the skill's own.
 */
function publish(scenario: Scenario): Outcome {
  const tasks = wf.tasks as unknown as WorkflowTask[];
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const failedOptional = new Set<string>();
  const statuses = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const grants = new Set<string>();
  const ran: string[] = [];
  const inputs = new Map<string, Record<string, unknown>>();
  const runInputs = {
    ...(scenario.asItStands === true ? AS_IT_STANDS_INPUTS : RUN_INPUTS),
    ...scenario.inputs,
  };
  let asked = false;

  for (let round = 0; round < tasks.length + 1; round += 1) {
    const {
      ready,
      skipped: skip,
      errors,
    } = computeReadyTasksWithWhen(tasks, completed, skipped, { statuses, outputs }, failedOptional);
    expect(errors).toEqual([]);
    for (const { task } of skip) {
      skipped.add(task.taskId);
      statuses.set(task.taskId, 'skipped');
    }
    for (const task of ready) {
      if (ran.includes(task.taskId)) continue;
      ran.push(task.taskId);
      if (
        task.taskId === 'push' &&
        (scenario.baseMoved === 'conflicting' || !receiptAccepted(task, outputs, grants, runInputs))
      ) {
        statuses.set(task.taskId, 'failed');
        continue;
      }
      if (task.taskId === 'review-commit' && scenario.review === 'not-started') {
        statuses.set(task.taskId, 'failed');
        if (task.optional === true) failedOptional.add(task.taskId);
        continue;
      }
      if (task.taskId === 'approve-push') {
        asked = true;
        if (scenario.decision === 'declined' && scenario.declineAs !== 'answer') {
          for (const id of computeRejectedApprovalSkipSet(tasks, task.taskId)) {
            skipped.add(id);
            statuses.set(id, 'skipped');
          }
          continue;
        }
        if (scenario.decision === 'declined') {
          outputs.set(task.taskId, { decision: 'rejected' });
        } else {
          // As the operator's resolve records an approval: with the call its
          // preview resolved to, and the grant for the push that call names.
          const input = boundOutputs(task.actionPreview?.inputBindings, outputs, runInputs);
          if (scenario.approvalOf !== undefined) input['receipt'] = scenario.approvalOf;
          outputs.set(task.taskId, {
            decision: 'approved',
            approvedCall: { op: task.actionPreview?.op, input },
          });
          const key = grantKey(input);
          if (task.actionPreview?.op === 'host.process.exec' && key !== undefined) grants.add(key);
        }
      } else {
        const input =
          task.inputTemplate === undefined
            ? {}
            : substituteTemplateBinds(
                task.inputTemplate,
                boundOutputs(task.inputBindings, outputs, runInputs),
                new Set(Object.keys(task.inputBindings ?? {})),
              );
        inputs.set(task.taskId, input);
        // `workflow.run.fail` fails its own task whatever it is handed.
        if (task.operation === 'workflow.run.fail') {
          statuses.set(task.taskId, 'failed');
          continue;
        }
        const raw = rawOutput(task.taskId, scenario, input);
        if (task.outputProjection !== undefined) {
          const projected = projectTaskOutput(task.outputProjection, raw, input);
          // A projection that fails with no resolution fails the task.
          if (!projected.ok) {
            statuses.set(task.taskId, 'failed');
            if (task.optional === true) failedOptional.add(task.taskId);
            continue;
          }
          outputs.set(task.taskId, projected.value);
        } else {
          outputs.set(task.taskId, raw);
        }
      }
      completed.add(task.taskId);
      statuses.set(task.taskId, 'succeeded');
    }
    if (ready.length === 0 && skip.length === 0) break;
  }

  const state = resolvePromotedRunMetrics(
    tasks,
    [...outputs].map(([taskId, output]) => ({
      taskId,
      status: statuses.get(taskId) ?? 'pending',
      output,
    })),
  );
  return {
    asked,
    pushed: statuses.get('push') === 'succeeded',
    ran,
    inputs,
    state,
    statuses,
    outputs,
  };
}

describe('Publish Local Changes — the folder decides whether the push asks', () => {
  const postures: HostPushApproval[] = ['always', 'never', 'unless-unreviewed'];
  const reviews: Review[] = [
    'approve',
    'request_changes',
    'comment',
    'failed',
    'cancelled',
    'paused',
    'not-started',
  ];
  const decisions: Decision[] = ['approved', 'declined'];

  for (const pushApproval of postures) {
    for (const review of reviews) {
      for (const decision of decisions) {
        const reviewed = pushApproval === 'unless-unreviewed';
        // A review that finished is decided by the rounds rule, and one short
        // of approve is fix_before_merge; only one that did not finish asks.
        const finished = ['approve', 'request_changes', 'comment'].includes(review);
        const keptLocal = reviewed && finished && review !== 'approve';
        const asks = pushApproval === 'always' || (reviewed && !finished);
        const pushes = asks ? decision === 'approved' : !keptLocal;
        it(`${pushApproval}, review ${review}, operator ${decision}: ${asks ? 'asks' : 'does not ask'}, ${pushes ? 'pushes' : 'does not push'}`, () => {
          const outcome = publish({ pushApproval, review, decision });
          expect(outcome.asked).toBe(asks);
          expect(outcome.pushed).toBe(pushes);
          expect(outcome.ran.includes('open-pr')).toBe(pushes);
          expect(outcome.ran.includes('review-commit')).toBe(reviewed);
        });
      }
    }
  }

  it('pushes without asking on `approve` alone, and keeps the branch local on `comment` as on `request_changes`, asking nothing', () => {
    for (const review of ['comment', 'request_changes'] as const) {
      const outcome = publish({ pushApproval: 'unless-unreviewed', review, decision: 'approved' });
      expect(outcome).toMatchObject({ asked: false, pushed: false });
      expect(outcome.state).toMatchObject({
        afterReview: 'fix_before_merge',
        pushDecision: 'keep_local',
      });
    }
    const approved = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'declined',
    });
    expect(approved).toMatchObject({ asked: false, pushed: true });
    expect(approved.ran).not.toContain('approve-push');

    // The approval asks exactly where the gate decided to ask.
    expect(taskOrThrow('approve-push').when).toEqual({
      expression: "tasks.decide-push.output.decision == 'ask'",
      onMissingRef: 'skip',
    });
    // Every verdict the review can return either clears the push or asks.
    const review = REVIEW_LOCAL_CHANGES.bundle.workflow.tasks[0]?.inputTemplate as {
      outputSchema: { properties: { verdict: { enum: string[] } } };
    };
    expect(review.outputSchema.properties.verdict.enum.sort()).toEqual([
      'approve',
      'comment',
      'request_changes',
    ]);
  });

  it('reports the pull request a branch already has into the base, and opens none beside it', () => {
    for (const pushApproval of ['never', 'unless-unreviewed'] as const) {
      const existing = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        existingPrInto: 'main',
      });
      expect(existing.pushed).toBe(true);
      expect(existing.ran).toContain('find-pr');
      expect(existing.ran).not.toContain('open-pr');
      expect(existing.state).toMatchObject({
        prUrl: 'https://github.com/aflowai/aflow/pull/5',
        prNumber: 5,
      });

      const fresh = publish({ pushApproval, review: 'approve', decision: 'approved' });
      expect(fresh.ran.indexOf('find-pr')).toBeLessThan(fresh.ran.indexOf('open-pr'));
      expect(fresh.state).toMatchObject({
        prUrl: 'https://github.com/aflowai/aflow/pull/7',
        prNumber: 7,
      });

      // One open from the branch into another base is not this publication's.
      const elsewhere = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        existingPrInto: 'release',
      });
      expect(elsewhere.ran).toContain('open-pr');
      expect(elsewhere.state).toMatchObject({
        prUrl: 'https://github.com/aflowai/aflow/pull/7',
        prNumber: 7,
      });
    }
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'A branch that already has an open pull request into the base gets no second one: the run reports that one.',
    );
  });

  it('starts a review only where the posture depends on one, after the commit', () => {
    for (const pushApproval of ['always', 'never'] as const) {
      expect(publish({ pushApproval, review: 'approve', decision: 'approved' }).ran).not.toContain(
        'review-commit',
      );
    }
    const { ran } = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
    });
    expect(ran.indexOf('commit')).toBeLessThan(ran.indexOf('review-commit'));
    expect(ran.indexOf('review-commit')).toBeLessThan(ran.indexOf('decide-push'));
    expect(ran.indexOf('decide-push')).toBeLessThan(ran.indexOf('push'));
  });

  it('reads no verdict from a review that did not complete, whatever it promoted', () => {
    // The waiter hands a task the run's output only when the run completed; a
    // failed, cancelled or paused child's verdict therefore reads null, and
    // null is not `approve`.
    const review = taskOrThrow('review-commit');
    if (review.outputProjection === undefined) throw new Error('the review must project');
    const started = { inputs: { bindingId: 'hb_app', from: 'a'.repeat(40), at: 'b'.repeat(40) } };
    const reviewed = started.inputs;
    for (const outcome of ['failed', 'cancelled', 'paused'] as const) {
      const projected = projectTaskOutput(review.outputProjection, reviewEnding(outcome), started);
      expect(projected).toEqual({
        ok: true,
        value: {
          verdict: null,
          reviewSummary: null,
          findings: null,
          outcome,
          reviewRunId: REVIEW_RUN_ID,
          reviewed,
        },
      });
    }
    const approved = projectTaskOutput(review.outputProjection, reviewEnding('approve'), started);
    expect(approved).toEqual({
      ok: true,
      value: {
        verdict: 'approve',
        reviewSummary: 'Read.',
        findings: [],
        outcome: 'completed',
        reviewRunId: REVIEW_RUN_ID,
        reviewed,
      },
    });
  });

  // The Local PR Shepherd merges on a verdict only for the head it reads
  // (Plan 321 D6), so the verdict names the commit it is for: the one pushed.
  it('names, beside its verdict, the commit it reviewed — the one the push carries', () => {
    const outcome = publish({ pushApproval: 'unless-unreviewed', review: 'approve' });
    const review = outcome.outputs.get('review-commit') as { reviewed: { at: string } };
    expect(review.reviewed.at).toBe(
      (outcome.outputs.get('commit') as { commit: { sha: string } }).commit.sha,
    );
    const refspec = (outcome.outputs.get('commit') as { commit: { pushRefspec: string } }).commit
      .pushRefspec;
    expect(outcome.pushed).toBe(true);
    expect(refspec.startsWith(`${review.reviewed.at}:`)).toBe(true);
  });

  it('asks when the review task itself fails, and not otherwise from that failure', () => {
    // Optional, so its failure satisfies the approval's dependency instead of
    // blocking it; the approval's own predicate then reads the failure.
    expect(taskOrThrow('review-commit').optional).toBe(true);
    const asked = publish({
      pushApproval: 'unless-unreviewed',
      review: 'not-started',
      decision: 'approved',
    });
    expect(asked).toMatchObject({ asked: true, pushed: true });
    const declined = publish({
      pushApproval: 'unless-unreviewed',
      review: 'not-started',
      decision: 'declined',
    });
    expect(declined).toMatchObject({ asked: true, pushed: false });
  });

  it('asks nothing and pushes nothing when the patch did not commit', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      committed: false,
    });
    expect(outcome).toMatchObject({
      asked: false,
      pushed: false,
      ran: ['message-from', 'read-folder', 'resolve-repository', 'commit'],
      state: {},
    });
  });

  it('pushes nothing from a folder that declares no push at all', () => {
    const outcome = publish({ pushApproval: 'no-prefix', review: 'approve', decision: 'approved' });
    expect(outcome.asked).toBe(false);
    expect(outcome.pushed).toBe(false);
    expect(outcome.ran).not.toContain('review-commit');
  });

  // The harness skips the gated branch on a decline; the push's own predicate
  // must refuse it too, in case a decline is ever recorded as an answer rather
  // than a skip — under every posture, `never` included, wherever it asks.
  for (const pushApproval of ['always', 'never', 'unless-unreviewed'] as const) {
    for (const scan of ['clean', 'unscanned', 'allowed'] as const) {
      for (const review of reviews) {
        const asked = publish({ pushApproval, review, decision: 'approved', scan }).asked;
        if (!asked) continue;
        it(`${pushApproval}, scan ${scan}, review ${review}: a decline read from the decision alone pushes nothing`, () => {
          const outcome = publish({
            pushApproval,
            review,
            decision: 'declined',
            scan,
            declineAs: 'answer',
          });
          expect(outcome.asked).toBe(true);
          expect(outcome.pushed).toBe(false);
          expect(outcome.ran).not.toContain('open-pr');
        });
      }
    }
  }

  it('reviews the range the scan read — everything the push would add — and waits for the review to end', () => {
    const review = taskOrThrow('review-commit');
    const template = review.inputTemplate;
    if (template === undefined) throw new Error('the review must carry a template');
    expect(review.inputBindings).toEqual({
      bindingId: { kind: 'run_input', path: 'bindingId' },
      from: { kind: 'task_output', taskId: 'commit', path: 'commit.pushBaseSha' },
      at: { kind: 'task_output', taskId: 'commit', path: 'commit.sha' },
      reviewHarness: { kind: 'run_input', path: 'reviewHarness' },
    });
    // The scan reads `pushRange`; the review is handed its two ends.
    expect(taskOrThrow('scan-commit').inputBindings?.['range']).toEqual({
      kind: 'task_output',
      taskId: 'commit',
      path: 'commit.pushRange',
    });
    expect(COMMIT.pushRange).toBe(`${COMMIT.pushBaseSha}..${COMMIT.sha}`);
    const declared = new Set(Object.keys(review.inputBindings ?? {}));
    const start = substituteTemplateBinds(
      template,
      { bindingId: 'folder-1', from: COMMIT.pushBaseSha, at: COMMIT.sha },
      declared,
    );
    // Named by its catalog entry, so a space workflow merely holding the slug
    // is refused rather than trusted to decide the approval.
    expect(WorkflowRunStartInputSchema.parse(start)).toMatchObject({
      slug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug,
      catalogId: REVIEW_LOCAL_CHANGES.catalogId,
      inputs: {
        bindingId: 'folder-1',
        from: ORIGIN_BASE,
        at: HEAD,
        depth: 'standard',
      },
      wait: 'until_complete',
    });
    // The review's checkout stands on the commit it judges — the range's tip —
    // never on the folder's HEAD, which is where the commission started: the
    // commit lands on a branch nothing has checked out, so a checkout at the
    // folder's HEAD reads every changed file as it was before the change.
    const inputs = (start as { inputs: { from: string; at: string } }).inputs;
    expect(inputs.at).toBe(COMMIT.sha);
    expect(inputs.at).not.toBe(COMMIT.baseSha);
    // Two shas and no branch name: the range still names this commit after
    // the branch moves.
    expect(JSON.stringify(start)).not.toContain('aflow/x');
    // Every input it passes is one the review declares.
    const accepted = new Set(
      (REVIEW_LOCAL_CHANGES.bundle.workflow.runInputs ?? []).map((i) => i.id),
    );
    for (const key of Object.keys((start as { inputs: Record<string, unknown> }).inputs)) {
      expect(accepted).toContain(key);
    }
    // A second attempt would start a second review.
    expect(review.retryability).toBe('unsafe');
    expect(review.maxAttempts).toBe(1);
  });

  it('runs the review on the harness `reviewHarness` names, and on the review’s default without it', () => {
    const review = taskOrThrow('review-commit');
    const template = review.inputTemplate;
    if (template === undefined) throw new Error('the review must carry a template');
    const declared = new Set(Object.keys(review.inputBindings ?? {}));
    const ends = { bindingId: 'folder-1', from: COMMIT.pushBaseSha, at: COMMIT.sha };

    const named = WorkflowRunStartInputSchema.parse(
      substituteTemplateBinds(template, { ...ends, reviewHarness: 'codex' }, declared),
    ) as { inputs: Record<string, unknown> };
    expect(named.inputs['harness']).toBe('codex');

    // Unset, nothing is passed, so the review picks its harness exactly as a
    // standalone review does.
    const unset = WorkflowRunStartInputSchema.parse(
      substituteTemplateBinds(template, ends, declared),
    ) as { inputs: Record<string, unknown> };
    expect(unset.inputs).not.toHaveProperty('harness');
    expect(unset.inputs).toEqual({
      bindingId: 'folder-1',
      from: COMMIT.pushBaseSha,
      at: COMMIT.sha,
      depth: 'standard',
    });

    // Optional, accepted at the start, and held to what the review itself accepts.
    const runInput = (wf.runInputs ?? []).find((i) => i.id === 'reviewHarness');
    expect(runInput?.required).toBe(false);
    const reviewHarness = (REVIEW_LOCAL_CHANGES.bundle.workflow.runInputs ?? []).find(
      (i) => i.id === 'harness',
    );
    expect(runInput?.schema).toEqual(reviewHarness?.schema);
    expect(taskOrThrow('message-from').inputContract?.bindings['reviewHarness']?.schema).toEqual(
      runInput?.schema,
    );
    expect(runInput?.description).toContain('passed to the review as its `harness`');
  });

  it('forwards `reviewHarness` through a whole publication to the review it starts', () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      inputs: { reviewHarness: 'codex' },
    });
    expect(outcome.inputs.get('review-commit')).toMatchObject({ inputs: { harness: 'codex' } });

    const without = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
    });
    expect(
      (without.inputs.get('review-commit') as { inputs: Record<string, unknown> }).inputs,
    ).not.toHaveProperty('harness');
  });

  it('says which case it is asking in, a line each, and where the verdict is', () => {
    const lines = (taskOrThrow('approve-push').pauseInstruction ?? '').split('\n');
    expect(lines).toContain(
      "- `always`: the folder's push approval asks before every push, and no review ran.",
    );
    const reviewed = lines.find((line) => line.startsWith('- `unless-unreviewed`, no findings:'));
    expect(reviewed).toContain(
      "this run's Local Code Review of `pushRange` did not return `approve`",
    );
    expect(reviewed).toContain('its verdict is on the "Review the commit" task');
    expect(taskOrThrow('review-commit').name).toBe('Review the commit');
    // No decision asks: the rounds rule makes one every time, and the line
    // over a blocker or a major names the task that made it.
    expect(lines.some((line) => /undecided/.test(line))).toBe(false);
    const severe = lines.find((line) =>
      line.startsWith('- `unless-unreviewed`, a blocker or a major among the findings:'),
    );
    expect(severe).toContain(`"${taskOrThrow('settle-after-review').name}" task`);
  });

  it('names the three postures and the default in its description, and why it is the default', () => {
    expect(HOST_PUSH_APPROVAL_DEFAULT).toBe('unless-unreviewed');
    for (const phrase of [
      '`always`',
      '`never`',
      '`unless-unreviewed`',
      'is `unless-unreviewed`, the default',
    ]) {
      expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(phrase);
    }
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      "Whatever the posture, the run scans every line the push would add, the headers and message of every commit it carries, and the pull request's title and summary for secrets before any of this, and a finding stops it with nothing pushed — which is what lets a review stand in for the operator.",
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      "Once the run asks, the operator's answer decides: a declined push pushes nothing, whatever the posture.",
    );
  });
});

describe('Publish Local Changes — the commit is scanned for secrets before anything leaves', () => {
  it('scans everything the push would add, from the base on origin to the commit, by two shas', () => {
    const scan = taskOrThrow('scan-commit');
    expect(scan.inputBindings).toEqual({
      bindingId: { kind: 'run_input', path: 'bindingId' },
      range: { kind: 'task_output', taskId: 'commit', path: 'commit.pushRange' },
      title: { kind: 'run_input', path: 'title' },
      summary: { kind: 'run_input', path: 'summary' },
    });
    const template = scan.inputTemplate;
    if (template === undefined) throw new Error('the scan must carry a template');
    const declared = new Set(Object.keys(scan.inputBindings ?? {}));
    const input = substituteTemplateBinds(
      template,
      { bindingId: 'folder-1', range: COMMIT.pushRange, title: 'Fix it', summary: 'Why.' },
      declared,
    );
    expect(HostCommitScanInputSchema.parse(input)).toEqual({
      bindingId: 'folder-1',
      range: `${ORIGIN_BASE}..${HEAD}`,
      texts: { 'pull request title': 'Fix it', 'pull request summary': 'Why.' },
    });
    // The summary is optional: absent, it is not scanned as an empty text.
    const untitled = substituteTemplateBinds(
      template,
      { bindingId: 'folder-1', range: COMMIT.pushRange, title: 'Fix it' },
      declared,
    );
    expect(HostCommitScanInputSchema.parse(untitled)).toEqual({
      bindingId: 'folder-1',
      range: `${ORIGIN_BASE}..${HEAD}`,
      texts: { 'pull request title': 'Fix it' },
    });
    // A commit the checks did not clear is never scanned: nothing after them runs.
    expect(scan.when).toEqual({
      anyOf: [
        'tasks.check-commit.output.passed == true',
        'tasks.recheck-commit.output.passed == true',
      ],
      onMissingRef: 'skip',
    });
  });

  it('fails at the scan on a finding, rather than pausing on a resolution that could clear it', () => {
    const scan = taskOrThrow('scan-commit');
    // The unflagged range exists only when nothing was found, so a finding is
    // a projection that does not resolve; one attempt and no output contract
    // leave nothing to resume with, and the run fails there.
    expect(scan.outputProjection).toEqual({
      unflaggedRange: { path: 'unflaggedRange', onMissing: 'error' },
      clean: { path: 'clean', onMissing: 'error' },
      unscanned: { path: 'unscanned', onMissing: 'error' },
      allowed: { path: 'allowed', onMissing: 'error' },
      summary: { path: 'summary', onMissing: 'error' },
      receipt: { path: 'receipt', onMissing: 'error' },
    });
    if (scan.outputProjection === undefined) throw new Error('the scan must project');
    expect(projectTaskOutput(scan.outputProjection, scanResult('finding'), null).ok).toBe(false);
    expect(projectTaskOutput(scan.outputProjection, scanResult('unscanned'), null)).toEqual({
      ok: true,
      value: {
        unflaggedRange: COMMIT.pushRange,
        clean: false,
        unscanned: [{ file: 'bundle.js', reason: 'too-large' }],
        allowed: [],
        summary: 'No secret found in the lines read, but not every file was read.',
        receipt: RECEIPT.unscanned,
      },
    });
    expect(projectTaskOutput(scan.outputProjection, scanResult('allowed'), null)).toEqual({
      ok: true,
      value: {
        unflaggedRange: COMMIT.pushRange,
        clean: false,
        unscanned: [],
        allowed: [{ file: 'fixture.ts', line: 4, pattern: 'secret-assignment' }],
        summary: 'No secret found, apart from lines marked allowed.',
        receipt: RECEIPT.allowed,
      },
    });
    expect(scan.outputContract).toBeUndefined();
    expect(scan.maxAttempts).toBe(1);
    expect(scan.optional).toBeUndefined();
    const failure = scan.failureInstruction ?? '';
    expect(failure).toContain('named above by file, line and rule');
    expect(failure).toContain(
      "`<sha> (headers)` or `<sha> (message)` for a commit's headers or message",
    );
    expect(failure).toContain('`pull request title` or `pull request summary`');
    expect(failure).toContain('never by its value');
    expect(failure).toContain('The branch stayed on the machine and nothing was pushed.');
    expect(failure).toContain('publish it on a fresh branch');
  });

  for (const pushApproval of ['always', 'never', 'unless-unreviewed'] as const) {
    it(`${pushApproval}: a finding asks nothing, reviews nothing and pushes nothing`, () => {
      const outcome = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        scan: 'finding',
      });
      expect(outcome).toMatchObject({ asked: false, pushed: false });
      expect(outcome.ran).toContain('scan-commit');
      for (const task of ['review-commit', 'approve-push', 'push', 'open-pr']) {
        expect(outcome.ran, task).not.toContain(task);
      }
    });
  }

  it('scans after the commit and before the review, the approval and the push', () => {
    // A review that did not finish asks, so the approval runs too.
    const { ran } = publish({
      pushApproval: 'unless-unreviewed',
      review: 'failed',
      decision: 'approved',
    });
    expect(ran.indexOf('commit')).toBeLessThan(ran.indexOf('scan-commit'));
    for (const later of ['review-commit', 'approve-push', 'push']) {
      expect(ran, later).toContain(later);
      expect(ran.indexOf('scan-commit'), later).toBeLessThan(ran.indexOf(later));
    }
  });

  const uncleared = {
    unscanned: 'a file the scan could not read',
    allowed: 'a line marked allowed',
  };
  for (const pushApproval of ['always', 'never', 'unless-unreviewed'] as const) {
    for (const scan of ['unscanned', 'allowed'] as const) {
      for (const decision of ['approved', 'declined'] as const) {
        it(`${pushApproval}: ${uncleared[scan]} asks, reviews nothing, and the operator ${decision}`, () => {
          const outcome = publish({ pushApproval, review: 'approve', decision, scan });
          expect(outcome.asked).toBe(true);
          expect(outcome.pushed).toBe(decision === 'approved');
          expect(outcome.ran.includes('open-pr')).toBe(decision === 'approved');
          expect(outcome.ran).not.toContain('review-commit');
          // The posture decides only whether to ask, and this range asks
          // whatever it is.
          expect(outcome.ran).not.toContain('read-push-approval');
        });
      }
    }
  }

  it('lets only a range the scan cleared skip the approval', () => {
    for (const pushApproval of ['never', 'unless-unreviewed'] as const) {
      expect(
        publish({ pushApproval, review: 'approve', decision: 'declined' }),
        pushApproval,
      ).toMatchObject({ asked: false, pushed: true });
      for (const scan of ['unscanned', 'allowed'] as const) {
        expect(
          publish({ pushApproval, review: 'approve', decision: 'declined', scan }),
          `${pushApproval}, ${scan}`,
        ).toMatchObject({ asked: true, pushed: false });
      }
    }
  });

  it('reads the posture only over a range the scan cleared, and the push follows a decision it asked for', () => {
    expect(taskOrThrow('read-push-approval').when).toEqual({
      expression: 'tasks.scan-commit.output.clean == true',
      onMissingRef: 'skip',
    });
    // The second line holds only where the approval did not ask: it asks on `ask` alone.
    expect(taskOrThrow('push').when).toEqual({
      anyOf: [
        "tasks.approve-push.output.decision == 'approved'",
        "tasks.decide-push.output.decision == 'push'",
      ],
      onMissingRef: 'skip',
    });
  });

  it('reviews only a range the scan cleared', () => {
    expect(taskOrThrow('review-commit').when).toEqual({
      allOf: [
        "tasks.read-push-approval.output.branchPolicy.pushApproval == 'unless-unreviewed'",
        'tasks.scan-commit.output.clean == true',
      ],
      onMissingRef: 'skip',
    });
  });

  it('says on the approval what the scan read, and names the lines marked allowed and the files it could not read', () => {
    const instruction = taskOrThrow('approve-push').pauseInstruction ?? '';
    expect(instruction).toContain('nothing has left the machine');
    expect(instruction).toContain(
      'The scan read them for secrets and found none outside the lines and files listed below',
    );
    const lines = instruction.split('\n');
    const allowed = lines.find((l) => l.startsWith('- Lines marked allowed, whatever the posture'));
    expect(allowed).toContain('`allowed` names each by file, line and rule');
    expect(allowed).toContain('whoever wrote the change could have written');
    expect(allowed).toContain('no review ran');
    const unread = lines.find((l) => l.startsWith('- Files, messages or texts the scan could not'));
    expect(unread).toContain('`unscanned` names each and why');
    expect(unread).toContain('a Git LFS pointer, whose content the push uploads');
    expect(unread).toContain('no review ran');
    expect(instruction).toContain(
      "Declining leaves the branch local whatever the folder's push approval says",
    );
    expect(instruction.length).toBeLessThanOrEqual(PAUSE_INSTRUCTION_MAX_CHARS);
    // The lines themselves are shown with the approval, as the scan reported them.
    expect(taskOrThrow('approve-push').actionPreview?.inputBindings?.['allowed']).toEqual({
      kind: 'task_output',
      taskId: 'scan-commit',
      path: 'allowed',
    });
  });

  it('reports a finding by file, line and rule, and never asks for the value', () => {
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'report each place and rule it names — never ask for or repeat the value',
    );
  });
});

describe("Publish Local Changes — the push checks origin's base and URL in its own step", () => {
  it('hands the push the base the commit measured against and the scan of the range it read', () => {
    const push = taskOrThrow('push');
    expect(push.inputBindings?.['base']).toEqual(taskOrThrow('commit').inputBindings?.['base']);
    // The scan read the range the commit reported, and its receipt is what the
    // push carries; the executor measures the base the range starts from itself.
    expect(taskOrThrow('scan-commit').inputBindings?.['range']).toEqual({
      kind: 'task_output',
      taskId: 'commit',
      path: 'commit.pushRange',
    });
    const template = push.inputTemplate;
    if (template === undefined) throw new Error('the push must carry a template');
    const input = HostProcessExecInputSchema.parse(
      substituteTemplateBinds(
        template,
        {
          bindingId: 'folder-1',
          refspec: COMMIT.pushRefspec,
          base: 'main',
          receipt: RECEIPT.unscanned,
          checkReceipt: CHECK_RECEIPT.passed,
        },
        new Set(Object.keys(push.inputBindings ?? {})),
      ),
    );
    expect(input.pushBase).toBe('main');
    expect(input.scan).toEqual({ receipt: RECEIPT.unscanned });
    expect(input.check).toEqual({ receipt: CHECK_RECEIPT.passed });
    expect(push.maxAttempts).toBe(1);
    expect(push.optional).toBeUndefined();
  });

  it('carries the push call as the approval\u2019s approvedCall, so the decision mints its grant', () => {
    const preview = taskOrThrow('approve-push').actionPreview;
    const push = taskOrThrow('push');
    expect(preview?.op).toBe(push.operation);
    // The three fields the grant's hash covers are bound exactly as the push binds them.
    for (const field of ['bindingId', 'refspec', 'receipt'] as const) {
      expect(preview?.inputBindings?.[field], field).toEqual(push.inputBindings?.[field]);
    }
    const asked = publish({ pushApproval: 'never', review: 'approve', decision: 'approved' });
    expect(asked.pushed).toBe(true);
  });

  for (const scan of ['unscanned', 'allowed'] as const) {
    it(`${scan}: the operator's approval is what lets the push through, and a decline mints nothing`, () => {
      const approved = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        scan,
      });
      expect(approved).toMatchObject({ asked: true, pushed: true });
      for (const declineAs of ['skip', 'answer'] as const) {
        const declined = publish({
          pushApproval: 'never',
          review: 'approve',
          decision: 'declined',
          declineAs,
          scan,
        });
        expect(declined.pushed, declineAs).toBe(false);
      }
    });

    it(`${scan}: an approval recorded for another scan pushes nothing`, () => {
      const outcome = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        scan,
        approvalOf: RECEIPT.clean,
      });
      expect(outcome.asked).toBe(true);
      expect(outcome.ran).toContain('push');
      expect(outcome.pushed).toBe(false);
    });
  }

  it('runs no separate base check a moving base could slip past', () => {
    expect(wf.tasks.some((task) => task.operation === 'host.commit.check_base')).toBe(false);
    for (const pushApproval of ['always', 'never', 'unless-unreviewed'] as const) {
      const { ran } = publish({ pushApproval, review: 'approve', decision: 'approved' });
      // The review read back follows the push, where a review ran, and gates nothing.
      expect(ran.filter((id) => id !== 'read-review').slice(-3)).toEqual([
        'push',
        'find-pr',
        'open-pr',
      ]);
    }
  });

  for (const pushApproval of ['always', 'never', 'unless-unreviewed'] as const) {
    it(`${pushApproval}: a base that moved on since the scan is scanned again by the push, which goes ahead`, () => {
      const outcome = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        baseMoved: 'cleanly',
      });
      expect(outcome.ran.filter((id) => id !== 'read-review').slice(-3)).toEqual([
        'push',
        'find-pr',
        'open-pr',
      ]);
      expect(outcome.pushed).toBe(true);
      // One more scan, in the push's own step: no second scan task, and no round.
      expect(outcome.ran.filter((id) => id === 'scan-commit')).toHaveLength(1);
    });

    it(`${pushApproval}: a moved base the commit conflicts with pushes nothing and opens no pull request`, () => {
      const outcome = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        baseMoved: 'conflicting',
      });
      expect(outcome.ran).toContain('push');
      expect(outcome.pushed).toBe(false);
      expect(outcome.ran).not.toContain('open-pr');
    });
  }

  it('says on failure that nothing was pushed, why, and names the remedy for each refusal', () => {
    const failure = taskOrThrow('push').failureInstruction ?? '';
    expect(failure).toContain('Nothing was pushed, and the commit is still on its branch');
    // A move the commit conflicts with: the merge round, by name.
    expect(failure).toContain('no longer merges cleanly');
    expect(failure).toContain('the remedy is the merge round');
    expect(failure).toContain('`mergeFrom: origin/<base>`');
    // Every other refusal leaves the commit to be published as it stands, never stranded.
    expect(failure).toContain('pushes somewhere other than where it fetches from');
    expect(failure).toContain('publish this branch as it stands');
    expect(failure).toContain('no approval of this push is on record');
    expect(failure).not.toContain('fresh branch');
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'A refused push leaves the commit on its branch: report its message and the remedy the run names.',
    );
  });

  it('names, for a refusal the commit survives, the publication as it stands and the exact inputs it takes', () => {
    const failure = taskOrThrow('push').failureInstruction ?? '';
    // A check receipt lost to an executor restart is one such refusal.
    expect(failure).toContain('the executor restarted since the checks');
    expect(failure).toContain(PUBLISH_AS_IT_STANDS);
    expect(failure).toContain("Never publish the commission's patch again");

    const declared = new Set((wf.runInputs ?? []).map((input) => input.id));
    const carried = ['bindingId', 'owner', 'repo', 'base', 'round', 'findings'];
    const left = ['patchRef', 'patch', 'mergeFrom', 'commitMessage'];
    for (const id of [...carried, ...left, 'branch', 'baseSha']) {
      expect(declared.has(id), id).toBe(true);
      expect(PUBLISH_AS_IT_STANDS, id).toContain(`\`${id}\``);
    }
    expect(PUBLISH_AS_IT_STANDS).toContain(
      "`baseSha` the `commit.sha` this run's commit task reported",
    );
    expect(PUBLISH_AS_IT_STANDS).toContain(
      'no `patchRef`, `patch`, `mergeFrom` or `commitMessage`',
    );

    // The path exists: a run whose push was refused, followed by the run the text names.
    const refused = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      baseMoved: 'conflicting',
    });
    expect(refused.pushed).toBe(false);
    const madeSha = readOutput(refused.outputs, 'commit', 'commit.sha');
    expect(madeSha).toBe(HEAD);
    // The same folder, repository and base as the refused run, which the scenario carries.
    const again = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      asItStands: true,
      inputs: { branch: 'aflow/x', baseSha: madeSha },
    });
    expect((again.inputs.get('commit') ?? {})['commit']).toEqual({
      branch: 'aflow/x',
      baseSha: HEAD,
      pushBase: 'main',
    });
    for (const task of ['check-commit', 'scan-commit', 'review-commit', 'push']) {
      expect(again.statuses.get(task), task).toBe('succeeded');
    }
    expect(again.pushed).toBe(true);
  });
});

describe('Publish Local Changes — a branch is published as it stands', () => {
  it('takes no change: neither patch input, no merge and no commit message', () => {
    const runInput = (id: string) => (wf.runInputs ?? []).find((i) => i.id === id);
    for (const id of ['patchRef', 'patch', 'mergeFrom', 'commitMessage']) {
      expect(runInput(id)?.required, id).toBe(false);
    }
    expect(runInput('patchRef')?.description).toContain(
      'Omit both, `mergeFrom` and `commitMessage` to publish `branch` as it stands',
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain('A branch as it stands:');
  });

  it('runs check, scan, review and push on the branch head, with no patch input', () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      asItStands: true,
    });
    expect(outcome.ran).toEqual([
      'message-from',
      'read-folder',
      'resolve-repository',
      'commit',
      'check-commit',
      'scan-commit',
      'read-repository',
      'read-push-approval',
      'review-commit',
      'settle-after-review',
      'claim-override',
      'verify-override',
      'describe-pr',
      'decide-push',
      'push',
      'find-pr',
      'read-review',
      'open-pr',
    ]);
    expect(outcome.pushed).toBe(true);
    expect(outcome.asked).toBe(false);
    // Nothing is committed, so no message is derived: the head keeps its own.
    expect(outcome.outputs.get('message-from')?.['decision']).toBe('as_it_stands');

    // The commit is asked for the head as it stands, and the operation takes it so.
    const commit = outcome.inputs.get('commit') ?? {};
    expect(commit).not.toHaveProperty('patchRef');
    expect(commit).not.toHaveProperty('patch');
    expect(commit['commit']).toEqual({ branch: 'aflow/x', baseSha: STRANDED, pushBase: 'main' });
    expect(HostFilePatchInputSchema.safeParse(commit).success).toBe(true);

    // Everything after it reads that head, measured against where `origin`'s base is.
    expect(outcome.inputs.get('check-commit')).toMatchObject({ sha: STRANDED, base: ORIGIN_BASE });
    expect(outcome.inputs.get('scan-commit')).toMatchObject({
      range: `${ORIGIN_BASE}..${STRANDED}`,
    });
    expect(outcome.inputs.get('review-commit')).toMatchObject({
      inputs: { from: ORIGIN_BASE, at: STRANDED },
    });
    expect((outcome.inputs.get('push')?.['command'] as string[] | undefined)?.at(-1)).toBe(
      `${STRANDED}:refs/heads/aflow/x`,
    );
    expect(outcome.inputs.get('describe-pr')).toMatchObject({
      range: `${ORIGIN_BASE}..${STRANDED}`,
    });
  });

  it('publishes a committed branch that moved on from `baseSha` at its head, as it stands, with no new commit', () => {
    // The base a refused publication's patch was made against: the branch
    // has since gained that publication's commit, which is what goes.
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      asItStands: true,
      inputs: { baseSha: HEAD },
    });
    expect(outcome.pushed).toBe(true);
    for (const task of ['commit', 'check-commit', 'scan-commit', 'review-commit', 'push']) {
      expect(outcome.statuses.get(task), task).toBe('succeeded');
    }

    // Asked with no change and no message, which the operation reads as nothing to make.
    const asked = outcome.inputs.get('commit') ?? {};
    expect(asked['commit']).toEqual({ branch: 'aflow/x', baseSha: HEAD, pushBase: 'main' });
    expect(asked).not.toHaveProperty('patchRef');
    expect(asked).not.toHaveProperty('patch');
    expect(HostFilePatchInputSchema.safeParse(asked).success).toBe(true);
    expect(outcome.outputs.get('commit')).toMatchObject({
      filesChanged: 0,
      commit: { sha: STRANDED, asItStands: true },
    });
    expect(
      wf.tasks.filter((task) => task.operation === 'host.file.patch').map((t) => t.taskId),
    ).toEqual(['commit']);

    // Every later task reads the head the branch stands at, not the sha it was named by.
    expect(outcome.inputs.get('check-commit')).toMatchObject({ sha: STRANDED, base: ORIGIN_BASE });
    expect(outcome.inputs.get('scan-commit')).toMatchObject({
      range: `${ORIGIN_BASE}..${STRANDED}`,
    });
    expect(outcome.inputs.get('review-commit')).toMatchObject({
      inputs: { from: ORIGIN_BASE, at: STRANDED },
    });
    expect((outcome.inputs.get('push')?.['command'] as string[] | undefined)?.at(-1)).toBe(
      `${STRANDED}:refs/heads/aflow/x`,
    );
  });

  it('is refused at the commit with a message, but no change, as two readings of one request', () => {
    const asked = HostFilePatchInputSchema.safeParse({
      bindingId: 'folder-1',
      commit: { branch: 'aflow/x', baseSha: STRANDED, message: 'm', pushBase: 'main' },
    });
    expect(asked.success).toBe(false);
    expect(asked.error?.issues[0]?.message).toContain('a branch as it stands');
  });
});

describe("Publish Local Changes — the folder's checks run before anything leaves", () => {
  const postures: HostPushApproval[] = ['always', 'never', 'unless-unreviewed'];

  it("runs the folder's checks on the commit it made, measured against `origin`'s base", () => {
    const check = taskOrThrow('check-commit');
    expect(check.inputBindings).toEqual({
      bindingId: { kind: 'run_input', path: 'bindingId' },
      sha: { kind: 'task_output', taskId: 'commit', path: 'commit.sha' },
      pushBaseSha: { kind: 'task_output', taskId: 'commit', path: 'commit.pushBaseSha' },
    });
    const outputs = new Map<string, Record<string, unknown>>([
      ['commit', { state: 'applied', commit: COMMIT }],
    ]);
    const input = substituteTemplateBinds(
      check.inputTemplate ?? {},
      boundOutputs(check.inputBindings, outputs),
      new Set(Object.keys(check.inputBindings ?? {})),
    );
    expect(HostCommitCheckInputSchema.parse(input)).toEqual({
      bindingId: 'folder-1',
      sha: HEAD,
      base: ORIGIN_BASE,
    });
    // The command is the folder's: nothing the run passes can name one.
    expect(Object.keys(HostCommitCheckInputSchema.shape).sort()).toEqual([
      'base',
      'bindingId',
      'sha',
    ]);
  });

  it('checks after the commit and before the scan, and so before the review, the approval and the push', () => {
    expect(taskOrThrow('check-commit').dependsOn).toEqual(['commit']);
    expect(taskOrThrow('scan-commit').dependsOn).toContain('check-commit');
    const outcome = publish({ pushApproval: 'never', review: 'approve', decision: 'approved' });
    expect(outcome.ran.indexOf('check-commit')).toBeGreaterThan(outcome.ran.indexOf('commit'));
    expect(outcome.ran.indexOf('scan-commit')).toBeGreaterThan(outcome.ran.indexOf('check-commit'));
    expect(outcome.pushed).toBe(true);
  });

  it('records every ending of the first run, so the run itself chooses rerun or stop — and fails at the second', () => {
    for (const taskId of ['check-commit', 'recheck-commit']) {
      const check = taskOrThrow(taskId);
      expect(check.maxAttempts, taskId).toBe(1);
      expect(check.outputContract, taskId).toBeUndefined();
      expect(check.optional, taskId).not.toBe(true);
    }
    const projects = (taskId: string, ending: Check): boolean =>
      projectTaskOutput(taskOrThrow(taskId).outputProjection ?? {}, checkResult(ending), null).ok;
    for (const ending of ['passed', 'skipped', 'failed', 'timed-out', 'test-timeouts'] as const) {
      expect(projects('check-commit', ending), ending).toBe(true);
    }
    // The second run is the last: anything but passing fails it, and the run.
    for (const ending of ['failed', 'timed-out', 'test-timeouts'] as const) {
      expect(projects('recheck-commit', ending), ending).toBe(false);
    }
    expect(projects('recheck-commit', 'passed')).toBe(true);
  });

  describe('a run of the checks lost only to tests running out of time', () => {
    const LATER = [
      'scan-commit',
      'read-push-approval',
      'review-commit',
      'approve-push',
      'push',
      'find-pr',
      'open-pr',
    ];
    const checkRuns = (ran: readonly string[]) =>
      ran.filter((taskId) => taskOrThrow(taskId).operation === 'host.commit.check');

    it('is run once more by the publication itself, which then goes on and pushes on the second run’s receipt', () => {
      const outcome = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        check: 'test-timeouts',
      });
      expect(checkRuns(outcome.ran)).toEqual(['check-commit', 'recheck-commit']);
      expect(outcome.ran.indexOf('scan-commit')).toBeGreaterThan(
        outcome.ran.indexOf('recheck-commit'),
      );
      expect(outcome.inputs.get('recheck-commit')).toEqual(outcome.inputs.get('check-commit'));
      expect(outcome.inputs.get('recheck-commit')).toEqual({
        bindingId: 'folder-1',
        sha: HEAD,
        base: ORIGIN_BASE,
      });
      expect(outcome.pushed).toBe(true);
      expect(outcome.inputs.get('push')?.['check']).toEqual({ receipt: CHECK_RECEIPT.passed });
    });

    it('is recorded on the run: the first check names the tests and did not pass, the second is its own task', () => {
      const outcome = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        check: 'test-timeouts',
      });
      expect(outcome.statuses.get('check-commit')).toBe('succeeded');
      expect(outcome.outputs.get('check-commit')).toMatchObject({
        passed: false,
        testTimeouts: [TIMED_OUT_TEST],
        receipt: CHECK_RECEIPT.failed,
      });
      expect(outcome.statuses.get('recheck-commit')).toBe('succeeded');
      expect(outcome.outputs.get('recheck-commit')).toMatchObject({
        passed: true,
        clearedSha: HEAD,
        receipt: CHECK_RECEIPT.passed,
      });
      expect(taskOrThrow('recheck-commit').name).toBe(
        "Run the folder's checks again, after tests ran out of time",
      );
    });

    for (const recheck of ['test-timeouts', 'failed', 'timed-out'] as const) {
      it(`is run exactly once: a second run that ${recheck === 'test-timeouts' ? 'loses to time again' : recheck === 'failed' ? 'fails' : 'runs out of the folder’s time'} fails the publication with nothing later run`, () => {
        const outcome = publish({
          pushApproval: 'never',
          review: 'approve',
          decision: 'approved',
          check: 'test-timeouts',
          recheck,
        });
        expect(checkRuns(outcome.ran)).toEqual(['check-commit', 'recheck-commit']);
        expect(outcome.statuses.get('recheck-commit')).toBe('failed');
        for (const later of LATER) expect(outcome.ran, later).not.toContain(later);
        expect(outcome.pushed).toBe(false);
      });
    }

    for (const check of ['passed', 'skipped', 'failed', 'timed-out'] as const) {
      it(`is not what a run that ${check === 'timed-out' ? 'ran out of the folder’s time' : check} is: no second run`, () => {
        const outcome = publish({
          pushApproval: 'never',
          review: 'approve',
          decision: 'approved',
          check,
        });
        expect(checkRuns(outcome.ran)).toEqual(['check-commit']);
      });
    }

    it('says on the second run’s failure that it was the second, and why there was one — never that the first failed only on time', () => {
      const failure = taskOrThrow('recheck-commit').failureInstruction ?? '';
      expect(failure).toContain('Nothing was scanned, reviewed or pushed');
      expect(failure).toContain('because tests ran out of their time on the first');
      expect(failure).toContain('this second run failed as well');
      expect(failure).not.toMatch(/failed only/);
    });

    it('is the only route to a second run: no decision sends a run there', () => {
      expect(taskOrThrow('recheck-commit').when).toEqual({
        expression: 'tasks.check-commit.output.testTimeouts != null',
        onMissingRef: 'skip',
      });
    });
  });

  for (const pushApproval of postures) {
    for (const check of ['failed', 'timed-out'] as const) {
      it(`${pushApproval}: checks that ${check === 'failed' ? 'fail' : 'run out of time'} scan nothing, review nothing, ask nothing and push nothing`, () => {
        const outcome = publish({ pushApproval, review: 'approve', decision: 'approved', check });
        expect(outcome.ran).toContain('check-commit');
        for (const later of [
          'scan-commit',
          'read-push-approval',
          'review-commit',
          'approve-push',
          'push',
          'find-pr',
          'open-pr',
        ]) {
          expect(outcome.ran).not.toContain(later);
        }
        expect(outcome.asked).toBe(false);
        expect(outcome.pushed).toBe(false);
        expect(outcome.state['prUrl']).toBeUndefined();
      });
    }
  }

  it('goes on as before where the folder declares no checks', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      check: 'skipped',
    });
    expect(outcome.ran).toContain('scan-commit');
    expect(outcome.pushed).toBe(true);
  });

  it('checks nothing when the patch did not commit', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      committed: false,
    });
    expect(outcome.ran).not.toContain('check-commit');
    expect(outcome.pushed).toBe(false);
  });

  it("carries the check's tail into the failure, and says nothing left the machine", () => {
    const failed = checkResult('failed');
    expect(String(failed['summary'])).toContain(CHECK_TAIL);
    expect(failed['outputRef']).toBeDefined();
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      check: 'failed',
    });
    expect(outcome.inputs.get('checks-failed')).toEqual({ reason: failed['summary'] });
    const failure = taskOrThrow('checks-failed').failureInstruction ?? '';
    expect(failure).toContain('Nothing was scanned, reviewed or pushed');
    expect(failure).toContain('`checksTimeoutMs`');
  });

  it("says in its description that the folder's checks run first, and that the pull request's remain the proof", () => {
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'run in a checkout of the commit before the scan, and nothing is scanned, reviewed or pushed until they pass',
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'any other failure stops the run with the end of what they printed.',
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain('the push needs their passing receipt.');
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      'A folder that declares none runs none.',
    );
    expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain(
      "The pull request's own checks remain the proof.",
    );
  });

  it("binds the check's receipt into the push, and none where the folder declares no checks", () => {
    const push = taskOrThrow('push');
    expect(push.dependsOn).toContain('check-commit');
    expect(push.inputBindings?.['checkReceipt']).toEqual({
      kind: 'task_output',
      taskId: 'check-commit',
      path: 'receipt',
    });
    const template = push.inputTemplate;
    if (template === undefined) throw new Error('the push must carry a template');
    const declared = new Set(Object.keys(push.inputBindings ?? {}));
    const inputs = {
      bindingId: 'folder-1',
      refspec: COMMIT.pushRefspec,
      base: 'main',
      receipt: RECEIPT.clean,
    };
    for (const [check, expected] of [
      ['passed', CHECK_RECEIPT.passed],
      ['skipped', null],
    ] as const) {
      const projection = taskOrThrow('check-commit').outputProjection;
      if (projection === undefined) throw new Error('the check must project its output');
      const projected = projectTaskOutput(projection, checkResult(check), null);
      if (!projected.ok) throw new Error(`the ${check} check must project`);
      const input = HostProcessExecInputSchema.parse(
        substituteTemplateBinds(
          template,
          { ...inputs, checkReceipt: projected.value['receipt'] },
          declared,
        ),
      );
      expect(input.check, check).toEqual({ receipt: expected });
    }
  });

  it('pushes a commit whose checks passed only with their receipt, and one from a folder without checks with none', () => {
    for (const check of ['passed', 'skipped'] as const) {
      const outcome = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        check,
      });
      expect(outcome.pushed, check).toBe(true);
    }
  });
});

describe('Publish Local Changes — the pull request describes the branch as a whole', () => {
  const GITHUB_INPUTS = { owner: 'aflowai', repo: 'aflow' };
  const FINDINGS = [
    {
      severity: 'major',
      file: 'src/cache.ts',
      line: 40,
      claim: 'The cache is never invalidated.',
      state: 'closed',
    },
    { severity: 'nit', file: 'src/cache.ts', claim: 'A name says what it was.', state: 'open' },
  ] as const;
  const GAPS = ['The cold path was not measured under load.'];

  /** What the composition was handed, read as `host.commit.describe` reads it. */
  function describedWith(outcome: Outcome) {
    return HostCommitDescribeInputSchema.parse(outcome.inputs.get('describe-pr'));
  }

  it("is handed the push's whole range, this run's review and checks, and the findings and gaps the brief passed", () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      inputs: { ...GITHUB_INPUTS, findings: FINDINGS, gaps: GAPS },
    });
    expect(outcome.pushed).toBe(true);
    const described = describedWith(outcome);
    expect(described.range).toBe(COMMIT.pushRange);
    expect(described.findings).toEqual(FINDINGS);
    expect(described.gaps).toEqual(GAPS);
    expect(described.review).toEqual({
      verdict: 'approve',
      outcome: 'completed',
      reviewSummary: 'Read.',
      findings: [],
    });
    expect(described.check).toMatchObject({
      passed: true,
      summary: '`node scripts/verify-commit.mjs` passed.',
      tail: 'ok   prettier (3 files) (1.2 s)\n',
    });
    expect(described.recheck).toBeUndefined();
    // Neither a title nor a summary: both are the composition's.
    expect(described.title).toBeUndefined();
    expect(described.summary).toBeUndefined();

    expect(outcome.ran).toContain('open-pr');
    expect(outcome.inputs.get('open-pr')?.['params']).toMatchObject({
      body: { title: SLICE_TITLE, body: `Composed from \`${COMMIT.pushRange}\`.` },
    });
  });

  it('carries both runs of the checks where the first lost only to time, and no review where none finished', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      check: 'test-timeouts',
    });
    const described = describedWith(outcome);
    expect(described.check?.passed).toBe(false);
    expect(described.recheck).toMatchObject({ passed: true });
    // Under `never` no review runs, and the composition is told none did.
    expect(described.review).toBeUndefined();

    const failed = describedWith(
      publish({ pushApproval: 'unless-unreviewed', review: 'failed', decision: 'approved' }),
    );
    expect(failed.review).toEqual({
      verdict: null,
      outcome: 'failed',
      reviewSummary: null,
      findings: null,
    });
  });

  it("passes a person's own title and summary to the composition, where they stand", () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      inputs: { ...GITHUB_INPUTS, title: 'Their title', summary: 'Their words.' },
    });
    expect(outcome.inputs.get('open-pr')?.['params']).toMatchObject({
      body: { title: 'Their title', body: 'Their words.' },
    });
  });

  it("rewrites an existing pull request's body on an appended push, rather than leaving the first publication's", () => {
    const previousHead = 'b'.repeat(40);
    const appended = {
      ...COMMIT,
      message: 'Fix the finding',
      baseSha: previousHead,
      appended: true,
      range: `${previousHead}..${HEAD}`,
    };
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      existingPrInto: 'main',
      commit: appended,
      inputs: GITHUB_INPUTS,
    });
    expect(outcome.pushed).toBe(true);
    expect(outcome.ran).toContain('update-pr');
    expect(outcome.ran).not.toContain('open-pr');
    // The whole branch from `origin`'s base, not the round that appended.
    expect(describedWith(outcome).range).toBe(`${ORIGIN_BASE}..${HEAD}`);
    expect(outcome.inputs.get('update-pr')).toEqual({
      apiId: 'github',
      endpointId: 'updatePullRequest',
      params: {
        owner: 'aflowai',
        repo: 'aflow',
        pull_number: 5,
        // No title passed: one edited on GitHub since stays.
        body: { body: `Composed from \`${ORIGIN_BASE}..${HEAD}\`.` },
      },
      response: { format: 'json' },
    });
    expect(outcome.statuses.get('update-pr')).toBe('succeeded');
    expect(outcome.state).toEqual({
      prUrl: 'https://github.com/aflowai/aflow/pull/5',
      prNumber: 5,
      findings: [],
      findingsLeftOut: null,
      afterReview: null,
      afterReviewOverride: null,
      overrideCheck: 'none',
      overrideCheckReason: "No override was passed: the decision on the review's findings stands.",
      pushDecision: 'push',
      pushReason: "The folder's push approval is `never`, over a range the scan cleared.",
    });

    const titled = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      existingPrInto: 'main',
      commit: appended,
      inputs: { ...GITHUB_INPUTS, title: 'Their title' },
    });
    expect(titled.inputs.get('update-pr')?.['params']).toMatchObject({
      body: { title: 'Their title', body: `Composed from \`${ORIGIN_BASE}..${HEAD}\`.` },
    });
  });

  it('opens a fresh pull request with no rewrite beside it', () => {
    const outcome = publish({ pushApproval: 'never', review: 'approve', decision: 'approved' });
    expect(outcome.ran).toContain('open-pr');
    expect(outcome.statuses.get('update-pr')).toBe('skipped');
  });

  it('pushes nothing where the composed text cannot go out', () => {
    for (const pushApproval of ['always', 'never', 'unless-unreviewed'] as const) {
      const outcome = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        describeRefused: true,
      });
      expect(outcome.statuses.get('describe-pr'), pushApproval).toBe('failed');
      expect(outcome.pushed, pushApproval).toBe(false);
      expect(outcome.ran, pushApproval).not.toContain('find-pr');
    }
    expect(taskOrThrow('describe-pr').failureInstruction).toContain('nothing was pushed');
    expect(taskOrThrow('update-pr').failureInstruction).toContain('The push went through');
  });

  it("derives the findings and gaps it takes from the composition's own schemas", () => {
    expect(runInputOrThrow('findings').schema).toEqual({
      ...toJsonSchemaSync(PullRequestFindingsSchema),
    });
    expect(runInputOrThrow('gaps').schema).toEqual({ ...toJsonSchemaSync(PullRequestGapsSchema) });
  });
});

// ── A failed check stops the run: no decision is asked of it ───────────────

describe('Publish Local Changes — a failed check stops the run, and no decision is asked of it', () => {
  /** Everything that only runs on a commit the checks cleared. */
  const CLEARED_ONLY = [
    'scan-commit',
    'read-repository',
    'read-push-approval',
    'review-commit',
    'describe-pr',
    'approve-push',
    'push',
    'find-pr',
    'open-pr',
  ];

  function checkedWith(check: Check, extra: Partial<Scenario> = {}): Outcome {
    return publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      check,
      inputs: { owner: 'aflowai', repo: 'aflow' },
      ...extra,
    });
  }

  it('asks a decision model nothing, over the checks or the review', () => {
    expect(wf.tasks.filter((t) => t.operation === 'ai.decision.decide')).toEqual([]);
    for (const task of wf.tasks) {
      expect(JSON.stringify(task), task.taskId).not.toMatch(/decide-after-check|next_step/);
    }
  });

  for (const check of ['failed', 'timed-out'] as const) {
    it(`${check}: fails the publication at \`checks-failed\` with the checks' account as the reason, and nothing else runs`, () => {
      const outcome = checkedWith(check);
      expect(outcome.statuses.get('check-commit')).toBe('succeeded');
      expect(outcome.statuses.get('checks-failed')).toBe('failed');
      expect(outcome.inputs.get('checks-failed')).toEqual({
        reason: checkResult(check)['summary'],
      });
      for (const id of [...CLEARED_ONLY, 'recheck-commit']) {
        expect(outcome.ran, id).not.toContain(id);
      }
      expect(outcome.pushed).toBe(false);
      expect(outcome.state['prUrl']).toBeUndefined();
    });
  }

  for (const check of ['passed', 'skipped', 'test-timeouts'] as const) {
    it(`${check}: does not stop the run`, () => {
      const outcome = checkedWith(check);
      expect(outcome.ran).not.toContain('checks-failed');
      expect(outcome.pushed).toBe(true);
    });
  }

  it('says the checks did not pass and what was left untouched, and steers to no remedy their account has not named', () => {
    const stop = taskOrThrow('checks-failed');
    expect(stop.optional).not.toBe(true);
    const failure = stop.failureInstruction ?? '';
    expect(failure).toContain("The folder's checks did not pass on this run's commit");
    expect(failure).toContain('Nothing was scanned, reviewed or pushed');
    expect(failure).toContain('the change, or the machine the checks ran on');
    // A fault on the machine is not the change's, so no fix to the change is prescribed.
    expect(failure).not.toMatch(/[Cc]ommission/);
    expect(failure).not.toBe(taskOrThrow('check-commit').failureInstruction);
  });

  it('says, where the check step itself breaks, that the checks could not run — and prescribes no fix to the change', () => {
    // A run of the checks that did not pass succeeds and stops at `checks-failed`, so the first
    // run's own failure is only ever the step breaking: the executor, the checkout, the fetch.
    for (const check of ['failed', 'timed-out', 'test-timeouts'] as const) {
      expect(
        projectTaskOutput(
          taskOrThrow('check-commit').outputProjection ?? {},
          checkResult(check),
          null,
        ).ok,
        check,
      ).toBe(true);
    }
    const failure = taskOrThrow('check-commit').failureInstruction ?? '';
    expect(failure).toContain("The folder's checks could not be run on this run's commit");
    expect(failure).toContain('Nothing was scanned, reviewed or pushed');
    expect(failure).toContain('Nothing says the change is at fault');
    expect(failure).not.toMatch(/[Cc]ommission/);
    expect(failure).not.toContain('checks failed');
  });

  it('projects what the stop, the rerun, the push and the composition read, and nothing else', () => {
    expect(Object.keys(taskOrThrow('check-commit').outputProjection ?? {}).sort()).toEqual([
      'passed',
      'receipt',
      'skipped',
      'summary',
      'tail',
      'testTimeouts',
    ]);
  });
});

// ── No publication starts a publication, or a commission ──────────────────

describe('Publish Local Changes — no publication starts a publication', () => {
  /** What a task starts as a run of its own, by the catalog entry it names. */
  const startedBy = (task: WorkflowTask): string | undefined => {
    if (task.operation !== 'workflow.run.start') return undefined;
    const template = task.inputTemplate as { catalogId?: unknown; slug?: unknown } | undefined;
    return String(template?.catalogId ?? template?.slug);
  };

  it('starts one run of its own, the review of its commit, and no other skill', () => {
    const started = wf.tasks.flatMap((task) => {
      const skill = startedBy(task as WorkflowTask);
      return skill === undefined ? [] : [[task.taskId, skill]];
    });
    expect(started).toEqual([['review-commit', REVIEW_LOCAL_CHANGES.catalogId]]);
  });

  // Plan 321: the shepherd publishes its fixes through Local Publish, and the
  // review that publication starts must still be within the chain's depth, or
  // the shepherd's push would ask where the operator's own would not.
  it('is started only by the shepherd, which no skill starts, so its review stays within the run depth', () => {
    const starting = (catalogId: string) =>
      SKILL_CATALOG.filter((skill) =>
        skill.bundle.workflow.tasks.some((task) => {
          const template = task.inputTemplate as
            { catalogId?: unknown; slug?: unknown } | undefined;
          return (
            task.operation === 'workflow.run.start' &&
            [template?.catalogId, template?.slug].includes(catalogId)
          );
        }),
      ).map((skill) => skill.catalogId);
    expect(starting(PUBLISH_LOCAL_CHANGES.catalogId)).toEqual([LOCAL_PR_SHEPHERD.catalogId]);
    expect(starting(LOCAL_PR_SHEPHERD.catalogId)).toEqual([]);
    // The shepherd at 1, its publication at 2, that publication's review at 3.
    expect(MAX_WORKFLOW_RUN_DEPTH).toBeGreaterThanOrEqual(3);
  });

  it('commits once and pushes once: the fix round is the conversation’s, not a second commit or push of its own', () => {
    for (const operation of ['host.file.patch', 'host.process.exec']) {
      expect(
        wf.tasks.filter((task) => task.operation === operation).map((task) => task.taskId),
        operation,
      ).toHaveLength(1);
    }
  });
});

// ── What the run decides about a review's findings, by the rounds rule ─────

describe("Publish Local Changes — the rounds rule decides a review's findings, and the push gate follows it", () => {
  const LEAK: Finding = {
    severity: 'major',
    file: 'src/cache.ts',
    line: 40,
    claim: 'The cache is never invalidated after a write.',
    evidence:
      'put() writes the store and leaves the map entry; the test reads only before the write.',
  };
  const NAME: Finding = {
    severity: 'nit',
    file: 'src/cache.ts',
    claim: 'The name says what it was.',
    evidence: 'cacheOld',
  };
  const NIT_TOO: Finding = { ...NAME, file: 'src/lock.ts', claim: 'The comment says what.' };
  const RACE: Finding = {
    severity: 'blocker',
    file: 'src/lock.ts',
    line: 12,
    claim: 'Two writers can both take the lock.',
    evidence: 'The check and the set are two calls.',
  };
  const FINDINGS = [LEAK, NAME, RACE];
  const SLIP: Finding = {
    severity: 'minor',
    file: 'src/cache.ts',
    line: 52,
    claim: 'The miss counter counts a hit after a reload.',
    evidence: 'reload() increments misses before it reads the entry.',
  };
  const STALE: Finding = {
    severity: 'minor',
    file: 'src/cache.ts',
    line: 61,
    claim: 'The eviction log names the key after it is gone.',
    evidence: 'evict() deletes the entry, then formats the message from it.',
  };
  /** Findings no more severe than minor: the only ones a decision clears a push over. */
  const MINORS = [SLIP, NAME];
  /** An earlier round's finding the brief passed on, closed by a commit of the branch. */
  const EARLIER = {
    severity: 'minor',
    file: 'src/cache.ts',
    line: 12,
    claim: 'The size is read twice.',
    state: 'closed',
  } as const;
  /** An earlier round's finding the branch still leaves as the review found it. */
  const EARLIER_OPEN = {
    severity: 'nit',
    file: 'src/cache.ts',
    claim: 'The constant is named for the old default.',
    state: 'open',
  } as const;
  const PR_TASKS = ['find-pr', 'update-pr', 'open-pr'];
  const nits = (count: number): Finding[] =>
    Array.from({ length: count }, (_, i) => ({ ...NAME, claim: `Nit ${String(i)}.` }));

  /** `round` as a publication is started with it; absent is the slice's first, as the default says. */
  type Round = number | 'absent';

  function reviewedWith(extra: Partial<Scenario> & { round?: Round }): Outcome {
    const { round = 'absent', ...scenario } = extra;
    return publish({
      pushApproval: 'unless-unreviewed',
      review: 'request_changes',
      decision: 'approved',
      findings: FINDINGS,
      ...scenario,
      inputs: {
        owner: 'aflowai',
        repo: 'aflow',
        findings: [EARLIER, EARLIER_OPEN],
        ...(round === 'absent' ? {} : { round }),
        ...scenario.inputs,
      },
    });
  }

  /** A run that ended completed: nothing failed, and every task ran or was skipped. */
  function endedCompleted(outcome: Outcome): void {
    expect([...outcome.statuses].filter(([, status]) => status === 'failed')).toEqual([]);
    expect(
      outcome.ran.length + [...outcome.statuses.values()].filter((s) => s === 'skipped').length,
    ).toBe(wf.tasks.length);
  }

  /** What the rounds rule settled, and that the gate followed it: the decision on the run and the pull request's record. */
  function expectSettled(outcome: Outcome, decision: string, reason: string, label: string): void {
    expect(outcome.outputs.get('settle-after-review'), label).toEqual({ decision, reason });
    expect(outcome.state['afterReview'], label).toBe(decision);
    expect(outcome.outputs.get('describe-pr')?.['afterReview'], label).toBe(decision);
  }

  /** `fix_before_merge`: no pause, nothing pushed, no pull request touched, and the run completed. */
  function expectKeptLocal(outcome: Outcome, label: string): void {
    expect(outcome, label).toMatchObject({ asked: false, pushed: false });
    expect(outcome.ran, label).not.toContain('approve-push');
    for (const taskId of PR_TASKS) expect(outcome.ran, label).not.toContain(taskId);
    endedCompleted(outcome);
    expect(outcome.state, label).toMatchObject({
      pushDecision: 'keep_local',
      reviewRunId: REVIEW_RUN_ID,
    });
    expect(outcome.state['pushReason'], label).toContain('`fix_before_merge`');
    expect(outcome.state['prUrl'], label).toBeUndefined();
  }

  describe('every branch of the rule', () => {
    it('a verdict short of approve is fix_before_merge, whatever it found and whatever the round', () => {
      for (const review of ['request_changes', 'comment'] as const) {
        for (const [found, findings] of [
          ['nothing', []],
          ['nits alone', [NAME, NIT_TOO]],
          ['minors', MINORS],
          ['a blocker and a major', FINDINGS],
        ] as const) {
          for (const round of ['absent', 1, 2, 5] as const) {
            const label = `${review}, ${found}, round ${String(round)}`;
            const outcome = reviewedWith({ review, findings, round });
            expectSettled(outcome, 'fix_before_merge', NOT_APPROVED_REASON, label);
            expectKeptLocal(outcome, label);
          }
        }
      }
    });

    it('approve with no finding above a nit is publish_as_is, whatever the round, and pushes without asking', () => {
      for (const [found, findings] of [
        ['nothing', []],
        ['nits alone', [NAME, NIT_TOO]],
        ['as many nits as a review can return', nits(REVIEW_FINDINGS_MAX)],
      ] as const) {
        for (const round of ['absent', 1, 2] as const) {
          const label = `${found}, round ${String(round)}`;
          const outcome = reviewedWith({ review: 'approve', findings, round });
          expectSettled(
            outcome,
            'publish_as_is',
            round === 2 ? AFTER_FIX_ROUND_REASON : NITS_ONLY_REASON,
            label,
          );
          expect(outcome, label).toMatchObject({ asked: false, pushed: true });
          expect(outcome.state['pushDecision'], label).toBe('push');
        }
      }
      expect(NITS_ONLY_REASON).toBe('nits-only review: the rounds rule ends the rounds');
    });

    it("approve with minors on the slice's first publication is fix_before_merge — the one round", () => {
      for (const round of ['absent', 1] as const) {
        const label = `round ${String(round)}`;
        const outcome = reviewedWith({ review: 'approve', findings: MINORS, round });
        expectSettled(outcome, 'fix_before_merge', FIRST_ROUND_REASON, label);
        expectKeptLocal(outcome, label);
        // Every finding is handed on, for the fix round's publication to mark.
        expect(outcome.state['findings'], label).toHaveLength(MINORS.length);
      }
    });

    it('approve with minors once a fix round has run is publish_as_is: pushed without asking, the minors carried open on the pull request', () => {
      for (const round of [2, 3] as const) {
        const label = `round ${String(round)}`;
        const outcome = reviewedWith({ review: 'approve', findings: [SLIP, STALE, NAME], round });
        expectSettled(outcome, 'publish_as_is', AFTER_FIX_ROUND_REASON, label);
        expect(outcome, label).toMatchObject({ asked: false, pushed: true });
        expect(outcome.state, label).toMatchObject({
          pushDecision: 'push',
          prUrl: 'https://github.com/aflowai/aflow/pull/7',
        });
        // Carried: the composition is handed every finding, records them open, and hands them on.
        const described = HostCommitDescribeInputSchema.parse(outcome.inputs.get('describe-pr'));
        expect(
          described.review?.findings?.map((f) => f.claim),
          label,
        ).toEqual([SLIP, STALE, NAME].map((f) => f.claim));
        expect(PullRequestFindingsSchema.parse(outcome.state['findings']), label).toEqual(
          [SLIP, STALE, NAME].map(({ severity, file, line, claim }) => ({
            severity,
            file,
            ...(line === undefined ? {} : { line }),
            claim,
            state: 'open',
          })),
        );
        const opened = outcome.inputs.get('open-pr') as { params: { body: { body: unknown } } };
        expect(opened.params.body.body, label).toBe(outcome.outputs.get('describe-pr')?.['body']);
      }
    });

    it('approve over a blocker or a major takes the round as minors do, and after it the gate asks the operator, whose answer decides', () => {
      for (const [severity, findings] of [
        ['a blocker', [SLIP, RACE]],
        ['a major', [NAME, LEAK]],
      ] as const) {
        const first = reviewedWith({ review: 'approve', findings });
        expectSettled(first, 'fix_before_merge', FIRST_ROUND_REASON, severity);
        expectKeptLocal(first, severity);

        const after = reviewedWith({ review: 'approve', findings, round: 2 });
        expectSettled(after, 'publish_as_is', AFTER_FIX_ROUND_REASON, severity);
        expect(after, severity).toMatchObject({ asked: true, pushed: true });
        expect(after.state['pushDecision'], severity).toBe('ask');
        expect(after.state['pushReason'], severity).toContain('a blocker or a major');
        const declined = reviewedWith({
          review: 'approve',
          findings,
          round: 2,
          decision: 'declined',
        });
        expect(declined, severity).toMatchObject({ asked: true, pushed: false });
        for (const taskId of PR_TASKS) expect(declined.ran, severity).not.toContain(taskId);
      }
    });

    it('reads every severity above a nit at every place a review can put a finding, and a missing round as the first', () => {
      const decide = (state: Record<string, unknown>) =>
        decideByRules({
          state,
          rules: [...AFTER_REVIEW_SETTLE_RULES],
          otherwise: AFTER_REVIEW_SETTLE_OTHERWISE,
        }).decision;
      for (const severity of ['minor', 'major', 'blocker'] as const) {
        for (const at of [0, REVIEW_FINDINGS_MAX - 1]) {
          const findings = nits(REVIEW_FINDINGS_MAX).map((nit, i) =>
            i === at ? { ...nit, severity } : nit,
          );
          const label = `${severity} at ${String(at)}`;
          expect(decide({ verdict: 'approve', findings }), label).toBe('fix_before_merge');
          expect(decide({ verdict: 'approve', findings, round: null }), label).toBe(
            'fix_before_merge',
          );
          expect(decide({ verdict: 'approve', findings, round: 1 }), label).toBe(
            'fix_before_merge',
          );
          expect(decide({ verdict: 'approve', findings, round: 2 }), label).toBe('publish_as_is');
        }
      }
      expect(Object.keys(REVIEW_SEVERITIES)).toEqual(['blocker', 'major', 'minor', 'nit']);
      // A verdict that is not there is no approval.
      expect(decide({ findings: [] })).toBe('fix_before_merge');
    });
  });

  describe('the round is a fact the run is handed, never a guess', () => {
    it('is a declared run input — optional, a whole number from 1, defaulting to 1 — accepted at the start', () => {
      const round = runInputOrThrow('round');
      expect(round.required).toBe(false);
      expect(round.schema).toEqual({ type: 'integer', minimum: 1, maximum: 1000, default: 1 });
      expect(taskOrThrow('message-from').inputContract?.bindings['round']?.schema).toEqual(
        round.schema,
      );
      expect(round.description).toContain('1, the default');
      expect(skillGuidance(PUBLISH_LOCAL_CHANGES)).toContain('`round`');
    });

    it('reaches the rule from the run input alone, beside the verdict and the findings', () => {
      expect(taskOrThrow('settle-after-review').inputBindings).toEqual({
        verdict: { kind: 'task_output', taskId: 'review-commit', path: 'verdict' },
        findings: { kind: 'task_output', taskId: 'review-commit', path: 'findings' },
        round: { kind: 'run_input', path: 'round' },
      });
      const outcome = reviewedWith({ review: 'approve', findings: MINORS, round: 2 });
      expect(outcome.inputs.get('settle-after-review')).toMatchObject({
        state: { verdict: 'approve', findings: MINORS, round: 2 },
      });
    });
  });

  describe('no model decides, and nothing is left undecided', () => {
    it('asks no decision model and has no undecided path anywhere — not in the rule, the gate or the record', () => {
      expect(wf.tasks.some((task) => task.operation === 'ai.decision.decide')).toBe(false);
      expect(taskById.has('decide-after-review')).toBe(false);
      expect(JSON.stringify(wf)).not.toMatch(/undecided|decide-after-review/);
      expect(JSON.stringify(PUSH_GATE_RULES)).not.toContain('undecided');
      const decisions = new Set([
        ...AFTER_REVIEW_SETTLE_RULES.map((rule) => rule.decision),
        AFTER_REVIEW_SETTLE_OTHERWISE.decision,
      ]);
      expect([...decisions].sort()).toEqual([...AFTER_REVIEW_ROUTES].sort());
    });

    it('never pauses a cleared range under `unless-unreviewed` over findings no more severe than minor: every verdict, every round', () => {
      for (const review of ['approve', 'request_changes', 'comment'] as const) {
        for (const findings of [[], [NAME], MINORS, [SLIP, STALE]]) {
          for (const round of ['absent', 1, 2] as const) {
            const outcome = reviewedWith({ review, findings, round });
            const label = `${review}, ${String(findings.length)} findings, round ${String(round)}`;
            expect(outcome.asked, label).toBe(false);
            expect(outcome.ran, label).not.toContain('approve-push');
          }
        }
      }
    });

    for (const round of ['absent', 2] as const) {
      it(`posture always asks whatever the rule would decide (round ${String(round)}), and runs no review to decide on`, () => {
        const outcome = reviewedWith({ pushApproval: 'always', review: 'approve', round });
        expect(outcome.asked).toBe(true);
        expect(outcome.ran).not.toContain('review-commit');
        expect(outcome.state['pushDecision']).toBe('ask');
      });

      for (const scan of ['unscanned', 'allowed'] as const) {
        it(`an unclean scan (${scan}) asks whatever the rule would decide (round ${String(round)})`, () => {
          for (const pushApproval of ['never', 'unless-unreviewed'] as const) {
            const outcome = reviewedWith({ pushApproval, scan, review: 'approve', round });
            expect(outcome.asked, pushApproval).toBe(true);
            expect(outcome.ran, pushApproval).not.toContain('review-commit');
            expect(outcome.state['pushDecision'], pushApproval).toBe('ask');
          }
        });
      }
    }
  });

  describe('an override of the decision, taken only on an authority the run verifies', () => {
    const OPERATOR = {
      by: 'operator',
      reason: 'The operator said to publish it as it stands.',
    } as const;
    const LABEL = {
      by: 'hands_off_label',
      reason: 'A person labelled the pull request hands-off: they take the findings on.',
    } as const;
    const SHEPHERD = {
      by: 'shepherd_rule',
      reason: 'The shepherd reached this pull request’s attempt budget.',
    } as const;
    type Override = typeof OPERATOR | typeof LABEL | typeof SHEPHERD;
    const GITHUB_READS = ['read-override-pr', 'read-override-pin', 'read-override-handoff'];
    const BUDGET_SPENT: OnGitHub = { shepherdDecision: 'abandon' };

    /** Over minors from a review that did not approve: the rule's fix_before_merge, set aside. */
    function overridden(
      override: Override,
      extra: Partial<Scenario> & { round?: Round } = {},
    ): Outcome {
      return reviewedWith({
        findings: MINORS,
        ...extra,
        inputs: { override, ...extra.inputs },
      });
    }

    /** Refused at the override: the run fails there with the reason it read, and nothing is composed, asked or pushed. */
    function expectRefused(outcome: Outcome, label: string): void {
      expect(outcome.statuses.get('override-refused'), label).toBe('failed');
      expect(outcome.inputs.get('override-refused'), label).toEqual({
        reason: outcome.state['overrideCheckReason'],
      });
      expect(outcome.state['overrideCheck'], label).toBe('refused');
      expect(outcome, label).toMatchObject({ asked: false, pushed: false });
      expect(outcome.ran, label).not.toContain('describe-pr');
      for (const taskId of PR_TASKS) expect(outcome.ran, label).not.toContain(taskId);
      expect(outcome.state['pushDecision'], label).toBe('keep_local');
    }

    it("claiming the operator over fix_before_merge: never taken on the claim — the push asks, and only the operator's approval in the run, their word on record, pushes it", () => {
      const approved = overridden(OPERATOR);
      expect(approved).toMatchObject({ asked: true, pushed: true });
      expect(approved.state).toMatchObject({
        overrideCheck: 'operator',
        afterReview: 'publish_as_is',
        afterReviewOverride: { ...OPERATOR, overrode: 'fix_before_merge' },
        pushDecision: 'ask',
      });
      expect(approved.state['pushReason']).toContain("the operator's word");
      for (const taskId of GITHUB_READS) expect(approved.ran).not.toContain(taskId);

      // No word of the operator's: the claim alone pushes nothing and opens nothing.
      const declined = overridden(OPERATOR, { decision: 'declined' });
      expect(declined).toMatchObject({ asked: true, pushed: false });
      for (const taskId of PR_TASKS) expect(declined.ran).not.toContain(taskId);
    });

    it("the hands-off label over fix_before_merge: pushes only where the branch's open pull request carries it", () => {
      const labelled = overridden(LABEL, { onGitHub: { handsOff: true } });
      expect(labelled).toMatchObject({ asked: false, pushed: true });
      expect(labelled.state).toMatchObject({
        overrideCheck: 'hands_off_label',
        afterReview: 'publish_as_is',
        afterReviewOverride: { ...LABEL, overrode: 'fix_before_merge' },
        pushDecision: 'push',
      });
      expect(labelled.ran).not.toContain('read-override-pin');

      for (const [unverified, onGitHub] of [
        ['no label on it', { handsOff: false }],
        ['no open pull request of the branch', { noPullRequest: true }],
        ['GitHub refusing the read', { refused: true, handsOff: true }],
      ] as const) {
        expectRefused(overridden(LABEL, { onGitHub }), unverified);
      }
    });

    it("a shepherd rule over fix_before_merge: pushes only where the shepherd's own pinned record holds its budget spent", () => {
      const spent = overridden(SHEPHERD, { onGitHub: BUDGET_SPENT });
      expect(spent).toMatchObject({ asked: false, pushed: true });
      expect(spent.state).toMatchObject({
        overrideCheck: 'shepherd_rule',
        afterReview: 'publish_as_is',
        afterReviewOverride: { ...SHEPHERD, overrode: 'fix_before_merge' },
        pushDecision: 'push',
      });
      // Read by the pinned id, and trusted only from the login it was pinned as.
      expect(spent.inputs.get('read-override-handoff')).toMatchObject({
        endpointId: 'getIssueComment',
        params: { comment_id: 41 },
        response: { transformPresetId: `loop_handoff:${PINNED_AUTHOR}:5` },
      });

      for (const [unverified, onGitHub] of [
        ['a record holding another decision', { shepherdDecision: 'wait' }],
        ['no record at all', {}],
        ['a record another login wrote', { ...BUDGET_SPENT, recordAuthor: 'someone-else' }],
        ['no handoff pinned', { ...BUDGET_SPENT, pinned: false }],
        ['no open pull request of the branch', { ...BUDGET_SPENT, noPullRequest: true }],
      ] as const) {
        expectRefused(overridden(SHEPHERD, { onGitHub }), unverified);
      }
    });

    it("reads the shepherd's pin at the one path the shepherd writes and reads it at: the same binding, not a copy of its spelling", () => {
      const pathOf = (task: WorkflowTask | undefined): unknown => {
        const template = task?.inputTemplate as
          { path?: unknown; target?: { path?: unknown } } | undefined;
        return template?.target?.path ?? template?.path;
      };
      const shepherdTasks = new Map(
        LOCAL_PR_SHEPHERD.bundle.workflow.tasks.map((task) => [task.taskId, task]),
      );
      expect(pathOf(taskById.get('read-override-pin'))).toBe(HANDOFF_PIN_PATH);
      expect(pathOf(shepherdTasks.get('remember-handoff'))).toBe(HANDOFF_PIN_PATH);
      expect(pathOf(shepherdTasks.get('read-handoff-pin'))).toBe(HANDOFF_PIN_PATH);
      // Bound from what the verification binds: the repository and the pull request's number.
      expect(Object.keys(taskById.get('read-override-pin')?.inputBindings ?? {}).sort()).toEqual([
        'number',
        'owner',
        'repo',
      ]);
    });

    it('verified, still asks over a blocker or a major: it sets the decision aside, not the severities', () => {
      const outcome = overridden(LABEL, { findings: FINDINGS, onGitHub: { handsOff: true } });
      expect(outcome.state).toMatchObject({
        overrideCheck: 'hands_off_label',
        afterReview: 'publish_as_is',
        pushDecision: 'ask',
      });
      expect(outcome.asked).toBe(true);
    });

    it('over a review that found nothing and did not approve, still asks: that review could not judge the range', () => {
      const outcome = overridden(LABEL, {
        review: 'comment',
        findings: [],
        onGitHub: { handsOff: true },
      });
      expect(outcome.state).toMatchObject({
        afterReview: 'publish_as_is',
        afterReviewOverride: { ...LABEL, overrode: 'fix_before_merge' },
        pushDecision: 'ask',
      });
      expect(outcome.state['pushReason']).toContain('could not judge the range');
    });

    it('is neither checked nor recorded where it sets nothing aside — the decision already publish_as_is, or no findings', () => {
      for (const [label, extra] of [
        ['publish_as_is after a fix round', { review: 'approve', round: 2 }],
        ['no findings', { review: 'approve', findings: [] }],
      ] as const) {
        const outcome = overridden(LABEL, { ...extra, onGitHub: { handsOff: false } });
        expect(outcome.state['overrideCheck'], label).toBe('none');
        for (const taskId of GITHUB_READS) expect(outcome.ran, label).not.toContain(taskId);
        expect(outcome.state['afterReviewOverride'], label).toBeNull();
        expect(outcome.pushed, label).toBe(true);
      }
      expect(reviewedWith({}).state['afterReviewOverride']).toBeNull();
    });

    it('never stands in for an `always` folder or an unclean scan', () => {
      const onGitHub = { handsOff: true };
      expect(overridden(LABEL, { pushApproval: 'always', onGitHub }).asked).toBe(true);
      expect(overridden(LABEL, { scan: 'allowed', onGitHub }).asked).toBe(true);
    });

    it('pushes nothing where the record names an authority the check did not verify, whatever else holds', () => {
      const cleared = {
        scanClean: true,
        posture: 'unless-unreviewed',
        afterReview: 'publish_as_is',
        severest: 'minor',
      };
      const decide = (state: Record<string, unknown>) =>
        decideByRules({ state, rules: [...PUSH_GATE_RULES], otherwise: PUSH_GATE_OTHERWISE })
          .decision;
      expect(decide({ ...cleared, overrideBy: 'hands_off_label', overrideCheck: 'none' })).toBe(
        'keep_local',
      );
      expect(decide({ ...cleared, overrideBy: 'hands_off_label' })).toBe('keep_local');
      expect(decide({ ...cleared, posture: 'never', overrideCheck: 'refused' })).toBe('keep_local');
      expect(
        decide({ ...cleared, overrideBy: 'hands_off_label', overrideCheck: 'hands_off_label' }),
      ).toBe('push');
    });

    it('is taken only as the schema the composition reads it with — whose act, and a reason', () => {
      expect(runInputOrThrow('override').schema).toEqual({
        ...toJsonSchemaSync(AfterReviewOverrideSchema),
      });
      expect(runInputOrThrow('override').required).toBe(false);
    });
  });

  it('reads the decision as the composition records it — an override included — and every task that leaves the machine reads the gate', () => {
    expect(taskOrThrow('decide-push').inputBindings?.['afterReview']).toEqual({
      kind: 'task_output',
      taskId: 'describe-pr',
      path: 'afterReview',
    });
    expect(taskOrThrow('describe-pr').inputBindings?.['afterReview']).toEqual({
      kind: 'task_output',
      taskId: 'settle-after-review',
      path: 'decision',
    });
    expect(taskOrThrow('push').when).toEqual({
      anyOf: [
        "tasks.approve-push.output.decision == 'approved'",
        "tasks.decide-push.output.decision == 'push'",
      ],
      onMissingRef: 'skip',
    });
    for (const taskId of PR_TASKS) {
      expect(JSON.stringify(taskOrThrow(taskId).when), taskId).toContain(
        "tasks.decide-push.output.decision != 'keep_local'",
      );
    }
    // The scan and the posture are read before the decision, so no decision passes them.
    const order = PUSH_GATE_RULES.map((rule) => JSON.stringify(rule.when));
    const first = (needle: string) => order.findIndex((when) => when.includes(needle));
    for (const before of ['state.scanClean', "state.posture == 'always'"]) {
      expect(first(before), before).toBeLessThan(first('state.afterReview'));
    }
    // An override the run did not verify keeps the branch local before anything else is read.
    expect(first('state.overrideCheck')).toBe(0);
    expect(first('state.overrideBy != state.overrideCheck')).toBe(1);
    expect(PUSH_GATE_OTHERWISE.decision).toBe('ask');
  });

  it("hands on this review's findings as the open ones, replacing the earlier rounds' — a round's list never grows", () => {
    const outcome = reviewedWith({});
    const described = HostCommitDescribeInputSchema.parse(outcome.inputs.get('describe-pr'));
    expect(described.review?.findings?.map((f) => f.claim)).toEqual(FINDINGS.map((f) => f.claim));
    const record = outcome.outputs.get('describe-pr')?.['findings'];
    // The most severe first, so a bounded list keeps what matters most.
    expect(PullRequestFindingsSchema.parse(record)).toEqual([
      ...[RACE, LEAK, NAME].map(({ severity, file, line, claim }) => ({
        severity,
        file,
        ...(line === undefined ? {} : { line }),
        claim,
        state: 'open',
      })),
    ]);
    expect(outcome.state['findings']).toEqual(record);
  });

  it('records no decision where the review did not finish, since there were no findings to decide on — and asks', () => {
    for (const review of ['failed', 'not-started'] as const) {
      const outcome = reviewedWith({ review, findings: FINDINGS, round: 2 });
      expect(outcome.ran, review).not.toContain('settle-after-review');
      expect(outcome.state['afterReview'], review).toBeNull();
      expect(outcome.state['pushDecision'], review).toBe('ask');
    }
  });

  it('names its review run, whose findings a fix round is briefed from, every one whole', () => {
    const outcome = reviewedWith({});
    expect(outcome.state['reviewRunId']).toBe(REVIEW_RUN_ID);
    expect(outcome.outputs.get('review-commit')?.['findings']).toEqual(FINDINGS);
  });

  it('says how many findings the bounded hand-on left out, and leaves it null where none', () => {
    const many: Finding[] = Array.from({ length: HANDED_ON_FINDINGS_MAX_COUNT + 3 }, (_, i) => ({
      severity: 'minor',
      file: `src/f${String(i)}.ts`,
      claim: `Finding ${String(i)}.`,
      evidence: 'Shown.',
    }));
    const bounded = reviewedWith({ findings: many });
    expect(bounded.state['findings']).toHaveLength(HANDED_ON_FINDINGS_MAX_COUNT);
    expect(bounded.state['findingsLeftOut']).toBe(3);
    // The review run itself still holds every one of them.
    expect(bounded.outputs.get('review-commit')?.['findings']).toHaveLength(many.length);
    expect(reviewedWith({}).state['findingsLeftOut']).toBeNull();
  });

  it('hands on none where its review finished finding nothing, and the open ones it was given where none finished', () => {
    expect(reviewedWith({ review: 'approve', findings: [] }).state['findings']).toEqual([]);
    for (const review of ['failed', 'not-started'] as const) {
      expect(reviewedWith({ review }).state['findings'], review).toEqual([EARLIER_OPEN]);
    }
  });

  it("keeps the measurement's question as the skill last asked it: the severity ontology, and the rule's two decisions as its only answers", () => {
    for (const [severity, meaning] of Object.entries(REVIEW_SEVERITIES)) {
      expect(AFTER_REVIEW_QUESTION.instructions).toContain(`${severity}: ${meaning}`);
    }
    expect(Object.keys(AFTER_REVIEW_QUESTION.options)).toEqual([
      'fix_before_merge',
      'publish_as_is',
    ]);
    expect(AFTER_REVIEW_ROUTES).toEqual(['fix_before_merge', 'publish_as_is']);
  });

  // A decline pushes nothing, however it is recorded: skipped, as the harness
  // does, or as the answer itself, which leaves the push to refuse on its own
  // predicate.
  for (const declineAs of ['skip', 'answer'] as const) {
    it(`a decline recorded as ${declineAs === 'skip' ? 'a skip' : 'an answer'} pushes nothing over a blocker after the fix round`, () => {
      const outcome = reviewedWith({
        review: 'approve',
        round: 2,
        decision: 'declined',
        declineAs,
      });
      expect(outcome.asked).toBe(true);
      expect(outcome.pushed).toBe(false);
      expect(outcome.state['prUrl']).toBeUndefined();
    });
  }

  it('reads nothing a decision could steer into the scan or the posture', () => {
    // 316 D9: a decider can be steered by what it reads, so it is never the
    // only gate: the scan and the posture it never reaches stay ahead of it.
    const reads = (task: WorkflowTask) =>
      JSON.stringify([task.when, task.inputBindings, task.dependsOn]);
    for (const gate of ['read-push-approval', 'scan-commit']) {
      expect(reads(taskOrThrow(gate) as WorkflowTask), gate).not.toMatch(/decide-|describe-pr/);
    }
  });
});

// ── What a publication hands the next round ────────────────────────────────

describe("Publish Local Changes — the commit is made under the commission's summary when no message is passed", () => {
  const PATCH_REF = 'gs://file-store/tenants/t_1/runs/r_1/steps/s_1/attempt/1/patch.json';
  const COMMISSION_RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const SUMMARY = {
    title: "Derive a publication's commit message from its commission",
    paragraph:
      "A publication with no commitMessage now commits under the summary its commission's coding agent wrote, read from the commission's run, instead of failing at its commit task.",
  };
  const commission = { runId: COMMISSION_RUN_ID, patchRef: PATCH_REF, summary: SUMMARY };

  function committedMessage(outcome: Outcome): string {
    const commit = outcome.inputs.get('commit')?.['commit'] as { message?: unknown } | undefined;
    if (typeof commit?.message !== 'string') throw new Error('the commit carried no message');
    return commit.message;
  }

  function expectWellFormed(message: string): void {
    const lines = message.split('\n');
    expect(lines).toHaveLength(3);
    const [title = '', blank, paragraph = ''] = lines;
    expect(title.length).toBeLessThan(72);
    expect(title.trim()).toBe(title);
    expect(blank).toBe('');
    expect(paragraph.length).toBeGreaterThan(0);
  }

  for (const [how, inputs] of [
    ['names the commission run', { patchRef: PATCH_REF, commission: COMMISSION_RUN_ID }],
    ['passes only its patchRef', { patchRef: PATCH_REF }],
  ] as const) {
    it(`commits with a well-formed message derived from the summary when the caller ${how}`, () => {
      const outcome = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        commission,
        inputs: { owner: 'aflowai', repo: 'aflow', ...inputs },
      });
      expect(outcome.statuses.get('commit')).toBe('succeeded');
      expect(outcome.pushed).toBe(true);
      const message = committedMessage(outcome);
      expect(message).toBe(`${SUMMARY.title}\n\n${SUMMARY.paragraph}`);
      expectWellFormed(message);
      // The operation takes it as a commit message like any other.
      expect(
        HostFilePatchInputSchema.safeParse(outcome.inputs.get('commit')).success,
        'host.file.patch input',
      ).toBe(true);
    });
  }

  it('commits under the message the caller passed, and reads no commission for it', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      commission,
      inputs: {
        owner: 'aflowai',
        repo: 'aflow',
        patchRef: PATCH_REF,
        commitMessage: 'Mine\n\nWhy.',
      },
    });
    expect(committedMessage(outcome)).toBe('Mine\n\nWhy.');
    expect(outcome.ran).not.toContain('find-commission');
    expect(outcome.ran).not.toContain('read-commission');
  });

  it('fails before anything is committed where no commission reported the patchRef, saying what to pass', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      inputs: { owner: 'aflowai', repo: 'aflow', patchRef: PATCH_REF },
    });
    expect(outcome.statuses.get('find-commission')).toBe('failed');
    expect(outcome.ran).not.toContain('commit');
    expect(taskOrThrow('find-commission').failureInstruction).toContain('`commitMessage`');
    expect(taskOrThrow('read-commission').failureInstruction).toContain('`commitMessage`');
  });

  it('refuses a named run that is not the commission which reported the patchRef, naming the one that did', () => {
    const OTHER_RUN_ID = '9b2f1c3a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      commission,
      inputs: { owner: 'aflowai', repo: 'aflow', patchRef: PATCH_REF, commission: OTHER_RUN_ID },
    });
    expect(outcome.outputs.get('check-commission')?.['decision']).toBe('refused');
    expect(outcome.statuses.get('commission-refused')).toBe('failed');
    expect(outcome.ran).not.toContain('read-commission');
    expect(outcome.ran).not.toContain('commit');
    const reason = String(outcome.inputs.get('commission-refused')?.['reason']);
    expect(reason).toContain(OTHER_RUN_ID);
    expect(reason).toContain(COMMISSION_RUN_ID);
    expect(reason).toContain('nothing was committed');
  });

  it('reads the summary of the run that reported the patchRef once the named one is found to be it', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      commission,
      inputs: {
        owner: 'aflowai',
        repo: 'aflow',
        patchRef: PATCH_REF,
        commission: COMMISSION_RUN_ID,
      },
    });
    expect(outcome.outputs.get('check-commission')?.['decision']).toBe('confirmed');
    expect(outcome.statuses.get('commission-refused')).toBe('skipped');
    expect(outcome.inputs.get('read-commission')).toEqual({
      runId: COMMISSION_RUN_ID,
      compact: true,
    });
  });

  it('finds no commission for a patchRef reported on another folder, named or not', () => {
    for (const named of [{}, { commission: COMMISSION_RUN_ID }]) {
      const outcome = publish({
        pushApproval: 'never',
        review: 'approve',
        decision: 'approved',
        commission: { ...commission, bindingId: 'folder-2' },
        inputs: { owner: 'aflowai', repo: 'aflow', patchRef: PATCH_REF, ...named },
      });
      expect(outcome.statuses.get('find-commission'), JSON.stringify(named)).toBe('failed');
      expect(outcome.ran).not.toContain('commit');
    }
    // This folder's runs of the Commission Change that reported this patchRef.
    expect(taskOrThrow('find-commission').inputTemplate).toMatchObject({
      slug: COMMISSION_CHANGE.bundle.workflow.slug,
      input: { field: 'bindingId' },
      succeeded: [{ taskId: 'commission', output: { path: 'patchRef' } }],
      status: ['completed'],
    });
  });

  it("holds the commission's summary to a title under 72 characters and one paragraph", () => {
    const validate = new AjvCtor({ allErrors: true, strict: false }).compile(
      COMMISSION_RESULT_SCHEMA,
    );
    expect(validate({ summary: SUMMARY, checks: 'the brief’s own report' })).toBe(true);
    for (const summary of [
      { ...SUMMARY, title: 'x'.repeat(72) },
      { ...SUMMARY, title: 'Two\nlines' },
      { ...SUMMARY, paragraph: 'One paragraph.\n\nAnd a second.' },
      { title: SUMMARY.title },
    ]) {
      expect(validate({ summary }), JSON.stringify(summary)).toBe(false);
    }
    expect(validate({})).toBe(false);
  });
});

describe('Publish Local Changes — a change with no message and no commission is refused at the start', () => {
  const entry = taskOrThrow('message-from');
  const base = {
    bindingId: 'folder-1',
    branch: 'aflow/x',
    owner: 'aflowai',
    repo: 'aflow',
    base: 'main',
  };

  it('is refused at input validation, before the run exists, naming what to pass', () => {
    for (const change of [
      { patch: 'diff --git a/a b/a' },
      { baseSha: 'a'.repeat(40), mergeFrom: 'b'.repeat(40) },
      // A run id beside no `patchRef` has nothing its summary can be checked against.
      { patch: 'diff --git a/a b/a', commission: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
      {
        baseSha: 'a'.repeat(40),
        mergeFrom: 'b'.repeat(40),
        commission: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      },
    ]) {
      const result = validateParentTaskInputs(entry, { ...base, ...change }, wf.runInputs);
      expect(result.ok, JSON.stringify(change)).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toEqual([
        expect.objectContaining({ bindAs: 'commitMessage', code: 'MISSING_BINDAS' }),
      ]);
      const message = renderParentInputsValidationFailure(
        entry.taskId,
        result.issues,
        result.populatableBindAs,
      );
      expect(message).toContain('Cannot start');
      expect(message).toContain('`commitMessage`');
      expect(message).toContain('`patchRef`');
    }
  });

  it("starts with a message, with a commission's patchRef to take one from, or with nothing to commit", () => {
    for (const inputs of [
      { patch: 'diff --git a/a b/a', commitMessage: 'Fix\n\nWhy.' },
      { patchRef: 'gs://file-store/x/patch.json' },
      {
        patchRef: 'gs://file-store/x/patch.json',
        commission: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      },
      { patchRef: 'gs://file-store/x/patch.json', mergeFrom: 'b'.repeat(40) },
      { baseSha: 'a'.repeat(40) },
    ]) {
      expect(
        validateParentTaskInputs(entry, { ...base, ...inputs }, wf.runInputs).ok,
        JSON.stringify(inputs),
      ).toBe(true);
    }
  });

  it('is the entry task, so the start checks every input against it', () => {
    expect(
      selectFirstTaskForParentInputs(wf).ok && selectFirstTaskForParentInputs(wf),
    ).toMatchObject({
      task: { taskId: 'message-from' },
    });
    expect(runInputOrThrow('commitMessage').required).toBe(false);
    expect(runInputOrThrow('commitMessage').requiredWhen).toMatchObject({
      anyGiven: ['patch', 'mergeFrom'],
      noneGiven: ['patchRef'],
    });
  });
});

describe('Publish Local Changes — fix_before_merge hands the fix round its branch and base', () => {
  const MINOR: Finding = {
    severity: 'minor',
    file: 'src/a.ts',
    line: 3,
    claim: 'An edge is unhandled.',
    evidence: 'a.ts:3',
  };

  function keptLocal(commit: Record<string, unknown>): Outcome {
    return publish({
      pushApproval: 'unless-unreviewed',
      review: 'request_changes',
      decision: 'approved',
      findings: [MINOR],
      commit,
      inputs: { owner: 'aflowai', repo: 'aflow', base: 'main' },
    });
  }

  it('carries fixRound with the exact Commission Change inputs — base the branch — where the base has not moved', () => {
    const outcome = keptLocal({ ...COMMIT, baseMoved: false });
    expect(outcome.state['afterReview']).toBe('fix_before_merge');
    expect(outcome.state['pushDecision']).toBe('keep_local');
    expect(outcome.pushed).toBe(false);
    expect(outcome.state['fixRound']).toEqual({
      branch: COMMIT.branch,
      headSha: COMMIT.sha,
      baseMovedSince: false,
      reviewRunId: REVIEW_RUN_ID,
      findings: outcome.state['findings'],
      commissionInputs: { base: COMMIT.branch },
    });
    expect(outcome.ran).not.toContain('hand-fix-round-merging');
  });

  it('adds mergeFrom: origin/<base> to the Commission Change inputs where the base moved', () => {
    const outcome = keptLocal({ ...COMMIT, baseMoved: true });
    expect(outcome.state['fixRound']).toMatchObject({
      branch: COMMIT.branch,
      headSha: COMMIT.sha,
      baseMovedSince: true,
      reviewRunId: REVIEW_RUN_ID,
      commissionInputs: { base: COMMIT.branch, mergeFrom: 'origin/main' },
    });
    expect(outcome.ran).not.toContain('hand-fix-round');
  });

  it('hands Commission Change exactly the inputs its own base and mergeFrom take', () => {
    const commission = COMMISSION_CHANGE.bundle.workflow;
    for (const moved of [false, true]) {
      const { commissionInputs } = keptLocal({ ...COMMIT, baseMoved: moved }).state['fixRound'] as {
        commissionInputs: Record<string, unknown>;
      };
      for (const [id, value] of Object.entries(commissionInputs)) {
        const declared = commission.runInputs?.find((input) => input.id === id);
        expect(declared, id).toBeDefined();
        const validate = new AjvCtor({ strict: false }).compile(declared?.schema ?? {});
        expect(validate(value), `${id}=${String(value)}`).toBe(true);
      }
    }
  });

  it('records no fixRound where the branch was published', () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      commit: { ...COMMIT, baseMoved: true },
    });
    expect(outcome.pushed).toBe(true);
    expect(outcome.state['fixRound']).toBeUndefined();
  });
});

describe('Publish Local Changes — a review retried in place records its final verdict', () => {
  it('records approve where the review failed once and its retry in place approved', () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'failed',
      reviewNow: 'approve',
      decision: 'approved',
    });
    // The publication heard the first ending — no verdict — and asked.
    expect(outcome.outputs.get('review-commit')?.['verdict']).toBeNull();
    expect(outcome.asked).toBe(true);
    // Its output carries the review run's verdict as the run stands: its final attempt.
    expect(outcome.state['verdict']).toBe('approve');
    expect(outcome.inputs.get('read-review')).toEqual({ runId: REVIEW_RUN_ID, compact: true });
  });

  it('records the verdict a first pass returned exactly as a retry that returned it', () => {
    const first = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
    });
    expect(first.state['verdict']).toBe('approve');
  });

  it('records no verdict where the review run has not completed', () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'failed',
      decision: 'approved',
    });
    expect(outcome.state['verdict']).toBeNull();
  });

  it("reads the shepherd's verdict from the same task, which the run read re-projects from the review run", () => {
    const review = taskOrThrow('review-commit');
    // A retried review, read back through the publication's own projection.
    const firstEnding = projectTaskOutput(review.outputProjection ?? {}, reviewEnding('failed'), {
      inputs: { at: HEAD, from: ORIGIN_BASE },
    });
    expect(firstEnding.ok && firstEnding.value['outcome']).toBe('failed');
    expect(failedChildRunOf(review, firstEnding.ok ? firstEnding.value : null)).toBe(REVIEW_RUN_ID);
    const finalAttempt = taskOutputFromCompletedRun(
      review,
      firstEnding.ok ? firstEnding.value : {},
      {
        runId: REVIEW_RUN_ID,
        result: { output: { verdict: 'approve', reviewSummary: 'Read.', findings: [] } } as never,
      },
      { inputs: { at: HEAD, from: ORIGIN_BASE } },
    );
    expect(finalAttempt).toMatchObject({
      verdict: 'approve',
      outcome: 'completed',
      reviewRunId: REVIEW_RUN_ID,
      reviewed: { at: HEAD },
    });
  });
});

describe("Publish Local Changes — the repository and base are the folder's unless the caller names them", () => {
  /** A start naming only what the folder cannot say. */
  const MINIMAL = {
    bindingId: 'hb_aflow',
    patchRef: 'gs://file-store/x/patch.json',
    branch: 'aflow/x',
    baseSha: BASE,
    commitMessage: 'Fix the thing\n\nWhy it was broken.',
  };
  const TRUNK = { owner: 'aflowai', repo: 'aflow', defaultBranch: 'trunk' };

  function opened(inputs: Record<string, unknown>, folderOrigin?: Record<string, unknown> | null) {
    return publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      inputs,
      ...(folderOrigin !== undefined ? { folderOrigin } : {}),
    });
  }

  /** Where each task that names the repository or the base pointed. */
  function targets(outcome: Outcome) {
    const params = (taskId: string) =>
      (outcome.inputs.get(taskId)?.['params'] ?? {}) as Record<string, unknown>;
    const commit = outcome.inputs.get('commit')?.['commit'] as Record<string, unknown> | undefined;
    return {
      commitBase: commit?.['pushBase'],
      pushBase: outcome.inputs.get('push')?.['pushBase'],
      readRepository: params('read-repository'),
      findPr: params('find-pr'),
      openPr: params('open-pr'),
    };
  }

  it('starts with only the folder, the change, the branch, its base sha and the message', () => {
    const entry = taskOrThrow('message-from');
    const result = validateParentTaskInputs(entry, MINIMAL, wf.runInputs);
    expect(result.ok).toBe(true);
    for (const id of ['owner', 'repo', 'base']) {
      expect(runInputOrThrow(id).required, id).toBe(false);
      // A default would stand in for the folder's own branch, which is the guess this removes.
      expect((runInputOrThrow(id).schema as { default?: unknown }).default, id).toBeUndefined();
    }
  });

  it("opens the pull request in the folder's repository, against its default branch", () => {
    const outcome = opened(MINIMAL, TRUNK);
    expect(outcome.pushed).toBe(true);
    expect(outcome.ran).not.toContain('repository-unknown');
    expect(targets(outcome)).toEqual({
      commitBase: 'trunk',
      pushBase: 'trunk',
      readRepository: { owner: 'aflowai', repo: 'aflow' },
      findPr: {
        owner: 'aflowai',
        repo: 'aflow',
        head: 'aflowai:aflow/x',
        base: 'trunk',
        state: 'open',
      },
      openPr: expect.objectContaining({
        owner: 'aflowai',
        repo: 'aflow',
        body: expect.objectContaining({ head: 'aflow/x', base: 'trunk' }),
      }),
    });
    expect(outcome.state['prUrl']).toBe('https://github.com/aflowai/aflow/pull/7');
  });

  it("takes each of `owner`, `repo` and `base` the caller passes over the folder's", () => {
    const overridden = targets(
      opened({ ...MINIMAL, owner: 'fork-owner', repo: 'fork', base: 'release' }, TRUNK),
    );
    expect(overridden.commitBase).toBe('release');
    expect(overridden.pushBase).toBe('release');
    expect(overridden.readRepository).toEqual({ owner: 'fork-owner', repo: 'fork' });
    expect(overridden.openPr).toMatchObject({
      owner: 'fork-owner',
      repo: 'fork',
      body: { head: 'aflow/x', base: 'release' },
    });

    // One override alone leaves the other two the folder's.
    const baseOnly = targets(opened({ ...MINIMAL, base: 'release' }, TRUNK));
    expect(baseOnly.readRepository).toEqual({ owner: 'aflowai', repo: 'aflow' });
    expect(baseOnly.openPr).toMatchObject({ body: { base: 'release' } });
  });

  it('stops before committing where neither the caller nor the folder names them, saying what to pass', () => {
    for (const folderOrigin of [null, { owner: 'aflowai', repo: 'aflow' }]) {
      const outcome = opened(MINIMAL, folderOrigin);
      expect(outcome.ran, JSON.stringify(folderOrigin)).toContain('repository-unknown');
      expect(outcome.statuses.get('repository-unknown')).toBe('failed');
      expect(outcome.ran).not.toContain('commit');
      expect(outcome.pushed).toBe(false);
    }
    expect(taskOrThrow('repository-unknown').inputTemplate).toEqual({
      reason: REPOSITORY_UNKNOWN_FAILURE,
    });
    expect(REPOSITORY_UNKNOWN_FAILURE).toContain('Nothing was committed');
    expect(REPOSITORY_UNKNOWN_FAILURE).toContain('`owner` and `repo`');
    expect(REPOSITORY_UNKNOWN_FAILURE).toContain('`base` for the branch');

    // A folder off GitHub publishes once the caller names all three.
    const named = opened({ ...MINIMAL, owner: 'aflowai', repo: 'aflow', base: 'main' }, null);
    expect(named.ran).not.toContain('repository-unknown');
    expect(named.pushed).toBe(true);
  });
});
