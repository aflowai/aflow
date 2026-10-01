import { describe, it, expect } from 'vitest';
import {
  computeReadyTasksWithWhen,
  computeRejectedApprovalSkipSet,
  materializeAndValidateSkillConfig,
  projectTaskOutput,
} from '@aflow/cybernetic-runtime';
import {
  HostBindingInspectOutputSchema,
  type HostPushApproval,
  type WorkflowTask,
  WorkflowRunLatestOutputSchema,
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  isEvalPlaneOperation,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  substituteTemplateBinds,
} from '@aflow/schemas';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';

const wf = PUBLISH_LOCAL_CHANGES.bundle.workflow;
const taskById = new Map(wf.tasks.map((task) => [task.taskId, task]));

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
      branch: 'publish/the-change',
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

  it('is seven tasks — commit, the reads that decide the approval, approve, push, pull request', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual([
      'commit',
      'read-repository',
      'read-push-approval',
      'read-review',
      'approve-push',
      'push',
      'open-pr',
    ]);
    expect(wf.tasks.map((t) => t.type)).toEqual([
      'operation',
      'operation',
      'operation',
      'operation',
      'human',
      'operation',
      'operation',
    ]);
    expect(wf.tasks.map((t) => t.dependsOn ?? [])).toEqual([
      [],
      ['commit'],
      ['commit'],
      ['read-push-approval'],
      ['read-repository', 'read-review'],
      ['approve-push'],
      ['push'],
    ]);
    expect(taskOrThrow('commit').operation).toBe('host.file.patch');
    expect(taskOrThrow('read-repository').operation).toBe('api.http.call');
    expect(taskOrThrow('read-push-approval').operation).toBe('host.binding.inspect');
    expect(taskOrThrow('read-review').operation).toBe('workflow.run.latest');
    expect(taskOrThrow('push').operation).toBe('host.process.exec');
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
      },
    });
    // A commit is not replayable — after the first attempt the branch exists
    // or has moved, and the operation refuses what no longer matches.
    expect(commit.retryability).toBe('unsafe');
  });

  it('binds the base only when the caller passed one, and names how a branch is reused', () => {
    const commit = taskOrThrow('commit');
    const template = commit.inputTemplate;
    if (template === undefined) throw new Error('the commit task must carry a template');
    const declared = new Set(Object.keys(commit.inputBindings ?? {}));
    const inputs = { bindingId: 'folder-1', patch: 'diff', branch: 'feat/x', commitMessage: 'm' };
    const fresh = substituteTemplateBinds(template, inputs, declared);
    expect(fresh['commit']).toEqual({ branch: 'feat/x', message: 'm' });
    const appended = substituteTemplateBinds(
      template,
      { ...inputs, baseSha: 'a'.repeat(40) },
      declared,
    );
    expect(appended['commit']).toEqual({
      branch: 'feat/x',
      message: 'm',
      baseSha: 'a'.repeat(40),
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

  it('pins the push argv, binding only the branch', () => {
    const [pushCommand, ...rest] = materializedCommands();
    expect(rest).toEqual([]);
    expect(pushCommand).toEqual(['git', 'push', '--set-upstream', 'origin', 'publish/the-change']);
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
      pushApproval: {
        kind: 'task_output',
        taskId: 'read-push-approval',
        path: 'branchPolicy.pushApproval',
      },
      commitSha: { kind: 'task_output', taskId: 'commit', path: 'commit.sha' },
      commitBranch: { kind: 'task_output', taskId: 'commit', path: 'commit.branch' },
      commitMessage: { kind: 'task_output', taskId: 'commit', path: 'commit.message' },
      filesChanged: { kind: 'task_output', taskId: 'commit', path: 'filesChanged' },
    });
    // Every path is one the patch operation returns for an applied commit, so
    // the preview resolves — an unresolved one refuses the approval itself.
    const applied = HostFilePatchOutputSchema.parse({
      state: 'applied',
      filesChanged: 2,
      files: ['a.ts', 'b.ts'],
      conflicts: [],
      commit: {
        branch: 'aflow/x',
        sha: 'b'.repeat(40),
        message: 'The change',
        baseSha: 'a'.repeat(40),
        appended: false,
      },
    });
    expect(applied.commit?.message).toBe('The change');
    expect(applied.filesChanged).toBe(2);
  });

  it('lets any number of publications wait at their approvals at once', () => {
    expect(PUBLISH_LOCAL_CHANGES.bundle.manifest.concurrency?.maxConcurrentRuns).toBe('unlimited');
  });

  it('opens the pull request on the space’s own GitHub connection, only after the push succeeded', () => {
    const openPr = taskOrThrow('open-pr');
    expect(openPr.when).toEqual({
      expression: 'tasks.push.output.exitCode == 0',
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
          body: { $bind: 'summary' },
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
    const kinds = Object.values(openPr.inputBindings ?? {}).map((b) => b.kind);
    expect(kinds).not.toContain('connection_binding');
    expect(openPr.promoteOutputs?.map((p) => ('toState' in p ? p.toState : ''))).toEqual([
      'prUrl',
      'prNumber',
    ]);
    expect(wf.output?.primary).toBe('prUrl');
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

const HEAD = 'c'.repeat(40);

type Review = 'none' | 'approve' | 'request_changes' | 'comment';
type Decision = 'approved' | 'declined';

interface Scenario {
  pushApproval: HostPushApproval | 'no-prefix';
  review: Review;
  decision: Decision;
  committed?: boolean;
}

interface Outcome {
  asked: boolean;
  pushed: boolean;
  ran: string[];
}

/** What each operation returns in a scenario, before the task's own projection. */
function rawOutput(taskId: string, scenario: Scenario): Record<string, unknown> {
  switch (taskId) {
    case 'commit':
      return scenario.committed === false
        ? { state: 'conflict', filesChanged: 0, files: [], conflicts: ['a.ts'] }
        : {
            state: 'applied',
            filesChanged: 1,
            files: ['a.ts'],
            conflicts: [],
            commit: {
              branch: 'aflow/x',
              sha: HEAD,
              message: 'The change',
              baseSha: 'a'.repeat(40),
              appended: false,
            },
          };
    case 'read-repository':
      return { statusCode: 200, data: { full_name: 'aflowai/aflow' } };
    case 'read-push-approval':
      return HostBindingInspectOutputSchema.parse({
        id: 'hb_app',
        root: '/tmp/app',
        mode: 'readwrite',
        allowsExecution: true,
        ...(scenario.pushApproval === 'no-prefix'
          ? {}
          : { branchPolicy: { branchPrefix: 'aflow/', pushApproval: scenario.pushApproval } }),
        harnesses: [],
      });
    case 'read-review':
      return WorkflowRunLatestOutputSchema.parse({
        run:
          scenario.review === 'none'
            ? null
            : {
                runId: 'review-run',
                completedAt: new Date().toISOString(),
                state: { verdict: scenario.review, reviewedHead: HEAD },
              },
        scanned: 3,
      });
    case 'push':
      return { exitCode: 0 };
    case 'open-pr':
      return { statusCode: 201, data: { number: 7, html_url: 'https://github.com/aflowai/aflow/pull/7' } };
    default:
      return {};
  }
}

/**
 * Drive the graph the way the harness does: ready tasks run, false predicates
 * skip, a declined approval skips its gated branch. Only the outputs are
 * scripted; every decision is the skill's own `when`.
 */
function publish(scenario: Scenario): Outcome {
  const tasks = wf.tasks as unknown as WorkflowTask[];
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const statuses = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const ran: string[] = [];
  let asked = false;

  for (let round = 0; round < tasks.length + 1; round += 1) {
    const { ready, skipped: skip, errors } = computeReadyTasksWithWhen(
      tasks,
      completed,
      skipped,
      { statuses, outputs },
    );
    expect(errors).toEqual([]);
    for (const { task } of skip) {
      skipped.add(task.taskId);
      statuses.set(task.taskId, 'skipped');
    }
    for (const task of ready) {
      ran.push(task.taskId);
      if (task.taskId === 'approve-push') {
        asked = true;
        if (scenario.decision === 'declined') {
          for (const id of computeRejectedApprovalSkipSet(tasks, task.taskId)) {
            skipped.add(id);
            statuses.set(id, 'skipped');
          }
          continue;
        }
        outputs.set(task.taskId, { decision: 'approved' });
      } else {
        const raw = rawOutput(task.taskId, scenario);
        if (task.outputProjection !== undefined) {
          const projected = projectTaskOutput(task.outputProjection, raw, null);
          if (!projected.ok) throw new Error(`${task.taskId} did not project`);
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

  return { asked, pushed: ran.includes('push'), ran };
}

describe('Publish Local Changes — the folder decides whether the push asks', () => {
  const postures: HostPushApproval[] = ['always', 'never', 'unless-unreviewed'];
  const reviews: Review[] = ['none', 'approve', 'request_changes', 'comment'];
  const decisions: Decision[] = ['approved', 'declined'];

  for (const pushApproval of postures) {
    for (const review of reviews) {
      for (const decision of decisions) {
        const asks =
          pushApproval === 'always' || (pushApproval === 'unless-unreviewed' && review !== 'approve');
        const pushes = asks ? decision === 'approved' : true;
        it(`${pushApproval}, review ${review}, operator ${decision}: ${asks ? 'asks' : 'does not ask'}, ${pushes ? 'pushes' : 'does not push'}`, () => {
          const outcome = publish({ pushApproval, review, decision });
          expect(outcome.asked).toBe(asks);
          expect(outcome.pushed).toBe(pushes);
          expect(outcome.ran.includes('open-pr')).toBe(pushes);
        });
      }
    }
  }

  it('reads a review only where the posture depends on one', () => {
    expect(publish({ pushApproval: 'always', review: 'approve', decision: 'approved' }).ran).not.toContain(
      'read-review',
    );
    expect(publish({ pushApproval: 'never', review: 'approve', decision: 'approved' }).ran).not.toContain(
      'read-review',
    );
    expect(
      publish({ pushApproval: 'unless-unreviewed', review: 'none', decision: 'approved' }).ran,
    ).toContain('read-review');
  });

  it('asks nothing and pushes nothing when the patch did not commit', () => {
    const outcome = publish({
      pushApproval: 'never',
      review: 'approve',
      decision: 'approved',
      committed: false,
    });
    expect(outcome).toEqual({ asked: false, pushed: false, ran: ['commit'] });
  });

  it('pushes nothing from a folder that declares no push at all', () => {
    const outcome = publish({ pushApproval: 'no-prefix', review: 'none', decision: 'approved' });
    expect(outcome.asked).toBe(false);
    expect(outcome.pushed).toBe(false);
  });

  it('never pushes after a decline, even read from the decision alone', () => {
    // The harness skips the gated branch on a decline; the push's own
    // predicate must refuse it too, in case a decline is ever recorded as an
    // answer rather than a skip.
    const push = taskOrThrow('push') as unknown as WorkflowTask;
    for (const pushApproval of ['always', 'unless-unreviewed'] as const) {
      const verdict = pushApproval === 'always' ? undefined : 'request_changes';
      const ready = computeReadyTasksWithWhen(
        [push],
        new Set(['approve-push']),
        new Set(),
        {
          statuses: new Map([['approve-push', 'succeeded']]),
          outputs: new Map<string, Record<string, unknown>>([
            ['approve-push', { decision: 'rejected' }],
            ['read-push-approval', { branchPolicy: { branchPrefix: 'aflow/', pushApproval } }],
            ...(verdict === undefined
              ? []
              : [['read-review', { verdict, reviewRunId: 'r' }] as [string, Record<string, unknown>]]),
          ]),
        },
      );
      expect(ready.ready).toEqual([]);
    }
  });

  it('looks for the review of exactly the commit it is about to push', () => {
    const read = taskOrThrow('read-review');
    const template = read.inputTemplate;
    if (template === undefined) throw new Error('the review read must carry a template');
    expect(read.inputBindings).toEqual({
      head: { kind: 'task_output', taskId: 'commit', path: 'commit.sha' },
    });
    const declared = new Set(Object.keys(read.inputBindings ?? {}));
    expect(substituteTemplateBinds(template, { head: HEAD }, declared)).toEqual({
      slug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug,
      match: { stateVariable: 'reviewedHead', equals: HEAD },
    });
    // The variable it matches on is one the review promotes.
    const reviewWf = REVIEW_LOCAL_CHANGES.bundle.workflow;
    expect(reviewWf.stateVariables?.map((v) => v.variableId)).toContain('reviewedHead');
    expect(
      reviewWf.tasks.flatMap((t) => t.promoteOutputs ?? []).map((p) => ('toState' in p ? p.toState : '')),
    ).toContain('reviewedHead');
  });

  it('says why it is asking, and shows the posture beside the commit', () => {
    const approve = taskOrThrow('approve-push');
    expect(approve.pauseInstruction).toContain('`always` asks before every push');
    expect(approve.pauseInstruction).toContain(
      '`unless-unreviewed` asks because no Local Code Review of this exact commit returned `approve`',
    );
  });

  it('names the three postures and the default in its description', () => {
    for (const phrase of ['`always`', '`never`', '`unless-unreviewed`', 'is `unless-unreviewed`']) {
      expect(PUBLISH_LOCAL_CHANGES.description).toContain(phrase);
    }
  });
});
