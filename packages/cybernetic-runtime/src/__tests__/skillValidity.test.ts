import { describe, it, expect } from 'vitest';
import type { WorkflowTask, SkillValidity } from '@aflow/schemas';
import { computeSkillReadiness } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import {
  materializeAndValidateSkillConfig,
  materializeSkillTasks,
  ensureCurrentSkillValidity,
  ensureWorkflowDocValidity,
  computeQualityAdvisories,
  hashWorkflowConfig,
  cachedOrRecomputeValidity,
  selectIneligibleTaskCriteria,
} from '../skillValidity/skillValidity.js';

function agent(taskId: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'agent', ...partial };
}
function opTask(taskId: string, operation: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'operation', operation, ...partial };
}

describe('Plan 190 — materializeAndValidateSkillConfig', () => {
  it('returns valid for a coherent config', () => {
    const { validity } = materializeAndValidateSkillConfig({ tasks: [agent('do-thing')] });
    expect(validity.status).toBe('valid');
    expect(validity.diagnostics).toHaveLength(0);
    expect(validity.validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('flags an unsatisfiable op-input contract with a structured op_input diagnostic', () => {
    // `workflow.learn` requires `learnings`; the op task supplies neither a
    // literal nor a binding, and derivation has no producer to fill it.
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [opTask('record', 'workflow.learn')],
    });
    expect(validity.status).toBe('invalid');
    const missing = validity.diagnostics.find((d) => d.code === 'op_input_missing_required');
    expect(missing).toBeDefined();
    expect(missing!.dimension).toBe('op_input');
    expect(missing!.severity).toBe('error');
    expect(missing!.taskId).toBe('record');
    expect(missing!.operationId).toBe('workflow.learn');
  });

  it('routes an unknown platform operation to an op_input diagnostic', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [opTask('x', 'workflow.does_not_exist')],
    });
    expect(validity.status).toBe('invalid');
    expect(validity.diagnostics.some((d) => d.code === 'op_unknown')).toBe(true);
  });

  it('runs bundle-level eval-linkage checks only when bundle context is supplied', () => {
    const tasks = [agent('only-task')];

    // Without bundle context: tasks-only contract (no eval linkage check).
    expect(materializeAndValidateSkillConfig({ tasks }).validity.status).toBe('valid');

    // A dead taskCriteria key is advisory, not invalidating.
    const { validity } = materializeAndValidateSkillConfig({
      tasks,
      bundle: { taskCriteria: { 'ghost-task': [] } },
    });
    expect(validity.status).toBe('valid');
    const evalDiag = validity.advisories.find((d) => d.code === 'eval_unknown_task');
    expect(evalDiag?.dimension).toBe('eval_linkage');
    expect(evalDiag?.taskId).toBe('ghost-task');
  });

  it('fails closed with a parse diagnostic when tasks is not an array (no crash)', () => {
    // A JSON-valid-but-malformed persisted doc must yield an actionable verdict
    const { materializedTasks, validity } = materializeAndValidateSkillConfig({
      tasks: undefined as unknown as WorkflowTask[],
    });
    expect(validity.status).toBe('invalid');
    expect(materializedTasks).toEqual([]);
    expect(validity.diagnostics[0]?.dimension).toBe('parse');
    expect(validity.diagnostics[0]?.code).toBe('tasks_not_array');
  });

  it('populates the structured `field` for op-input diagnostics', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [opTask('record', 'workflow.learn')],
    });
    const missing = validity.diagnostics.find((d) => d.code === 'op_input_missing_required');
    expect(missing?.field).toBe('learnings');
  });

  it('does not mislabel a missing-dependency target as producerTaskId', () => {
    // `missing_dep` taskIds = [task, depId]; depId is a missing dependency, not
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('a', { dependsOn: ['ghost'] })],
    });
    const dep = validity.diagnostics.find((d) => d.code === 'missing_dep');
    expect(dep).toBeDefined();
    expect(dep!.producerTaskId).toBeUndefined();
  });

  it('sets producerTaskId for a dataflow binding error', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        opTask('record', 'workflow.learn', {
          inputBindings: {
            learnings: { kind: 'task_output', taskId: 'ghost-producer', path: 'learnings' },
          },
        }),
      ],
    });
    const dangler = validity.diagnostics.find((d) => d.code === 'binding_dangling_task_ref');
    expect(dangler?.producerTaskId).toBe('ghost-producer');
    expect(dangler?.field).toBe('learnings');
  });

  it('materializes (derives) op-bound producer shapes on the returned tasks', () => {
    const producer = agent('extract', { produces: [{ key: 'learnings' }] });
    const consumer = opTask('record', 'workflow.learn', {
      dependsOn: ['extract'],
      inputBindings: {
        learnings: { kind: 'task_output', taskId: 'extract', path: 'learnings' },
      },
    });
    const { materializedTasks, validity } = materializeAndValidateSkillConfig({
      tasks: [producer, consumer],
    });
    // Derivation fills the agent producer's `learnings` port from the op's
    // required shape — the contract is coherent by construction.
    expect(validity.status).toBe('valid');
    const derivedProducer = materializedTasks.find((t) => t.taskId === 'extract');
    const port = derivedProducer?.produces?.find((p) => p.key === 'learnings');
    expect(port?.shape).toBeDefined();
  });
});

describe('Plan 190 Slice 5a — materializeSkillTasks (derive-only, execution resolve)', () => {
  it('derives op-bound producer shapes without running the validator', () => {
    const producer = agent('extract', { produces: [{ key: 'learnings' }] });
    const consumer = opTask('record', 'workflow.learn', {
      dependsOn: ['extract'],
      inputBindings: {
        learnings: { kind: 'task_output', taskId: 'extract', path: 'learnings' },
      },
    });
    const out = materializeSkillTasks([producer, consumer]);
    const derivedProducer = out.find((t) => t.taskId === 'extract');
    expect(derivedProducer?.produces?.find((p) => p.key === 'learnings')?.shape).toBeDefined();
  });

  it('is fail-soft: returns the input unchanged on a non-array input (never throws)', () => {
    const notTasks = undefined as unknown as WorkflowTask[];
    expect(materializeSkillTasks(notTasks)).toBe(notTasks);
  });
});

describe('Plan 195 §4.7.2 — entry_inputs_undeclared advisory', () => {
  it('flags uncovered entry-task run_input bindings as a non-blocking advisory', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        agent('entry', {
          inputBindings: {
            competitionSlug: { kind: 'run_input', path: 'competitionSlug' },
            forceRedownload: { kind: 'run_input', path: 'forceRedownload' },
          },
        }),
        agent('downstream', { dependsOn: ['entry'] }),
      ],
    });
    // Advisory tier — never blocks (promotion to blocking is the campaign layer).
    expect(validity.status).toBe('valid');
    expect(validity.diagnostics).toHaveLength(0);
    const adv = validity.advisories.find((d) => d.code === 'entry_inputs_undeclared');
    expect(adv).toBeDefined();
    expect(adv!.severity).toBe('advisory');
    expect(adv!.dimension).toBe('graph');
    expect(adv!.taskId).toBe('entry');
    expect(adv!.detail).toContain('competitionSlug');
    expect(adv!.detail).toContain('forceRedownload');
  });

  it('partial coverage names only the uncovered bindAs', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        agent('entry', {
          inputBindings: {
            covered: { kind: 'run_input', path: 'covered' },
            uncovered: { kind: 'run_input', path: 'uncovered' },
          },
          inputContract: {
            bindings: {
              covered: {
                kind: 'run_input',
                bindAs: 'covered',
                path: 'covered',
                schema: { type: 'string' },
              },
            },
          },
        }),
      ],
    });
    const adv = validity.advisories.find((d) => d.code === 'entry_inputs_undeclared');
    expect(adv).toBeDefined();
    expect(adv!.detail).toContain('uncovered');
    expect(adv!.detail).not.toContain('[covered');
  });

  it('does not flag fully covered entry tasks or non-entry run_input bindings', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        agent('entry', {
          inputBindings: { slug: { kind: 'run_input', path: 'slug' } },
          inputContract: {
            bindings: {
              slug: { kind: 'run_input', bindAs: 'slug', path: 'slug', schema: { type: 'string' } },
            },
          },
        }),
        // Non-entry task with an uncovered run_input binding — out of scope
        // for this rule (only the entry task is the parent-typed-input surface).
        agent('later', {
          dependsOn: ['entry'],
          inputBindings: { extra: { kind: 'run_input', path: 'extra' } },
        }),
      ],
    });
    expect(validity.advisories.filter((d) => d.code === 'entry_inputs_undeclared')).toEqual([]);
  });

  it('the campaign-driven Kaggle skill is valid (config comes from the campaign, not per-run inputs)', () => {
    const entry = getSkillCatalogEntry('kaggle-competition-optimizer');
    expect(entry).toBeDefined();
    const { validity } = materializeAndValidateSkillConfig({
      tasks: entry!.bundle.workflow.tasks as WorkflowTask[],
      stateVariables: entry!.bundle.workflow.stateVariables,
    });
    expect(validity.status).toBe('valid');
    expect(validity.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('Plan 190 — ensureCurrentSkillValidity (read side)', () => {
  it('recomputes the verdict from current config (fail-closed, no stamp)', () => {
    expect(ensureCurrentSkillValidity({ tasks: [agent('ok')] }).status).toBe('valid');
    expect(ensureCurrentSkillValidity({ tasks: [opTask('record', 'workflow.learn')] }).status).toBe(
      'invalid',
    );
  });
});

// ============================================================================

function workflowDoc(tasks: WorkflowTask[]): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    slug: 'demo',
    name: 'Demo',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'done' } }],
    mode: 'process',
    tasks,
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    stateVariables: [],
    revision: 1,
    status: 'approved',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
  };
}

describe('Plan 190 §8 — ensureWorkflowDocValidity (surface read)', () => {
  it('fails closed with a parse diagnostic for a missing / unparseable doc', () => {
    const v = ensureWorkflowDocValidity(null);
    expect(v.status).toBe('invalid');
    expect(v.diagnostics[0]?.dimension).toBe('parse');
  });

  it('fails closed with a parse diagnostic for a structurally-invalid doc', () => {
    const v = ensureWorkflowDocValidity({ slug: 'x', tasks: 'not-an-array' });
    expect(v.status).toBe('invalid');
    expect(v.diagnostics[0]?.dimension).toBe('parse');
  });

  it('recomputes the contract verdict for a parseable doc (the kind-class bug still bites)', () => {
    const valid = ensureWorkflowDocValidity(workflowDoc([agent('do-thing')]));
    expect(valid.status).toBe('valid');

    const broken = ensureWorkflowDocValidity(workflowDoc([opTask('record', 'workflow.learn')]));
    expect(broken.status).toBe('invalid');
    expect(broken.diagnostics.some((d) => d.code === 'op_input_missing_required')).toBe(true);
  });

  it('carries a no_capability_declarations quality advisory on a valid-but-bare skill', () => {
    const v = ensureWorkflowDocValidity(workflowDoc([agent('do-thing')]));
    expect(v.status).toBe('valid');
    expect(v.advisories.some((a) => a.code === 'no_capability_declarations')).toBe(true);
  });
});

describe('Plan 190 §8 — computeQualityAdvisories', () => {
  it('flags a workflow where no task declares capabilities', () => {
    expect(
      computeQualityAdvisories([agent('a')]).some((d) => d.code === 'no_capability_declarations'),
    ).toBe(true);
  });

  it('does not flag a workflow with at least one capability-declaring task', () => {
    const withCaps = agent('a', {
      context: {
        strategy: 'scoped',
        learnings: 'active',
        capabilities: { operations: [] },
      } as never,
    });
    expect(computeQualityAdvisories([withCaps])).toHaveLength(0);
  });
});

// ============================================================================

// ============================================================================

/** An agent task with a CLOSED outputContract declaring exactly `fields`. */
function closedAgent(
  taskId: string,
  fields: string[],
  partial?: Partial<WorkflowTask>,
): WorkflowTask {
  return agent(taskId, {
    outputContract: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: fields,
        properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])),
      },
    },
    ...partial,
  });
}

describe('selectIneligibleTaskCriteria — measurement-participation gate', () => {
  it('marks every criterion of an unknown task ineligible', () => {
    const out = selectIneligibleTaskCriteria([agent('real')], {
      ghost: [
        { name: 'a', type: 'threshold', metric: 'm', operator: 'gt', target: 0 },
        { name: 'b', type: 'contains', inField: 'f', pattern: 'x' },
      ],
    });
    expect(out).toEqual(new Set(['ghost a', 'ghost b']));
  });

  it('marks a criterion bound to a field a closed output never yields', () => {
    const out = selectIneligibleTaskCriteria([closedAgent('poll', ['lbValue'])], {
      poll: [
        { name: 'good', type: 'threshold', metric: 'lbValue', operator: 'gt', target: 0 },
        { name: 'dead', type: 'threshold', metric: 'ghost', operator: 'gt', target: 0 },
      ],
    });
    expect(out).toEqual(new Set(['poll dead']));
  });

  it('never excludes a criterion on an open / undeclared output', () => {
    const out = selectIneligibleTaskCriteria([agent('execute')], {
      execute: [{ name: 'x', type: 'contains', inField: 'anything', pattern: 'y' }],
    });
    expect(out.size).toBe(0);
  });
});

describe('Plan 190 Slice 4 — eval ↔ output-field linkage (eval_linkage)', () => {
  it('flags a criterion bound to a field absent from a closed task output (the market-briefing bug class)', () => {
    // synthesize-briefing produces {briefingPath}; a criterion bound to a
    // non-existent field can never pass → false fault=agent at runtime.
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [closedAgent('synthesize', ['briefingPath'])],
      bundle: {
        taskCriteria: {
          synthesize: [
            { name: 'path-emitted', type: 'contains', inField: 'briefingPathh', pattern: 'x' },
          ],
        },
      },
    });
    expect(validity.status).toBe('valid');
    const diag = validity.advisories.find((d) => d.code === 'eval_field_not_produced');
    expect(diag?.dimension).toBe('eval_linkage');
    expect(diag?.taskId).toBe('synthesize');
    expect(diag?.field).toBe('briefingPathh');
  });

  it("accepts the reserved 'summary' field (the real market-briefing pattern stays valid)", () => {
    // `inField: 'summary'` resolves to the task summary string at runtime
    // (CONTAINS_RESERVED_FIELDS) — never the non-existent-field bug.
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [closedAgent('synthesize', ['briefingPath'])],
      bundle: {
        taskCriteria: {
          synthesize: [
            { name: 'path-emitted', type: 'contains', inField: 'summary', pattern: 'briefing.md' },
          ],
        },
      },
    });
    expect(validity.status).toBe('valid');
  });

  it('does not flag a field on an open / undeclared task output (absence unprovable)', () => {
    // No outputContract ⇒ the field may exist at runtime (kaggle execute /
    // validationScore). Conservative: never flag.
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('execute')],
      bundle: {
        taskCriteria: {
          execute: [
            { name: 'validation', type: 'contains', inField: 'validationScore', pattern: '\\d' },
          ],
        },
      },
    });
    expect(validity.status).toBe('valid');
  });

  it('accepts a threshold metric present in the closed output, flags an absent one', () => {
    const present = materializeAndValidateSkillConfig({
      tasks: [closedAgent('poll', ['lbValue'])],
      bundle: {
        taskCriteria: {
          poll: [
            { name: 'target', type: 'threshold', metric: 'lbValue', operator: 'gt', target: 0 },
          ],
        },
      },
    });
    expect(present.validity.status).toBe('valid');

    const absent = materializeAndValidateSkillConfig({
      tasks: [closedAgent('poll', ['lbValue'])],
      bundle: {
        taskCriteria: {
          poll: [
            { name: 'target', type: 'threshold', metric: 'ghostMetric', operator: 'gt', target: 0 },
          ],
        },
      },
    });
    expect(absent.validity.status).toBe('valid');
    expect(absent.validity.advisories.some((d) => d.code === 'eval_field_not_produced')).toBe(true);
  });
});

describe('Plan 190 Slice 4 — manifest ref coherence (ref)', () => {
  it('flags a workflowSlug that does not match the bundled workflow', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('a')],
      bundle: {
        manifestRefs: { workflowSlug: 'wrong-slug' },
        artifacts: { workflowSlug: 'real-slug' },
      },
    });
    const diag = validity.diagnostics.find((d) => d.code === 'dangling_workflow_ref');
    expect(diag?.dimension).toBe('ref');
  });

  it('flags an evalSuiteRef the bundle does not carry', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('a')],
      bundle: {
        manifestRefs: { evalSuiteRef: '/evals/demo/suite.json' },
        artifacts: { hasEvalSuite: false },
      },
    });
    expect(validity.diagnostics.some((d) => d.code === 'dangling_eval_suite_ref')).toBe(true);
  });

  it('accepts refs that resolve against the bundle', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('a')],
      bundle: {
        manifestRefs: {
          workflowSlug: 's',
          evalSuiteRef: '/evals/s/suite.json',
          activationRef: '/x',
        },
        artifacts: { workflowSlug: 's', hasEvalSuite: true, hasActivation: true },
      },
    });
    expect(validity.diagnostics.some((d) => d.dimension === 'ref')).toBe(false);
  });
});

describe('Plan 190 Slice 4 — capability grant well-formedness (capability)', () => {
  function agentWithOps(taskId: string, operations: string[]): WorkflowTask {
    return agent(taskId, {
      context: { strategy: 'scoped', learnings: 'active', capabilities: { operations } } as never,
    });
  }

  it('flags an agent granting an unknown platform operation', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agentWithOps('a', ['memory.store.bogus'])],
      bundle: {},
    });
    const diag = validity.diagnostics.find((d) => d.code === 'capability_unknown_operation');
    expect(diag?.dimension).toBe('capability');
    expect(diag?.operationId).toBe('memory.store.bogus');
  });

  it('accepts a real platform op and ignores external (non-platform) prefixes', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agentWithOps('a', ['memory.store.put', 'stripe.charges.create'])],
      bundle: {},
    });
    expect(validity.diagnostics.some((d) => d.dimension === 'capability')).toBe(false);
  });
});

describe('Plan 190 Slice 4 — removed/renamed op field strictness (op_input)', () => {
  it('flags a literal bound to a field the op does not declare', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [opTask('record', 'workflow.learn', { inputs: { learnings: [], removedField: 1 } })],
    });
    const diag = validity.diagnostics.find((d) => d.code === 'op_input_undeclared_field');
    expect(diag?.dimension).toBe('op_input');
    expect(diag?.taskId).toBe('record');
    expect(diag?.field).toBe('removedField');
  });

  it('does not false-flag the harness-injected workflowExecution envelope key', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        opTask('record', 'workflow.learn', {
          inputs: { learnings: [], workflowExecution: { runId: 'r', taskId: 't', attempt: 1 } },
        }),
      ],
    });
    expect(validity.diagnostics.some((d) => d.code === 'op_input_undeclared_field')).toBe(false);
  });
});

describe('Plan 190 §6 — computeSkillReadiness', () => {
  const validVerdict = {
    status: 'valid' as const,
    diagnostics: [],
    advisories: [],
    validatedAt: '2026-06-09T00:00:00.000Z',
  };
  const invalidVerdict = {
    status: 'invalid' as const,
    diagnostics: [
      {
        code: 'op_unknown',
        dimension: 'op_input' as const,
        severity: 'error' as const,
        detail: 'x',
      },
    ],
    advisories: [],
    validatedAt: '2026-06-09T00:00:00.000Z',
  };

  it('canRun only when contract-valid AND activation active', () => {
    expect(
      computeSkillReadiness({ contractValidity: validVerdict, activationStatus: 'active' }),
    ).toEqual({
      contractValid: true,
      canRun: true,
      canShow: true,
      needsSetup: false,
    });
  });

  it('valid + needs_binding ⇒ needsSetup, not canRun', () => {
    const r = computeSkillReadiness({
      contractValidity: validVerdict,
      activationStatus: 'needs_binding',
    });
    expect(r.canRun).toBe(false);
    expect(r.needsSetup).toBe(true);
    expect(r.canShow).toBe(true);
  });

  it('contract-invalid ⇒ neither canRun nor needsSetup, but still shown', () => {
    const r = computeSkillReadiness({
      contractValidity: invalidVerdict,
      activationStatus: 'active',
    });
    expect(r).toEqual({ contractValid: false, canRun: false, canShow: true, needsSetup: false });
  });

  it('fail-closed on a missing verdict (never valid by omission)', () => {
    const r = computeSkillReadiness({ activationStatus: 'active' });
    expect(r.contractValid).toBe(false);
    expect(r.canRun).toBe(false);
  });

  it('archived / dormant ⇒ not canShow and not needsSetup (lifecycle, not a setup gap)', () => {
    for (const activationStatus of ['archived', 'dormant'] as const) {
      const r = computeSkillReadiness({ contractValidity: validVerdict, activationStatus });
      expect(r.canShow).toBe(false);
      expect(r.needsSetup).toBe(false);
    }
  });

  it('degraded ⇒ needsSetup (valid skill, broken grant — operator-fixable)', () => {
    const r = computeSkillReadiness({
      contractValidity: validVerdict,
      activationStatus: 'degraded',
    });
    expect(r.needsSetup).toBe(true);
    expect(r.canRun).toBe(false);
  });
});

// ============================================================================

describe('Plan 190 Slice 5b — hashWorkflowConfig', () => {
  it('is stable: the same config hashes the same', () => {
    const tasks = [agent('a'), opTask('b', 'workflow.learn')];
    expect(hashWorkflowConfig(tasks, [])).toBe(hashWorkflowConfig(tasks, []));
  });

  it('is canonical: object key order does not change the hash', () => {
    const a = { taskId: 'x', name: 'x', goal: 'g', type: 'agent' };
    const b = { type: 'agent', goal: 'g', name: 'x', taskId: 'x' };
    expect(hashWorkflowConfig([a], [])).toBe(hashWorkflowConfig([b], []));
  });

  it('busts on a real task change', () => {
    const before = hashWorkflowConfig([agent('a')], []);
    const after = hashWorkflowConfig([agent('a', { goal: 'changed' })], []);
    expect(after).not.toBe(before);
  });

  it('busts on a stateVariables change', () => {
    const tasks = [agent('a')];
    expect(hashWorkflowConfig(tasks, [{ name: 's', type: 'string' }])).not.toBe(
      hashWorkflowConfig(tasks, []),
    );
  });

  it('does NOT bust on a cosmetic doc-level field change (hashes tasks + stateVariables only)', () => {
    // The caller passes only `doc.tasks` / `doc.stateVariables`, so a change to
    // `updatedAt` / `revision` / `name` never reaches the hash — no spurious bust.
    const docA = workflowDoc([agent('a')]);
    const docB = {
      ...workflowDoc([agent('a')]),
      updatedAt: '2099-12-31T00:00:00.000Z',
      revision: 99,
      name: 'Renamed Skill',
    };
    expect(hashWorkflowConfig(docB['tasks'], docB['stateVariables'])).toBe(
      hashWorkflowConfig(docA['tasks'], docA['stateVariables']),
    );
  });
});

describe('Plan 190 Slice 5b — cachedOrRecomputeValidity', () => {
  // A deliberately STALE sentinel verdict: it says `valid`, but the paired
  // config (the kind bug) recomputes to `invalid`. So a returned `valid` proves
  // the cache short-circuited derive+validate; a returned `invalid` proves a
  // fresh recompute happened.
  const STALE_VALID: SkillValidity = {
    status: 'valid',
    diagnostics: [],
    advisories: [],
    validatedAt: '2000-01-01T00:00:00.000Z',
  };
  // `workflow.learn` with no producer for `learnings` ⇒ recompute is `invalid`.
  const brokenDoc = workflowDoc([opTask('record', 'workflow.learn')]);

  it('cache HIT: returns the cached verdict (no recompute) when the hash matches', () => {
    const hash = hashWorkflowConfig(brokenDoc['tasks'], brokenDoc['stateVariables']);
    const result = cachedOrRecomputeValidity(brokenDoc, {
      contractValidity: STALE_VALID,
      contractValidityHash: hash,
    });
    expect(result).toBe(STALE_VALID); // same object — derive+validate was skipped
    expect(result.status).toBe('valid'); // the cached value, not the true `invalid`
  });

  it('cache MISS: recomputes the true verdict when the hash does not match', () => {
    const result = cachedOrRecomputeValidity(brokenDoc, {
      contractValidity: STALE_VALID,
      contractValidityHash: 'stale-hash-from-an-older-config',
    });
    expect(result).not.toBe(STALE_VALID);
    expect(result.status).toBe('invalid'); // freshly recomputed truth
    expect(result.diagnostics.some((d) => d.code === 'op_input_missing_required')).toBe(true);
  });

  it('recomputes when no hash is persisted (never trust a hashless cached verdict)', () => {
    const result = cachedOrRecomputeValidity(brokenDoc, { contractValidity: STALE_VALID });
    expect(result.status).toBe('invalid');
  });

  it('recomputes when no verdict is persisted at all', () => {
    const result = cachedOrRecomputeValidity(brokenDoc, { contractValidityHash: 'whatever' });
    expect(result.status).toBe('invalid');
  });

  it('fail-closed (parse-invalid) when the workflow doc is absent', () => {
    const result = cachedOrRecomputeValidity(null, {
      contractValidity: STALE_VALID,
      contractValidityHash: 'x',
    });
    expect(result.status).toBe('invalid');
    expect(result.diagnostics[0]?.dimension).toBe('parse');
  });

  it('round-trips: a fresh reconcile-style hash matches the surface recompute hash', () => {
    // Mirrors the producer (reconciler) ↔ consumer (surface) contract: both read
    // the same raw doc, so a hash stamped from `doc.tasks/stateVariables` matches
    // the surface's fresh hash and the cached verdict is used verbatim.
    const validDoc = workflowDoc([agent('do-thing')]);
    const reconcilerHash = hashWorkflowConfig(validDoc['tasks'], validDoc['stateVariables']);
    const cachedVerdict = ensureWorkflowDocValidity(validDoc);
    const surfaced = cachedOrRecomputeValidity(validDoc, {
      contractValidity: cachedVerdict,
      contractValidityHash: reconcilerHash,
    });
    expect(surfaced).toBe(cachedVerdict);
  });
});

describe('Plan 203 — optimization archetype coherence', () => {
  const metricVar = {
    variableId: 'lbValue',
    name: 'Leaderboard score',
    required: false,
    sensitive: false,
    immutable: false,
  };
  // Agent "observe" task: carries the campaign_input binding + promoteOutputs
  // (agents skip the op-input contract, keeping these tests focused on the
  // archetype checks rather than api.http.call's input shape).
  const observe = agent('observe', {
    inputBindings: { slug: { kind: 'campaign_input', path: 'competitionSlug' } },
    promoteOutputs: [{ kind: 'output_path', path: 'lbValue', toState: 'lbValue' }],
  });
  const goal = { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' } as const;
  // A campaign-contracted skill's bar lives on the campaign — the threshold
  // target must be a $campaign ref, not a literal (Plan 195 §1b).
  const outcomes = [
    {
      id: 'g',
      name: 'Goal',
      evaluator: {
        type: 'threshold',
        metric: 'lbValue',
        operator: 'gte',
        target: { $campaign: 'targetScore' },
      },
    },
  ] as const;
  const contract = {
    fields: {
      competitionSlug: { schema: { type: 'string' }, identity: true, label: 'Slug' },
      targetScore: { schema: { type: 'number' }, label: 'Target' },
    },
  };

  it('is valid with campaign + promoted metric + threshold + bound identity field', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [observe],
      stateVariables: [metricVar],
      mode: 'optimization',
      campaign: { contract, goal, outcomes: [...outcomes] },
    });
    expect(validity.status).toBe('valid');
  });

  it('flags optimization_missing_campaign when there is no campaign contract', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [observe],
      stateVariables: [metricVar],
      mode: 'optimization',
      campaign: { goal, outcomes: [...outcomes] },
    });
    expect(validity.diagnostics.map((d) => d.code)).toContain('optimization_missing_campaign');
  });

  it('flags optimization_goal_metric_unresolved when the metric is neither promoted nor thresholded', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        agent('observe', {
          inputBindings: { slug: { kind: 'campaign_input', path: 'competitionSlug' } },
        }),
      ],
      stateVariables: [],
      mode: 'optimization',
      campaign: { contract, goal, outcomes: [] },
    });
    expect(validity.status).toBe('invalid');
    expect(validity.diagnostics.some((d) => d.code === 'optimization_goal_metric_unresolved')).toBe(
      true,
    );
  });

  it('flags campaign_field_unbound when a declared identity field is never consumed', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        agent('observe', {
          promoteOutputs: [{ kind: 'output_path', path: 'lbValue', toState: 'lbValue' }],
        }),
      ],
      stateVariables: [metricVar],
      mode: 'optimization',
      campaign: { contract, goal, outcomes: [...outcomes] },
    });
    expect(validity.diagnostics.map((d) => d.code)).toContain('campaign_field_unbound');
  });

  it('skips the archetype checks entirely for non-optimization skills', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('x')],
      mode: 'process',
    });
    expect(validity.status).toBe('valid');
    expect(validity.diagnostics.map((d) => d.code)).not.toContain('optimization_missing_campaign');
  });
});

describe('Plan 301 — a declared run input a caller cannot pass', () => {
  const skill = (runInputs: { id: string; required: boolean }[]) => ({
    tasks: [
      agent('entry', {
        inputBindings: { seed: { kind: 'run_input' as const, path: 'seed' } },
        inputContract: {
          bindings: {
            seed: {
              kind: 'run_input' as const,
              bindAs: 'seed',
              path: 'seed',
              schema: { type: 'string' },
            },
          },
        },
      }),
      agent('downstream', { dependsOn: ['entry'] }),
    ],
    runInputs,
  });

  it('blocks when the unreachable slot is required — the skill cannot start at all', () => {
    const { validity } = materializeAndValidateSkillConfig(
      skill([
        { id: 'seed', required: true },
        { id: 'simulationId', required: true },
      ]),
    );
    expect(validity.status).toBe('invalid');
    const err = validity.diagnostics.find((d) => d.code === 'run_input_unreachable');
    expect(err?.severity).toBe('error');
    expect(err?.taskId).toBe('entry');
    expect(err?.detail).toContain('simulationId');
  });

  it('only advises when the slot is optional — the skill still runs without it', () => {
    const { validity } = materializeAndValidateSkillConfig(
      skill([
        { id: 'seed', required: true },
        { id: 'focus', required: false },
      ]),
    );
    expect(validity.status).toBe('valid');
    expect(validity.advisories.find((d) => d.code === 'run_input_unreachable')).toBeDefined();
  });

  it('reads the binding path, not the key it is bound as', () => {
    // A run input is identified by its binding's `path`; `bindAs` is the name
    // the task uses locally. Comparing against the key reports a working skill
    // as unstartable.
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [
        agent('entry', {
          inputBindings: { userGoal: { kind: 'run_input', path: 'goal' } },
          inputContract: {
            bindings: {
              userGoal: {
                kind: 'run_input',
                bindAs: 'userGoal',
                path: 'goal',
                schema: { type: 'string' },
              },
            },
          },
        }),
      ],
      runInputs: [{ id: 'goal', required: true }],
    });
    expect(
      [...validity.diagnostics, ...validity.advisories].filter(
        (d) => d.code === 'run_input_unreachable',
      ),
    ).toEqual([]);
  });

  it('says nothing when the entry task declares no run-input surface at all', () => {
    // That task takes the catch-all in validateParentTaskInputs, which accepts
    // whatever a caller passes — so every input is reachable.
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [agent('entry', {}), agent('downstream', { dependsOn: ['entry'] })],
      runInputs: [{ id: 'anything', required: true }],
    });
    expect(validity.status).toBe('valid');
    expect(
      [...validity.diagnostics, ...validity.advisories].filter(
        (d) => d.code === 'run_input_unreachable',
      ),
    ).toEqual([]);
  });

  it('stays silent when the entry task declares every slot', () => {
    const { validity } = materializeAndValidateSkillConfig(skill([{ id: 'seed', required: true }]));
    expect(
      [...validity.diagnostics, ...validity.advisories].filter(
        (d) => d.code === 'run_input_unreachable',
      ),
    ).toEqual([]);
  });
});
