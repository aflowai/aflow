import { describe, it, expect } from 'vitest';
import AjvModule from 'ajv';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  HostHarnessRunInputSchema,
  isEvalPlaneOperation,
  substituteTemplateBinds,
} from '@aflow/schemas';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';
import { skillGuidance } from '../__tests__/skillGuidance.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;

interface SchemaField {
  maxLength?: number;
  description?: string;
}

const wf = REVIEW_LOCAL_CHANGES.bundle.workflow;
const task = wf.tasks[0];
const template = task?.inputTemplate as
  | {
      bindingId: unknown;
      task: string;
      inputs: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      maxTurns: unknown;
      resultRetries: number;
    }
  | undefined;

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

  it('is one read-only operation task on the host harness', () => {
    expect(wf.tasks).toHaveLength(1);
    expect(task?.type).toBe('operation');
    expect(task?.operation).toBe('host.harness.run');
    expect(task?.context?.capabilities?.operations).toEqual(['host.harness.run']);
    expect(task?.context?.capabilities?.integrations ?? []).toEqual([]);
    expect(template?.resultRetries).toBe(2);
    expect(template?.task).toContain('Edit no file, stage nothing and commit nothing.');
  });

  it('takes the folder and the range’s two ends as run inputs, and carries them to the harness', () => {
    const required = (wf.runInputs ?? []).filter((i) => i.required).map((i) => i.id);
    expect(required).toEqual(['bindingId', 'at']);
    expect(task?.inputBindings?.['bindingId']).toMatchObject({ kind: 'run_input' });
    expect(Object.keys(template?.inputs ?? {})).toEqual(['range', 'focus', 'depth']);
    expect(template?.outputSchema).not.toHaveProperty('x-reviewRequest');
    expect(template?.task).toContain('inputs of this task');
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
    expect(template?.task).toContain('detached at the commit the range ends at');
    expect(template?.task).toContain('names only where the diff starts');
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('detached at `at`');
    const at = (wf.runInputs ?? []).find((i) => i.id === 'at');
    expect(at?.description).toContain('"HEAD" for "main..HEAD"');
  });

  it('reads a range’s diff from where its two ends meet, and its commits as given', () => {
    // A branch its base moved past, read two-dot, shows every change the base
    // took since as one the branch undoes.
    expect(template?.task).toContain('`git log <base>..<sha>`');
    expect(template?.task).toContain('`git diff <base>...<sha>`');
    expect(template?.task).not.toMatch(/git diff <base>\.\.<sha>/);
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
    expect(template?.task).toContain('At `brief`');
    // What tells the Helmsman that a request for something quick is this rung
    // and not a sentence in `focus`.
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain('smoke test');
    expect(skillGuidance(REVIEW_LOCAL_CHANGES)).toContain(
      'not something to ask the coding agent for',
    );
  });

  it('promotes the verdict, the summary a person reads, and the findings a publication decides on one at a time', () => {
    const promoted = (task?.promoteOutputs ?? []).map((p) => ('toState' in p ? p.toState : ''));
    expect(promoted).toEqual(['verdict', 'reviewSummary', 'findings']);
    const declared = (wf.stateVariables ?? []).map((v) => v.variableId);
    expect(declared).toEqual(['verdict', 'reviewSummary', 'findings']);
    for (const id of promoted) expect(declared).toContain(id);
    // The summary stays the review as it is reported; the findings are for a run to act on.
    expect(wf.output?.primary).toBe('verdict');
  });

  it('makes the summary self-sufficient, in the schema and in the task prose', () => {
    const summary = (template?.outputSchema as { properties: Record<string, SchemaField> })
      .properties['summary'];
    expect(summary?.maxLength).toBe(16000);
    expect(summary?.description).toContain('file:line');
    expect(template?.task).toContain('Write the summary as the deliverable');
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
