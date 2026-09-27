import { describe, it, expect } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { isEvalPlaneOperation, substituteTemplateBinds } from '@aflow/schemas';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';

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

  it('is four tasks in one chain — commit, approve, push, pull request', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual(['commit', 'approve-push', 'push', 'open-pr']);
    expect(wf.tasks.map((t) => t.type)).toEqual(['operation', 'human', 'operation', 'operation']);
    expect(wf.tasks.map((t) => t.dependsOn ?? [])).toEqual([
      [],
      ['commit'],
      ['approve-push'],
      ['push'],
    ]);
    expect(taskOrThrow('commit').operation).toBe('host.file.patch');
    expect(taskOrThrow('push').operation).toBe('host.process.exec');
    expect(taskOrThrow('open-pr').operation).toBe('api.http.call');
  });

  it('commits the patch onto its branch, carrying the base it was made against', () => {
    const commit = taskOrThrow('commit');
    expect(commit.inputTemplate).toEqual({
      bindingId: { $bind: 'bindingId' },
      patch: { $bind: 'patch' },
      mode: 'clean',
      commit: {
        branch: { $bind: 'branch' },
        message: { $bind: 'commitMessage' },
        base: { $bind: 'baseSha' },
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
    expect(appended['commit']).toEqual({ branch: 'feat/x', message: 'm', base: 'a'.repeat(40) });

    const baseSha = (wf.runInputs ?? []).find((i) => i.id === 'baseSha');
    expect(baseSha?.required).toBe(false);
    expect(PUBLISH_LOCAL_CHANGES.description).toContain(
      'a branch is reused only that way, and a fresh change takes a fresh branch',
    );
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
    expect(approve.when).toEqual({
      expression: "tasks.commit.output.state == 'applied'",
      onMissingRef: 'skip',
    });
    // Gating does not propagate: the push reads the decision itself.
    expect(taskOrThrow('push').when).toEqual({
      expression: "tasks.approve-push.output.decision == 'approved'",
      onMissingRef: 'skip',
    });
    expect(taskOrThrow('push').maxAttempts).toBe(1);
    expect(approve.pauseInstruction).toContain('nothing has left the machine');
    expect(approve.actionPreview?.op).toBe('host.process.exec');
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
      'patch',
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
