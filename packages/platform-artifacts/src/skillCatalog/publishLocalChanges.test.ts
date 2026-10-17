import { describe, it, expect } from 'vitest';
import {
  computeReadyTasksWithWhen,
  computeRejectedApprovalSkipSet,
  materializeAndValidateSkillConfig,
  projectTaskOutput,
  resolvePromotedRunMetrics,
} from '@aflow/cybernetic-runtime';
import {
  HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_KEEP_AWAKE_DEFAULT,
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
  WorkflowRunStartInputSchema,
  WorkflowRunWakeupEnvelopeSchema,
  HostCommitDescribeInputSchema,
  HostCommitDescribeOutputSchema,
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  isEvalPlaneOperation,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  PAUSE_INSTRUCTION_MAX_CHARS,
  PullRequestFindingsSchema,
  PullRequestGapsSchema,
  RUN_PULL_REQUEST_URL_OUTPUT,
  substituteTemplateBinds,
  toJsonSchemaSync,
} from '@aflow/schemas';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import {
  AFTER_CHECK_QUESTION,
  AFTER_REVIEW_QUESTION,
  FIX_CHECKS_BRIEF_LEAD,
  FIX_FINDINGS_BRIEF_LEAD,
  type AfterCheckRoute,
  AFTER_REVIEW_ROUTES,
  type AfterReviewRoute,
} from './publishLocalChangesDecisions.js';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';

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

  it('is twenty tasks — commit, check, what follows a failed check, scan, what decides the approval, the review and what follows its findings, the pull request composed, approve, push, the pull request found, rewritten or opened, and a fix round and its publication', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual([
      'commit',
      'check-commit',
      'decide-after-check',
      'checks-failed',
      'recheck-commit',
      'scan-commit',
      'read-repository',
      'read-push-approval',
      'review-commit',
      'decide-after-review',
      'describe-pr',
      'approve-push',
      'push',
      'find-pr',
      'update-pr',
      'open-pr',
      'fix-checks',
      'republish-after-checks',
      'fix-findings',
      'republish-after-findings',
    ]);
    expect(wf.tasks.filter((t) => t.type !== 'operation').map((t) => t.taskId)).toEqual([
      'approve-push',
    ]);
    expect(Object.fromEntries(wf.tasks.map((t) => [t.taskId, t.dependsOn ?? []]))).toEqual({
      commit: [],
      'check-commit': ['commit'],
      'decide-after-check': ['check-commit'],
      'checks-failed': ['check-commit', 'decide-after-check'],
      'recheck-commit': ['commit', 'check-commit', 'decide-after-check'],
      'scan-commit': ['commit', 'check-commit', 'recheck-commit'],
      'read-repository': ['commit', 'check-commit', 'recheck-commit'],
      'read-push-approval': ['commit', 'scan-commit'],
      'review-commit': ['read-push-approval', 'scan-commit'],
      'decide-after-review': ['review-commit'],
      'describe-pr': ['commit', 'check-commit', 'recheck-commit', 'scan-commit', 'review-commit'],
      'approve-push': ['read-repository', 'scan-commit', 'review-commit'],
      push: ['approve-push', 'scan-commit', 'check-commit', 'recheck-commit', 'describe-pr'],
      'find-pr': ['push'],
      'update-pr': ['find-pr', 'describe-pr'],
      'open-pr': ['find-pr', 'describe-pr'],
      'fix-checks': ['commit', 'check-commit', 'decide-after-check'],
      'republish-after-checks': ['fix-checks'],
      // After the approval and the push, both: no commission while the
      // operator has yet to answer, and no fix published where this did not go.
      'fix-findings': ['commit', 'review-commit', 'decide-after-review', 'approve-push', 'push'],
      'republish-after-findings': ['fix-findings', 'approve-push', 'push'],
    });
    expect(Object.fromEntries(wf.tasks.map((t) => [t.taskId, t.operation]))).toEqual({
      commit: 'host.file.patch',
      'check-commit': 'host.commit.check',
      'decide-after-check': 'ai.decision.decide',
      'checks-failed': 'workflow.run.fail',
      'recheck-commit': 'host.commit.check',
      'scan-commit': 'host.commit.scan',
      'read-repository': 'api.http.call',
      'read-push-approval': 'host.binding.inspect',
      'review-commit': 'workflow.run.start',
      'decide-after-review': 'ai.decision.decide',
      'describe-pr': 'host.commit.describe',
      'approve-push': undefined,
      push: 'host.process.exec',
      'find-pr': 'api.http.call',
      'update-pr': 'api.http.call',
      'open-pr': 'api.http.call',
      'fix-checks': 'workflow.run.start',
      'fix-findings': 'workflow.run.start',
      'republish-after-checks': 'workflow.run.start',
      'republish-after-findings': 'workflow.run.start',
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
      owner: { kind: 'run_input', path: 'owner' },
      repo: { kind: 'run_input', path: 'repo' },
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
      PUBLISH_LOCAL_CHANGES.description,
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
        message: { $bind: 'commitMessage' },
        baseSha: { $bind: 'baseSha' },
        mergeFrom: { $bind: 'mergeFrom' },
        pushBase: { $bind: 'base' },
      },
    });
    expect(commit.inputBindings?.['base']).toEqual({ kind: 'run_input', path: 'base' });
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
    expect(taskOrThrow('commit').inputContract?.bindings['baseSha']?.schema).toEqual(
      baseSha?.schema,
    );
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'a branch is reused only that way, and a fresh change takes a fresh branch',
    );
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
    expect(commit.inputContract?.bindings['mergeFrom']?.schema).toEqual(mergeFrom?.schema);
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'is commissioned with `mergeFrom: origin/<base>` as well',
    );
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
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
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'it is published with `mergeFrom` and neither `patchRef` nor `patch`',
    );

    const runInput = (id: string) => (wf.runInputs ?? []).find((i) => i.id === id);
    expect(runInput('patchRef')?.required).toBe(false);
    expect(runInput('patch')?.required).toBe(false);
    for (const id of ['patchRef', 'patch']) {
      expect(commit.inputContract?.bindings[id]?.schema, id).toEqual(runInput(id)?.schema);
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
    expect(PUBLISH_LOCAL_CHANGES.description).toContain("Never pass a commission's `patch` text.");
  });

  it('takes the owner and the repository as names, never a URL or `owner/repo`', () => {
    const entry = taskOrThrow('commit').inputContract?.bindings ?? {};
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
      base: { kind: 'run_input', path: 'base' },
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
      expression: 'tasks.push.output.exitCode == 0',
      onMissingRef: 'skip',
    });
    expect(openPr.when).toEqual({
      expression: 'tasks.find-pr.output.prNumber == null',
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
    // A fix round's publication reports its pull request as this run's: the
    // same branch, so the same pull request, and it comes later in the list
    // so its value is the one the run keeps.
    expect(promoters.map((task) => task.taskId).sort()).toEqual([
      'find-pr',
      'open-pr',
      'republish-after-checks',
      'republish-after-findings',
    ]);
    const order = wf.tasks.map((task) => task.taskId);
    for (const republish of ['republish-after-checks', 'republish-after-findings']) {
      expect(order.indexOf(republish)).toBeGreaterThan(order.indexOf('open-pr'));
    }
    expect(
      wf.stateVariables.find((v) => v.variableId === RUN_PULL_REQUEST_URL_OUTPUT)?.sensitive,
    ).toBe(false);
  });

  it("asks GitHub for the branch's open pull request by `owner:branch` and the base", () => {
    const findPr = taskOrThrow('find-pr');
    const template = findPr.inputTemplate;
    if (template === undefined) throw new Error('find-pr must carry a template');
    const declared = new Set(Object.keys(findPr.inputBindings ?? {}));
    expect(findPr.inputBindings?.['base']).toEqual({ kind: 'run_input', path: 'base' });
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
    expect(required).toEqual(['bindingId', 'branch', 'owner', 'repo', 'base']);
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
    runId: 'review-run',
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

/**
 * What a decision model answers, scripted: a choice and its confidence, or
 * `unavailable` — no decision model bound, a provider refusing — which fails
 * the decision step.
 */
type Choice<Route extends string> = { value: Route; confidence: number } | 'unavailable';

/** A choice answered as `ai.decision.decide` returns it, decided by the question's own bar. */
function choiceOutput(
  name: string,
  minConfidence: number,
  choice: { value: string; confidence: number },
): Record<string, unknown> {
  return {
    answers: {
      [name]: {
        type: 'choice',
        value: choice.value,
        decidedValue: choice.confidence >= minConfidence ? choice.value : null,
        confidence: choice.confidence,
        probabilities: { [choice.value]: choice.confidence },
        decided: choice.confidence >= minConfidence,
      },
    },
    model: 'jev-1.13.0',
    usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    latencyMs: 40,
  };
}

/** The patch a fix round's commission returns, and the base it reports: this run's commit. */
const FIX_PATCH_REF = 'payload:fix-patch';

/** A run a task started and waited on, ending as `output` says, or failing. */
function runEnding(
  runId: string,
  output: Record<string, unknown> | 'failed' | 'cancelled' | 'paused',
) {
  const ended = typeof output === 'string';
  return WorkflowRunWakeupEnvelopeSchema.parse({
    runId,
    outcome: ended ? output : 'completed',
    waiterId: `waiter-${runId}`,
    ...(ended ? {} : { result: { output } }),
  });
}

/** The pull request the publication of a fix ends with. */
const FIX_PR = { prUrl: 'https://github.com/aflowai/aflow/pull/9', prNumber: 9 };

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
/** The decision after a run lost only to time, sure of it. */
const RECHECK = { value: 'recheck_on_timeout', confidence: 0.95 } as const;
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
        clearedOrRetriableSha: HEAD,
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
        clearedOrRetriableSha: HEAD,
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
        clearedOrRetriableSha: HEAD,
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
  /** What the decision after a failed check answers; absent is `unavailable`. */
  afterCheck?: Choice<AfterCheckRoute>;
  /** The findings a completed review returns; absent is none. */
  findings?: readonly Finding[];
  /** What the decision on a fix round answers; absent is `unavailable`. */
  afterReview?: Choice<AfterReviewRoute>;
  /** How a fix round's commission ends: with a change, with none, or failed; absent is a change. */
  commission?: 'patch' | 'no-change' | 'failed';
  /**
   * How the publication of the fix ends: pushed with its pull request, its push
   * declined (completed with none), stopped at its approval, or failed;
   * absent is pushed.
   */
  republished?: 'pushed' | 'declined' | 'paused' | 'failed';
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
 * host executor's own tests prove: the title given or the slice's, and a body
 * naming the range it was composed from, so a test can tell whose it is.
 */
function describedPullRequest(input: Record<string, unknown>): Record<string, unknown> {
  const { title, summary, range } = input;
  return HostCommitDescribeOutputSchema.parse({
    title: typeof title === 'string' ? title : SLICE_TITLE,
    body: typeof summary === 'string' ? summary : `Composed from \`${String(range)}\`.`,
    commits: [{ sha: HEAD, subject: SLICE_TITLE }],
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
                checksTimeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
              },
            }),
      });
    case 'review-commit':
      if (scenario.review === 'not-started')
        throw new Error('a review that did not start has no output');
      return reviewEnding(scenario.review, scenario.findings);
    case 'decide-after-check':
      if (scenario.afterCheck === undefined || scenario.afterCheck === 'unavailable') return {};
      return choiceOutput('next_step', AFTER_CHECK_QUESTION.minConfidence, scenario.afterCheck);
    case 'decide-after-review':
      if (scenario.afterReview === undefined || scenario.afterReview === 'unavailable') return {};
      return choiceOutput(
        'after_review',
        AFTER_REVIEW_QUESTION.minConfidence,
        scenario.afterReview,
      );
    case 'fix-checks':
    case 'fix-findings':
      return runEnding(
        `commission-${taskId}`,
        scenario.commission === 'failed'
          ? 'failed'
          : scenario.commission === 'no-change'
            ? { baseSha: HEAD }
            : { patchRef: FIX_PATCH_REF, baseSha: HEAD },
      );
    case 'republish-after-checks':
    case 'republish-after-findings': {
      const ending = scenario.republished ?? 'pushed';
      return runEnding(
        `publication-${taskId}`,
        ending === 'pushed' ? FIX_PR : ending === 'declined' ? {} : ending,
      );
    }
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

/** A dot path into a task's output, as a binding reads it. */
function readOutput(
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  taskId: string,
  path: string | undefined,
): unknown {
  let value: unknown = outputs.get(taskId);
  for (const key of path?.split('.') ?? []) {
    value =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

/** The run's own inputs, as a publication is started with them. */
const RUN_INPUTS: Readonly<Record<string, unknown>> = {
  bindingId: 'folder-1',
  branch: 'aflow/x',
  base: 'main',
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
      // A decision that could not be made fails its step, as the executor does.
      if (
        (task.taskId === 'decide-after-check' &&
          (scenario.afterCheck ?? 'unavailable') === 'unavailable') ||
        (task.taskId === 'decide-after-review' &&
          (scenario.afterReview ?? 'unavailable') === 'unavailable')
      ) {
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
          const projected = projectTaskOutput(task.outputProjection, raw, null);
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
        const asks = pushApproval === 'always' || (reviewed && review !== 'approve');
        const pushes = asks ? decision === 'approved' : true;
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

  it('pushes without asking on `approve` alone, and asks on `comment` as on `request_changes`', () => {
    for (const review of ['comment', 'request_changes'] as const) {
      const outcome = publish({ pushApproval: 'unless-unreviewed', review, decision: 'declined' });
      expect(outcome).toMatchObject({ asked: true, pushed: false });
    }
    const approved = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'declined',
    });
    expect(approved).toMatchObject({ asked: false, pushed: true });
    expect(approved.ran).not.toContain('approve-push');

    expect(taskOrThrow('approve-push').when).toEqual({
      anyOf: [
        "tasks.read-push-approval.output.branchPolicy.pushApproval == 'always'",
        "tasks.review-commit.output.verdict != 'approve'",
        "tasks.review-commit.status == 'failed'",
        'tasks.scan-commit.output.clean == false',
      ],
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
      expect(existing.state).toEqual({
        prUrl: 'https://github.com/aflowai/aflow/pull/5',
        prNumber: 5,
      });

      const fresh = publish({ pushApproval, review: 'approve', decision: 'approved' });
      expect(fresh.ran.indexOf('find-pr')).toBeLessThan(fresh.ran.indexOf('open-pr'));
      expect(fresh.state).toEqual({
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
      expect(elsewhere.state).toEqual({
        prUrl: 'https://github.com/aflowai/aflow/pull/7',
        prNumber: 7,
      });
    }
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
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
      review: 'request_changes',
      decision: 'approved',
    });
    expect(ran.indexOf('commit')).toBeLessThan(ran.indexOf('review-commit'));
    expect(ran.indexOf('review-commit')).toBeLessThan(ran.indexOf('approve-push'));
  });

  it('reads no verdict from a review that did not complete, whatever it promoted', () => {
    // The waiter hands a task the run's output only when the run completed; a
    // failed, cancelled or paused child's verdict therefore reads null, and
    // null is not `approve`.
    const review = taskOrThrow('review-commit');
    if (review.outputProjection === undefined) throw new Error('the review must project');
    for (const outcome of ['failed', 'cancelled', 'paused'] as const) {
      const projected = projectTaskOutput(review.outputProjection, reviewEnding(outcome), null);
      expect(projected).toEqual({
        ok: true,
        value: {
          verdict: null,
          reviewSummary: null,
          findings: null,
          outcome,
          reviewRunId: 'review-run',
        },
      });
    }
    const approved = projectTaskOutput(review.outputProjection, reviewEnding('approve'), null);
    expect(approved).toEqual({
      ok: true,
      value: {
        verdict: 'approve',
        reviewSummary: 'Read.',
        findings: [],
        outcome: 'completed',
        reviewRunId: 'review-run',
      },
    });
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
    expect(outcome).toMatchObject({ asked: false, pushed: false, ran: ['commit'], state: {} });
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
      range: { kind: 'task_output', taskId: 'commit', path: 'commit.pushRange' },
    });
    expect(review.inputBindings?.['range']).toEqual(
      taskOrThrow('scan-commit').inputBindings?.['range'],
    );
    const declared = new Set(Object.keys(review.inputBindings ?? {}));
    const start = substituteTemplateBinds(
      template,
      { bindingId: 'folder-1', range: COMMIT.pushRange },
      declared,
    );
    // Named by its catalog entry, so a space workflow merely holding the slug
    // is refused rather than trusted to decide the approval.
    expect(WorkflowRunStartInputSchema.parse(start)).toMatchObject({
      slug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug,
      catalogId: REVIEW_LOCAL_CHANGES.catalogId,
      inputs: { bindingId: 'folder-1', range: `${ORIGIN_BASE}..${HEAD}`, depth: 'standard' },
      wait: 'until_complete',
    });
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

  it('says which case it is asking in, a line each, and where the verdict is', () => {
    const lines = (taskOrThrow('approve-push').pauseInstruction ?? '').split('\n');
    expect(lines).toContain(
      "- `always`: the folder's push approval asks before every push, and no review ran.",
    );
    const reviewed = lines.find((line) => line.startsWith('- `unless-unreviewed`:'));
    expect(reviewed).toContain(
      "this run's Local Code Review of `pushRange` did not return `approve`",
    );
    expect(reviewed).toContain('its verdict is on the "Review the commit" task');
    expect(taskOrThrow('review-commit').name).toBe('Review the commit');
  });

  it('names the three postures and the default in its description, and why it is the default', () => {
    expect(HOST_PUSH_APPROVAL_DEFAULT).toBe('unless-unreviewed');
    for (const phrase of [
      '`always`',
      '`never`',
      '`unless-unreviewed`',
      'is `unless-unreviewed`, the default',
    ]) {
      expect(PUBLISH_LOCAL_CHANGES.description).toContain(phrase);
    }
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      "Whatever the posture, the run scans every line the push would add, the headers and message of every commit it carries, and the pull request's title and summary for secrets before any of this, and a finding stops it with nothing pushed — which is what lets a review stand in for the operator.",
    );
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
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
    const { ran } = publish({
      pushApproval: 'unless-unreviewed',
      review: 'request_changes',
      decision: 'approved',
    });
    expect(ran.indexOf('commit')).toBeLessThan(ran.indexOf('scan-commit'));
    for (const later of ['review-commit', 'approve-push', 'push']) {
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
    // Each line but the first can hold only where the approval did not ask.
    expect(taskOrThrow('push').when).toEqual({
      anyOf: [
        "tasks.approve-push.output.decision == 'approved'",
        "tasks.read-push-approval.output.branchPolicy.pushApproval == 'never'",
        "tasks.review-commit.output.verdict == 'approve'",
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
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'report the files, commit headers and messages, title or summary, lines and rules it names — never ask for or repeat the value',
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
      expect(ran.slice(-3)).toEqual(['push', 'find-pr', 'open-pr']);
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
      expect(outcome.ran.slice(-3)).toEqual(['push', 'find-pr', 'open-pr']);
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
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'A refused push leaves the commit on its branch: report its message and the remedy the run names.',
    );
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
    expect(PUBLISH_LOCAL_CHANGES.description).toContain('**A branch as it stands**');
  });

  it('runs check, scan, review and push on the branch head, with no patch input', () => {
    const outcome = publish({
      pushApproval: 'unless-unreviewed',
      review: 'approve',
      decision: 'approved',
      asItStands: true,
    });
    expect(outcome.ran).toEqual([
      'commit',
      'check-commit',
      'scan-commit',
      'read-repository',
      'read-push-approval',
      'review-commit',
      'describe-pr',
      'push',
      'find-pr',
      'open-pr',
    ]);
    expect(outcome.pushed).toBe(true);
    expect(outcome.asked).toBe(false);

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
      inputs: { range: `${ORIGIN_BASE}..${STRANDED}` },
    });
    expect((outcome.inputs.get('push')?.['command'] as string[] | undefined)?.at(-1)).toBe(
      `${STRANDED}:refs/heads/aflow/x`,
    );
    expect(outcome.inputs.get('describe-pr')).toMatchObject({
      range: `${ORIGIN_BASE}..${STRANDED}`,
    });
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

  it('records every ending of the first run, so what follows a failure is decided — and fails at the second', () => {
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
        afterCheck: RECHECK,
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
        afterCheck: RECHECK,
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
        "Run the folder's checks again, after they ran out of time",
      );
    });

    for (const recheck of ['test-timeouts', 'failed', 'timed-out'] as const) {
      it(`is run exactly once: a second run that ${recheck === 'test-timeouts' ? 'loses to time again' : recheck === 'failed' ? 'fails' : 'runs out of the folder’s time'} fails the publication with nothing later run`, () => {
        const outcome = publish({
          pushApproval: 'never',
          review: 'approve',
          decision: 'approved',
          check: 'test-timeouts',
          afterCheck: RECHECK,
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

    it('says on the second run’s failure that it was the second', () => {
      const failure = taskOrThrow('recheck-commit').failureInstruction ?? '';
      expect(failure).toContain('Nothing was scanned, reviewed or pushed');
      expect(failure).toContain('this second run failed as well');
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
    const failure = taskOrThrow('check-commit').failureInstruction ?? '';
    expect(failure).toContain('Nothing was scanned, reviewed or pushed');
    expect(failure).toContain('`checksTimeoutMs`');
  });

  it("says in its description that the folder's checks run first, and that the pull request's remain the proof", () => {
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'run in a checkout of the commit before the scan, and nothing is scanned, reviewed or pushed until they pass',
    );
    // What a failed check leads to is the run's own decision, and an unsure one stops it.
    expect(PUBLISH_LOCAL_CHANGES.description).toContain('or a stop, as an unsure decision is.');
    expect(PUBLISH_LOCAL_CHANGES.description).toContain('No decision clears or holds a push.');
    expect(PUBLISH_LOCAL_CHANGES.description).toContain('the push needs their passing receipt.');
    expect(PUBLISH_LOCAL_CHANGES.description).toContain('A folder that declares none runs none.');
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
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
      afterCheck: RECHECK,
    });
    const described = describedWith(outcome);
    expect(described.check?.passed).toBe(false);
    expect(described.recheck).toMatchObject({ passed: true });
    // Under `never` no review runs, and the composition is told none did.
    expect(described.review).toBeUndefined();

    const failed = describedWith(
      publish({ pushApproval: 'unless-unreviewed', review: 'failed', decision: 'approved' }),
    );
    expect(failed.review).toEqual({ verdict: null, outcome: 'failed', reviewSummary: null });
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

// ── What follows a failed check, decided by the skill ──────────────────────

describe('Publish Local Changes — a failed check is decided on, not handed to a conversation', () => {
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
  const FIX_ROUND = ['fix-checks', 'republish-after-checks'];

  function failedWith(afterCheck: Choice<AfterCheckRoute>, extra: Partial<Scenario> = {}): Outcome {
    return publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      check: 'failed',
      afterCheck,
      inputs: { owner: 'aflowai', repo: 'aflow' },
      ...extra,
    });
  }

  it("asks one choice of the three routes, over the checks' own account, and only when they did not pass", () => {
    const decide = taskOrThrow('decide-after-check');
    const questions = (decide.inputTemplate as { questions: Record<string, { options: object }> })
      .questions;
    expect(Object.keys(questions)).toEqual(['next_step']);
    expect(Object.keys(questions['next_step']?.options ?? {})).toEqual([
      'recheck_on_timeout',
      'fix_commission',
      'operator_install_mismatch',
    ]);
    // Never a failure of test timeouts alone: today's rule reruns those.
    expect(decide.when).toEqual({
      allOf: [
        'tasks.check-commit.output.passed == false',
        'tasks.check-commit.output.testTimeouts == null',
      ],
      onMissingRef: 'skip',
    });
    const outcome = failedWith({ value: 'fix_commission', confidence: 0.95 });
    expect(outcome.inputs.get('decide-after-check')?.['state']).toEqual({
      summary: checkResult('failed')['summary'],
      tail: CHECK_TAIL,
      failingGuard: null,
      timedOut: null,
      testTimeouts: null,
    });
    for (const check of ['passed', 'skipped'] as const) {
      expect(failedWith(RECHECK, { check }).ran, check).not.toContain('decide-after-check');
    }
  });

  it('recheck_on_timeout: runs the checks once more, and pushes only on that run passing', () => {
    const passes = failedWith(RECHECK, { check: 'timed-out' });
    expect(passes.ran).toContain('recheck-commit');
    expect(passes.pushed).toBe(true);
    expect(passes.inputs.get('push')?.['check']).toEqual({ receipt: CHECK_RECEIPT.passed });
    for (const id of [...FIX_ROUND, 'checks-failed']) expect(passes.ran, id).not.toContain(id);

    const failsAgain = failedWith(RECHECK, { check: 'timed-out', recheck: 'failed' });
    expect(failsAgain.statuses.get('recheck-commit')).toBe('failed');
    for (const id of CLEARED_ONLY) expect(failsAgain.ran, id).not.toContain(id);
  });

  it("fix_commission: commissions the fix on this commit, briefed from the checks' account alone, then publishes the branch again", () => {
    const outcome = failedWith({ value: 'fix_commission', confidence: 0.95 });
    expect(outcome.ran).toEqual(expect.arrayContaining(FIX_ROUND));
    // Nothing of this commit leaves the machine from this run: the
    // republication checks, scans, reviews and pushes it as any publication does.
    for (const id of [...CLEARED_ONLY, 'recheck-commit', 'checks-failed']) {
      expect(outcome.ran, id).not.toContain(id);
    }
    const commission = WorkflowRunStartInputSchema.parse(outcome.inputs.get('fix-checks'));
    expect(commission).toMatchObject({
      slug: 'commission-change',
      catalogId: 'commission-change',
      wait: 'until_complete',
    });
    // The brief is the fixed lead and the checks' own summary — which names
    // the failing step and carries the tail — and nothing a model wrote.
    expect(commission.inputs).toEqual({
      bindingId: 'folder-1',
      task: `${FIX_CHECKS_BRIEF_LEAD}${String(checkResult('failed')['summary'])}`,
      base: HEAD,
    });
    expect(String(commission.inputs?.['task'])).toContain(CHECK_TAIL);

    const republish = WorkflowRunStartInputSchema.parse(
      outcome.inputs.get('republish-after-checks'),
    );
    expect(republish).toMatchObject({
      slug: 'publish-local-changes',
      catalogId: 'publish-local-changes',
      wait: 'until_complete',
    });
    // Appended to this branch at this commit, which is what the commission was made against.
    expect(republish.inputs).toMatchObject({
      bindingId: 'folder-1',
      branch: 'aflow/x',
      base: 'main',
      owner: 'aflowai',
      repo: 'aflow',
      patchRef: FIX_PATCH_REF,
      baseSha: HEAD,
    });
    // The commit names the round it came from: its commission's run and this commit.
    expect(republish.inputs?.['commitMessage']).toBe(
      `Make the folder's checks pass\n\nThe fix commission commission-fix-checks made from what the folder's checks printed when they failed on ${HEAD}.`,
    );
    expect(outcome.state['prUrl']).toBe(FIX_PR.prUrl);
  });

  it('names the failing step in the brief where the checks named one', () => {
    const summary = 'node scripts/verify-commit.mjs exited 1: the check failed at `eslint`.';
    const brief = substituteTemplateBinds(
      taskOrThrow('fix-checks').inputTemplate ?? {},
      { bindingId: 'folder-1', commitSha: HEAD, summary },
      new Set(Object.keys(taskOrThrow('fix-checks').inputBindings ?? {})),
    );
    expect((brief['inputs'] as { task: string }).task).toBe(`${FIX_CHECKS_BRIEF_LEAD}${summary}`);
  });

  for (const republished of ['declined', 'paused', 'failed'] as const) {
    it(`fix_commission: a publication of the fix that ${republished === 'declined' ? 'had its push declined' : republished === 'paused' ? 'stopped at its approval' : 'failed'} fails this run, reporting no pull request`, () => {
      const outcome = failedWith({ value: 'fix_commission', confidence: 0.95 }, { republished });
      expect(outcome.statuses.get('republish-after-checks')).toBe('failed');
      expect(outcome.state['prUrl']).toBeUndefined();
      expect(outcome.state['prNumber']).toBeUndefined();
    });
  }

  for (const ending of ['no-change', 'failed'] as const) {
    it(`fix_commission: a commission that ${ending === 'failed' ? 'fails' : 'returns no change'} fails the publication, and nothing is published again`, () => {
      const outcome = failedWith(
        { value: 'fix_commission', confidence: 0.95 },
        { commission: ending },
      );
      expect(outcome.statuses.get('fix-checks')).toBe('failed');
      expect(outcome.ran).not.toContain('republish-after-checks');
      expect(outcome.pushed).toBe(false);
      expect(taskOrThrow('fix-checks').failureInstruction).toContain(
        'Nothing was scanned, reviewed or pushed',
      );
    });
  }

  const STOPS: Array<[string, Choice<AfterCheckRoute>]> = [
    ['operator_install_mismatch', { value: 'operator_install_mismatch', confidence: 0.95 }],
    ['an undecided fix_commission', { value: 'fix_commission', confidence: 0.79 }],
    ['an undecided recheck_on_timeout', { value: 'recheck_on_timeout', confidence: 0.5 }],
    ['no decision at all', 'unavailable'],
  ];
  for (const [label, afterCheck] of STOPS) {
    it(`${label}: fails the publication as a failed check always did, with the checks' account as the reason`, () => {
      const outcome = failedWith(afterCheck);
      expect(outcome.statuses.get('checks-failed')).toBe('failed');
      expect(outcome.inputs.get('checks-failed')).toEqual({
        reason: checkResult('failed')['summary'],
      });
      for (const id of [...CLEARED_ONLY, ...FIX_ROUND, 'recheck-commit']) {
        expect(outcome.ran, id).not.toContain(id);
      }
      expect(outcome.pushed).toBe(false);
      expect(outcome.state['prUrl']).toBeUndefined();
    });
  }

  it('fails with the same instruction a failed check always carried', () => {
    const stop = taskOrThrow('checks-failed');
    expect(stop.failureInstruction).toBe(taskOrThrow('check-commit').failureInstruction);
    expect(stop.optional).not.toBe(true);
    // The decision is optional so that its own failure is a route, not the run's end.
    expect(taskOrThrow('decide-after-check').optional).toBe(true);
  });

  // Today's rule, whatever model the space has: the checks reported that
  // nothing failed but tests running out of their time.
  for (const afterCheck of [
    'unavailable',
    { value: 'fix_commission', confidence: 0.99 },
  ] as const) {
    it(`test timeouts alone: reruns the checks by today's rule ${afterCheck === 'unavailable' ? 'where no decision can be made' : 'and asks no decision beside it'}, and pushes on that run`, () => {
      const outcome = failedWith(afterCheck, { check: 'test-timeouts' });
      expect(outcome.ran).not.toContain('decide-after-check');
      expect(outcome.ran).toContain('recheck-commit');
      for (const id of [...FIX_ROUND, 'checks-failed']) expect(outcome.ran, id).not.toContain(id);
      expect(outcome.pushed).toBe(true);
      expect(outcome.inputs.get('push')?.['check']).toEqual({ receipt: CHECK_RECEIPT.passed });
    });
  }

  it("the folder's time running out, with no decision possible, fails as it always did", () => {
    const outcome = failedWith('unavailable', { check: 'timed-out' });
    expect(outcome.statuses.get('decide-after-check')).toBe('failed');
    expect(outcome.ran).not.toContain('recheck-commit');
    expect(outcome.statuses.get('checks-failed')).toBe('failed');
    expect(outcome.pushed).toBe(false);
  });

  it('routes on the answer only where it cleared the bar: one comparison, never value and decided apart', () => {
    for (const id of ['recheck-commit', 'fix-checks']) {
      const when = JSON.stringify(taskOrThrow(id).when);
      expect(when, id).toContain('tasks.decide-after-check.output.nextStep ==');
      expect(when, id).not.toContain('decided');
    }
    const decide = taskOrThrow('decide-after-check');
    expect(decide.outputProjection?.['nextStep']).toEqual({
      path: 'answers.next_step.decidedValue',
      onMissing: 'error',
    });
  });

  it('abstains below the bar the question sets, whatever it chose', () => {
    expect(AFTER_CHECK_QUESTION.minConfidence).toBeGreaterThanOrEqual(0.8);
    const at = failedWith({
      value: 'fix_commission',
      confidence: AFTER_CHECK_QUESTION.minConfidence,
    });
    expect(at.ran).toContain('fix-checks');
    const below = failedWith({
      value: 'fix_commission',
      confidence: AFTER_CHECK_QUESTION.minConfidence - 0.01,
    });
    expect(below.ran).not.toContain('fix-checks');
    expect(below.ran).toContain('checks-failed');
  });
});

// ── Whether a review's findings take a fix round, decided by the skill ─────

describe("Publish Local Changes — whether a review's findings take a fix round is decided once, over all of them", () => {
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
  const RACE: Finding = {
    severity: 'blocker',
    file: 'src/lock.ts',
    line: 12,
    claim: 'Two writers can both take the lock.',
    evidence: 'The check and the set are two calls.',
  };
  const FINDINGS = [LEAK, NAME, RACE];
  const FIX = { value: 'fix_before_merge', confidence: 0.95 } as const;
  const FIX_ROUND = ['fix-findings', 'republish-after-findings'];

  function reviewedWith(extra: Partial<Scenario>): Outcome {
    return publish({
      pushApproval: 'unless-unreviewed',
      review: 'request_changes',
      decision: 'approved',
      findings: FINDINGS,
      inputs: { owner: 'aflowai', repo: 'aflow' },
      ...extra,
    });
  }

  /** Whether the push and its approval went as they would with no decision at all. */
  function gateAsBefore(outcome: Outcome, scenario: Partial<Scenario>): void {
    const without = publish({
      pushApproval: 'unless-unreviewed',
      review: 'request_changes',
      decision: 'approved',
      inputs: { owner: 'aflowai', repo: 'aflow' },
      ...scenario,
      findings: [],
    });
    expect(outcome.asked).toBe(without.asked);
    expect(outcome.pushed).toBe(without.pushed);
  }

  it('asks one choice over every finding the review returned, and judges none of them apart', () => {
    const outcome = reviewedWith({ afterReview: FIX });
    const asked = outcome.inputs.get('decide-after-review') as {
      state: { findings: unknown };
      questions: Record<string, unknown>;
      each?: unknown;
    };
    expect(asked.state.findings).toEqual(FINDINGS);
    expect(Object.keys(asked.questions)).toEqual(['after_review']);
    expect(asked.each).toBeUndefined();
    expect(AFTER_REVIEW_QUESTION.minConfidence).toBe(0.8);
  });

  it('fix_before_merge: commissions the fix only once the operator approved and this run pushed', () => {
    const outcome = reviewedWith({ afterReview: FIX });
    expect(outcome.asked).toBe(true);
    expect(outcome.pushed).toBe(true);
    expect(outcome.ran.indexOf('fix-findings')).toBeGreaterThan(
      outcome.ran.indexOf('approve-push'),
    );
    expect(outcome.ran.indexOf('fix-findings')).toBeGreaterThan(outcome.ran.indexOf('push'));
    gateAsBefore(outcome, {});
  });

  it('fix_before_merge: briefs the commission with every finding, as the review reported them', () => {
    const outcome = reviewedWith({ afterReview: FIX });
    const commission = WorkflowRunStartInputSchema.parse(outcome.inputs.get('fix-findings'));
    expect(commission).toMatchObject({ slug: 'commission-change', catalogId: 'commission-change' });
    expect(commission.inputs).toEqual({
      bindingId: 'folder-1',
      task: `${FIX_FINDINGS_BRIEF_LEAD}${summaryOf(FINDINGS)}`,
      base: HEAD,
    });
    for (const finding of FINDINGS) {
      expect(String(commission.inputs?.['task']), finding.claim).toContain(finding.claim);
    }
  });

  it('fix_before_merge: publishes the fix after this run pushed, appended at this commit', () => {
    const outcome = reviewedWith({ afterReview: FIX });
    expect(outcome.ran.indexOf('republish-after-findings')).toBeGreaterThan(
      outcome.ran.indexOf('push'),
    );
    const republish = WorkflowRunStartInputSchema.parse(
      outcome.inputs.get('republish-after-findings'),
    );
    expect(republish).toMatchObject({
      slug: 'publish-local-changes',
      catalogId: 'publish-local-changes',
    });
    expect(republish.inputs).toMatchObject({
      branch: 'aflow/x',
      patchRef: FIX_PATCH_REF,
      baseSha: HEAD,
    });
    expect(String(republish.inputs?.['commitMessage'])).toMatch(
      /^Fix the review's findings\n\nThe fix commission commission-fix-findings made /,
    );
    expect(outcome.state['prUrl']).toBe(FIX_PR.prUrl);
  });

  // A decline pushes nothing, whatever the posture and however it is recorded:
  // skipped, as the harness does, or as the answer itself, which leaves the
  // push to refuse on its own predicate.
  for (const declineAs of ['skip', 'answer'] as const) {
    for (const pushApproval of ['always', 'unless-unreviewed', 'never'] as const) {
      // Only `unless-unreviewed` reviews, so only there is a fix round decided;
      // under the others the invariant is the same with nothing to hold back.
      it(`a decline recorded as ${declineAs === 'skip' ? 'a skip' : 'an answer'} under \`${pushApproval}\` pushes nothing, commissions nothing and publishes nothing`, () => {
        const outcome = reviewedWith({
          pushApproval,
          decision: 'declined',
          declineAs,
          // Under `never` only a range the scan did not clear asks at all.
          ...(pushApproval === 'never' ? { scan: 'allowed' as const } : {}),
          afterReview: FIX,
        });
        expect(outcome.asked).toBe(true);
        expect(outcome.pushed).toBe(false);
        if (pushApproval === 'unless-unreviewed') {
          expect(outcome.outputs.get('decide-after-review')?.['afterReview']).toBe(
            'fix_before_merge',
          );
        }
        for (const id of FIX_ROUND) expect(outcome.ran, id).not.toContain(id);
        expect(outcome.state['prUrl']).toBeUndefined();
      });
    }
  }

  it('with the decline recorded as an answer, the findings were decided for a fix round — the decline alone held it', () => {
    const outcome = reviewedWith({ decision: 'declined', declineAs: 'answer', afterReview: FIX });
    expect(outcome.ran).toContain('decide-after-review');
    expect(outcome.outputs.get('decide-after-review')?.['afterReview']).toBe('fix_before_merge');
    expect(outcome.outputs.get('approve-push')).toEqual({ decision: 'rejected' });
    expect(outcome.ran).not.toContain('fix-findings');
  });

  it('gates the publication of the fix on this run having pushed, on its own predicate', () => {
    expect(taskOrThrow('republish-after-findings').when).toEqual({
      allOf: ['tasks.fix-findings.output.patchRef != null', 'tasks.push.output.exitCode == 0'],
      onMissingRef: 'skip',
    });
  });

  for (const republished of ['declined', 'paused', 'failed'] as const) {
    it(`fix_before_merge: a publication of the fix that ${republished === 'declined' ? 'had its push declined' : republished === 'paused' ? 'stopped at its approval' : 'failed'} fails this run, and the pull request this run opened stands`, () => {
      const outcome = reviewedWith({ afterReview: FIX, republished });
      expect(outcome.pushed).toBe(true);
      expect(outcome.statuses.get('republish-after-findings')).toBe('failed');
      // Never a null over it: the pull request this run's own push opened.
      expect(outcome.state['prUrl']).toBe('https://github.com/aflowai/aflow/pull/7');
      expect(outcome.state['prNumber']).toBe(7);
    });
  }

  it("undecided: takes today's path — through the approval, with no fix round", () => {
    const outcome = reviewedWith({
      afterReview: {
        value: 'fix_before_merge',
        confidence: AFTER_REVIEW_QUESTION.minConfidence - 0.01,
      },
    });
    expect(outcome.ran).toContain('decide-after-review');
    for (const id of FIX_ROUND) expect(outcome.ran, id).not.toContain(id);
    expect(outcome.state['afterReview']).toBeNull();
    gateAsBefore(outcome, {});
  });

  it('publish_as_is: takes no fix round, records the decision, and leaves the push as it was', () => {
    const outcome = reviewedWith({ afterReview: { value: 'publish_as_is', confidence: 0.95 } });
    for (const id of FIX_ROUND) expect(outcome.ran, id).not.toContain(id);
    expect(outcome.state['afterReview']).toBe('publish_as_is');
    gateAsBefore(outcome, {});
  });

  it('offers only the two answers that route differently — unsure is the undecided path, not an option', () => {
    // An option that routes as another does is one nothing reads: the schema
    // carries the rule by not offering it.
    expect(Object.keys(AFTER_REVIEW_QUESTION.options)).toEqual([
      'fix_before_merge',
      'publish_as_is',
    ]);
    expect(AFTER_REVIEW_ROUTES).toEqual(['fix_before_merge', 'publish_as_is']);
  });

  it('no fix round where the round cannot be decided: the run goes on as before', () => {
    const outcome = reviewedWith({ afterReview: 'unavailable' });
    expect(outcome.statuses.get('decide-after-review')).toBe('failed');
    for (const id of FIX_ROUND) expect(outcome.ran, id).not.toContain(id);
    gateAsBefore(outcome, {});
  });

  it('decides nothing where the review returned no findings or did not finish', () => {
    for (const review of ['approve', 'failed', 'not-started'] as const) {
      const outcome = reviewedWith({ review, findings: review === 'approve' ? [] : FINDINGS });
      expect(outcome.ran, review).not.toContain('decide-after-review');
    }
  });

  it('leaves the push gate, the scan and the posture exactly as they were', () => {
    // 316 D9: a decision reads text it can be steered by, so it is never a gate.
    const push = taskOrThrow('push');
    expect(push.when).toEqual({
      anyOf: [
        "tasks.approve-push.output.decision == 'approved'",
        "tasks.read-push-approval.output.branchPolicy.pushApproval == 'never'",
        "tasks.review-commit.output.verdict == 'approve'",
      ],
      onMissingRef: 'skip',
    });
    const reads = (task: WorkflowTask) =>
      JSON.stringify([task.when, task.inputBindings, task.dependsOn]);
    for (const gate of ['push', 'approve-push', 'read-push-approval', 'scan-commit']) {
      expect(reads(taskOrThrow(gate) as WorkflowTask), gate).not.toMatch(/decide-|fix-|republish-/);
    }
  });
});
