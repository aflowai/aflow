import { describe, it, expect } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_HARNESS_MAX_TURNS_DEFAULT,
  HOST_HARNESS_TIMEOUT_DEFAULT_MS,
  HOST_HARNESS_TIMEOUT_MAX_MS,
  HostHarnessBrowserSchema,
  HostHarnessRunInputSchema,
  isEvalPlaneOperation,
  substituteTemplateBinds,
  toJsonSchemaSync,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import {
  COMMISSION_CHANGE,
  COMMISSION_RESULT_SCHEMA,
  COMMIT_TITLE_MAX_CHARS,
} from './commissionChange.js';
import { skillGuidance } from '../__tests__/skillGuidance.js';

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
      'harness',
      'model',
      'maxTurns',
      'timeoutMs',
      'browser',
    ]);
    expect(inputs.filter((i) => i.required).map((i) => i.id)).toEqual(['bindingId', 'task']);
    for (const input of inputs) {
      expect(task?.inputBindings?.[input.id]).toEqual({ kind: 'run_input', path: input.id });
      expect(input.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('runs two hours when the brief names no time, and sends no turn budget it did not name', () => {
    const op = substituteTemplateBinds(template, { bindingId: 'hb_repo', task: BRIEF }, declared);
    expect(op).toEqual({
      bindingId: 'hb_repo',
      task: BRIEF,
      timeoutMs: HOST_HARNESS_TIMEOUT_MAX_MS,
      outputSchema: COMMISSION_RESULT_SCHEMA,
      resultRequired: false,
    });
    expect('maxTurns' in op).toBe(false);
    expect(op['timeoutMs']).toBeGreaterThan(HOST_HARNESS_TIMEOUT_DEFAULT_MS);
    const parsed = HostHarnessRunInputSchema.safeParse(op);
    expect(parsed.success).toBe(true);
    // Absent, the operation chooses: its own default on a coding agent that
    // takes a budget, and none on one that does not, so nothing is refused.
    expect(parsed.data?.maxTurns).toBeUndefined();

    const timeout = (wf.runInputs ?? []).find((i) => i.id === 'timeoutMs');
    expect(timeout?.schema).toMatchObject({ default: HOST_HARNESS_TIMEOUT_MAX_MS });
    expect(timeout?.description).toContain('thirty to forty minutes');
    const turns = (wf.runInputs ?? []).find((i) => i.id === 'maxTurns');
    expect(turns?.schema).not.toHaveProperty('default');
    expect(turns?.description).toContain('Every tool call is a turn');
    expect(turns?.description).toContain(String(HOST_HARNESS_MAX_TURNS_DEFAULT));
    expect(turns?.description).toContain('none on one that does not');
  });

  it('binds the harness through, and leaves it to the machine when the brief names none', () => {
    expect(template['harness']).toEqual({ $bind: 'harness' });
    const op = substituteTemplateBinds(
      template,
      { bindingId: 'hb_repo', task: BRIEF, harness: 'opencode' },
      declared,
    );
    expect(op['harness']).toBe('opencode');
    expect(HostHarnessRunInputSchema.safeParse(op).success).toBe(true);
    const harness = (wf.runInputs ?? []).find((i) => i.id === 'harness');
    expect(harness?.required).toBe(false);
    expect(harness?.description).toContain("the machine's default");
  });

  it('carries what the brief names to the operation as it stands', () => {
    const named = {
      bindingId: 'hb_repo',
      task: BRIEF,
      base: 'aflow/fix-cache',
      mergeFrom: 'origin/main',
      continueFrom: 'session-1',
      harness: 'claude',
      model: 'claude-opus-5-5',
      maxTurns: 40,
      timeoutMs: 600_000,
      browser: { profile: 'ephemeral' },
    };
    const op = substituteTemplateBinds(template, named, declared);
    expect(op).toEqual({ ...named, outputSchema: COMMISSION_RESULT_SCHEMA, resultRequired: false });
    expect(HostHarnessRunInputSchema.safeParse(op).success).toBe(true);
  });

  it('gives the coding agent no browser when the brief asks for none', () => {
    const op = substituteTemplateBinds(template, { bindingId: 'hb_repo', task: BRIEF }, declared);
    expect('browser' in op).toBe(false);
    const parsed = HostHarnessRunInputSchema.safeParse(op);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.browser).toBeUndefined();
  });

  it('hands the operation the browser the brief names, unchanged', () => {
    for (const browser of [{ profile: 'ephemeral' }, { profile: 'work-chrome' }]) {
      const op = substituteTemplateBinds(
        template,
        { bindingId: 'hb_repo', task: BRIEF, browser },
        declared,
      );
      expect(op['browser']).toEqual(browser);
      const parsed = HostHarnessRunInputSchema.safeParse(op);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.browser).toEqual(browser);
    }
  });

  it("takes the operation's browser schema, and says to ask for one for a page of the web UI", () => {
    const input = (wf.runInputs ?? []).find((i) => i.id === 'browser');
    expect(input?.required).toBe(false);
    expect(input?.schema).toEqual(toJsonSchemaSync(HostHarnessBrowserSchema));
    expect(input?.schema?.['description']).toBe(HostHarnessBrowserSchema.description);
    expect(input?.description).toContain(
      "A change that touches a page of the repository's web UI gets `{ profile: 'ephemeral' }`",
    );
    expect(input?.description).toContain(
      'names the dev-server URL the coding agent opens and what it should see working there',
    );
    expect(input?.description?.length ?? 0).toBeLessThanOrEqual(500);
    expect(skillGuidance(COMMISSION_CHANGE)).toContain("`browser: { profile: 'ephemeral' }`");
  });

  it('promotes the change and what a publication and a further turn take, patchRef primary', () => {
    const promoted = (task?.promoteOutputs ?? []).map((p) => ('toState' in p ? p.toState : ''));
    const expected = [
      'summary',
      'patchRef',
      'baseSha',
      'merge',
      'applies',
      'filesChanged',
      'sessionRef',
      'continued',
    ];
    expect(promoted).toEqual(expected);
    expect((wf.stateVariables ?? []).map((v) => v.variableId)).toEqual(expected);
    expect(wf.output?.primary).toBe('patchRef');
    expect(wf.output?.guidance).toContain('patchRef, baseSha and merge.from as they stand');
    expect(wf.output?.guidance).toContain('commits under summary unless given a commitMessage');
    expect(wf.output?.guidance).toContain('sessionRef');
  });

  it('has the coding agent report a summary — a title under 72 characters and one paragraph — beside what the brief asks', () => {
    expect(template['outputSchema']).toBe(COMMISSION_RESULT_SCHEMA);
    expect(task?.promoteOutputs).toContainEqual({
      kind: 'output_path',
      path: 'result.summary',
      toState: 'summary',
    });
    const summary = COMMISSION_RESULT_SCHEMA.properties.summary;
    expect(summary.required).toEqual(['title', 'paragraph']);
    expect(summary.properties.title.maxLength).toBe(COMMIT_TITLE_MAX_CHARS);
    expect(COMMIT_TITLE_MAX_CHARS).toBeLessThan(72);
    // The rest of the result is the brief's to ask for.
    expect(COMMISSION_RESULT_SCHEMA).not.toHaveProperty('additionalProperties');
    expect(skillGuidance(COMMISSION_CHANGE)).toContain(
      'The coding agent writes the `summary` whatever the brief asks: a title line under 72 characters and one paragraph',
    );
    expect(skillGuidance(COMMISSION_CHANGE)).toContain('its run id as `commission`');
  });

  it('keeps the change when the coding agent writes no valid summary', () => {
    // The patch is the product: a missing or invalid result costs the summary
    // only, and the publication then asks for a commit message.
    expect(template['resultRequired']).toBe(false);
    expect(skillGuidance(COMMISSION_CHANGE)).toContain(
      'A commission whose coding agent wrote no valid summary still returns its change',
    );
    const op = substituteTemplateBinds(template, { bindingId: 'hb_repo', task: BRIEF }, declared);
    const parsed = HostHarnessRunInputSchema.parse(op);
    expect(parsed.resultRequired).toBe(false);
  });

  it("starts a fix round at the branch's head, named as `base`, pushed or kept local", () => {
    expect(skillGuidance(COMMISSION_CHANGE)).toContain(
      "the branch's name for a fix appended to a branch — a fix round included, whose branch holds the earlier round's commit pushed or kept local — so the patch is made against the branch's head and never against the earlier commission's `baseSha`",
    );
    const base = (wf.runInputs ?? []).find((i) => i.id === 'base');
    expect(base?.description).toContain(
      'the checkout starts at its head, and the patch appends to its commit',
    );
  });

  it('says what a commission is, how it starts, how many run, and whose checks the brief names', () => {
    const description = skillGuidance(COMMISSION_CHANGE);
    expect(description).toContain("`wait: 'none'`");
    expect(description).toContain('wakes it');
    expect(description).toContain(
      `${String(HOST_HARNESS_CONCURRENCY_DEFAULT)} unless its operator chose another number`,
    );
    expect(description).toContain('waits for one to end rather than being refused');
    expect(description).toContain("The checks a brief asks for are the folder's own");
  });

  it("has the brief run the repository's guards before the commission returns, and fix what fails there", () => {
    const description = skillGuidance(COMMISSION_CHANGE);
    expect(description).toContain('`node --import tsx scripts/large-files/cli.ts check`');
    expect(description).toContain(
      '`node --conditions=ts-source --import tsx scripts/context-budget/cli.ts check`',
    );
    expect(description).toContain('before it returns, fix what fails in the same session');
    const taskInput = wf.runInputs?.find((i) => i.id === 'task');
    expect(taskInput?.description).toContain('checks and guards to run before it returns');
    expect(getSkillBundleEntry('local-commission')?.helmsmanHints).toEqual([]);
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

  it('is started for its plan node by the start’s planNodeId, never by a run input of its own', () => {
    expect(skillGuidance(COMMISSION_CHANGE)).toContain(
      'started with `planNodeId`, beside its inputs',
    );
    expect(skillGuidance(COMMISSION_CHANGE)).toContain('plan.node.get');
    expect(wf.runInputs?.map((input) => input.id)).not.toContain('planNodeId');
  });
});
