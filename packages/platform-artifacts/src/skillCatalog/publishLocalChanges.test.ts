import { describe, it, expect } from 'vitest';
import {
  computeReadyTasksWithWhen,
  computeRejectedApprovalSkipSet,
  materializeAndValidateSkillConfig,
  projectTaskOutput,
  resolvePromotedRunMetrics,
} from '@aflow/cybernetic-runtime';
import {
  HOST_PUSH_APPROVAL_DEFAULT,
  HostApprovedPushSchema,
  HostBindingInspectOutputSchema,
  HostProcessExecInputSchema,
  HostCommitScanInputSchema,
  HostCommitScanOutputSchema,
  type HostPushApproval,
  type WorkflowTask,
  WorkflowRunStartInputSchema,
  WorkflowRunWakeupEnvelopeSchema,
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  isEvalPlaneOperation,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  PAUSE_INSTRUCTION_MAX_CHARS,
  substituteTemplateBinds,
} from '@aflow/schemas';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
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
  pushRefspec: `${HEAD}:refs/heads/aflow/x`,
};

function taskOrThrow(taskId: string) {
  const task = taskById.get(taskId);
  if (!task) throw new Error(`task "${taskId}" must exist`);
  return task;
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

  it('is nine tasks — commit, scan, what decides the approval, approve, push, find or open the pull request', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual([
      'commit',
      'scan-commit',
      'read-repository',
      'read-push-approval',
      'review-commit',
      'approve-push',
      'push',
      'find-pr',
      'open-pr',
    ]);
    expect(wf.tasks.map((t) => t.type)).toEqual([
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'human',
      'operation',
      'operation',
      'operation',
    ]);
    expect(wf.tasks.map((t) => t.dependsOn ?? [])).toEqual([
      [],
      ['commit'],
      ['commit'],
      ['commit', 'scan-commit'],
      ['read-push-approval', 'scan-commit'],
      ['read-repository', 'scan-commit', 'review-commit'],
      ['approve-push', 'scan-commit'],
      ['push'],
      ['find-pr'],
    ]);
    expect(taskOrThrow('commit').operation).toBe('host.file.patch');
    expect(taskOrThrow('scan-commit').operation).toBe('host.commit.scan');
    expect(taskOrThrow('read-repository').operation).toBe('api.http.call');
    expect(taskOrThrow('read-push-approval').operation).toBe('host.binding.inspect');
    expect(taskOrThrow('review-commit').operation).toBe('workflow.run.start');
    expect(taskOrThrow('push').operation).toBe('host.process.exec');
    expect(taskOrThrow('find-pr').operation).toBe('api.http.call');
    expect(taskOrThrow('open-pr').operation).toBe('api.http.call');
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
    expect(read.when).toEqual({
      expression: "tasks.commit.output.state == 'applied'",
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
          body: { $firstOf: [{ $bind: 'summary' }, { $bind: 'messageBody' }] },
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
    for (const task of [findPr, openPr]) {
      const kinds = Object.values(task.inputBindings ?? {}).map((b) => b.kind);
      expect(kinds, task.taskId).not.toContain('connection_binding');
      expect(task.promoteOutputs?.map((p) => ('toState' in p ? p.toState : ''))).toEqual([
        'prUrl',
        'prNumber',
      ]);
    }
    expect(PUBLISH_LOCAL_CHANGES.capabilityHints?.[0]?.requiredEndpoints).toEqual([
      'getRepository',
      'listPullRequests',
      'createPullRequest',
    ]);
    expect(wf.output?.primary).toBe('prUrl');
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

  it("opens the pull request with the summary as its body, or the commit message's body without one", () => {
    const openPr = taskOrThrow('open-pr');
    const template = openPr.inputTemplate;
    if (template === undefined) throw new Error('open-pr must carry a template');
    expect(openPr.inputBindings?.['messageBody']).toEqual({
      kind: 'task_output',
      taskId: 'commit',
      path: 'commit.body',
    });
    const declared = new Set(Object.keys(openPr.inputBindings ?? {}));
    const inputs = { owner: 'aflowai', repo: 'aflow', branch: 'aflow/x', base: 'main', title: 'T' };
    const bodyOf = (resolved: Record<string, unknown>) =>
      (
        substituteTemplateBinds(template, { ...inputs, ...resolved }, declared)['params'] as {
          body: Record<string, unknown>;
        }
      ).body;

    // The commission's own account, as the commit task reports it.
    const commit = HostFilePatchOutputSchema.parse({
      state: 'applied',
      filesChanged: 1,
      files: ['a.ts'],
      conflicts: [],
      commit: { ...COMMIT, message: 'The change\n\nWhy it was made.', body: 'Why it was made.' },
    }).commit;
    const outputs = new Map([['commit', commit === undefined ? {} : { commit }]]);
    const messageBody = readOutput(outputs, 'commit', 'commit.body');
    expect(messageBody).toBe('Why it was made.');

    expect(bodyOf({ messageBody })['body']).toBe('Why it was made.');
    expect(bodyOf({ summary: 'The summary.', messageBody })['body']).toBe('The summary.');
    // A one-line message and no summary: no body at all, never an empty one.
    expect(bodyOf({})).not.toHaveProperty('body');
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      "omitted, the pull request's body is the commit message after its first line — the commission's own account of the change",
    );
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
    expect(required).toEqual([
      'bindingId',
      'branch',
      'commitMessage',
      'title',
      'owner',
      'repo',
      'base',
    ]);
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
function reviewEnding(review: Exclude<Review, 'not-started'>): Record<string, unknown> {
  const completed = review !== 'failed' && review !== 'cancelled' && review !== 'paused';
  return WorkflowRunWakeupEnvelopeSchema.parse({
    runId: 'review-run',
    outcome: completed ? 'completed' : review,
    waiterId: 'waiter-1',
    ...(completed ? { result: { output: { verdict: review, reviewSummary: 'Read.' } } } : {}),
  });
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

interface Scenario {
  pushApproval: HostPushApproval | 'no-prefix';
  review: Review;
  decision: Decision;
  committed?: boolean;
  /** What the scan of the commit found; absent is clean. */
  scan?: Scan;
  /**
   * How a decline is recorded: `skip`, as the harness does, skipping the gated
   * branch; or `answer`, the decision alone, so the push's own predicate is
   * what refuses it.
   */
  declineAs?: 'skip' | 'answer';
  /** Whether `origin`'s base is no longer where the scanned range starts, which fails the push. */
  baseMoved?: boolean;
  /** The receipt the approval records, where not the one its preview resolves to. */
  approvalOf?: string;
  /** The base of the pull request the branch already has open when the push lands, where it has one. */
  existingPrInto?: string;
}

interface Outcome {
  asked: boolean;
  pushed: boolean;
  ran: string[];
  /** The run's state as its tasks' promoted outputs make it. */
  state: Record<string, unknown>;
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
      return scenario.committed === false
        ? { state: 'conflict', filesChanged: 0, files: [], conflicts: ['a.ts'] }
        : {
            state: 'applied',
            filesChanged: 1,
            files: ['a.ts'],
            conflicts: [],
            commit: COMMIT,
          };
    case 'scan-commit':
      return scanResult(scenario.scan ?? 'clean');
    case 'read-repository':
      return { statusCode: 200, data: { full_name: 'aflowai/aflow' } };
    case 'read-push-approval':
      return HostBindingInspectOutputSchema.parse({
        id: 'hb_app',
        ...(scenario.pushApproval === 'no-prefix'
          ? {}
          : { branchPolicy: { branchPrefix: 'aflow/', pushApproval: scenario.pushApproval } }),
      });
    case 'review-commit':
      if (scenario.review === 'not-started')
        throw new Error('a review that did not start has no output');
      return reviewEnding(scenario.review);
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

/** What a task's run-input and `task_output` bindings resolve to, absent ones left out. */
function boundOutputs(
  bindings: WorkflowTask['inputBindings'],
  outputs: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    const value =
      binding.kind === 'task_output'
        ? readOutput(outputs, binding.taskId, binding.path)
        : binding.kind === 'run_input'
          ? RUN_INPUTS[binding.path]
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
 * base it measures from and the scan's receipt always, and for a range the
 * scan did not clear a grant the operator's approval minted for exactly this
 * push. Nothing the push's own input says stands in for the grant.
 */
function receiptAccepted(
  push: WorkflowTask,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  grants: ReadonlySet<string>,
): boolean {
  const { bindingId, refspec, base, receipt } = boundOutputs(push.inputBindings, outputs);
  if (typeof receipt !== 'string' || typeof base !== 'string') return false;
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
        (scenario.baseMoved === true || !receiptAccepted(task, outputs, grants))
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
          const input = boundOutputs(task.actionPreview?.inputBindings, outputs);
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
                boundOutputs(task.inputBindings, outputs),
                new Set(Object.keys(task.inputBindings ?? {})),
              );
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
  return { asked, pushed: statuses.get('push') === 'succeeded', ran, state };
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
        value: { verdict: null, outcome, reviewRunId: 'review-run' },
      });
    }
    const approved = projectTaskOutput(review.outputProjection, reviewEnding('approve'), null);
    expect(approved).toEqual({
      ok: true,
      value: { verdict: 'approve', outcome: 'completed', reviewRunId: 'review-run' },
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
    expect(outcome).toEqual({ asked: false, pushed: false, ran: ['commit'], state: {} });
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
    expect(scan.when).toEqual({
      expression: "tasks.commit.output.state == 'applied'",
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
        },
        new Set(Object.keys(push.inputBindings ?? {})),
      ),
    );
    expect(input.pushBase).toBe('main');
    expect(input.scan).toEqual({ receipt: RECEIPT.unscanned });
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
    it(`${pushApproval}: a base that moved since the scan pushes nothing and opens no pull request`, () => {
      const outcome = publish({
        pushApproval,
        review: 'approve',
        decision: 'approved',
        baseMoved: true,
      });
      expect(outcome.ran).toContain('push');
      expect(outcome.pushed).toBe(false);
      expect(outcome.ran).not.toContain('open-pr');
    });
  }

  it('says on failure that nothing was pushed, why, and that the publication runs again', () => {
    const failure = taskOrThrow('push').failureInstruction ?? '';
    expect(failure).toContain(
      "`origin`'s base branch is somewhere other than where the receipt's range starts",
    );
    expect(failure).toContain('no approval of this push is on record');
    expect(failure).toContain('pushes somewhere other than where it fetches from');
    expect(failure).toContain('nothing was pushed');
    expect(failure).toContain('run the publication again on a fresh branch');
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'is no longer where the run measured from, forward or back, or `origin` pushes elsewhere than it fetches, the push refused just before git ran and nothing was pushed',
    );
  });
});
