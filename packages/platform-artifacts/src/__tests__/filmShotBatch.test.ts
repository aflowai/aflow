/**
 * The batch skill, held to the same graph checks as every other catalog skill.
 *
 * The case this file exists for is the one a review caught and nothing else
 * would have: a task binding a path off an upstream agent task that never
 * declared one. Graph validation only checks a binding against a producer that
 * declares its ports, so an agent task without an output contract silently
 * resolves every path to nothing — and the consumer invents what it was
 * supposed to be reporting.
 */
import { describe, expect, it } from 'vitest';
import { deriveOpBoundProducerShapes, validateWorkflowGraph } from '@aflow/cybernetic-runtime';
import { SkillComposeBundleSchema, type WorkflowTask } from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';

const SKILL_ID = 'film-shot-batch';
const BUNDLE_ID = 'film-production';

describe('FILM_SHOT_BATCH', () => {
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

  it('is a two-task line: render in a loop, then summarise', () => {
    expect(wf.tasks.map((candidate) => candidate.taskId)).toEqual([
      'render-shots',
      'summarise-pass',
    ]);
    expect(task('render-shots')?.type).toBe('agent');
    expect(task('summarise-pass')?.type).toBe('agent');
    expect(task('summarise-pass')?.dependsOn).toEqual(['render-shots']);
  });

  it('every task_output binding names a path its producer declares', () => {
    // Graph validation cannot check this for an agent producer, so the check
    // is here: a path the producer never declares resolves to nothing at run
    // time, and the consumer reports whatever it decides to.
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

  it('names its spend ceiling as a required input, and binds it', () => {
    // Nothing in the platform bounds the tool calls of an agent task, and each
    // one here buys a render — so the ceiling is the operator's to state and
    // the pass has to be handed it.
    const inputs = new Map(wf.runInputs?.map((input) => [input.id, input]) ?? []);
    expect(inputs.get('maxShots')?.required).toBe(true);
    expect(task('render-shots')?.inputBindings?.['maxShots']).toEqual({
      kind: 'run_input',
      path: 'maxShots',
    });
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

  it('refuses to be auto-retried, because a retried loop re-buys what it had not recorded', () => {
    expect(task('render-shots')?.retryability).toBe('unsafe');
  });

  it('can report a pass that rendered nothing because nothing owed a take', () => {
    // The zero-spend pass is the outcome this skill exists to protect, so the
    // shape it reports itself in has to be able to express it.
    const schema = task('summarise-pass')?.outputContract?.schema as {
      properties: Record<string, { minimum?: number }>;
    };
    expect(schema.properties['unexplained']?.minimum).toBe(0);
    const outcome = wf.outcomes?.[0]?.evaluator as { metric: string; operator: string };
    expect(outcome.metric).toBe('unexplained');
    expect(outcome.operator).toBe('lte');
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

  it('ships in a bundle that installs both film skills, in the order the work happens', () => {
    const bundle = getSkillBundleEntry(BUNDLE_ID);
    expect(bundle?.skillCatalogIds).toEqual(['film-concept', 'film-world-development', SKILL_ID]);
    // A render reaches its provider through the platform's own media
    // operations, so a binding here would be a second way to reach one route.
    expect(bundle?.apiDefinitions ?? []).toEqual([]);
    expect(bundle?.apiBindingTemplates ?? []).toEqual([]);
  });
});
