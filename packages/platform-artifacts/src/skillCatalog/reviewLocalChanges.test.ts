import { describe, it, expect } from 'vitest';
import AjvModule from 'ajv';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  declareFolderPreviewCommand,
  HOST_HARNESS_CONCURRENCY_DEFAULT,
  HOST_KEEP_AWAKE_DEFAULT,
  HOST_SANDBOX_POSTURE_DEFAULT,
  HostBindingInspectInputSchema,
  HostBindingInspectOutputSchema,
  type HostFolderUiAnswer,
  HostHarnessRunInputSchema,
  isEvalPlaneOperation,
  NEEDS_SETUP_FINDING_KIND,
  substituteTemplateBinds,
} from '@aflow/schemas';
import {
  BROWSER_UNAVAILABLE_ON_HARNESS,
  RULE_PREVIEW,
  UI_NOT_SEEN_NO_GRANT,
  UI_NOT_SEEN_NO_PREVIEW,
  UI_NOT_SEEN_PREVIEW_UNAVAILABLE,
} from './localBrowserRule.js';
import {
  REVIEW_FINDING_SCHEMA,
  REVIEW_LOCAL_CHANGES,
  REVIEW_PREVIEW_PARAGRAPH,
} from './reviewLocalChanges.js';
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
    expect(wf.tasks.map((t) => t.taskId)).toEqual([
      'read-ui',
      'decide-browser',
      'review',
      'report-setup',
    ]);
    // Nothing in the skill writes: the folder is only read, and the decision is the orchestrator's.
    expect(wf.tasks.map((t) => t.operation)).toEqual([
      'host.binding.inspect',
      'workflow.run.decide',
      'host.harness.run',
      'workflow.run.decide',
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

    // Only the rule writes a `needs_setup` finding: the reviewer's result has no kind.
    expect(
      validate({ ...review, findings: [{ ...review.findings[0], kind: 'needs_setup' }] }),
    ).toBe(false);
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
function review(
  read: TaskAnswer,
  runInputs: Record<string, unknown> = RANGE,
  verdict: TaskAnswer = VERDICT,
) {
  return runSkillTasks(
    wf.tasks,
    runInputs,
    (taskId) => (taskId === 'read-ui' ? read : verdict),
    wf.stateVariables,
  );
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
    expect(call.preview).toBe(RULE_PREVIEW);
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
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain("keeps each one in the run's browser log");
    expect(REVIEW_PREVIEW_PARAGRAPH).toContain('say in it what each screenshot showed');
    // The pull request's body links the browser log only once P6(d) builds it.
    expect(REVIEW_PREVIEW_PARAGRAPH).not.toContain('pull request');
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

  it.each([
    ['its fixed port is in use', 'preview port 41802 is in use.'],
    [
      'it never answers',
      'The preview `yarn dev` did not answer at http://127.0.0.1:47101/ within 120 s. What it printed is in `previewLog`.',
    ],
  ])(
    'reviews on and says so where the preview the rule gave it cannot be had: %s (D21)',
    (_case, happened) => {
      // The executor reviewed without the preview and its browser and said
      // what happened to the preview, rather than failing the review.
      const run = review(folderAnswer({ preview: 'declared', ...TOUCHED }), RANGE, {
        ...VERDICT,
        previewUnavailable: happened,
      });
      expect(HostHarnessRunInputSchema.parse(run.inputs.get('review')).preview).toBe(RULE_PREVIEW);
      expect(run.statuses.get('review')).toBe('succeeded');
      expect(run.state['uiNotSeen']).toBe(`${UI_NOT_SEEN_PREVIEW_UNAVAILABLE}: ${happened}`);
      expect(run.state).toMatchObject({ verdict: 'approve' });
    },
  );

  it('says nothing after a review that had its preview', () => {
    const run = review(folderAnswer({ preview: 'declared', ...TOUCHED }), RANGE, {
      ...VERDICT,
      previewUrl: 'http://127.0.0.1:47101/',
    });
    expect(run.statuses.get('report-setup')).toBe('skipped');
    expect(run.state).not.toHaveProperty('uiNotSeen');
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

// --- Plan 320 D21: the needs_setup finding, of the review's own kind --------

const NIT = {
  severity: 'nit',
  file: 'src/web/Checkout.vue',
  line: 4,
  claim: 'The class name repeats the component name.',
  evidence: 'class="checkout-checkout".',
};
const WITH_NIT = { result: { verdict: 'approve', summary: 'One nit.', findings: [NIT] } };

const validFinding = new AjvCtor({ allErrors: true, strict: false }).compile(REVIEW_FINDING_SCHEMA);

/** The review's findings, its own first, and the one its rule added last. */
function setupFinding(run: ReturnType<typeof review>): Record<string, unknown> {
  const findings = run.state['findings'] as Array<Record<string, unknown>>;
  expect(findings.slice(0, -1)).toEqual([NIT]);
  const added = findings.at(-1) ?? {};
  expect(validFinding(added)).toBe(true);
  expect(added).toMatchObject({
    kind: NEEDS_SETUP_FINDING_KIND,
    severity: 'minor',
    file: 'src/web/Checkout.vue',
  });
  expect(added['evidence']).toContain('`src/web/Checkout.vue`');
  return added;
}

describe('Review Local Changes — needs_setup where the review had no browser (Plan 320 D21)', () => {
  it('reports a folder with no preview as a minor finding of its own kind, with the command that declares one', () => {
    const run = review(folderAnswer({ preview: 'not_declared', ...TOUCHED }), RANGE, WITH_NIT);
    const added = setupFinding(run);
    expect(added['claim']).toBe('UI change not seen in a browser: the folder declares no preview');
    expect(added['suggestion']).toContain(`\`${declareFolderPreviewCommand('hb_app')}\``);
    expect(added['suggestion']).toContain('aflow folder hb_app preview --command');
    // The verdict is the reviewer's, and the line beside it stands.
    expect(run.state).toMatchObject({ verdict: 'approve' });
    expect(run.state['uiNotSeen']).toContain(UI_NOT_SEEN_NO_PREVIEW);
  });

  it('reports a harness without browser arguments the same way, naming the harness', () => {
    const run = review(
      folderAnswer({
        preview: 'declared',
        ...TOUCHED,
        browser: { harness: 'codex', unavailable: 'harness' },
      }),
      RANGE,
      WITH_NIT,
    );
    const added = setupFinding(run);
    expect(added['claim']).toContain(`${BROWSER_UNAVAILABLE_ON_HARNESS} codex`);
    expect(added['claim']).toContain('`aflow harness browser codex`');
  });

  it('reports a grant without browser.page:write as needs_setup, never a permission failure', () => {
    const run = review(
      folderAnswer({
        preview: 'declared',
        ...TOUCHED,
        browser: { harness: 'claude', unavailable: 'grant' },
      }),
      RANGE,
      WITH_NIT,
    );
    expect([...run.statuses.values()]).not.toContain('failed');
    expect(setupFinding(run)['claim']).toBe(UI_NOT_SEEN_NO_GRANT);
  });

  it('reports a preview the rule gave the review and it could not have, saying what happened', () => {
    const happened = 'preview port 41802 is in use.';
    const run = review(folderAnswer({ preview: 'declared', ...TOUCHED }), RANGE, {
      ...WITH_NIT,
      previewUnavailable: happened,
    });
    expect(setupFinding(run)['claim']).toBe(`${UI_NOT_SEEN_PREVIEW_UNAVAILABLE}: ${happened}`);
  });

  it('adds nothing where the review had its preview, or its range touched no UI', () => {
    for (const [label, read, verdict] of [
      [
        'preview open',
        folderAnswer({ preview: 'declared', ...TOUCHED }),
        { ...WITH_NIT, previewUrl: 'http://127.0.0.1:47101/' },
      ],
      ['no UI file', folderAnswer({ preview: 'not_declared' }), WITH_NIT],
    ] as const) {
      const run = review(read, RANGE, verdict);
      expect(run.state['findings'], label).toEqual([NIT]);
    }
  });

  it('adds nothing to a review that did not finish, so a publication still reads it as unfinished', () => {
    const run = review(folderAnswer({ preview: 'not_declared', ...TOUCHED }), RANGE, 'fail');
    expect(run.statuses.get('review')).toBe('failed');
    expect(run.state).not.toHaveProperty('findings');
  });

  it('names the kind in the brief, so the reviewer writes no finding of a missing browser itself', () => {
    expect(reviewBrief()).toContain('`needs_setup`');
    expect(reviewBrief()).toContain('Write no finding about a missing browser or preview');
    const findings = (wf.stateVariables ?? []).find((v) => v.variableId === 'findings');
    expect(findings?.writers).toBe('append');
    expect(findings?.description).toContain('`needs_setup`');
  });
});
