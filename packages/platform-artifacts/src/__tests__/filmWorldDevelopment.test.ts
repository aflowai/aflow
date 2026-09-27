/**
 * The world-development skill, held to the same graph checks as every other
 * catalog skill — plus the one invariant that makes it this skill: the seam
 * between authoring a world and paying to photograph it is the capability
 * list, not the prompt.
 */
import { describe, expect, it } from 'vitest';
import { deriveOpBoundProducerShapes, validateWorkflowGraph } from '@aflow/cybernetic-runtime';
import { SkillComposeBundleSchema, type WorkflowTask } from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';

const SKILL_ID = 'film-world-development';

describe('FILM_WORLD_DEVELOPMENT', () => {
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

  it('is a two-task line: develop in a loop, then report', () => {
    expect(wf.tasks.map((candidate) => candidate.taskId)).toEqual([
      'develop-world',
      'summarise-development',
    ]);
    expect(task('develop-world')?.type).toBe('agent');
    expect(task('summarise-development')?.dependsOn).toEqual(['develop-world']);
  });

  it('renders images and nothing that moves — the seam with the render skill is structural', () => {
    const capabilities = task('develop-world')?.context?.capabilities as {
      operations: string[];
    };
    expect(capabilities.operations).toContain('ai.media.image');
    for (const op of capabilities.operations) {
      expect(op, 'no video or animate operation in the world pass').not.toMatch(/video|animate/);
    }
    // The summary is pure synthesis: it cannot re-read the film and disagree
    // with the pass it is summarising.
    const summary = task('summarise-development')?.context?.capabilities as {
      operations: string[];
    };
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

  it('names its spend ceiling as a required input, and binds it', () => {
    const inputs = new Map(wf.runInputs?.map((input) => [input.id, input]) ?? []);
    expect(inputs.get('maxRenders')?.required).toBe(true);
    expect(task('develop-world')?.inputBindings?.['maxRenders']).toEqual({
      kind: 'run_input',
      path: 'maxRenders',
    });
  });

  it('takes the brief as a required input — the pass has no other creative authority', () => {
    const inputs = new Map(wf.runInputs?.map((input) => [input.id, input]) ?? []);
    expect(inputs.get('brief')?.required).toBe(true);
    expect(task('develop-world')?.inputBindings?.['brief']).toEqual({
      kind: 'run_input',
      path: 'brief',
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

  it('refuses to be auto-retried, because a retried pass re-buys unbound plates', () => {
    expect(task('develop-world')?.retryability).toBe('unsafe');
  });

  it('reports decisions as their own contract member, not prose in a headline', () => {
    // The decisions are the operator's redirection surface — a schema member
    // survives summarisation; a paragraph does not.
    for (const id of ['develop-world', 'summarise-development']) {
      const schema = task(id)?.outputContract?.schema as {
        required: string[];
        properties: Record<string, unknown>;
      };
      expect(schema.required, id).toContain('decisions');
    }
  });

  it('can report a pass that authored nothing because nothing was missing', () => {
    const schema = task('summarise-development')?.outputContract?.schema as {
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
});
