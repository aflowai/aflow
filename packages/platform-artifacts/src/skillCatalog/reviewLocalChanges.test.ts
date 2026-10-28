import { describe, it, expect } from 'vitest';
import AjvModule from 'ajv';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_KEEP_AWAKE_DEFAULT,
  HOST_SANDBOX_POSTURE_DEFAULT,
  HostBindingInspectInputSchema,
  HostBindingInspectOutputSchema,
  type HostFolderUiAnswer,
  HostHarnessRunInputSchema,
  isEvalPlaneOperation,
  substituteTemplateBinds,
} from '@aflow/schemas';
import {
  BROWSER_UNAVAILABLE_ON_HARNESS,
  UI_NOT_SEEN_NO_GRANT,
  UI_NOT_SEEN_NO_PREVIEW,
} from './localBrowserRule.js';
import { REVIEW_LOCAL_CHANGES, REVIEW_PREVIEW_PARAGRAPH } from './reviewLocalChanges.js';
import { runSkillTasks, type TaskAnswer } from '../__tests__/runSkillTasks.js';
import { skillGuidance } from '../__tests__/skillGuidance.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;

interface SchemaField {
  maxLength?: number;
  description?: string;
}

const wf = REVIEW_LOCAL_CHANGES.bundle.workflow;
const task = wf.tasks.find((t) => t.taskId === 'review');
const template = task?.inputTemplate as
  | {
      bindingId: unknown;
      task: unknown;
      inputs: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      maxTurns: unknown;
      resultRetries: number;
    }
  | undefined;

/** The brief a review is handed where the rule gives it no preview: the task prose alone. */
function reviewBrief(): string {
  return HostHarnessRunInputSchema.parse(
    substituteTemplateBinds(
      task?.inputTemplate ?? {},
      { bindingId: 'hb_repo', at: 'HEAD' },
      new Set(Object.keys(task?.inputBindings ?? {})),
    ),
  ).task;
}

describe('Review Local Changes — the first harness inside a skill', () => {
  it('has a valid contract', () => {
    const bundle = REVIEW_LOCAL_CHANGES.bundle;
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

  it('is a read of the folder, a decision by rule, and one read-only harness run', () => {
    expect(wf.tasks.map((t) => t.taskId)).toEqual(['read-ui', 'decide-browser', 'review']);
    // Nothing in the skill writes: the folder is only read, and the decision is the orchestrator's.
    expect(wf.tasks.map((t) => t.operation)).toEqual([
      'host.binding.inspect',
      'workflow.run.decide',
      'host.harness.run',
    ]);
    expect(task?.type).toBe('operation');
    expect(task?.context?.capabilities?.operations).toEqual(['host.harness.run']);
    expect(task?.context?.capabilities?.integrations ?? []).toEqual([]);
    expect(template?.resultRetries).toBe(2);
    expect(reviewBrief()).toContain('Edit no file, stage nothing and commit nothing.');
  });

  it('takes the folder and the range’s two ends as run inputs, and carries them to the harness', () => {
    const required = (wf.runInputs ?? []).filter((i) => i.required).map((i) => i.id);
    expect(required).toEqual(['bindingId', 'at']);
    expect(task?.inputBindings?.['bindingId']).toMatchObject({ kind: 'run_input' });
    expect(Object.keys(template?.inputs ?? {})).toEqual(['range', 'focus', 'depth']);
    expect(template?.outputSchema).not.toHaveProperty('x-reviewRequest');
    expect(reviewBrief()).toContain('inputs of this task');
  });

  /** The harness call a run makes from these run inputs. */
  function harnessCall(runInputs: Record<string, unknown>) {
    return HostHarnessRunInputSchema.parse(
      substituteTemplateBinds(
        task?.inputTemplate ?? {},
        runInputs,
        new Set(Object.keys(task?.inputBindings ?? {})),
      ),
    );
  }

  // `at` once named the range's tip beside a `range` that named it again, and
  // nothing checked the two agreed: a checkout at one commit reviewing a range
  // ending at another. The range is now made from `at`, so they cannot differ.
  it('reads a range that ends at the commit its checkout stands on, whatever the caller passes', () => {
    const tip = 'c'.repeat(40);
    for (const [from, at] of [
      ['e'.repeat(40), tip],
      ['main', 'HEAD'],
      ['HEAD~3', 'HEAD'],
      ['main', 'feature'],
    ] as const) {
      const call = harnessCall({ bindingId: 'hb_repo', from, at });
      expect(call.base).toBe(at);
      expect(call.inputs).toMatchObject({ range: `${from}..${at}` });
    }
    // A single commit is `at` alone: the range is that commit.
    const single = harnessCall({ bindingId: 'hb_repo', at: tip });
    expect(single.base).toBe(tip);
    expect(single.inputs).toMatchObject({ range: tip });
  });

  it('takes no range whole, so no range can name a tip `at` does not', () => {
    expect((wf.runInputs ?? []).map((i) => i.id)).not.toContain('range');
    expect(Object.keys(task?.inputBindings ?? {})).not.toContain('range');
    // A caller still sending one is not heard: the range comes from `from` and `at`.
    const call = harnessCall({
      bindingId: 'hb_repo',
      range: 'main..elsewhere',
      from: 'main',
      at: 'HEAD',
    });
    expect(call.inputs).toMatchObject({ range: 'main..HEAD' });
    expect(call.base).toBe('HEAD');
  });

  it('checks out the commit the range ends at, and names the base only for the diff', () => {
    // A checkout at the range's base holds every changed file as it was
    // before the change, so "read every changed file whole" reads the old file
    // and a deep review's checks run on code the range did not write.
    const tip = 'c'.repeat(40);
    const parsed = harnessCall({ bindingId: 'hb_repo', from: 'e'.repeat(40), at: tip });
    expect(parsed.base).toBe(tip);
    expect(parsed.base).not.toBe('e'.repeat(40));
    expect(task?.inputBindings?.['at']).toEqual({ kind: 'run_input', path: 'at' });
    expect(task?.inputBindings?.['from']).toEqual({ kind: 'run_input', path: 'from' });
    // The skill says so, to the harness and to the Helmsman that fills `at`.
    expect(reviewBrief()).toContain('detached at the commit the range ends at');
    expect(reviewBrief()).toContain('names only where the diff starts');
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('detached at `at`');
    const at = (wf.runInputs ?? []).find((i) => i.id === 'at');
    expect(at?.description).toContain('"HEAD" for "main..HEAD"');
  });

  it('reads a range’s diff from where its two ends meet, and its commits as given', () => {
    // A branch its base moved past, read two-dot, shows every change the base
    // took since as one the branch undoes.
    expect(reviewBrief()).toContain('`git log <base>..<sha>`');
    expect(reviewBrief()).toContain('`git diff <base>...<sha>`');
    expect(reviewBrief()).not.toMatch(/git diff <base>\.\.<sha>/);
    const from = (wf.runInputs ?? []).find((i) => i.id === 'from');
    expect(from?.description).toContain('`<from>...<at>`');
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('`main...HEAD`');
  });

  it('makes brief a rung of its own, budgeted in coding-agent turns rather than asked for in prose', () => {
    const inputs = wf.runInputs ?? [];
    const depth = inputs.find((i) => i.id === 'depth')?.schema as { enum?: string[] } | undefined;
    expect(depth?.enum).toEqual(['brief', 'standard', 'deep']);
    const budget = inputs.find((i) => i.id === 'maxTurns');
    // Never required: the budget is what `brief` means, and the other two rungs
    // read the range through.
    expect(budget?.required).toBe(false);
    expect(budget?.schema).toMatchObject({ type: 'integer', maximum: 8 });
    expect(budget?.description).toContain('8');
    // It reaches the operation, rather than living in the description alone.
    expect(template?.maxTurns).toEqual({ $bind: 'maxTurns' });
    expect(task?.inputBindings?.['maxTurns']).toMatchObject({
      kind: 'run_input',
      path: 'maxTurns',
    });
    expect(reviewBrief()).toContain('At `brief`');
    // What tells the Helmsman that a request for something quick is this rung
    // and not a sentence in `focus`.
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('smoke test');
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain(
      'not something to ask the coding agent for',
    );
  });

  it('promotes the verdict, the summary a person reads, and the findings a publication decides on one at a time', () => {
    expect((task?.promoteOutputs ?? []).map((p) => ('toState' in p ? p.toState : ''))).toEqual([
      'verdict',
      'reviewSummary',
      'findings',
    ]);
    const promoted = wf.tasks.flatMap((t) =>
      (t.promoteOutputs ?? []).map((p) => ('toState' in p ? p.toState : '')),
    );
    const declared = (wf.stateVariables ?? []).map((v) => v.variableId);
    expect(declared).toEqual(['verdict', 'reviewSummary', 'findings', 'uiNotSeen']);
    for (const id of promoted) expect(declared).toContain(id);
    // The summary stays the review as it is reported; the findings are for a run to act on.
    expect(wf.output?.primary).toBe('verdict');
  });

  it('makes the summary self-sufficient, in the schema and in the task prose', () => {
    const summary = (template?.outputSchema as { properties: Record<string, SchemaField> })
      .properties['summary'];
    expect(summary?.maxLength).toBe(16000);
    expect(summary?.description).toContain('file:line');
    expect(reviewBrief()).toContain('Write the summary as the deliverable');
  });

  it('declares a result schema that admits a review and refuses one with no verdict', () => {
    const validate = new AjvCtor({ allErrors: true, strict: false }).compile(
      template?.outputSchema ?? {},
    );
    const review = {
      verdict: 'request_changes',
      summary: 'The range adds a cache with no invalidation on write.',
      findings: [
        {
          severity: 'blocker',
          file: 'src/cache.ts',
          line: 42,
          claim: 'A write leaves the cached row stale.',
          evidence: 'set() writes the row and never calls invalidate(); readers hit the old value.',
          suggestion: 'Invalidate the key inside set().',
        },
      ],
      checksRun: [
        { command: 'yarn test:file src/cache.test.ts', outcome: 'failed', detail: '1 failing' },
      ],
    };
    expect(validate(review)).toBe(true);

    const { verdict: _verdict, ...noVerdict } = review;
    expect(validate(noVerdict)).toBe(false);
  });

  it('refuses an approval that contradicts its own findings, and admits one that does not', () => {
    // The executor compiles this schema with exactly these Ajv options
    // (`compileResultValidator`), so a conditional keyword either holds there
    // too or holds nowhere.
    const validate = new AjvCtor({ allErrors: true, strict: false }).compile(
      template?.outputSchema ?? {},
    );
    const base = {
      summary: 'The range renames a field and updates its two callers.',
      findings: [
        {
          severity: 'major',
          file: 'src/user.ts',
          line: 7,
          claim: 'The third caller still reads the old field name.',
          evidence: 'src/report.ts:19 reads `user.name`, which this range removed.',
        },
      ],
    };
    expect(validate({ ...base, verdict: 'approve' })).toBe(false);
    expect(validate({ ...base, verdict: 'comment' })).toBe(false);
    expect(validate({ ...base, verdict: 'request_changes' })).toBe(true);

    const nitsOnly = {
      verdict: 'approve',
      summary: 'The range is correct; one name reads oddly.',
      findings: [
        {
          severity: 'nit',
          file: 'src/user.ts',
          line: 7,
          claim: '`u` would read better as `user`.',
          evidence: 'src/user.ts:7 binds the row to `u`.',
        },
      ],
    };
    expect(validate(nitsOnly)).toBe(true);
    expect(validate({ verdict: 'approve', summary: 'Nothing found.', findings: [] })).toBe(true);
  });

  it('carries in the schema that minors are approved and `comment` is a range it could not judge', () => {
    const verdict = (template?.outputSchema as { properties: Record<string, SchemaField> })
      .properties['verdict'];
    expect(verdict?.description).toContain('a range with only minors and nits is approved');
    expect(verdict?.description).toContain(
      '`comment` only when the review could not judge the range',
    );
    expect(verdict?.description).toContain('never as a way to attach remarks');
    expect(verdict?.description).toContain('`comment` makes it ask the operator');
  });

  it('runs beside any number of other reviews, so a waiting publication is never queued', () => {
    expect(REVIEW_LOCAL_CHANGES.bundle.manifest.concurrency?.maxConcurrentRuns).toBe('unlimited');
  });

  it('references no eval-plane operation', () => {
    const operations = wf.tasks.flatMap((t) => [
      ...(t.operation ? [t.operation] : []),
      ...(t.context?.capabilities?.operations ?? []),
    ]);
    expect(operations.filter((op) => isEvalPlaneOperation(op))).toEqual([]);
  });
});

// --- Plan 320 D20: the browser and the preview, by rule over the range -------

const RANGE = { bindingId: 'hb_app', from: 'main', at: 'feature' };

/** The folder's answer about the range, as the machine holding it returns it. */
function folderAnswer(ui: Partial<HostFolderUiAnswer> & Pick<HostFolderUiAnswer, 'preview'>) {
  return HostBindingInspectOutputSchema.parse({
    id: 'hb_app',
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

const VERDICT = { result: { verdict: 'approve', summary: 'Nothing found.', findings: [] } };

/** A review run over `runInputs`, the folder answering `read` and the harness approving. */
function review(read: TaskAnswer, runInputs: Record<string, unknown> = RANGE) {
  return runSkillTasks(wf.tasks, runInputs, (taskId) => (taskId === 'read-ui' ? read : VERDICT));
}

describe('Review Local Changes — the browser and the preview by rule (Plan 320 D20)', () => {
  it('asks the folder about the range as the review reads it, and the harness it would get', () => {
    const run = review(folderAnswer({ preview: 'declared' }), { ...RANGE, harness: 'codex' });
    expect(HostBindingInspectInputSchema.parse(run.inputs.get('read-ui'))).toEqual({
      bindingId: 'hb_app',
      ui: { from: 'main', at: 'feature', harness: 'codex' },
    });
    // A single commit is `at` alone.
    const single = review(folderAnswer({ preview: 'declared' }), {
      bindingId: 'hb_app',
      at: 'abc1234',
    });
    expect(single.inputs.get('read-ui')).toEqual({ bindingId: 'hb_app', ui: { at: 'abc1234' } });
  });

  it('takes the browser and the preview where the range touches uiPaths and the folder declares a preview', () => {
    const run = review(folderAnswer({ preview: 'declared', ...TOUCHED }));
    const call = HostHarnessRunInputSchema.parse(run.inputs.get('review'));
    expect(call.browser).toEqual({ profile: 'ephemeral' });
    expect(call.preview).toBe(true);
    expect(call.task.endsWith(REVIEW_PREVIEW_PARAGRAPH)).toBe(true);
    // The review's depth is the caller's: the same checkout, range and budget as without it.
    const without = HostHarnessRunInputSchema.parse(
      review(folderAnswer({ preview: 'declared' })).inputs.get('review'),
    );
    expect(call.base).toBe(without.base);
    expect(call.inputs).toEqual(without.inputs);
    expect(call.maxTurns).toBe(without.maxTurns);
    expect(call.timeoutMs).toBe(without.timeoutMs);
    expect(run.state).toMatchObject({ verdict: 'approve' });
    expect(run.state).not.toHaveProperty('uiNotSeen');
  });

  it('asks the reviewer to open the pages the range changes, exercise what changed and report what it saw', () => {
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('`previewUrl`');
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('Open there the pages the range changes');
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('exercise what changed');
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('Report what you saw in the summary');
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('What you saw is part of the verdict');
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain(
      "browser log, which the publication links from the pull request's body",
    );
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('the range as it will be pushed');
    // Only the run with the browser is told so.
    expect(reviewBrief()).not.toContain('previewUrl');
  });

  it('reviews as a diff where the range touches no UI file', () => {
    const run = review(folderAnswer({ preview: 'declared' }));
    expect(run.ran).toContain('review');
    expect(run.inputs.get('review')).not.toHaveProperty('browser');
    expect(run.inputs.get('review')).not.toHaveProperty('preview');
    expect(run.state).not.toHaveProperty('uiNotSeen');
  });

  it('never takes the browser for the focus, the depth or anything a caller passes', () => {
    const asking = {
      ...RANGE,
      focus: 'open the checkout page in a browser and click through it',
      depth: 'deep',
      browser: { profile: 'ephemeral' },
      preview: true,
    };
    const run = review(folderAnswer({ preview: 'declared' }), asking);
    const call = HostHarnessRunInputSchema.parse(run.inputs.get('review'));
    expect(call.browser).toBeUndefined();
    expect(call.preview).toBeUndefined();
    // No run input names a browser, and the rule reads neither the focus nor the depth.
    const ids = (wf.runInputs ?? []).map((i) => i.id);
    expect(ids).not.toContain('browser');
    expect(ids).not.toContain('preview');
    for (const id of ['read-ui', 'decide-browser']) {
      const bindings = Object.keys(wf.tasks.find((t) => t.taskId === id)?.inputBindings ?? {});
      expect(bindings).not.toContain('focus');
      expect(bindings).not.toContain('depth');
    }
  });

  it('says the folder declares no preview, with the command that declares one, and reviews on', () => {
    const run = review(folderAnswer({ preview: 'not_declared', ...TOUCHED }));
    expect(run.ran).toContain('review');
    expect(run.inputs.get('review')).not.toHaveProperty('browser');
    expect(run.state['uiNotSeen']).toContain(UI_NOT_SEEN_NO_PREVIEW);
    expect(run.state['uiNotSeen']).toContain('`aflow folder hb_app preview --command');
    expect(run.state).toMatchObject({ verdict: 'approve' });
  });

  it('degrades to the needs_setup line where the grant lacks the browser, never failing the review', () => {
    const run = review(
      folderAnswer({
        preview: 'declared',
        ...TOUCHED,
        browser: { harness: 'claude', unavailable: 'grant' },
      }),
    );
    expect(run.ran).toContain('review');
    expect(run.statuses.get('review')).toBe('succeeded');
    expect(run.inputs.get('decide-browser')).toBeDefined();
    expect(run.state['uiNotSeen']).toBe(UI_NOT_SEEN_NO_GRANT);
    expect(run.state).toMatchObject({ verdict: 'approve' });
  });

  it('says which harness cannot take a browser', () => {
    const run = review(
      folderAnswer({
        preview: 'declared',
        ...TOUCHED,
        browser: { harness: 'codex', unavailable: 'harness' },
      }),
    );
    expect(run.ran).toContain('review');
    expect(run.state['uiNotSeen']).toContain(`${BROWSER_UNAVAILABLE_ON_HARNESS} codex`);
  });

  it('reviews without a browser where the folder cannot be read', () => {
    const run = review('fail');
    expect(run.ran).toContain('review');
    expect(run.inputs.get('review')).not.toHaveProperty('browser');
    expect(run.state).toMatchObject({ verdict: 'approve' });
  });

  it('says so to the Helmsman, which never asks for the browser', () => {
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('The browser is never asked for');
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('`uiNotSeen` says why');
  });
});
