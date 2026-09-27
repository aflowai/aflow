import { describe, expect, it } from 'vitest';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  deriveOpBoundProducerShapes,
  validateAgentOpTaskOnlyTools,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
import {
  GoldenCaseContentSchema,
  SkillComposeBundleSchema,
  isEvalPlaneOperation,
  toJsonSchemaSync,
  type WorkflowTask,
} from '@aflow/schemas';

const SLUG = 'eval-suite-design';

describe('EVAL_SUITE_DESIGN', () => {
  const entry = getSkillCatalogEntry(SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${SLUG}" not found`);
  }
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id);

  it('parses as a SkillComposeBundle workflow', () => {
    const parsed = SkillComposeBundleSchema.safeParse(entry.bundle);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes validateWorkflowGraph after materialization', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    expect(validateWorkflowGraph(tasks, wf.stateVariables)).toEqual([]);
  });

  it('keeps the op-task-only proposal off every agent tool surface', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks as unknown as WorkflowTask[])).toBeNull();
  });

  it('drafts, then proposes — and can read both documents it grounds cases in', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(new Set(['design', 'propose']));
    expect(task('propose')?.dependsOn).toEqual(['design']);
    // Neither read can be an operation task: both are general read ops whose
    // inline handlers emit no workflowExecution-correlated result, so the
    // dispatcher refuses them on the workflow-task safelist.
    const ops = task('design')?.context?.capabilities?.operations ?? [];
    expect(ops).toContain('workflow.manage.get');
    expect(ops).toContain('integration.simulation.get');
  });

  it('lets a caller pass every run input it declares', () => {
    // The entry task's contract is the callable surface. A run input missing
    // from it is rejected at start with UNKNOWN_BINDAS, however correctly the
    // workflow declares it in runInputs — the skill is simply un-startable.
    const entry = wf.tasks.find((t) => !t.dependsOn || t.dependsOn.length === 0);
    const declared = Object.keys(entry?.inputContract?.bindings ?? {}).sort();
    expect(declared).toEqual((wf.runInputs ?? []).map((i) => i.id).sort());
  });

  it('grants every operation its own prompt tells the agent to call', () => {
    // Prose naming a tool the task cannot call does not degrade gracefully: the
    // agent substitutes what it has and repeats it until the loop detector
    // stops the run.
    const design = task('design');
    const granted = new Set(design?.context?.capabilities?.operations ?? []);
    const named = new Set((design?.goal ?? '').match(/\b[a-z_]+\.[a-z_]+\.[a-z_]+\b/g) ?? []);
    const ungranted = [...named].filter((op) => !granted.has(op));
    expect(ungranted).toEqual([]);
  });

  it('carries no eval-plane capability beyond proposing', () => {
    // The authoring skill drafts the ruler; it must not be able to read a
    // measurement taken with it.
    for (const t of wf.tasks) {
      for (const op of t.context?.capabilities?.operations ?? []) {
        expect(isEvalPlaneOperation(op)).toBe(false);
      }
    }
    expect(task('propose')?.operation).toBe('eval.case.propose');
  });

  it('derives the case contract from the schema the write path validates', () => {
    // A hand-mirrored shape drifts, and the drift surfaces as an operator
    // ratifying nothing: the model emits a case the gate cannot parse.
    const schema = task('design')?.outputContract?.schema as unknown as {
      properties: { cases: { items: unknown } };
    };
    const warn = console.warn;
    console.warn = () => {};
    const derived = toJsonSchemaSync(GoldenCaseContentSchema);
    console.warn = warn;
    expect(schema.properties.cases.items).toEqual(derived);
  });
});
