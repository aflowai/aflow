import { GoldenCaseContentSchema, toJsonSchemaSync, type SkillCatalogEntry } from '@aflow/schemas';

import { EVAL_SUITE_DESIGN_PROMPT } from './evalSuiteDesignProse.js';

/**
 * The case shape the design task must emit, derived from the schema the write
 * path validates against. Hand-writing it here would let the two drift, and the
 * drift would surface as an operator ratifying nothing.
 *
 * A check comparand holds a free-form JSON value, so the converter meets a
 * recursive reference and collapses it to `any` — the shape intended here. It
 * announces that on stderr, and this catalog loads at boot, so the notice is
 * silenced for the one call rather than printed by every process.
 */
function deriveGoldenCaseContentSchema(): ReturnType<typeof toJsonSchemaSync> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return toJsonSchemaSync(GoldenCaseContentSchema);
  } finally {
    console.warn = warn;
  }
}

const GOLDEN_CASE_CONTENT_JSON_SCHEMA = deriveGoldenCaseContentSchema();

const EVAL_SUITE_DESIGN: SkillCatalogEntry = {
  catalogId: 'eval-suite-design',
  version: 16,
  name: 'Eval Suite Design',
  tagline: 'Draft a golden eval suite for a skill, grounded in its simulated world.',
  description: `Given a skill and the simulation it runs against, draft the golden cases that would catch it regressing — and hand them to an operator to ratify.

**Scaffolds the suite; does not grade the skill.** One run reads the target skill's contract and its simulation, designs a stratified set of cases, and proposes them as a single staged change. Nothing lands until an operator accepts it, and acceptance re-runs the authoring gate against the skill's current revision.

**The hard part is selection.** Which situations are worth a case, what to call them, and what each case actually requires of the skill are judgements the platform cannot make. This skill makes a first pass at them that an operator edits, which is a different starting point from an empty dataset.

**Checks are held to the same bar as hand-written ones.** A drafted case is validated exactly like one an operator types: its claims must name declared requirements, and its checks must be able to fail. A suite that passes no matter what the skill does is refused at ratification rather than accepted and trusted.

**Prerequisites**: the target skill and a simulation configured for the integrations it calls. The cases it drafts are only as grounded as the simulation's collections and rule profiles.`,
  tags: ['evals', 'testing', 'simulation', 'quality', 'developer-tools'],
  capabilityHints: [],
  bundle: {
    workflow: {
      slug: 'eval-suite-design',
      name: 'Eval Suite Design',
      description:
        'Read a skill’s contract and the simulation it runs against, design a stratified set of golden cases covering the situations where the wrong move is plausible, and propose them as one staged change for an operator to ratify.',
      goal: 'Produce a golden eval suite for the target skill that an operator can ratify — stratified across scenarios and directions, with requirements stated independently of the checks that detect them.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'suite-proposed',
          name: 'Eval suite proposed',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'A set of golden cases covering the target skill’s important strata was drafted against its simulation and proposed as a staged change awaiting operator ratification.',
          },
        },
      ],
      runInputs: [
        {
          id: 'targetSkillSlug',
          required: true,
          description: 'The skill the suite measures.',
        },
        {
          id: 'simulationId',
          required: true,
          description:
            'The simulation the cases run against — its collections and rule profiles are what checks can read.',
        },
        {
          id: 'focus',
          required: false,
          description:
            'What the suite should emphasise ("the refusal paths", "everything touching credit"). Omit for balanced coverage of the contract.',
        },
      ],
      tasks: [
        {
          taskId: 'design',
          name: 'Design the suite',
          goal: EVAL_SUITE_DESIGN_PROMPT,
          type: 'agent' as const,
          retryability: 'safe' as const,
          inputBindings: {
            targetSkillSlug: { kind: 'run_input' as const, path: 'targetSkillSlug' },
            simulationId: { kind: 'run_input' as const, path: 'simulationId' },
            focus: { kind: 'run_input' as const, path: 'focus' },
          },
          // The entry task's contract is the skill's callable input surface: a
          // run input absent from it is refused at start, whatever runInputs
          // declares.
          inputContract: {
            bindings: {
              targetSkillSlug: {
                kind: 'run_input' as const,
                bindAs: 'targetSkillSlug',
                path: 'targetSkillSlug',
                schema: { type: 'string', minLength: 1, maxLength: 128 },
              },
              simulationId: {
                kind: 'run_input' as const,
                bindAs: 'simulationId',
                path: 'simulationId',
                schema: { type: 'string', minLength: 1, maxLength: 128 },
              },
              focus: {
                kind: 'run_input' as const,
                bindAs: 'focus',
                path: 'focus',
                schema: { type: 'string', minLength: 1, maxLength: 2000 },
              },
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // The contract and the world are read here rather than in
              // operation tasks: both are general read ops whose inline
              // handlers emit no workflowExecution-correlated result, so
              // neither can BE a workflow task.
              operations: [
                'workflow.manage.get',
                'integration.simulation.get',
                // The simulation read is large enough to come back as a payload
                // ref, and reading it whole is what exhausts the turn. These are
                // the navigation ops the prompt tells it to use; without them it
                // re-reads the same payload until the loop detector stops it.
                'memory.store.get',
                'memory.run_output.get',
                'agent.control.signal_blocked',
              ],
              integrations: [],
            },
          },
          outputContract: {
            // Polarity is a cross-field rule the JSON projection cannot carry,
            // and a draft that gets it wrong is repairable only while the turn
            // that wrote it is still running.
            validatorRefs: ['eval.case-draft'],
            schema: {
              type: 'object',
              required: ['cases', 'rationale'],
              additionalProperties: false,
              properties: {
                cases: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  description:
                    'The drafted cases. Each is validated at ratification exactly as a hand-written one would be.',
                  items: GOLDEN_CASE_CONTENT_JSON_SCHEMA,
                },
                rationale: {
                  type: 'string',
                  minLength: 1,
                  // Matches what eval.case.propose stores; a wider contract here
                  // is refused at install as an incompatible bind.
                  maxLength: 8000,
                  description:
                    'What the suite covers, which strata were deliberately left out, and what it would fail to notice — for the operator deciding whether to ratify.',
                },
              },
            },
          },
        },

        {
          taskId: 'propose',
          name: 'Propose the suite',
          goal: 'Hand the drafted cases to the operator as one staged change. Nothing is measured and no case lands here — ratification is where a case arrives, and it re-runs the authoring gate against the skill’s current revision.',
          type: 'operation' as const,
          operation: 'eval.case.propose',
          dependsOn: ['design'],
          retryability: 'unsafe' as const,
          inputBindings: {
            targetSkillSlug: { kind: 'run_input' as const, path: 'targetSkillSlug' },
            cases: { kind: 'task_output' as const, taskId: 'design', path: 'cases' },
            rationale: { kind: 'task_output' as const, taskId: 'design', path: 'rationale' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['eval.case.propose'],
              integrations: [],
            },
          },
          inputTemplate: {
            workflowSlug: { $bind: 'targetSkillSlug' },
            cases: { $bind: 'cases' },
            rationale: { $bind: 'rationale' },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'stagedChangeId', toState: 'stagedChangeId' },
            { kind: 'output_path' as const, path: 'caseCount', toState: 'caseCount' },
          ],
        },
      ],
      stateVariables: [
        {
          variableId: 'stagedChangeId',
          name: 'Proposed suite',
          description: 'The staged change carrying the drafted cases, awaiting ratification.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'caseCount',
          name: 'Cases drafted',
          description: 'How many cases the proposal carries.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'stagedChangeId',
        guidance:
          'The run ends with a proposal, not a dataset. Report how many cases were drafted and what the suite covers, and point the operator at the staged change to review — ratifying it runs each case through the same gate a hand-written case meets, so a case that cannot fail is refused there rather than accepted. Cases the operator rejects are worth re-drafting with a narrower focus.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'eval-suite-design',
      name: 'Eval Suite Design',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'suite-proposed',
            description:
              'A stratified set of golden cases for the target skill is drafted against its simulation — requirements stated independently of checks — and proposed as a staged change for operator ratification.',
          },
        ],
      },
      mode: 'process' as const,
    },
    activation: {
      triggerPatterns: [
        'design an eval suite',
        'draft eval cases',
        'create golden cases for this skill',
        'build a test suite for this skill',
        'what should we be testing',
      ],
      activationHint:
        'Run to scaffold a golden eval suite for a skill that has a simulation configured. Drafts the cases and proposes them; an operator ratifies. Does not run evaluations and does not read scores — a skill that could see its own measurement would optimise against it.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Plan 301 — the authoring half of the rehearsal loop. Case selection, titling, and stating requirements independently of checks are the judgements a team without platform context gets wrong first, and none of them can be enforced by schema. The suite arrives as a proposal because the skill drafting cases must not be able to write the ruler it is measured by; ratification re-runs validateGoldenCase, so a drafted case meets the same bar as a hand-written one.',
  },
};

export { EVAL_SUITE_DESIGN };
