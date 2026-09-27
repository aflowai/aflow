import { z } from 'zod';
import {
  AssembleWorkflowOutputSchema,
  ComposeIntentSchema,
  PrepareDesignSurfaceInputSchema,
  PrepareDesignSurfaceOutputSchema,
  TaskGraphDraftSchema,
  WorkflowAssemblyInputSchema,
} from '../cybernetic/composeSkill.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

// ============================================================================

/**
 * D10 success-only output for validation nodes. On contract failure, the
 * handler emits FAILED with `errorRef.contractErrors[]` — `route_result`
 * routes per the consumer's `onContractFailure`. Authors never see a
 * `valid: false` value at runtime.
 */
const ValidationSuccessOutputSchema = z
  .object({
    valid: z.literal(true),
  })
  .strict();

/** validate_task_graph: input is the draft alone. */
export const ValidateTaskGraphInputSchema = z
  .object({
    draft: TaskGraphDraftSchema,
  })
  .strict();
export type ValidateTaskGraphInput = z.infer<typeof ValidateTaskGraphInputSchema>;

/** validate_source_coverage: cross-validates intent ↔ draft. */
export const ValidateSourceCoverageInputSchema = z
  .object({
    intent: ComposeIntentSchema,
    draft: TaskGraphDraftSchema,
  })
  .strict();
export type ValidateSourceCoverageInput = z.infer<typeof ValidateSourceCoverageInputSchema>;

/** All graph validators share this success-only output (D10). */
export const ValidationOutputSchema = ValidationSuccessOutputSchema;
export type ValidationOutput = z.infer<typeof ValidationOutputSchema>;

export const ComposeSkillOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'skill',
    group: 'compose',
    verb: 'prepare_surface',
    name: 'Prepare Design Surface',
    actionLabel: 'Computing legal design surface…',
    semanticDescription:
      'Deterministic feasibility gate for compose-skill. Reads the typed ComposeIntent, queries the space for bound APIs, MCP servers, available platform operations, and policies, and emits one of: (a) DesignSurface (legal universe of IDs the design phase may draw from), (b) PAUSED with a bind-capability handoff payload, or (c) PAUSED with signal_blocked semantics when no in-product skill can resolve the gap.',
    tags: ['skill', 'compose', 'cybernetic', 'platform-117'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Compute the deterministic design surface for a compose-skill run.',
      whenToUse: [
        'As the second task of compose-skill, after analyze-intent emits a typed ComposeIntent.',
      ],
      whenNotToUse: ['Directly — this is invoked by the workflow engine, not by agents.'],
      // Must parse against inputZod (PrepareDesignSurfaceInputSchema) — the
      // contract test in `__tests__/minimalExampleInputs.test.ts` enforces it.
      minimalExampleInput: {
        intent: {
          intent: 'Create a minimal skill that lists available platform operations.',
          iterationModel: 'process',
        },
      },
    },
    accessMode: 'read',
    inputZod: PrepareDesignSurfaceInputSchema,
    outputZod: PrepareDesignSurfaceOutputSchema,
    internal: true,
  },
  {
    stepType: 'skill',
    group: 'compose',
    verb: 'assemble_workflow',
    name: 'Assemble Workflow',
    actionLabel: 'Assembling workflow…',
    semanticDescription:
      'Deterministic lowering of a TaskGraphDraft + ComposeIntent + DesignSurface into a complete ComposedWorkflow. Maps iterationModel→mode; lifts produces[] onto each task as typed output ports and derives outputContract.schema from them; lowers consumes[] into inputBindings (kind: task_output, path = producer.produces[].key) and derives inputContract.bindings.*.schema from the producer port shape; dependsOn = explicit ∪ implicit-from-consumes. State variables stay reserved for run input, accumulators, checkpoints, and system_feedback — they are NOT the cross-task data lane. Pure structural transformation — no LLM in the path.',
    tags: ['skill', 'compose', 'cybernetic', 'platform-117'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Lower a typed TaskGraphDraft into a ComposedWorkflow.',
      whenToUse: [
        'As the fourth task of compose-skill, after draft-task-graph emits a TaskGraphDraft.',
      ],
      whenNotToUse: ['Directly — this is invoked by the workflow engine, not by agents.'],
      // Must parse against inputZod (WorkflowAssemblyInputSchema) — the
      // contract test in `__tests__/minimalExampleInputs.test.ts` enforces it.
      minimalExampleInput: {
        intent: {
          intent: 'Compose a minimal echo skill.',
          iterationModel: 'process',
        },
        surface: {
          integrations: [],
          operations: [],
          policies: { compute: false },
          bindableButUnbound: [],
        },
        draft: {
          slug: 'echo',
          name: 'Echo',
          description: 'Echo a message back.',
          goal: 'Read input, return it unchanged.',
          outcomes: [
            {
              id: 'echoed',
              name: 'Echoed',
              evaluator: { type: 'manual', instruction: 'Output equals input.' },
            },
          ],
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'echo',
              goal: 'Echo the message back.',
            },
          ],
        },
      },
    },
    accessMode: 'read',
    inputZod: WorkflowAssemblyInputSchema,
    outputZod: AssembleWorkflowOutputSchema,
    internal: true,
  },
  // ==========================================================================
  {
    stepType: 'skill',
    group: 'compose',
    verb: 'validate_task_graph',
    name: 'Validate Task Graph',
    actionLabel: 'Validating draft task graph…',
    semanticDescription:
      'Graph node — validates a TaskGraphDraft for self-consistency: dangling dependsOn / consumes references, unknown outputKey lookups, duplicate taskIds, and dependency cycles. Emits FAILED with one ContractError per violation (all blame=producer-contract, source.bindAs=draft) so the consumer routes back to the draft producer.',
    tags: ['skill', 'compose', 'cybernetic', 'platform-123', 'validation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Validate the structural self-consistency of a TaskGraphDraft.',
      whenToUse: ['As the first validator after draft-task-graph in compose-skill.'],
      whenNotToUse: ['Directly — emitted by the compose-skill graph compiler, not by agents.'],
      pitfalls: [],
      minimalExampleInput: {
        draft: {
          slug: 'echo',
          name: 'Echo',
          description: 'Echo a message back.',
          goal: 'Read input, return it unchanged.',
          outcomes: [
            {
              id: 'echoed',
              name: 'Echoed',
              evaluator: { type: 'manual', instruction: 'Output equals input.' },
            },
          ],
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'echo',
              goal: 'Echo the message back.',
            },
          ],
        },
      },
    },
    accessMode: 'read',
    inputZod: ValidateTaskGraphInputSchema,
    outputZod: ValidationOutputSchema,
    internal: true,
    agentTool: false,
    bypassGrant: true,
  },
  {
    stepType: 'skill',
    group: 'compose',
    verb: 'validate_source_coverage',
    name: 'Validate Source Coverage',
    actionLabel: 'Validating data-source coverage…',
    semanticDescription:
      'Graph node — verifies that every `intent.requiredDataSources` entry has exactly one task in the draft labelling its `providesPurposeId` AND carrying a callable api/mcp grant. Emits FAILED with one ContractError per missing/duplicate/unbound producer (all blame=producer-contract, source.bindAs=draft) so a missing label routes back to draft-task-graph for rerun.',
    tags: ['skill', 'compose', 'cybernetic', 'platform-123', 'validation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Validate that every required data source in the intent has a labelled, callable producer in the draft.',
      whenToUse: [
        "Between draft-task-graph and assemble-workflow when the intent's requiredDataSources are non-empty.",
      ],
      whenNotToUse: ['Directly — emitted by the compose-skill graph compiler, not by agents.'],
      pitfalls: [],
      minimalExampleInput: {
        intent: {
          intent: 'Compose a minimal echo skill.',
          iterationModel: 'process',
        },
        draft: {
          slug: 'echo',
          name: 'Echo',
          description: 'Echo a message back.',
          goal: 'Read input, return it unchanged.',
          outcomes: [
            {
              id: 'echoed',
              name: 'Echoed',
              evaluator: { type: 'manual', instruction: 'Output equals input.' },
            },
          ],
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'echo',
              goal: 'Echo the message back.',
            },
          ],
        },
      },
    },
    accessMode: 'read',
    inputZod: ValidateSourceCoverageInputSchema,
    outputZod: ValidationOutputSchema,
    internal: true,
    agentTool: false,
    bypassGrant: true,
  },
];
