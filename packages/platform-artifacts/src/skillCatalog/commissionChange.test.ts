import { describe, it, expect } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_HARNESS_MAX_TURNS_DEFAULT,
  HOST_HARNESS_TASK_MAX_LENGTH,
  HOST_HARNESS_TIMEOUT_DEFAULT_MS,
  HOST_HARNESS_TIMEOUT_MAX_MS,
  HOST_KEEP_AWAKE_DEFAULT,
  HOST_SANDBOX_POSTURE_DEFAULT,
  HostBindingInspectInputSchema,
  HostBindingInspectOutputSchema,
  type HostFolderUiAnswer,
  HostHarnessRunInputSchema,
  isEvalPlaneOperation,
  substituteTemplateBinds,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import {
  COMMISSION_BRIEF_MAX_LENGTH,
  COMMISSION_CHANGE,
  COMMISSION_PREVIEW_PARAGRAPH,
  COMMISSION_RESULT_SCHEMA,
  COMMIT_TITLE_MAX_CHARS,
} from './commissionChange.js';
import {
  BROWSER_UNAVAILABLE_ON_HARNESS,
  UI_NOT_SEEN_BY_COMMISSION,
  UI_NOT_SEEN_NO_GRANT,
  UI_NOT_SEEN_NO_PREVIEW,
} from './localBrowserRule.js';
import { runSkillTasks, type TaskAnswer } from '../__tests__/runSkillTasks.js';
import { skillGuidance } from '../__tests__/skillGuidance.js';

const wf = COMMISSION_CHANGE.bundle.workflow;
const task = wf.tasks.find((t) => t.taskId === 'commission');
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

  it('is a read of the folder, a decision by rule, one harness run, and a read of what it changed', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual([
      'read-ui',
      'decide-browser',
      'commission',
      'check-ui',
      'report-ui',
    ]);
    expect(wf.tasks.map((t) => t.operation)).toEqual([
      'host.binding.inspect',
      'workflow.run.decide',
      'host.harness.run',
      'host.binding.inspect',
      'workflow.run.decide',
    ]);
    expect(task?.type).toBe('operation');
    expect(task?.context?.capabilities?.operations).toEqual(['host.harness.run']);
    expect(task?.context?.capabilities?.integrations ?? []).toEqual([]);
    expect(task?.retryability).toBe('unsafe');
    // Only the coding agent's run is the commission; nothing around it fails it.
    for (const id of ['read-ui', 'decide-browser', 'check-ui']) {
      expect(wf.tasks.find((t) => t.taskId === id)?.optional).toBe(true);
    }
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
    };
    const op = substituteTemplateBinds(template, named, declared);
    expect(op).toEqual({ ...named, outputSchema: COMMISSION_RESULT_SCHEMA, resultRequired: false });
    expect(HostHarnessRunInputSchema.safeParse(op).success).toBe(true);
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
    expect((wf.stateVariables ?? []).map((v) => v.variableId)).toEqual([
      ...expected,
      'uiNotSeen',
      'uiFilesNotSeen',
    ]);
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

// --- Plan 320 D20: the browser and the preview, by rule over the brief --------

const UI_BRIEF = 'Make the empty state of `src/web/Checkout.vue:40` say why the cart is empty.';
const PATCH_REF = 'gs://payloads/t/patch/run-1';

/** The folder's answer, as the machine holding it returns it. */
function folderAnswer(ui: Partial<HostFolderUiAnswer> & Pick<HostFolderUiAnswer, 'preview'>) {
  return HostBindingInspectOutputSchema.parse({
    id: 'hb_repo',
    sandbox: HOST_SANDBOX_POSTURE_DEFAULT,
    maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
    keepAwake: HOST_KEEP_AWAKE_DEFAULT,
    ui: {
      uiPaths: ['src/web/**'],
      files: [],
      touched: false,
      browser: { harness: 'claude' },
      ...ui,
    },
  });
}

const TOUCHED = { files: ['src/web/Checkout.vue'], touched: true };

const CHANGE = {
  patchRef: PATCH_REF,
  baseSha: 'b'.repeat(40),
  filesChanged: 1,
  result: { summary: { title: 'Say why the cart is empty', paragraph: 'It says why.' } },
};

/**
 * A commission over `runInputs`: the folder answering `before` ahead of the
 * run and `after` once it ended, the coding agent returning one change.
 */
function commission(
  before: TaskAnswer,
  after: TaskAnswer = folderAnswer({ preview: 'declared' }),
  runInputs: Record<string, unknown> = { bindingId: 'hb_repo', task: UI_BRIEF },
) {
  return runSkillTasks(wf.tasks, runInputs, (taskId) =>
    taskId === 'read-ui' ? before : taskId === 'check-ui' ? after : CHANGE,
  );
}

describe('Commission Change — the browser and the preview by rule (Plan 320 D20)', () => {
  it('asks the folder about the brief, the branch it continues and the harness it would get', () => {
    const run = commission(folderAnswer({ preview: 'declared' }), undefined, {
      bindingId: 'hb_repo',
      task: UI_BRIEF,
      base: 'aflow/checkout-copy',
      harness: 'codex',
    });
    expect(HostBindingInspectInputSchema.parse(run.inputs.get('read-ui'))).toEqual({
      bindingId: 'hb_repo',
      ui: { text: UI_BRIEF, branch: 'aflow/checkout-copy', harness: 'codex' },
    });
  });

  it('takes the browser and the preview where the brief names a uiPaths file and the folder declares a preview', () => {
    const run = commission(folderAnswer({ preview: 'declared', ...TOUCHED }));
    const call = HostHarnessRunInputSchema.parse(run.inputs.get('commission'));
    expect(call.browser).toEqual({ profile: 'ephemeral' });
    expect(call.preview).toBe(true);
    expect(call.task).toBe(`${UI_BRIEF}\n\n${COMMISSION_PREVIEW_PARAGRAPH}`);
    // A run that had the preview open is not read again, and says nothing.
    expect(run.ran).not.toContain('check-ui');
    expect(run.state).not.toHaveProperty('uiNotSeen');
    expect(run.state).toMatchObject({ patchRef: PATCH_REF });
  });

  it('carries one standard paragraph naming previewUrl, the app as of its base', () => {
    expect(COMMISSION_PREVIEW_PARAGRAPH).toContain('`previewUrl`');
    expect(COMMISSION_PREVIEW_PARAGRAPH).toContain('the app as of its base');
    expect(COMMISSION_PREVIEW_PARAGRAPH).toContain('your own edits are not part of');
    expect(COMMISSION_PREVIEW_PARAGRAPH).toContain('start or stop no server yourself');
    // Always the same text, whatever the brief.
    const other = 'Restyle `src/web/Nav.vue`.';
    const run = commission(folderAnswer({ preview: 'declared', ...TOUCHED }), undefined, {
      bindingId: 'hb_repo',
      task: other,
    });
    expect(run.inputs.get('commission')?.['task']).toBe(
      `${other}\n\n${COMMISSION_PREVIEW_PARAGRAPH}`,
    );
    // Nothing in it names any one project or a port.
    expect(COMMISSION_PREVIEW_PARAGRAPH).not.toMatch(/aflow|localhost|:\d{2,5}/i);
  });

  it('leaves room for the paragraph after the longest brief it takes', () => {
    const input = (wf.runInputs ?? []).find((i) => i.id === 'task');
    expect(input?.schema).toMatchObject({ maxLength: COMMISSION_BRIEF_MAX_LENGTH });
    const named = 'Restyle `src/web/Nav.vue`. ';
    const longest = named + 'x'.repeat(COMMISSION_BRIEF_MAX_LENGTH - named.length);
    expect(longest).toHaveLength(COMMISSION_BRIEF_MAX_LENGTH);
    const run = commission(folderAnswer({ preview: 'declared', ...TOUCHED }), undefined, {
      bindingId: 'hb_repo',
      task: longest,
    });
    const call = HostHarnessRunInputSchema.parse(run.inputs.get('commission'));
    expect(call.task).toHaveLength(HOST_HARNESS_TASK_MAX_LENGTH);
    expect(call.preview).toBe(true);
  });

  it('gives no browser where the brief and the branch touch no UI file', () => {
    const run = commission(folderAnswer({ preview: 'declared' }));
    expect(run.ran).toContain('commission');
    const call = HostHarnessRunInputSchema.parse(run.inputs.get('commission'));
    expect(call.browser).toBeUndefined();
    expect(call.preview).toBeUndefined();
    expect(call.task).toBe(UI_BRIEF);
    expect(run.state['uiFilesNotSeen']).toEqual([]);
    expect(run.state).not.toHaveProperty('uiNotSeen');
  });

  it('does not take the browser where the folder declares no preview, and says so with the command', () => {
    const noPreview = folderAnswer({ preview: 'not_declared', ...TOUCHED });
    const run = commission(noPreview, noPreview);
    expect(run.ran).toContain('commission');
    expect(run.inputs.get('commission')).not.toHaveProperty('browser');
    expect(run.inputs.get('commission')).not.toHaveProperty('preview');
    expect(run.state['uiNotSeen']).toContain(UI_NOT_SEEN_NO_PREVIEW);
    expect(run.state['uiNotSeen']).toContain(
      '`aflow folder hb_repo preview --command "<the command that serves it, with {port}>"`',
    );
    expect(run.state['uiFilesNotSeen']).toEqual(['src/web/Checkout.vue']);
    expect(run.statuses.get('commission')).toBe('succeeded');
  });

  it('names each UI file a run changed without the trigger, and rests nothing on it', () => {
    const run = commission(
      folderAnswer({ preview: 'declared' }),
      folderAnswer({
        preview: 'declared',
        files: ['src/web/Cart.vue', 'src/web/Nav.vue'],
        touched: true,
      }),
      { bindingId: 'hb_repo', task: 'Fix the empty-cart bug.', harness: 'claude' },
    );
    expect(run.ran).toContain('commission');
    expect(HostBindingInspectInputSchema.parse(run.inputs.get('check-ui'))).toEqual({
      bindingId: 'hb_repo',
      ui: { patchRef: PATCH_REF, harness: 'claude' },
    });
    expect(run.state['uiNotSeen']).toBe(UI_NOT_SEEN_BY_COMMISSION);
    expect(run.state['uiFilesNotSeen']).toEqual(['src/web/Cart.vue', 'src/web/Nav.vue']);
    expect(run.state).toMatchObject({ patchRef: PATCH_REF, filesChanged: 1 });
  });

  it('degrades to the needs_setup line where the grant lacks the browser, never failing the commission', () => {
    const ungranted = folderAnswer({
      preview: 'declared',
      ...TOUCHED,
      browser: { harness: 'claude', unavailable: 'grant' },
    });
    const run = commission(ungranted, ungranted);
    expect(run.ran).toContain('commission');
    expect(run.inputs.get('commission')).not.toHaveProperty('browser');
    expect(run.statuses.get('commission')).toBe('succeeded');
    expect(run.state['uiNotSeen']).toBe(UI_NOT_SEEN_NO_GRANT);
    expect(run.state).toMatchObject({ patchRef: PATCH_REF });
  });

  it('says which harness cannot take a browser', () => {
    const noArguments = folderAnswer({
      preview: 'declared',
      ...TOUCHED,
      browser: { harness: 'codex', unavailable: 'harness' },
    });
    const run = commission(noArguments, noArguments);
    expect(run.ran).toContain('commission');
    expect(run.state['uiNotSeen']).toContain(`${BROWSER_UNAVAILABLE_ON_HARNESS} codex`);
    expect(run.state['uiNotSeen']).toContain('`aflow harness browser codex`');
  });

  it('runs without a browser where the folder cannot be read, before the run or after it', () => {
    const run = commission('fail', 'fail');
    expect(run.ran).toContain('commission');
    expect(run.inputs.get('commission')).not.toHaveProperty('browser');
    expect(run.statuses.get('commission')).toBe('succeeded');
    expect(run.state).toMatchObject({ patchRef: PATCH_REF });
    expect(run.state).not.toHaveProperty('uiNotSeen');
  });

  it('offers the Helmsman no browser to ask for, and says what the rule reads', () => {
    expect((wf.runInputs ?? []).map((i) => i.id)).not.toContain('browser');
    const guidance = skillGuidance(COMMISSION_CHANGE);
    expect(guidance).toContain('The browser is never asked for');
    expect(guidance).toContain("a file under the folder's `uiPaths`");
    expect(guidance).not.toContain('dev-server URL the coding agent opens');
    // A caller's browser is not heard: only the rule adds one.
    const run = commission(folderAnswer({ preview: 'declared' }), undefined, {
      bindingId: 'hb_repo',
      task: BRIEF,
      browser: { profile: 'ephemeral' },
    });
    expect(run.inputs.get('commission')).not.toHaveProperty('browser');
  });
});
