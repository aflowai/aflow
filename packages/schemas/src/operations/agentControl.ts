import { z } from 'zod';
import { StepTypeSchema } from '../artifact/operationDefinition.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { OperationIdSchema } from '../runtime/ids.js';
import { PersistentAgentTargetSchema } from '../runtime/agentTarget.js';
import { BlockerKindSchema } from '../cybernetic/runnerReflection.js';
import {
  PlatformFlowCreateInputSchema,
  PlatformFlowCreateOutputSchema,
  PlatformFlowReadInputSchema,
  PlatformFlowReadOutputSchema,
  PlatformFlowUpdateInputSchema,
  PlatformFlowUpdateOutputSchema,
  PlatformFlowDeleteInputSchema,
  PlatformFlowDeleteOutputSchema,
  PlatformFlowListInputSchema,
  PlatformFlowListOutputSchema,
} from './platform.js';

// ============================================================================
// agent.control.dispatch - Dispatch to Step
// ============================================================================

export const AgentDispatchInputSchema = z.object({
  /** Target step ID */
  targetStepId: z.string().max(128),
  /** Input for the target step */
  input: z.unknown().optional(),
  /** Whether to wait for the step to complete */
  wait: z.boolean().default(true),
  /** Timeout if waiting (in seconds) */
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
});
export type AgentDispatchInput = z.infer<typeof AgentDispatchInputSchema>;

export const AgentDispatchOutputSchema = z.object({
  /** Whether dispatch was successful */
  dispatched: z.boolean(),
  /** Step execution ID for the dispatched step */
  stepExecutionId: z.string().optional(),
  /** Output from the step (if wait=true and completed) */
  result: z.unknown().optional(),
  /** Status of the step (if wait=true) */
  status: z.enum(['SUCCEEDED', 'FAILED', 'PAUSED', 'PENDING']).optional(),
});
export type AgentDispatchOutput = z.infer<typeof AgentDispatchOutputSchema>;

// ============================================================================
// agent.control.delegate - Delegate to Sub-Agent
// ============================================================================

export const ExternalServiceObligationSchema = z.object({
  /** Vendor identifier as the parent looked it up — apiId, serverId, or substring used in integration.registry.lookup. */
  identifier: z.string().min(1).max(120),
  sourceKind: z.enum(['api', 'mcp']),
  /** Per-vendor status from the parent's lookup. 'bound' means the parent already verified the binding exists in scope; 'definition-only' / 'unknown' means the parent should normally have run bind-capability first — the gate enforces. */
  status: z.enum(['bound', 'definition-only', 'unknown']),
  apiId: z.string().min(1).max(120).optional(),
  bindingId: z.string().min(1).max(120).optional(),
  serverId: z.string().min(1).max(120).optional(),
  /** Why the parent flagged this service (free-form, for audit / sub-agent context). */
  rationale: z.string().max(16000).optional(),
});
export type ExternalServiceObligation = z.infer<typeof ExternalServiceObligationSchema>;

export const DelegationContextSchema = z.object({
  objective: z
    .string()
    .max(8000)
    .optional()
    .describe('High-level objective the parent is working toward (≤8000 chars)'),
  relevantState: z
    .record(z.unknown())
    .optional()
    .describe('Relevant state the sub-agent should know about'),
  constraints: z.array(z.string()).optional().describe('Constraints the sub-agent must respect'),
  parentSummary: z
    .string()
    .max(12000)
    .optional()
    .describe('Summary of what the parent has done so far (≤12000 chars)'),
  externalServices: z
    .array(ExternalServiceObligationSchema)
    .max(20)
    .optional()
    .describe('External services the parent has flagged with per-vendor binding status'),
});
export type DelegationContext = z.infer<typeof DelegationContextSchema>;

const WaitModeSchema = z.preprocess(
  (value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  },
  z.union([z.boolean(), z.literal('until_pause')]),
);

export const AgentDelegateInputSchema = z.object({
  target: PersistentAgentTargetSchema,
  /** Agent version (defaults to latest; only meaningful for custom-agent target). */
  agentVersion: z.string().max(64).optional(),
  /** Input for the sub-agent (string or object — mapped to the agent's primary input variable) */
  input: z.unknown().optional(),
  /** Config overrides for the sub-agent (e.g. { model: "sonnet" }) */
  config: z.record(z.unknown()).optional(),
  wait: WaitModeSchema.default(true),
  /**
   * Override the sub-agent's role for this delegation.
   * - "subagent" (default): autonomous execution, must complete with a result.
   * - "assistant": conversational mode, can ask for input freely.
   */
  agentRole: z.enum(['assistant', 'subagent']).default('subagent'),
  /** Timeout if waiting (in seconds) */
  timeoutSeconds: z.number().int().positive().max(86400).optional(),
  context: DelegationContextSchema.optional(),
  outputSchema: z.record(z.unknown()).optional(),
  outputValidatorRefs: z.array(z.string().min(1).max(128)).max(10).optional(),
  /**
   * Display-only metadata used by the chat UI to disambiguate parallel
   * sub-agent runs (e.g. two cybernetic-runner sessions started in the
   * same turn for different workflows). Stored on the child SessionHotState
   * and surfaced through SubflowEventForwarded so badge labels and the
   * activity bubble can show "Runner · {workflowSlug} › {taskName}" instead
   * of two indistinguishable "cybernetic-runner" rows.
   */
  displayMeta: z
    .object({
      workflowSlug: z.string().max(128).optional(),
      taskId: z.string().max(128).optional(),
      taskName: z.string().max(256).optional(),
    })
    .optional(),
});
export type AgentDelegateInput = z.infer<typeof AgentDelegateInputSchema>;

export const AgentDelegateOutputSchema = z.object({
  /** Child session ID */
  childSessionId: z.string(),
  /** Status of the child session */
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED']),
  /** Output from the sub-agent (if wait=true and completed) */
  result: z.unknown().optional(),
  /** Error from the sub-agent (if wait=true and failed) */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type AgentDelegateOutput = z.infer<typeof AgentDelegateOutputSchema>;

// ============================================================================

export const AgentResumeInputSchema = z.object({
  /** Child session ID to resume (from a prior delegate result) */
  childSessionId: z.string().uuid(),
  /** Message to send to the child agent (appends to its conversation) */
  message: z.string().max(10000),
  /**
   * Wait mode — same semantics as delegate.
   * - true: block until child completes or fails.
   * - "until_pause": block until child reaches any resting state.
   */
  wait: WaitModeSchema.default('until_pause'),
});
export type AgentResumeInput = z.infer<typeof AgentResumeInputSchema>;

export const AgentResumeOutputSchema = z.object({
  /** Child session ID */
  childSessionId: z.string(),
  /** Status of the child session after resume */
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED']),
  /** Output from the sub-agent (if completed) */
  result: z.unknown().optional(),
  /** Pause prompt from the sub-agent (if paused) */
  pausePrompt: z.string().optional(),
  /** Error from the sub-agent (if failed) */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type AgentResumeOutput = z.infer<typeof AgentResumeOutputSchema>;

// ============================================================================
// agent.control.abort - Abort the Current Session
// ============================================================================

export const AgentAbortInputSchema = z.object({
  /** Reason for aborting */
  reason: z.string().max(16000).optional(),
  /** Error code to report */
  errorCode: z.string().max(64).optional(),
  /** Final output to return (optional) */
  finalOutput: z.unknown().optional(),
});
export type AgentAbortInput = z.infer<typeof AgentAbortInputSchema>;

export const AgentAbortOutputSchema = z.object({
  /** Confirmation that abort was requested */
  aborted: z.literal(true),
});
export type AgentAbortOutput = z.infer<typeof AgentAbortOutputSchema>;

// ============================================================================
// agent.control.end - End the Current Session
// ============================================================================

export const AgentEndInputSchema = z.object({
  /** Reason for ending the flow */
  reason: z.string().max(16000).optional(),
  /** Final result to return */
  result: z.unknown().optional(),
});
export type AgentEndInput = z.infer<typeof AgentEndInputSchema>;

export const AgentEndOutputSchema = z.object({
  /** Confirmation that the flow was ended */
  ended: z.literal(true),
  /** Echoed reason */
  reason: z.string().optional(),
});
export type AgentEndOutput = z.infer<typeof AgentEndOutputSchema>;

// ============================================================================
// agent.control.submit_output - Submit Validated Task Output (104j §6.9)
// ============================================================================

/** One RFC 6902 operation against the attempt's draft. */
export const AgentDraftPatchOpSchema = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string().max(512).describe('JSON Pointer. "" addresses the document root.'),
  value: z.unknown().optional(),
  from: z.string().max(512).optional(),
});

export const AgentDraftPatchInputSchema = z.object({
  /**
   * Replay key. A repeat of a mutationId already applied returns the original
   * receipt and changes nothing, so a retried call cannot double-apply.
   */
  mutationId: z.string().min(1).max(128),
  operations: z.array(AgentDraftPatchOpSchema).min(1).max(128),
  /**
   * Compare-and-swap against the revision this patch was written for. Omit to
   * accept whatever is current.
   */
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type AgentDraftPatchInput = z.infer<typeof AgentDraftPatchInputSchema>;

export const AgentDraftReceiptSchema = z.object({
  revision: z.number().int().nonnegative(),
  contentHash: z.string(),
  /**
   * What the draft now holds, e.g. `{ cases[12], rationale }`. This is the
   * field the agent reads to learn whether its patch did anything. It replaced
   * a count that counted top-level KEYS, so an empty
   * `{cases: [], rationale: ''}` reported two items and read as progress.
   */
  census: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mutationId: z.string(),
  replayed: z.boolean(),
});
export type AgentDraftReceipt = z.infer<typeof AgentDraftReceiptSchema>;

export const AgentDraftGetInputSchema = z.object({
  view: z
    .enum(['outline', 'full'])
    .default('outline')
    .describe('`outline` reports shape and sizes; `full` returns the content at `path`.'),
  path: z
    .string()
    .max(512)
    .optional()
    .describe(
      'JSON Pointer to read instead of the whole draft — the same addressing draft_patch takes and validation errors report, e.g. "/cases/3/expectations/0".',
    ),
  itemRange: z
    .object({ start: z.number().int().nonnegative(), count: z.number().int().min(1).max(200) })
    .optional(),
});
export type AgentDraftGetInput = z.infer<typeof AgentDraftGetInputSchema>;

export const AgentDraftGetOutputSchema = z.object({
  revision: z.number().int().nonnegative(),
  contentHash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  exists: z.boolean(),
  content: z.unknown().optional(),
  outline: z.unknown().optional(),
});
export type AgentDraftGetOutput = z.infer<typeof AgentDraftGetOutputSchema>;

/**
 * Submitting takes no result.
 *
 * There is one way to produce a task output: build it with `draft_patch`, then
 * submit what is built. A second, literal form would be a choice the agent has
 * to make correctly, and the choice it makes under pressure is the one that
 * emits everything in a single message — which is the behaviour this exists to
 * remove. The draft is materialised BEFORE validation, so the value validated
 * and the value emitted are the same object.
 */
export const AgentSubmitOutputInputSchema = z
  .object({
    /** Optional human-readable summary of what was accomplished. */
    /**
     * Operator-facing prose, and the field the advisory findings are appended to.
     * 2000 refused a Sonnet summary outright and cost a whole submit round on a
     * suite that was otherwise finished — a cap sized to the author's imagination
     * rather than to anything that breaks.
     */
    summary: z.string().max(16000).optional(),
  })
  /**
   * Strict on purpose. A non-strict object accepts `{ result: … }` and strips
   * it, so a caller that believed it submitted a literal gets an empty input and
   * — if a draft happens to exist — a success describing something else. The
   * removed form is refused by name instead.
   */
  .strict();
export type AgentSubmitOutputInput = z.infer<typeof AgentSubmitOutputInputSchema>;

export const AgentSubmitOutputOutputSchema = z.object({
  /** Whether the output was accepted. */
  accepted: z.literal(true),
});
export type AgentSubmitOutputOutput = z.infer<typeof AgentSubmitOutputOutputSchema>;

// ============================================================================
// agent.control.signal_blocked - Signal Runner Cannot Proceed (104j §6.9)
// ============================================================================

export const AgentSignalBlockedInputSchema = z.object({
  /**
   * Why the agent cannot proceed — the account an operator reads when a run
   * pauses blocked, so it wants room. Every cap on this surface is a storage
   * ceiling rather than a style guide: 1000 characters is about 150 words, and
   * refusing the useful paragraph costs a turn without improving anything.
   */
  reason: z.string().min(1).max(16000),
  category: BlockerKindSchema,
  /** What information or action is needed to unblock. */
  needed: z.string().max(16000).optional(),
});
export type AgentSignalBlockedInput = z.infer<typeof AgentSignalBlockedInputSchema>;

export const AgentSignalBlockedOutputSchema = z.object({
  /** Whether the session was paused. */
  paused: z.literal(true),
});
export type AgentSignalBlockedOutput = z.infer<typeof AgentSignalBlockedOutputSchema>;

// ============================================================================
// agent.control.run_step - Run Any Operation Dynamically
// ============================================================================

export const AgentRunStepInputSchema = z.object({
  /** Fully-qualified operation ID from the catalog (e.g., "ai.text.generate", "memory.store.get"). */
  operationId: OperationIdSchema,
  /**
   * Operation-specific input fields for the target operation.
   * Place all parameters that the target operation expects inside this object.
   *
   * Example: `{ operationId: "ai.text.generate", inputs: { prompt: "Hello", model: "gpt-4o" } }`
   */
  inputs: z
    .record(z.unknown())
    .default({})
    .describe(
      "Flat key-value map of the target operation's input fields. " +
        "Each key is a top-level property from the operation's input schema. " +
        'Example for memory.store.get: { "target": { "path": "/notes/meeting.md" }, "view": "content" }. ' +
        'Do NOT nest inside a wrapper object — place fields directly at this level.',
    ),
});
export type AgentRunStepInput = z.infer<typeof AgentRunStepInputSchema>;

export const AgentRunStepOutputSchema = z.object({
  /** Status of the dynamically executed step */
  status: z.enum(['SUCCEEDED', 'FAILED']),
  /** Step execution ID of the dynamic step */
  stepExecutionId: z.string(),
  /** Operation that was executed */
  operationId: z.string(),
  /** Step type that was used */
  stepType: StepTypeSchema,
  /** Output from the executed operation (if succeeded) */
  result: z.unknown().optional(),
  /** Error from the executed operation (if failed) */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});
export type AgentRunStepOutput = z.infer<typeof AgentRunStepOutputSchema>;

// ============================================================================
// agent.manage.validate — Validate an Agent Definition
// ============================================================================

export const FlowManageValidateInputSchema = z.object({
  /** The flow definition to validate (same shape as AgentDefinition) */
  definition: z.record(z.unknown()),
});
export type FlowManageValidateInput = z.infer<typeof FlowManageValidateInputSchema>;

const FlowValidationErrorSchema = z.object({
  /** Dot-path to the problematic field (e.g., "steps[0].onSuccess.next[1].stepId") */
  path: z.string(),
  /** Human-readable description of the issue */
  message: z.string(),
  /** Severity: 'error' blocks create, 'warning' is informational */
  severity: z.enum(['error', 'warning']),
});

export const FlowManageValidateOutputSchema = z.object({
  /** Whether the definition is valid (no errors — warnings are OK) */
  valid: z.boolean(),
  /** Validation issues found */
  issues: z.array(FlowValidationErrorSchema),
  /** Number of steps in the definition */
  stepCount: z.number().int().nonnegative().optional(),
  /** Number of state variables defined */
  stateVariableCount: z.number().int().nonnegative().optional(),
});
export type FlowManageValidateOutput = z.infer<typeof FlowManageValidateOutputSchema>;

// ============================================================================

export const AgentOperationRegistrations: OperationRegistration[] = [
  // ---------------------------------------------------------------------------
  // Agent Manage — CRUD (agent.manage.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'create',
    name: 'Create Agent',
    actionLabel: 'Creating agent…',
    semanticDescription: 'Create a new agent definition with steps and transitions',
    tags: ['crud', 'agent'],
    crudView: { entityType: 'agent', action: 'create' },
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Create a new agent definition with steps and transitions.',
      whenToUse: [
        'Defining a new workflow with steps, transitions, and input bindings',
        'Programmatically creating agents from templates or user input',
      ],
      whenNotToUse: [
        'Updating an existing agent — use agent.manage.update',
        'Running an agent — use agent.control.dispatch',
      ],
      minimalExampleInput: {
        slug: 'my-flow',
        name: 'My Flow',
        definition: { steps: [], transitions: [] },
      },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformFlowCreateInputSchema,
    outputZod: PlatformFlowCreateOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'get',
    name: 'Get Agent',
    actionLabel: 'Reading agent…',
    semanticDescription: 'Retrieve an agent definition by ID and optional version',
    tags: ['crud', 'agent'],
    crudView: { entityType: 'agent', action: 'read' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve an agent definition by ID.',
      whenToUse: [
        'Inspecting an agent definition before running or editing it',
        'Fetching a specific version of an agent',
      ],
      whenNotToUse: ['Listing multiple agents — use agent.manage.list'],
      minimalExampleInput: { flowId: 'my-flow' },
    },
    accessMode: 'read',
    inputZod: PlatformFlowReadInputSchema,
    outputZod: PlatformFlowReadOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'update',
    name: 'Update Agent',
    actionLabel: 'Updating agent…',
    semanticDescription:
      'Update an existing agent definition (name, description, definition, tags)',
    tags: ['crud', 'agent'],
    crudView: { entityType: 'agent', action: 'update' },
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Update an existing agent definition.',
      whenToUse: [
        'Modifying steps, transitions, or metadata of an existing agent',
        'Renaming or re-tagging an agent',
      ],
      whenNotToUse: ['Creating a new flow — use agent.manage.create'],
      minimalExampleInput: { flowId: 'my-flow', name: 'Updated Name' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformFlowUpdateInputSchema,
    outputZod: PlatformFlowUpdateOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'delete',
    name: 'Delete Agent',
    actionLabel: 'Deleting agent…',
    semanticDescription: 'Delete an agent (soft-delete by default, hard-delete optional)',
    tags: ['crud', 'agent'],
    crudView: { entityType: 'agent', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete an agent definition (soft or hard delete).',
      whenToUse: [
        'Removing an agent that is no longer needed',
        'Archiving an agent (default soft-delete)',
      ],
      whenNotToUse: ['Temporarily disabling an agent — consider updating tags instead'],
      pitfalls: ['Hard delete is irreversible — use hardDelete: true with caution'],
      minimalExampleInput: { flowId: 'my-flow' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: PlatformFlowDeleteInputSchema,
    outputZod: PlatformFlowDeleteOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'list',
    name: 'List Agents',
    actionLabel: 'Listing agents…',
    semanticDescription: 'List agents with optional filtering by space, tags, or search query',
    tags: ['crud', 'agent'],
    crudView: { entityType: 'agent', action: 'list' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List agents with optional filtering and pagination.',
      whenToUse: ['Browsing available agents in a space', 'Searching for agents by name or tags'],
      whenNotToUse: ['Fetching a single flow by ID — use agent.manage.get'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: PlatformFlowListInputSchema,
    outputZod: PlatformFlowListOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'validate',
    name: 'Validate Agent',
    actionLabel: 'Validating agent…',
    semanticDescription:
      'Validate an agent definition without creating it. Checks schema conformance, transition consistency, ' +
      'step reachability, state variable rules, and returns structured errors and warnings.',
    tags: ['agent', 'validation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Validate an agent definition and return structured errors/warnings.',
      whenToUse: [
        'Before calling agent.manage.create to catch errors early',
        'Checking an agent definition for consistency issues',
        'Flow builder agent validating user-constructed agents',
      ],
      whenNotToUse: [
        'Creating an agent directly — use agent.manage.create (which does basic validation internally)',
      ],
      pitfalls: [
        'Validation is structural only — it does not check if referenced operations exist in the catalog',
      ],
      minimalExampleInput: {
        definition: {
          schemaVersion: 1,
          flowId: 'test',
          metadata: { name: 'Test' },
          steps: [
            {
              stepId: 'start',
              stepType: 'ai',
              operation: 'ai.text.generate',
              config: { prompt: 'Hello' },
            },
          ],
          startStepId: 'start',
        },
      },
    },
    accessMode: 'read',
    inputZod: FlowManageValidateInputSchema,
    outputZod: FlowManageValidateOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // Agent Control (agent.control.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'agent',
    group: 'control',
    verb: 'dispatch',
    name: 'Dispatch to Step',
    actionLabel: 'Dispatching…',
    semanticDescription:
      'Dispatch execution to a specific step in the current agent with optional input and wait behavior',
    tags: ['agent', 'orchestration'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Dispatch execution to a named step in the current agent.',
      whenToUse: [
        'Jumping to a specific step by ID within the same flow',
        'Conditionally routing execution based on runtime logic',
      ],
      whenNotToUse: [
        'Running an entirely separate flow — use agent.control.delegate instead',
        'Dynamically invoking an operation by ID — use agent.control.run_step instead',
      ],
      pitfalls: [
        'If wait=true and the step never completes, the dispatch step blocks until timeout',
        'targetStepId must match a stepId in the current agent definition',
      ],
      minimalExampleInput: { targetStepId: 'summarize' },
    },
    accessMode: 'write',
    inputZod: AgentDispatchInputSchema,
    outputZod: AgentDispatchOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'control',
    verb: 'delegate',
    name: 'Delegate to Sub-Agent',
    actionLabel: 'Delegating…',
    semanticDescription:
      'Delegate work to another agent. By default runs as subagent (autonomous, must complete). Pass agentRole="assistant" for conversational delegation.',
    tags: ['agent', 'orchestration', 'delegation'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delegate work to another agent as a sub-agent.',
      whenToUse: [
        'Composing reusable agents into a larger workflow',
        'Running a well-defined sub-process (e.g., data enrichment, agent building) from a parent agent',
      ],
      whenNotToUse: [
        'Dispatching to a step within the current agent — use agent.control.dispatch instead',
        'Simple sequential logic that fits in one agent',
      ],
      pitfalls: [
        'Sub-agent errors propagate to the parent only when wait=true',
        "Input is coerced to the target agent's input contract — pass a string for simple prompts, an object for structured input",
      ],
      minimalExampleInput: {
        target: { kind: 'platform-role', systemRole: 'mcp-runner' },
        input: 'Run the catalog listing for api operations',
      },
    },
    accessMode: 'write',
    inputZod: AgentDelegateInputSchema,
    outputZod: AgentDelegateOutputSchema,
    internalFields: { input: ['agentRole'] },
  },
  {
    stepType: 'agent',
    group: 'control',
    verb: 'resume',
    name: 'Resume Child Session',
    actionLabel: 'Resuming…',
    semanticDescription:
      'Resume an existing child session with a follow-up message. ' +
      'The child retains its full conversation history — the message appends to the existing conversation. ' +
      'Use after a delegate with wait="until_pause" returned a PAUSED status.',
    tags: ['agent', 'orchestration', 'delegation', 'resume'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Continue an existing child session with a follow-up message.',
      whenToUse: [
        'Child paused and you want to provide the answer it needs',
        'Follow-up question to a completed child session',
      ],
      whenNotToUse: [
        'Starting a new delegation — use agent.control.delegate instead',
        'Child has already been cancelled or expired',
      ],
      minimalExampleInput: {
        childSessionId: '00000000-0000-0000-0000-000000000000',
        message: 'Use the enterprise segment for the analysis',
      },
    },
    accessMode: 'write',
    inputZod: AgentResumeInputSchema,
    outputZod: AgentResumeOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'control',
    verb: 'abort',
    name: 'Abort Session',
    actionLabel: 'Aborting…',
    semanticDescription:
      'Abort the current session with optional reason, error code, and final output',
    tags: ['agent', 'orchestration'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Abort the current run immediately with an error status.',
      whenToUse: [
        'A fatal error condition is detected and the run cannot continue',
        'An external signal requires immediate cancellation',
      ],
      whenNotToUse: [
        'Run completed successfully — use agent.control.end instead',
        'A retryable error occurred — let the orchestrator retry the step',
      ],
      pitfalls: ['Abort is immediate — in-flight sibling steps are cancelled, not waited on'],
      minimalExampleInput: { reason: 'Invalid input detected' },
    },
    accessMode: 'write',
    inputZod: AgentAbortInputSchema,
    outputZod: AgentAbortOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'control',
    verb: 'end',
    name: 'End Session',
    actionLabel: 'Finishing…',
    semanticDescription:
      'Cleanly end the current session with an optional result and reason. Use as a terminal step.',
    tags: ['agent', 'orchestration', 'terminal'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Cleanly end the current agent run with an optional result.',
      whenToUse: [
        'The flow has reached its terminal state and should complete successfully',
        'Returning a final result to the caller or parent agent',
      ],
      whenNotToUse: [
        'An error occurred — use agent.control.abort to signal failure',
        'More steps remain to execute',
      ],
      pitfalls: ['Must be a terminal node in the step graph — no edges should follow it'],
      minimalExampleInput: { result: { summary: 'Task completed successfully.' } },
    },
    accessMode: 'write',
    inputZod: AgentEndInputSchema,
    outputZod: AgentEndOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'control',
    verb: 'run_step',
    name: 'Run Step',
    actionLabel: 'Running step…',
    semanticDescription:
      'Dynamically execute any operation at runtime. Pass operationId and wrap the operation-specific ' +
      'parameters in the `inputs` object. The step executes as a first-class step execution visible ' +
      'in run history.',
    tags: ['agent', 'orchestration', 'dynamic'],
    idempotency: 'unknown',
    mutates: true,
    skipInputValidation: true,
    usage: {
      oneLine: 'Dynamically invoke any catalog operation by operationId at runtime.',
      whenToUse: [
        'Agent sessions where the AI picks which operation to call next',
        'Generic step that routes to different operations based on runtime data',
        'MCP or system agents that execute arbitrary operations programmatically',
      ],
      whenNotToUse: [
        'The target operation is known at design time — wire it directly in the step graph',
        'Calling a subflow — use agent.control.delegate instead',
      ],
      pitfalls: [
        'All operation parameters must go inside `inputs`, not as flat top-level fields',
        'Idempotency depends on the underlying operation being invoked',
      ],
      minimalExampleInput: {
        operationId: 'agent.manage.list',
        inputs: { spaceId: 'my-space' },
      },
    },
    accessMode: 'write',
    inputZod: AgentRunStepInputSchema,
    outputZod: AgentRunStepOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // Agent Control — draft (Plan 303)
  // ---------------------------------------------------------------------------
  {
    stepType: 'agent',
    group: 'control',
    verb: 'draft_patch',
    name: 'Patch Draft',
    actionLabel: 'Building the result…',
    semanticDescription:
      'Build the task result here — this is the only way to produce one, and submit_output takes ' +
      'no result of its own. Apply JSON Patch operations to a draft scoped to this attempt, across ' +
      'as many turns as the work takes: establish the top-level shape once (`{ "op": "add", ' +
      '"path": "", "value": {...} }`), then append items (`{ "op": "add", "path": "/cases/-", ' +
      '"value": {...} }`). Re-sending the shape discards everything appended since and is ' +
      'refused. Nothing is validated on write, because an unfinished draft is expected to be ' +
      'incomplete — submit_output reports anything still unmet. Each call needs a fresh ' +
      'mutationId; repeating one returns the first receipt instead of applying twice.',
    tags: ['agent', 'orchestration', 'draft'],
    idempotency: 'idempotent',
    mutates: true,
    internal: true,
    agentTool: false,
    usage: {
      oneLine: 'Accumulate the task result across turns.',
      whenToUse: ['Always — the task result is built here and nowhere else'],
      whenNotToUse: ['Never: submit_output has no result parameter to bypass this with'],
      pitfalls: [
        'Not validated on write. Call submit_output to find out whether it satisfies the contract.',
      ],
      minimalExampleInput: {
        mutationId: 'add-case-1',
        operations: [{ op: 'add', path: '/cases/-', value: { title: 'A case' } }],
      },
    },
    // The draft is this run's own scratch space, addressed by a scope the
    // server derives from the session — there is no other run's draft it could
    // reach and so nothing for a grant to decide. Without this the surface gate
    // drops it: the Runner's grant carries agent.control:write, so the write
    // half of the draft tools survived and the read half silently did not.
    bypassGrant: true,
    accessMode: 'write' as const,
    inputZod: AgentDraftPatchInputSchema,
    outputZod: AgentDraftReceiptSchema,
  },
  {
    stepType: 'agent',
    group: 'control',
    verb: 'draft_get',
    name: 'Read Draft',
    actionLabel: 'Reading the draft…',
    semanticDescription:
      'Read back the draft built so far, as an outline by default so inspecting it does not reload ' +
      'the whole artifact into context. Narrow with `path`, a JSON Pointer such as "/cases/3" — ' +
      'the same addressing draft_patch takes and validation errors report.',
    tags: ['agent', 'orchestration', 'draft'],
    idempotency: 'idempotent',
    mutates: false,
    internal: true,
    agentTool: false,
    usage: {
      oneLine: 'Read the draft built so far.',
      whenToUse: ['Checking what has been written before adding more'],
      whenNotToUse: ['Nothing has been drafted yet'],
      minimalExampleInput: { view: 'outline' },
    },
    // The draft is this run's own scratch space, addressed by a scope the
    // server derives from the session — there is no other run's draft it could
    // reach and so nothing for a grant to decide. Without this the surface gate
    // drops it: the Runner's grant carries agent.control:write, so the write
    // half of the draft tools survived and the read half silently did not.
    bypassGrant: true,
    accessMode: 'read' as const,
    inputZod: AgentDraftGetInputSchema,
    outputZod: AgentDraftGetOutputSchema,
  },

  // Agent Control — submit_output (104j §6.9)
  // ---------------------------------------------------------------------------
  {
    stepType: 'agent',
    group: 'control',
    verb: 'submit_output',
    name: 'Submit Output',
    actionLabel: 'Validating output…',
    semanticDescription:
      'Submit what draft_patch has built. Takes no result: whatever the draft holds is validated ' +
      'and, if it matches the task contract, completes the task. If validation fails the draft is ' +
      'kept, so the next call repairs it rather than rebuilding it.',
    tags: ['agent', 'orchestration', 'terminal'],
    idempotency: 'non_idempotent',
    mutates: true,
    internal: true,
    agentTool: false,
    usage: {
      oneLine: 'Submit task output for schema validation and completion.',
      whenToUse: ['The draft is complete and ready to be the task result'],
      whenNotToUse: [
        'You are blocked and cannot produce output — use agent.control.signal_blocked instead',
      ],
      pitfalls: ['Output must match the declared schema. If validation fails, fix and resubmit.'],
      minimalExampleInput: {},
    },
    accessMode: 'write' as const,
    inputZod: AgentSubmitOutputInputSchema,
    outputZod: AgentSubmitOutputOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // Agent Control — signal_blocked (104j §6.9)
  // ---------------------------------------------------------------------------
  {
    stepType: 'agent',
    group: 'control',
    verb: 'signal_blocked',
    name: 'Signal Blocked',
    actionLabel: 'Pausing…',
    semanticDescription:
      'Signal that the task cannot proceed without additional input. The workflow pauses and the supervising agent ' +
      'can provide the missing information, relay to the user, or cancel.',
    tags: ['agent', 'orchestration'],
    idempotency: 'non_idempotent',
    mutates: true,
    internal: true,
    agentTool: false,
    usage: {
      oneLine: 'Pause the task because you are blocked and need input.',
      whenToUse: [
        'Missing critical information needed to complete the task',
        'Requirements are ambiguous and you cannot make a reasonable assumption',
        'An environment/platform error you cannot fix by editing your own input — permission denied, read-only/failed filesystem under /workspace/, a sandbox or infrastructure failure (category access_denied / external_dependency)',
        'The same operation has already failed the same way — stop and signal rather than looping on workarounds',
      ],
      whenNotToUse: [
        'The task is complete — use agent.control.submit_output instead',
        'A tool call failed because of YOUR arguments (a malformed input, a wrong path you can correct) — fix and retry ONCE. But do not keep retrying, and do not invent workarounds for an environment/platform failure — signal_blocked instead.',
      ],
      pitfalls: [
        'The workflow stays paused until the supervising agent resumes it',
        'Looping on workarounds for a platform error hides the gap from the Coach — a clean blocked signal is what gets it fixed',
      ],
      minimalExampleInput: {
        reason: 'Missing API endpoint URL — the target API was not specified',
        category: 'missing_input',
        needed: 'The API base URL or an OpenAPI spec URL',
      },
    },
    accessMode: 'write' as const,
    inputZod: AgentSignalBlockedInputSchema,
    outputZod: AgentSignalBlockedOutputSchema,
  },
];
