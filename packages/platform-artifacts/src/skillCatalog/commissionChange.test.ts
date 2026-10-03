import { describe, it, expect } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  HOST_HARNESS_TIMEOUT_DEFAULT_MS,
  HOST_HARNESS_TIMEOUT_MAX_MS,
  HostHarnessRunInputSchema,
  isEvalPlaneOperation,
  substituteTemplateBinds,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { COMMISSION_CHANGE } from './commissionChange.js';

const wf = COMMISSION_CHANGE.bundle.workflow;
const task = wf.tasks[0];
const template = task?.inputTemplate ?? {};
const declared = new Set(Object.keys(task?.inputBindings ?? {}));

const BRIEF = 'Fix the failing test in src/cache.test.ts.';

describe('Commission Change — a brief to the machine’s coding agent', () => {
  it('has a valid contract', () => {
    const bundle = COMMISSION_CHANGE.bundle;
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

  it('is one operation task on the host harness', () => {
    expect(wf.tasks).toHaveLength(1);
    expect(task?.type).toBe('operation');
    expect(task?.operation).toBe('host.harness.run');
    expect(task?.context?.capabilities?.operations).toEqual(['host.harness.run']);
    expect(task?.context?.capabilities?.integrations ?? []).toEqual([]);
  });

  it('takes as run inputs everything the operation takes that a brief names', () => {
    const inputs = wf.runInputs ?? [];
    expect(inputs.map((i) => i.id)).toEqual([
      'bindingId',
      'task',
      'base',
      'mergeFrom',
      'continueFrom',
      'model',
      'maxTurns',
      'timeoutMs',
    ]);
    expect(inputs.filter((i) => i.required).map((i) => i.id)).toEqual(['bindingId', 'task']);
    for (const input of inputs) {
      expect(task?.inputBindings?.[input.id]).toEqual({ kind: 'run_input', path: input.id });
      expect(input.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('runs two hours and several hundred turns when the brief names neither', () => {
    const op = substituteTemplateBinds(template, { bindingId: 'hb_repo', task: BRIEF }, declared);
    expect(op).toEqual({
      bindingId: 'hb_repo',
      task: BRIEF,
      maxTurns: expect.any(Number) as number,
      timeoutMs: HOST_HARNESS_TIMEOUT_MAX_MS,
    });
    expect(op['timeoutMs']).toBeGreaterThan(HOST_HARNESS_TIMEOUT_DEFAULT_MS);
    expect(op['maxTurns']).toBeGreaterThanOrEqual(300);
    expect(HostHarnessRunInputSchema.safeParse(op).success).toBe(true);

    const timeout = (wf.runInputs ?? []).find((i) => i.id === 'timeoutMs');
    expect(timeout?.schema).toMatchObject({ default: HOST_HARNESS_TIMEOUT_MAX_MS });
    expect(timeout?.description).toContain('thirty to forty minutes');
    const turns = (wf.runInputs ?? []).find((i) => i.id === 'maxTurns');
    expect(turns?.schema).toMatchObject({ default: op['maxTurns'] });
    expect(turns?.description).toContain('Every tool call is a turn');
  });

  it('carries what the brief names to the operation as it stands', () => {
    const named = {
      bindingId: 'hb_repo',
      task: BRIEF,
      base: 'aflow/fix-cache',
      mergeFrom: 'origin/main',
      continueFrom: 'session-1',
      model: 'claude-opus-5-5',
      maxTurns: 40,
      timeoutMs: 600_000,
    };
    const op = substituteTemplateBinds(template, named, declared);
    expect(op).toEqual(named);
    expect(HostHarnessRunInputSchema.safeParse(op).success).toBe(true);
  });

  it('promotes the change and what a publication and a further turn take, patchRef primary', () => {
    const promoted = (task?.promoteOutputs ?? []).map((p) => ('toState' in p ? p.toState : ''));
    const expected = [
      'patchRef',
      'baseSha',
      'merge',
      'applies',
      'filesChanged',
      'sessionRef',
      'continued',
      'refChanges',
    ];
    expect(promoted).toEqual(expected);
    expect((wf.stateVariables ?? []).map((v) => v.variableId)).toEqual(expected);
    expect(wf.output?.primary).toBe('patchRef');
    expect(wf.output?.guidance).toContain('patchRef, baseSha and merge.from as they stand');
    expect(wf.output?.guidance).toContain('sessionRef');
  });

  it('says what a commission is, how it starts, how many run, and whose checks the brief names', () => {
    const description = COMMISSION_CHANGE.description;
    expect(description).toContain("`wait: 'none'`");
    expect(description).toContain('wakes it');
    expect(description).toContain("within the machine's limit");
    expect(description).toContain("The checks a brief asks for are the folder's own");
  });

  it('runs beside any number of other commissions, one task each', () => {
    const concurrency = COMMISSION_CHANGE.bundle.manifest.concurrency;
    expect(concurrency?.maxConcurrentRuns).toBe('unlimited');
    expect(concurrency?.maxParallelTasksPerRun).toBe(1);
  });

  it('ships in its own bundle beside Local Code Review and Local Publish', () => {
    expect(getSkillBundleEntry('local-commission')?.skillCatalogIds).toEqual(['commission-change']);
  });

  it('references no eval-plane operation', () => {
    const operations = wf.tasks.flatMap((t) => [
      ...(t.operation ? [t.operation] : []),
      ...(t.context?.capabilities?.operations ?? []),
    ]);
    expect(operations.filter((op) => isEvalPlaneOperation(op))).toEqual([]);
  });
});
