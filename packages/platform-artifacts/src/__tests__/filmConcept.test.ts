/**
 * The concept skill, held to the same graph checks as every other catalog
 * skill — plus the invariant that makes it this skill: the zero-spend claim
 * is the capability list, not the prompt.
 */
import { describe, expect, it } from 'vitest';
import { deriveOpBoundProducerShapes, validateWorkflowGraph } from '@aflow/cybernetic-runtime';
import { SkillComposeBundleSchema, type WorkflowTask } from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';

const SKILL_ID = 'film-concept';

describe('FILM_CONCEPT', () => {
  const entry = getSkillCatalogEntry(SKILL_ID);
  if (!entry) throw new Error(`skill catalog entry "${SKILL_ID}" not found`);
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((candidate) => candidate.taskId === id);

  it('parses as a SkillComposeBundle workflow', () => {
    const parsed = SkillComposeBundleSchema.safeParse(entry.bundle);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes validateWorkflowGraph after Phase D materialization', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    expect(validateWorkflowGraph(tasks, wf.stateVariables, wf.output)).toEqual([]);
  });

  it('is a two-task line: stage, then pitch', () => {
    expect(wf.tasks.map((candidate) => candidate.taskId)).toEqual([
      'stage-concept',
      'summarise-concept',
    ]);
    expect(task('summarise-concept')?.dependsOn).toEqual(['stage-concept']);
  });

  it('spends nothing, structurally — no render operation exists in the pass', () => {
    const capabilities = task('stage-concept')?.context?.capabilities as {
      operations: string[];
    };
    for (const op of capabilities.operations) {
      expect(op, 'no media operation in the concept pass').not.toMatch(/^ai\.media\./);
    }
    // And no other paid generation surface either.
    expect(capabilities.operations).toEqual([
      'ui.applet.get',
      'ui.applet.act',
      'agent.control.signal_blocked',
    ]);
    const summary = task('summarise-concept')?.context?.capabilities as { operations: string[] };
    expect(summary.operations).toEqual([]);
  });

  it('every task_output binding names a path its producer declares', () => {
    for (const consumer of wf.tasks) {
      for (const [key, binding] of Object.entries(consumer.inputBindings ?? {})) {
        const bound = binding as { kind: string; taskId?: string; path?: string };
        if (bound.kind !== 'task_output') continue;
        const producer = task(bound.taskId ?? '');
        const declared = producer?.outputContract?.schema as
          { properties?: Record<string, unknown> } | undefined;
        expect(
          Object.keys(declared?.properties ?? {}),
          `${consumer.taskId} binds ${key} from ${String(bound.taskId)}`,
        ).toContain(bound.path);
      }
    }
  });

  it('every run_input binding names a declared run input', () => {
    const inputs = new Set(wf.runInputs?.map((input) => input.id) ?? []);
    for (const candidate of wf.tasks) {
      for (const [key, binding] of Object.entries(candidate.inputBindings ?? {})) {
        const bound = binding as { kind: string; path?: string };
        if (bound.kind !== 'run_input') continue;
        expect(inputs.has(bound.path ?? ''), `${candidate.taskId} binding ${key}`).toBe(true);
      }
    }
  });

  it('refuses to be auto-retried — a re-entered pass mints duplicate story', () => {
    expect(task('stage-concept')?.retryability).toBe('unsafe');
  });

  it('names no spend ceiling, because there is nothing to spend', () => {
    const inputs = new Set(wf.runInputs?.map((input) => input.id) ?? []);
    expect(inputs.has('maxRenders')).toBe(false);
    expect(inputs.has('maxShots')).toBe(false);
  });

  it('the outcome and the relayed records come from the pass, not the pitch', () => {
    const promoted = (task('stage-concept')?.promoteOutputs ?? []).map(
      (promotion) => (promotion as { toState: string }).toState,
    );
    expect(promoted).toEqual(['unexplained', 'decisions', 'undone']);
    const summaryPromoted = (task('summarise-concept')?.promoteOutputs ?? []).map(
      (promotion) => (promotion as { toState: string }).toState,
    );
    expect(summaryPromoted).toEqual(['headline']);
  });

  it('promotes every metric its outcomes evaluate', () => {
    const promoted = new Set(
      wf.tasks.flatMap((candidate) =>
        (candidate.promoteOutputs ?? []).map((promotion) => promotion.toState),
      ),
    );
    const declared = new Set(wf.stateVariables?.map((variable) => variable.variableId) ?? []);
    for (const outcome of wf.outcomes ?? []) {
      const metric = (outcome.evaluator as { metric?: string }).metric ?? '';
      expect(promoted.has(metric), `outcome ${outcome.id} metric promoted`).toBe(true);
      expect(declared.has(metric), `outcome ${outcome.id} metric declared`).toBe(true);
    }
  });
});
