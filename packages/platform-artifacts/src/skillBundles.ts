import { z } from 'zod';
import {
  DraftApiDefinitionOutputSchema,
  ComposeIntentSchema,
  PAUSE_INSTRUCTION_MAX_CHARS,
  StoreListingInstallInputSchema,
  TaskGraphDraftSchema,
  WorkflowRunResultAdvisorySchema,
  toJsonSchemaSync,
  type JsonSchema,
} from '@aflow/schemas';
import type { PlatformSkillBundleEntry, PlatformWorkflowDef } from './types.js';
import { buildAuthoringPlatformSkillBundles } from './platformSkillBundlesAuthoring.js';

// ============================================================================
// Output schemas for compose-skill agent tasks (104j §6.9 outputContract)
// ============================================================================
//
// Authoring rationale: validating Runner output against the same Zod schemas
// the inline `skill.compose.propose` handler uses — derived to JSON Schema
// once at module load — means a Runner that emits a malformed payload (wrong
// field names, missing required keys, etc.) gets `OUTPUT_VALIDATION_FAILED`
// in its OWN session and can self-correct before the bad output ever reaches
// the Driver's validate-and-propose step. Without this, an LLM mistake in
// `design-skill` propagates two task hops downstream and fails the whole
// run with no path back to the agent that made the mistake.

const ANALYZE_INTENT_OUTPUT_SCHEMA: JsonSchema = toJsonSchemaSync(ComposeIntentSchema);

// The LLM tool input_schema HINT only. Authoritative submit_output + harness
// enforcement runs the full Zod TaskGraphDraftSchema (incl. cross-field
// superRefines the JSON projection cannot carry) via the validatorRefs on the
// draft-task-graph task below — one authority (Plan 206).
const DRAFT_TASK_GRAPH_OUTPUT_SCHEMA: JsonSchema = toJsonSchemaSync(TaskGraphDraftSchema);

// ============================================================================
// Output schema for bind-capability draft-definition task
// ============================================================================
//
// Same authoring pattern as compose-skill: derive at module load from the
// platform's source-of-truth Zod schema. The runner's submit_output
// validates against this — so an `authKind: 'http_basic'` (where allowed
// values are bearer/api_key/oauth2/basic/none) gets rejected at the runner
// session, not three task hops later in capability.binding.propose.
const DRAFT_API_DEFINITION_OUTPUT_SCHEMA: JsonSchema = toJsonSchemaSync(
  DraftApiDefinitionOutputSchema,
);

// elicit-target classifies the request scope. A discriminated union on `scope`
// locks the consistency each branch depends on: API-change scopes carry
// `proceedWithApiChange: true` and no advisory; the store-install scope pins
// `proceedWithApiChange: false` and carries the listing coordinates the
// install op task binds; the skill-change scope carries
// `proceedWithApiChange: false` and a REQUIRED advisory (promoted onto the run
// result). `proceedWithApiChange` is the boolean the
// draft/propose `when` gates on (the proven `== true` predicate pattern).
const ELICIT_TARGET_NEW_API_FIELDS = {
  proceedWithApiChange: z.literal(true),
  apiId: z.string().min(1).max(128).optional(),
  targetSummary: z.string().optional(),
};
// Edit scopes REQUIRE the target id — an optional id here is how an edit
// falls back to a name-derived id downstream and ratifies into a duplicate.
const ELICIT_TARGET_EDIT_API_FIELDS = {
  proceedWithApiChange: z.literal(true),
  apiId: z
    .string()
    .min(1)
    .max(128)
    .describe("The EXISTING definition's apiId, copied verbatim from api.definition.list."),
  targetSummary: z.string().optional(),
};
const ELICIT_TARGET_OUTPUT_SCHEMA: JsonSchema = toJsonSchemaSync(
  z.discriminatedUnion('scope', [
    z.object({
      scope: z.literal('store_install'),
      proceedWithApiChange: z.literal(false),
      // The listing coordinates ARE the install op's input fields — one
      // authority, so the runner-validated output always satisfies the op.
      catalogId: StoreListingInstallInputSchema.shape.catalogId,
      expectedVersion: StoreListingInstallInputSchema.shape.expectedVersion,
      listingInstallState: z
        .literal('not_installed')
        .describe(
          'The installedState the store search/get reported for this listing. Only a ' +
            'not_installed listing is a store_install — an installed API that needs more ' +
            'endpoints is scope extend_existing.',
        ),
      targetSummary: z.string().optional(),
    }),
    z.object({ scope: z.literal('new_binding'), ...ELICIT_TARGET_NEW_API_FIELDS }),
    z.object({ scope: z.literal('extend_existing'), ...ELICIT_TARGET_EDIT_API_FIELDS }),
    z.object({ scope: z.literal('egress_update'), ...ELICIT_TARGET_EDIT_API_FIELDS }),
    z.object({
      scope: z.literal('no_api_change__recommend_skill_change'),
      proceedWithApiChange: z.literal(false),
      advisory: WorkflowRunResultAdvisorySchema,
      targetSummary: z.string().optional(),
    }),
  ]),
);

// The union root has no top-level properties to traverse, so the fields the
// install op task binds are also declared as produces[] ports — shapes derived
// from the op's own input schema.
const STORE_INSTALL_INPUT_PROPERTIES = (
  toJsonSchemaSync(StoreListingInstallInputSchema) as unknown as {
    properties?: Record<string, Record<string, unknown>>;
  }
).properties;

function storeInstallInputShape(key: 'catalogId' | 'expectedVersion'): Record<string, unknown> {
  const shape = STORE_INSTALL_INPUT_PROPERTIES?.[key];
  if (!shape) throw new Error(`store.listing.install input schema is missing '${key}'`);
  return shape;
}

// ============================================================================
// Timestamp constant (used in all definitions)
// ============================================================================

export const PLATFORM_EPOCH = '2025-01-01T00:00:00.000Z';

// ============================================================================
// compose-skill — the skill that creates other skills (104f)
// ============================================================================

export const COMPOSE_SKILL_WORKFLOW: PlatformWorkflowDef = {
  slug: 'compose-skill',
  name: 'Compose Skill',
  description: 'Design a new skill: workflow and activation pattern.',
  goal: 'Create a complete, validated skill bundle from a goal description.',
  mode: 'process',
  status: 'approved',
  revision: 17,
  origin: 'platform',
  outcomes: [
    {
      id: 'bundle-valid',
      name: 'Valid Bundle',
      evaluator: {
        type: 'manual',
        instruction: 'The emitted skill_compose proposal passes schema + graph validation.',
      },
    },
    {
      id: 'proposal-emitted',
      name: 'Proposal Emitted',
      evaluator: {
        type: 'manual',
        instruction: 'A StagedChange was successfully written to staging.',
      },
    },
  ],
  tasks: [
    {
      taskId: 'analyze-intent',
      name: 'Analyze Intent',
      goal: `Extract a typed ComposeIntent from the user's goal in your delegationContext. ONLY job: intent extraction — no skill design, no tool choice, no task proposals. The output schema (input_schema in your tool surface) defines the shape.

Hard requirements:
- **Classify create vs modify first.** compose-skill is ONLY for creating a new skill. If the user asks to fix, patch, repair, edit, update, or otherwise modify an existing skill/workflow, set \`authoringIntent: "modify_existing_skill"\`. Do NOT reinterpret it as a new skill request and do NOT design a replacement. The deterministic prepare step will stop and route Helmsman to \`workflow.manage.patch\`.
- Set \`authoringIntent: "create_new_skill"\` only when the user is asking for a brand-new skill.
- \`requiredCapabilities\` are non-droppable. List a capability ONLY if the user explicitly named it OR the goal structurally requires it (e.g. "submit through the Acme API" requires the Acme API capability). Downstream phases cannot remove what you list here.
- \`requiredDataSources\` describe real-source data the workflow must obtain. **\`purposeId\` is a JOIN KEY** — short slug-like identifier (e.g. "titanic-train", "submission-template", "competition-dataset"), NOT a description. \`validate-source-coverage\` compares it verbatim against \`produces[*].providesPurposeId\` on the producer task. Aim for ≤ 60 chars; max is 200.

External services rules:
- **\`compute.sandbox.exec\` is NOT external API access.** The sandbox has no network egress: no external APIs, no package indexes (PyPI, npm), no websites, no hosts outside the Phoenix VM. Pip-installing a vendor CLI fails at name resolution. If the user goal names an external service (any third-party domain or named API — Kaggle, Stripe, GitHub, Slack, etc.), classify it as \`kind: "api"\` (or \`"mcp"\` if served via MCP). Compute is for in-sandbox computation over data the workflow already has.
- **Read vs. write decides whether it is a data source.** \`requiredDataSources\` is ONLY for data the workflow OBTAINS. If the goal references fetching / downloading / reading FROM an external service, emit BOTH a \`requiredCapabilities\` entry of kind \`api\`/\`mcp\` AND a matching \`requiredDataSources\` entry (same sourceKind + sourceId). If the goal references submitting / uploading / posting / writing TO an external service, emit ONLY the \`requiredCapabilities\` entry — a write action obtains no data, so it gets NO \`requiredDataSources\` entry. (A service used for both read and write gets one \`requiredDataSources\` entry for the read only.)
- **Mirror the External services delegation block.** When Helmsman includes an "External services:" block in your delegation context, emit one \`requiredCapabilities\` entry per service, plus a \`requiredDataSources\` entry ONLY for services you READ data from. Dropping a \`requiredCapabilities\` entry is a hard error caught by the downstream gate.

Field guidance:
- \`iterationModel\`: \`optimization\` for iterating toward a target metric, \`process\` for independent cases per run, \`project\` for work that accumulates across runs.
- \`taskShapeHints\` are advisory only — surface only shapes essential to the structure (e.g. "needs a human approval before submission"). Don't enumerate every task.
- \`intent\`: one paragraph restating WHAT the skill must do, not HOW.

Do NOT call discovery tools (\`catalog.tool.list\`, \`api.binding.list\`) at this phase — discovery runs deterministically downstream in prepare-design-surface.`,
      type: 'agent',
      // Schema-first: ComposeIntent is the typed IR consumed by every
      // downstream phase. submit_output rejects malformed payloads at the
      // runner so the agent self-corrects instead of polluting downstream
      outputContract: {
        schema: ANALYZE_INTENT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
      // No promoteOutputs: validateWorkflowGraph rejects a promotion whose
      // toState is not declared in stateVariables, and state-promotion is
      // not yet wired at runtime (see the bundle-level comment above).
      // Downstream tasks consume this output via `task_output` inputBindings.
      context: {
        strategy: 'scoped',
        contextPolicy: 'auto-optimize',
        learnings: 'active',
        // Intent extraction is purely a reading task — no operation grants.
      },
    },
    {
      taskId: 'prepare-design-surface',
      name: 'Prepare Design Surface',
      goal: 'Compute the typed legal-IDs universe the design phase may draw from. Pauses with a bind-capability handoff if a hard requirement cannot be satisfied.',
      type: 'operation',
      operation: 'skill.compose.prepare_surface',
      dependsOn: ['analyze-intent'],
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
      },
      // No promoteOutputs: state-variable promotion is not yet wired at
      // runtime. design-skill consumes prepare-design-surface's output via
      // `task_output` inputBindings (typed `TaskInputs` channel).
    },
    {
      taskId: 'draft-task-graph',
      name: 'Draft Task Graph',
      goal: `Author a typed TaskGraphDraft from the typed ComposeIntent (\`inputs.intent\`) and DesignSurface (\`inputs.surface\`). assemble-workflow downstream lowers it mechanically into a complete workflow.

Your typed inputs:
- \`inputs.intent\` — the canonical ComposeIntent from analyze-intent. \`intent.requiredCapabilities\` and \`intent.requiredDataSources\` are HARD requirements; do not drop them.
- \`inputs.surface\` — the bound DesignSurface from prepare-design-surface. \`surface.integrations\` (one entry per bound API or MCP, with \`sourceKind: 'api' | 'mcp'\`, \`integrationId\`, \`bindingId\`, and \`toolNames\`) and \`surface.operations\` are the authoritative legal universe — every grant you author must subset this.
- \`inputs.system_feedback\` — typed ContractError when this is a producer rerun (validation failed downstream and routed back here). On the first attempt this field is absent. When present, READ \`system_feedback.contractName\`, \`system_feedback.zodIssues[].message\`, and \`system_feedback.actualValuePreview\` and edit the offending part of the draft to fix exactly that. Do NOT add the same broken pattern again.

The output schema (input_schema in your tool surface) defines the TaskGraphDraft shape — read it to see required fields, kind enums, and produces/consumes shapes. Author within the schema; do not paraphrase fields.

Graph structure rules:
- **Exactly one root task** — exactly one task may have no predecessors (no \`dependsOn\` or \`consumes\`). Multiple root tasks is a graph error (all start simultaneously at run launch). Fan out from a single setup/initialize task via \`dependsOn\`.
- Human tasks have no \`consumes\`, so predecessors come only from explicit \`dependsOn\` or \`approves\`.

Per-kind structural rules (enforced at submit_output by the schema invariants):
- **fetcher** — fetches real data from a named external source. MUST grant ≥1 callable api/mcp endpoint. MUST NOT grant \`compute.sandbox.exec\`. Typically labels one \`produces[*].providesPurposeId\`.
- **transformer** — derives output from upstream \`consumes[]\`. MAY grant \`compute.sandbox.exec\`. MUST NOT grant api/mcp endpoints (use a separate fetcher to get more source data).
- **writeback** — submits/posts to an external system. MUST grant ≥1 callable api/mcp endpoint. MUST NOT grant \`compute.sandbox.exec\`. MUST NOT label \`providesPurposeId\`.
- **judge** — evaluates upstream output. MUST NOT grant api/mcp endpoints; typically grants \`ai.*\` operations.
- **researcher** — open-ended exploration. Use sparingly; default to one of the four execution kinds.

Human-in-the-loop tasks (\`type: 'human'\`) — Plan 156 §5.3 idioms:
- Use \`type: 'human'\` ONLY when the workflow legitimately cannot proceed without a person (a typed answer that the operator must supply, OR a gate before something irreversible). Do NOT add a human task to "show progress" — chat already does that. Do NOT add one as a sanity-check on agent output — that's a \`judge\` task.
- Two intents, both pause the run and surface as Action Center items:
  - **\`intent: 'collect'\`** — gather structured input. Declare \`produces[]\` so the assembler derives a JSON schema; the platform renders a \`<SchemaForm>\` matching that schema and the operator's typed response becomes the task's output. Use for "what dataset?", "which model config?", "approve this draft text with edits", etc.
  - **\`intent: 'approve'\`** — gate downstream work behind an approve/reject decision. Do NOT declare \`produces[]\` or an output schema — the platform fixes the output to \`{ decision: 'approved' | 'rejected', comment?: string }\` and rejects custom contracts on approval tasks. Use for "submit this prediction?", "ratify this binding?", "proceed with destructive op?".
- \`pauseInstruction\` is the prompt shown to the operator (≤${PAUSE_INSTRUCTION_MAX_CHARS} chars). Be specific: name what they're deciding and what context they need.
- Human tasks have NO \`inputBindings\` and NO \`consumes\` — the human IS the input. If a downstream task needs the operator's typed response, declare a \`consumes\` against the human task's \`produces[*]\` port (collect-intent only — approval outputs are not typically consumed; downstream branches on the human task's \`status\`).
- **Never** add \`consumes\` pointing at a \`type: "human"\` task — human tasks have no output ports (\`outputKey: "decision"\` does not exist). Use \`dependsOn: ["<humanTaskId>"]\` to sequence after the gate; the run pauses there and proceeds automatically on approval.
- **For \`intent: 'approve'\` tasks**: set \`approves: ['<taskId>']\` to name the tasks whose output the human is reviewing. The assembler derives \`dependsOn\` from \`approves\` automatically — no need to set both. The platform also surfaces the \`approves\` list so the operator knows what they are deciding on. Omit \`approves\` and \`dependsOn\` only if the approval is intentionally gating the entire run before any work begins.

Capability rules:
- \`compute.sandbox.exec\` has no network egress — it cannot reach external APIs, package indexes, or websites. If a goal references an external service, classify it as \`kind: 'api'\` (or \`'mcp'\`) in the intent and grant the corresponding fetcher.
- **Two separate grant slots** inside \`context.capabilities\` — always spelled exactly this way, never at any other nesting level:
  - \`context.capabilities.integrations\` — array of api/mcp endpoint grants, shape \`{ sourceKind: 'api'|'mcp', integrationId, bindingId, toolNames: string[], grantKind?: 'endpoint_tools'|'direct_url' }\`.
  - \`context.capabilities.operations\` — array of platform operation ID strings, e.g. \`["memory.store.put", "workflow.learn.record", "ai.generate.text"]\`.
  Do NOT put either field directly under \`context\` — the only legal field under \`context\` is \`capabilities\`. \`context.operations\` is not a valid path; it must be \`context.capabilities.operations\`.
- Every integration grant must subset \`inputs.surface\`. For an \`endpoint_tools\` grant (the default), \`bindingId\` + \`toolNames\` must come from the bound binding's listed values; empty \`toolNames[]\` produces zero callable tools and is rejected.
- **Signed/dynamic cross-host URL** (a URL the API returns at runtime — e.g. a GCS upload/download URL — NOT a fixed endpoint): when \`inputs.surface\` marks a binding \`callMode: 'direct_url'\`, grant it with \`grantKind: 'direct_url'\` and NO \`toolNames\`, and call it via \`api.http.call\` direct-URL mode (\`apiId + bindingId + url\`). Never model such a URL as a new endpoint.
- Do NOT include \`api.http.call\` or \`mcp.tool.call\` in operations for \`endpoint_tools\` grants — the runner promotes those tools automatically. EXCEPTION: a \`direct_url\` grant is invoked through \`api.http.call\`, so a task using one MUST also list \`api.http.call\` in \`operations\`.
- **judge** tasks MUST NOT have any \`context.capabilities.integrations\` entries. They MAY have \`context.capabilities.operations\` (e.g. \`["memory.store.put", "ai.*"]\`) for persisting results or calling AI operations.
- Do NOT drop a \`requiredCapability\` from \`inputs.intent\` to satisfy a validation error; signal_blocked with category capability_unavailable instead.

Dataflow rules:
- For each \`intent.requiredDataSources[*]\` entry, exactly one task must label its \`produces[*].providesPurposeId\` with that entry's \`purposeId\` (verbatim) AND grant the matching api/mcp capability with a callable endpoint/tool. Downstream consumers do NOT re-label.
- Discovery tools (\`catalog.tool.list\`, \`api.binding.list\`, \`workflow.manage.list\`) are sanity-check tools — \`inputs.surface\` is the authoritative universe.

Typed channels — Plan 129 (the producer port is the single source of truth):
- \`produces[]\` declares each task's typed output ports. A port has \`key\` (camelCase identifier), \`shape\` (a real JSON Schema fragment — see below), and \`semantics\`.
- \`consumes[]\` declares cross-task data flow. Each entry references an upstream task's port by \`taskId + outputKey\` and gives it a local name via \`bindAs\`.
- Do NOT author \`outputContract\` or \`inputContract\` — the assembler derives both from \`produces[]\`. The producer's runtime contract requires every declared port at the top level (\`additionalProperties: false\`); the consumer's input contract is copied verbatim from the upstream port's shape. Authoring them yourself is a no-op and noise.
- Do NOT author \`inputBindings\` on agent or human tasks — the assembler lowers \`consumes[]\` into bindings automatically. (Operation tasks DO author \`inputBindings\` directly because that's their op-input-spec, distinct from cross-task data flow.)
- \`produces[].shape\` MUST be a usable JSON Schema fragment — it must include at least one of: \`type\`, \`$ref\`, \`oneOf\`, \`anyOf\`, \`allOf\`, \`enum\`, \`const\`. Empty \`{}\` is rejected. Prose strings are rejected. \`{ properties: {...} }\` without a \`type\` is rejected (Ajv would treat it as accept-everything). Author real schemas — \`{ "type": "object", "properties": { ... }, "required": [...] }\` — not skeletons.,

Optimization archetype — ONLY when \`inputs.intent.iterationModel\` is \`optimization\` (iterate toward a target metric). Add a top-level \`optimization\` block (field docs are in your output contract):
- \`goalMetric.producedBy\` names the produced port carrying the score (MUST be \`semantics: "metric"\`). \`direction\`/\`target\` may be \`$campaign\` refs (one skill serves maximize + minimize). A ref to a numeric/direction field is BARE — \`{ "$campaign": "targetScore" }\`; a \`map\` only translates a string-enum, never \`map: {}\`.
- \`campaign\` = per-campaign config (identity vs tunable). Bind a field via a \`campaign_field\` consume; every identity field must be consumed.
- The observe op reads the score via \`poll\` + \`outputProjection\` and declares that metric port. Gate irreversible/quota ops (\`retryability: "unsafe"\`) behind a \`human\`/\`approve\` task.
- Do NOT author \`stateVariables\`/\`promoteOutputs\`/\`output\`/\`outcomes\`/\`manifest.campaign\`+\`goal\` — the assembler DERIVES them all. Omit \`outcomes\` entirely (authoring any is rejected in optimization mode).

Activation is OPTIONAL — omit for chat-only skills. If included, both \`triggerPatterns\` (1–10 strings) and \`activationHint\` are required.`,
      type: 'agent',
      dependsOn: ['prepare-design-surface'],
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
        surface: {
          kind: 'task_output',
          taskId: 'prepare-design-surface',
          path: 'designSurface',
        },
        system_feedback: { kind: 'system_feedback' },
      },
      outputContract: {
        schema: DRAFT_TASK_GRAPH_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        validatorRefs: ['compose.task-graph-draft', 'task-graph-self-consistent'],
      },
      context: {
        strategy: 'scoped',
        contextPolicy: 'auto-optimize',
        learnings: 'active',
        capabilities: {
          operations: [
            'catalog.tool.list',
            'api.definition.list',
            'api.binding.list',
            'workflow.manage.list',
            'memory.store.query',
          ],
        },
      },
    },
    // ========================================================================
    {
      taskId: 'validate-task-graph',
      name: 'Validate Task Graph',
      goal: 'Validate draft self-consistency: dangling refs, unknown outputKeys, duplicate taskIds, cycles. Lifted from the legacy task-graph-self-consistent runtime validator.',
      type: 'operation',
      operation: 'skill.compose.validate_task_graph',
      dependsOn: ['draft-task-graph'],
      inputBindings: {
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      },
      outputContract: {
        schema: { type: 'object', properties: { valid: { const: true } }, required: ['valid'] },
      },
      onContractFailure: {
        perBinding: {
          draft: { producer: 'rerun', maxProducerReruns: 2 },
        },
      },
    },
    {
      taskId: 'validate-source-coverage',
      name: 'Validate Source Coverage',
      goal: 'Verify every requiredDataSource has exactly one labelled producer with a callable api/mcp grant. Lifted from assembleWorkflow.verifyRequiredDataSourceAccess.',
      type: 'operation',
      operation: 'skill.compose.validate_source_coverage',
      dependsOn: ['draft-task-graph'],
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      },
      outputContract: {
        schema: { type: 'object', properties: { valid: { const: true } }, required: ['valid'] },
      },
      onContractFailure: {
        perBinding: {
          // The draft is the rerunnable producer — most violations are
          // missing labels or mis-wired grants the runner can fix.
          draft: { producer: 'rerun', maxProducerReruns: 2 },
          // Intent shouldn't be re-derived mid-run (it's the canonical user
          // request). If the validator blames intent, escalate to a coach /
          // human resolution.
          intent: { producer: 'signal_blocked' },
        },
      },
    },
    {
      taskId: 'validate-capability-grants',
      name: 'Validate Capability Grants',
      goal: 'Verify draft grants subset the prepared DesignSurface. Lifted from assembleWorkflow.verifySurfaceConformance.',
      type: 'operation',
      operation: 'capability.validate.grants',
      dependsOn: ['draft-task-graph'],
      inputBindings: {
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
        surface: {
          kind: 'task_output',
          taskId: 'prepare-design-surface',
          path: 'designSurface',
        },
      },
      outputContract: {
        schema: { type: 'object', properties: { valid: { const: true } }, required: ['valid'] },
      },
      onContractFailure: {
        perBinding: {
          draft: { producer: 'rerun', maxProducerReruns: 2 },
          // Surface is deterministic from the intent — a surface-side
          // mismatch is a platform/authoring bug, not a producer-fixable
          // contract.
          surface: { producer: 'fail' },
        },
      },
    },
    {
      taskId: 'assemble-workflow',
      name: 'Assemble Workflow',
      goal: 'Lower the validated task-graph draft into a complete workflow definition.',
      type: 'operation',
      operation: 'skill.compose.assemble_workflow',
      // Wait for ALL three validators to succeed. Their inputBindings
      // route failures back to draft-task-graph via the rerun cycle.
      dependsOn: ['validate-task-graph', 'validate-source-coverage', 'validate-capability-grants'],
      // inputBindings still point at the original producers — the
      // validators are gates, not data sources.
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
        surface: {
          kind: 'task_output',
          taskId: 'prepare-design-surface',
          path: 'designSurface',
        },
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      },
    },
    {
      taskId: 'validate-and-propose',
      name: 'Validate and Propose',
      goal: 'Validate the bundle shape, resolve all referenced operations against the registry, and emit a skill_compose StagedChange for operator review.',
      type: 'operation',
      operation: 'skill.compose.propose',
      dependsOn: ['assemble-workflow'],
      inputBindings: {
        assembled: { kind: 'task_output', taskId: 'assemble-workflow' },
      },
    },
  ],
  iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
  createdAt: PLATFORM_EPOCH,
  updatedAt: PLATFORM_EPOCH,
};

export const COMPOSE_SKILL_EVAL_SUITE = {
  goalCriteria: [
    {
      name: 'bundle-schema-valid',
      type: 'contains',
      inField: 'validate_result',
      pattern: '"applied":true',
    },
    {
      name: 'proposal-emitted',
      type: 'contains',
      inField: 'propose_result',
      pattern: '"status":"proposed"',
    },
  ],
  taskCriteria: {},
  trajectoryCriteria: [
    { name: 'step-count', type: 'trace_bound', metric: 'step_count', maxValue: 15 },
    { name: 'duration', type: 'trace_bound', metric: 'duration_ms', maxValue: 180000 },
  ],
  weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
  createdAt: PLATFORM_EPOCH,
  updatedAt: PLATFORM_EPOCH,
  createdBy: 'platform',
};

// ============================================================================
// bind-capability — wire external APIs into the space (104g)
// ============================================================================

export const BIND_CAPABILITY_WORKFLOW: PlatformWorkflowDef = {
  slug: 'bind-capability',
  name: 'Bind Capability',
  description:
    "Wire or repair an external API in this space. Emits a capability_binding proposal for operator ratification. Covers the full API definition: name, baseUrl, authKind, endpoints (add/remove/edit), endpoint parameters, AND the binding's egress policy (allowedHosts, cross-host redirects, response-body and timeout limits, allowed methods). Use this when: (1) a new API needs wiring, (2) an existing API is missing an endpoint or has wrong parameters, (3) an existing API's baseUrl or auth scheme changed upstream, (4) a runtime egress error blocks an existing API (e.g., 'redirect to disallowed host', 'response too large', 'cross-host redirect blocked'). When the store carries a NOT-yet-installed listing for the vendor, the run stages a store-install proposal instead of drafting a definition; an already-installed API is extended in place. Does NOT rotate credentials — operator sets/updates auth via /integrations.",
  goal: 'Produce a validated API definition proposal for operator ratification — covers initial bindings, endpoint/parameter edits on existing APIs, and egress-policy updates.',
  mode: 'process',
  status: 'approved',
  revision: 20,
  origin: 'platform',
  stateVariables: [
    {
      variableId: 'binding_status',
      name: 'Binding Status',
      description:
        'Lifecycle status of the emitted capability_binding proposal (e.g. "proposed"), promoted from the propose-binding task.',
    },
    {
      variableId: 'advisory',
      name: 'Skill-change advisory',
      description:
        'Present only when the request is better handled by a skill change than an API change; a non-mutating recommendation surfaced on the run result for Helmsman to act on.',
    },
    {
      variableId: 'advisory_recommendation',
      name: 'Advisory recommendation kind',
      description:
        'The advisory recommendation identifier, promoted only on the advisory path — the branch-scoped scalar the Advisory Emitted outcome keys on, so runs down other branches read "not applicable" rather than "not met".',
    },
    {
      variableId: 'request_scope',
      name: 'Request scope',
      description:
        'The elicit-target classification (store_install | new_binding | extend_existing | egress_update | no_api_change__recommend_skill_change), promoted so each terminal path has a measurable outcome.',
    },
    {
      variableId: 'install_status',
      name: 'Store-install proposal status',
      description:
        'Lifecycle status of the emitted store_install proposal (e.g. "proposed"), promoted from the propose-store-install task.',
    },
  ],
  output: { advisory: 'advisory' },
  outcomes: [
    {
      id: 'definition-proposed',
      name: 'Definition Proposed',
      evaluator: { type: 'pattern', metric: 'binding_status', pattern: 'proposed' },
    },
    {
      id: 'store-install-proposed',
      name: 'Store Install Proposed',
      evaluator: { type: 'pattern', metric: 'install_status', pattern: 'proposed' },
    },
    {
      id: 'advisory-emitted',
      name: 'Advisory Emitted',
      // Keys on a variable only the advisory branch promotes — a metric the
      // other branches also set (request_scope) evaluates to met:false there,
      // which the run surface paints as a failure on a flawless run.
      evaluator: {
        type: 'pattern',
        metric: 'advisory_recommendation',
        pattern: '.+',
      },
    },
  ],
  tasks: [
    {
      taskId: 'elicit-target',
      name: 'Resolve API Target',
      goal: `Classify the **scope** of the request into exactly one of five, and emit it as the typed output below.

1. **store_install** — the request names a vendor/service NOT yet wired in this space, and a store listing covers it with \`installedState: not_installed\`. For any new vendor, search the store FIRST (store.listing.search with the vendor name) and prefer installing a matching listing over authoring a definition by hand — set \`catalogId\`, \`expectedVersion\`, and \`listingInstallState\` from the matching result. An already-installed listing is NEVER store_install: if the installed API is missing endpoints, that is extend_existing.
2. **new_binding** — a NEW API needs wiring and the store has no matching listing. Resolve to an OpenAPI spec URL, a named public API, or a manual description. If only a vendor name is known, use search.web.search to locate the official OpenAPI/Swagger spec URL. Check existing bindings (api.binding.list) to avoid duplicates. ELICIT values that vary per binding/space (e.g. a JIRA/Atlassian site subdomain, a region, an account id) and carry them forward as declared \`variables[]\` rather than baking them into the base URL. If the API base URL contains a per-binding component (subdomain/region/account id), do NOT bake it into baseUrl — declare it as a variable and use baseUrlTemplate; the operator fills the value once in /integrations.
3. **extend_existing** — an EXISTING API definition in this space needs endpoints added or corrected (a missing endpoint, a wrong path or parameter). Confirm the apiId against api.definition.list / api.binding.list. The downstream draft-definition task carries the existing endpoint set forward plus the additions/corrections.
4. **egress_update** — an EXISTING binding is blocked by egress (runtime errors like "redirect to disallowed host", "response too large", "cross-host redirect blocked", or a named egress field). List the existing binding (api.binding.list) and definition (api.definition.list) to confirm the apiId. The downstream draft-definition task reuses the existing endpoint set and adds a \`suggestedEgressPolicy\` block that the apply step merges into the binding.
5. **no_api_change__recommend_skill_change** — the API definition is already correct and the request is better handled by changing the SKILL that calls it, not the API. Choose this when: the needed call is already covered by an existing endpoint used wrongly; the target is a signed/dynamic cross-host URL the API returns at runtime (that belongs in the skill as an \`api.http.call\` direct-URL step against a credential-less egress-allowlisted binding, NOT as a new endpoint on the primary integration); or the fix is otherwise in the skill's task wiring. Do NOT mutate the API to work around a skill bug.

For paths 2–4 set \`proceedWithApiChange: true\`. For paths 1 and 5 set \`proceedWithApiChange: false\`; for path 5 also populate \`advisory\` with: a \`recommendation\`, a concrete \`rationale\` (which endpoint(s) to use and how), the \`affectedEndpoints\`, and a \`suggestedCall\` naming the op Helmsman should run next (e.g. \`{ op: "workflow.manage.patch" }\`). Pick the \`recommendation\` that names the precise fix:
- \`use_existing_endpoint\` — the right endpoint already exists; the skill is calling the wrong one or ignoring it.
- \`add_direct_url_binding\` — the target is a signed/dynamic cross-host URL; add a \`direct_url\` binding and call it via \`api.http.call\`.
- \`author_endpoint_schema\` — the endpoint exists but its request-body contract is missing or wrong (the runtime call failed on body fields). The durable fix is to author/correct the typed body \`schema\` on the endpoint definition, not to patch the task prose.
- \`fix_skill_task\` — the endpoint + contract are correct; the skill's task wiring (inputs, ordering, bindings) is what's wrong.
The advisory is surfaced on the run result; the draft/propose steps are skipped.

If both an API change and a skill change apply (rare), prefer the more conservative API scope: egress_update first, then extend_existing; defer net-new bindings to a separate run.`,
      type: 'agent',
      outputContract: {
        schema: ELICIT_TARGET_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
      produces: [
        { key: 'catalogId', shape: storeInstallInputShape('catalogId'), semantics: 'data' },
        {
          key: 'expectedVersion',
          shape: storeInstallInputShape('expectedVersion'),
          semantics: 'data',
        },
      ],
      promoteOutputs: [
        { kind: 'output_path', path: 'advisory', toState: 'advisory' },
        {
          kind: 'output_path',
          path: 'advisory.recommendation',
          toState: 'advisory_recommendation',
        },
        { kind: 'output_path', path: 'scope', toState: 'request_scope' },
      ],
      context: {
        strategy: 'scoped',
        contextPolicy: 'auto-optimize',
        learnings: 'active',
        capabilities: {
          operations: [
            'api.definition.list',
            'api.binding.list',
            'store.listing.search',
            'store.listing.get',
            'memory.store.query',
            'search.web.search',
          ],
        },
      },
    },
    {
      taskId: 'draft-definition',
      name: 'Draft API Definition',
      goal: `Output a JSON object with a top-level \`apiDefinition\` field. Required: name, authKind, endpoints[], and EITHER baseUrl OR baseUrlTemplate (never both, never neither). NEVER include secrets or credentials.

## Base URL — concrete vs per-binding template

\`baseUrl\` must be a CONCRETE url (e.g. \`https://api.example.com\`) with NO placeholders. If the base URL varies per binding/space, do NOT set \`baseUrl\`: set \`baseUrlTemplate\` instead (e.g. \`https://{domain}.atlassian.net\`) and declare each \`{placeholder}\` in \`variables[]\`. NEVER leave a raw \`{placeholder}\` in \`baseUrl\` — only endpoint PATH templates use \`{}\` (and those are extracted from \`path\`, see below). Setting both \`baseUrl\` and \`baseUrlTemplate\`, or neither, is rejected.

\`variables[]\` — each entry is \`{ name, description, example?, required? }\`:
- \`name\` — a valid identifier (\`[A-Za-z_][A-Za-z0-9_]*\`) referenced as \`{name}\` in \`baseUrlTemplate\`. Every \`{placeholder}\` in \`baseUrlTemplate\` MUST have a matching declared variable.
- \`description\` — operator-facing; what value to fill (e.g. "Your Atlassian site subdomain — the \`acme\` in acme.atlassian.net").
- \`example\` — a sample non-secret value (e.g. \`"acme"\`).
- \`required\` — defaults true; the binding is \`needs configuration\` until every required variable has a value.
Variables are NON-SECRET per-binding config (subdomain/region/account-id) the operator fills once in /integrations. NEVER tokens or passwords — those stay in credentials.

For NEW APIs: parse/design from the OpenAPI spec or vendor docs. Use search.web.fetch for the spec, api.http.call for live endpoint probes.

For ENDPOINT ADDITIONS/EDITS on an existing API (extend_existing): read the prior definition (api.definition.list), set \`apiId\` to the EXISTING id copied verbatim (omitting it derives a new id from name — a mismatch ratifies into a duplicate definition), keep name, baseUrl, and authKind, and output the FULL endpoint set — every existing endpoint carried forward unchanged (preserving each endpointId) plus the additions/corrections. The ratified proposal replaces the stored definition, so an endpoint you omit is an endpoint you delete.

For EGRESS POLICY UPDATES on an existing API: set \`apiId\` to the EXISTING id copied verbatim, keep the existing name, baseUrl, authKind, and endpoints[] from the prior definition (use api.definition.list to read them), AND add a \`suggestedEgressPolicy\` block describing the egress change. The apply handler MERGES suggestedEgressPolicy into the existing binding's egress_policy_json (this is how bind-capability covers egress edits). Available suggestedEgressPolicy fields:

- \`additionalHosts: string[]\` — hosts to allow beyond baseUrl (e.g. ["storage.googleapis.com"] for Kaggle's GCS redirect).
- \`allowCrossHostRedirects: boolean\` — set true when the API redirects to a different host (Kaggle, S3-presigned, GCS-presigned).
- \`allowedMethods: string[]\` — when the default GET/POST set is insufficient (e.g. signed-PUT uploads).
- \`minResponseBodyBytes: number\` — for large file downloads (e.g. 52428800 for 50 MB). Apply takes max(existing, this) — never shrinks.
- \`minTimeoutMs: number\` — for slow/large transfers (e.g. 60000 for 60s). Same max-merge.

Common signal: a runtime error like \`Redirect to https://storage.googleapis.com/...\` means the API redirects there; add \`additionalHosts: ["storage.googleapis.com"]\` AND \`allowCrossHostRedirects: true\`.

## Endpoint shape — paths and parameters

Each entry in \`endpoints[]\` carries \`{ path, method, summary?, queryParams?, body?, response? }\`. The path/query split is load-bearing — get it wrong and the resulting binding either rejects on submit or fails at runtime:

- **\`path\` is the URL path TEMPLATE only.** It must NOT contain a query string ('?…'). The schema rejects '?' anywhere in \`path\` and points you at \`queryParams\`. \`/v1beta1/news?symbols=AAPL\` is wrong; \`/v1beta1/news\` (with \`queryParams: [{ name: 'symbols', ... }]\`) is correct.
- **Path parameters come from \`{placeholders}\` in \`path\`** — NEVER list them in \`queryParams[]\`. Synthesis extracts them automatically and emits canonical \`EndpointParam\` entries with \`location: 'path'\`. \`/v2/stocks/{symbol}/bars\` already declares \`symbol\` as a path param; don't double-list it.
- **Use \`{name}\` braces for path params, NOT Express-style \`:name\`.** Only \`{...}\` placeholders are extracted by synthesis. A path like \`/users/:id\` produces ZERO path params and the URL is never substituted at runtime — the literal \`:id\` ships in the request.
- **\`queryParams[]\` is for query string parameters only.** Each entry: \`{ name, required?, description?, exampleValue? }\`.
  - \`required\`: omit (or false) when the API accepts the endpoint without the param. Operators can tighten during ratification — leaning permissive when unsure is safer than blocking valid calls.
  - \`description\`: short, operator-facing. From the OpenAPI \`description\` if present.
  - \`exampleValue\`: a sample value for the operator review pane and downstream agent prompts. Annotation only — the runtime does NOT auto-substitute it; callers must pass the value in \`params\`. (Do not confuse with a "default value".)
    - **Always a string** — even for numeric or boolean parameters, quote the value: \`"10"\`, \`"true"\`, \`"2026-01-01"\`. The schema enforces stringness; numbers or booleans fail at submit time.
    - **URL-decode before placing here** — a sample URL with \`?q=hello%20world\` becomes \`exampleValue: "hello world"\`, not \`"hello%20world"\`. The annotation is for humans reading the operator review pane.
    - When parsing an OpenAPI 3.x spec, prefer \`parameters[].example\` or \`parameters[].schema.example\` (in that order) as the source — both fields are designed for this. Fall back to a representative value derived from the description only when neither is present.
  - **Names must be unique within an endpoint.** Repeated names indicate authoring error; the runtime would just emit the caller's value twice.
- **Header parameters are NOT in scope.** Bearer/api-key headers come from the binding's auth profile (operator-configured).
- **\`endpointId\` is the stable identifier referenced by skill grants** — optional on new endpoints, REQUIRED to preserve on edits. When absent, apply derives the ID from \`method + path\` (lowercased, path placeholders flattened: \`POST /v2/orders\` → \`post_v2_orders\`). The catch: if you later edit the path on an existing endpoint, the synthesized ID changes, and every skill grant that references the old ID stops promoting tools (the skill goes mute at runtime).
  - **For NEW endpoints**, omit \`endpointId\` — let apply synthesize it. Operators reviewing the proposal will see the synthesized IDs.
  - **For PATH EDITS on existing endpoints** (e.g., upstream renamed \`/orders → /v2/orders\`), read the prior definition (\`api.definition.list\` or a prior \`api.definition.get\`), extract the existing \`endpointId\`, and SET it explicitly on the edited entry. The path changes; the identifier doesn't. Example: prior endpoint was \`{ "endpointId": "post_orders", "path": "/orders", "method": "POST" }\`; the new entry must carry \`{ "endpointId": "post_orders", "path": "/v2/orders", "method": "POST" }\` so dependent skill grants keep resolving.
  - **Renaming an endpointId is a breaking change** — every skill grant referencing the old ID will surface as \`status: 'missing_endpoint'\` in skill projections (Plan 148 Phase 3 surfaces this clearly to the operator). Don't rename unless you also update the skills.
- **Body parameters: use the \`body\` field whenever the endpoint takes a request body.** Each entry: \`{ contentType?, description?, schema }\` — \`schema\` is REQUIRED. \`contentType\` defaults to \`"application/json"\`; set it to \`"application/x-www-form-urlencoded"\` or \`"multipart/form-data"\` for form endpoints (apply lowers it to the canonical \`bodyEncoding\` and the executor encodes the body object accordingly — repeated keys for array values). Apply lowers \`body\` to a single canonical request-body parameter; the agent calls the promoted tool with \`body: <object>\` and the bytes flow to the wire intact.
  - **Typical methods that carry a body: POST, PUT, PATCH.** Some APIs also accept a JSON body on DELETE (e.g., bulk-delete with criteria) — declare \`body\` for those too. The executor sends bodies on every method except GET and HEAD; do NOT declare \`body\` on GET/HEAD (the schema accepts it but it would never be sent).
  - **\`description\` is operator-facing.** One short sentence describing the body shape (e.g., \`"Order request: symbol, qty, side, type, time_in_force"\`). Surfaces in the operator review pane.
  - **\`schema\` is REQUIRED JSON Schema for the body shape, and it is ENFORCED.** It becomes the promoted tool's \`body\` input schema and is validated against the request body on every call, so a body that violates it is rejected before the request goes out — for a raw caller as well as for the model. Take it from the OpenAPI \`requestBody.content['application/json'].schema\` when there is one; otherwise state the shape you know. Example: \`{ "type": "object", "required": ["symbol","qty","side"], "properties": { "symbol": {"type":"string"}, "qty": {"type":"string"}, "side": {"type":"string","enum":["buy","sell"]} } }\`.
    - Put per-field guidance in each property's \`description\` — the tool mapper uses this schema in place of the body's prose, so that is where a caller reads what a field means.
    - Set \`additionalProperties: false\` when the field list is exact. Leave it off when the API accepts more than you can enumerate.
  - **The agent supplies the full body as a single object** — there are no per-field body parameters to declare. The object is not opaque, though: it is checked against \`schema\` as a whole, which is how a missing required field or a wrong type is caught.
- **\`response\`: what a successful call returns — \`{ description?, schema }\`.** Declare it on every endpoint you can. It is the other half of the contract, and it is what decides whether the API can be SIMULATED as well as called: a simulation with nothing authored answers by generating against this schema, so an endpoint without one reads \`contract_missing\` and cannot be mocked at all. When the API does not exist yet, this field is the difference between a proposal and a runnable one.
  - **\`schema\` is the success (2xx) body**, as JSON Schema. Error shapes are not declared here — state the shape a caller gets when things work.
  - **Put per-field guidance in each property's \`description\`.** A generating simulation reads them, so \`{ "type": "string", "description": "ISO-4217 code, uppercase" }\` produces a plausible answer where a bare \`{ "type": "string" }\` produces noise.
  - **\`description\` is one operator-facing sentence** about what comes back. It is merged into the stored schema when the schema has none of its own, so it is never lost.
  - From an OpenAPI spec, take \`responses['200'].content['application/json'].schema\` (or the 2xx equivalent) and RESOLVE it the same way — the response schema is stored exactly as you write it too. Skip the field only when the response genuinely has no stable shape.

### Two authoring paths for parameters

1. **From an OpenAPI / Swagger spec (the common case)** — walk the operation's parameter sources:
   - \`parameters[]\` entries where \`in == 'query'\` → one \`queryParams[]\` entry each: name → \`name\`, required → \`required\`, description → \`description\`, \`example\` (or \`schema.example\`) → \`exampleValue\` (as a string).
   - \`parameters[]\` entries where \`in == 'path'\` → already covered by the \`{placeholders}\` in \`path\`. Skip (don't double-list).
   - \`parameters[]\` entries where \`in == 'header'\` → out of scope.
   - **Request body — two spec shapes**:
     - **OpenAPI 3.x**: the operation's \`requestBody.content['application/json'].schema\` → set \`body.schema\` to that schema fragment, RESOLVED. Do not paste a \`$ref\` through: nothing resolves it later — this draft is stored exactly as you write it — so a \`{"$ref": "#/components/schemas/Order"}\` produces an endpoint that fails every call, and the draft schema rejects it at submit time. Inline the referenced shape from \`components.schemas\`, or for a genuinely recursive shape carry it in the schema's own \`$defs\` and point at \`#/$defs/<name>\`. \`body.description\` comes from \`requestBody.description\` or the operation summary. JSON only — if the spec lists multiple content types, take \`application/json\`. When the spec declares no usable schema, \`schema\` is still REQUIRED: state the open contract \`{ "type": "object", "additionalProperties": true }\` rather than omitting the field, which fails submit_output.
     - **Swagger 2.0**: \`parameters[]\` entries where \`in == 'body'\` → map to the \`body\` field. The body parameter's \`schema\` field holds the JSON Schema; resolve any \`#/definitions/...\` reference and put the RESULT into \`body.schema\` — a reference copied through is stored unresolved and breaks every call. The parameter's \`description\` → \`body.description\`.

2. **From a user description or example URL (the manual case)** — when the user writes \`/news?symbols=AAPL\` or \`/v2/stocks/{symbol}/bars?timeframe=1Day&start=2026-01-01\`, split the \`?…\` segment by '&', then by '=': each \`key=value\` becomes one \`queryParams\` entry, where \`key\` is \`name\` and the URL-decoded \`value\` is \`exampleValue\`. Move the bare path (everything before '?') into \`path\`. If unsure whether a param is required, mark \`required: false\` — operator review can tighten it. For bodies, capture the JSON shape from the user's curl example into \`body.schema\` (annotation only) and a one-sentence \`body.description\`.

### Worked examples

\`\`\`json
// Query-only endpoint (no path params).
// Synthesis emits params: [
//   { name: "symbols", location: "query", required: true,  description: "Comma-separated tickers" },
//   { name: "limit",   location: "query", required: false, description: "Max results" }
// ]
{ "path": "/v1beta1/news", "method": "GET",
  "summary": "Fetch news for one or more symbols",
  "queryParams": [
    { "name": "symbols", "required": true, "description": "Comma-separated tickers", "exampleValue": "AAPL,MSFT" },
    { "name": "limit", "description": "Max results", "exampleValue": "10" }
  ] }

// Mixed path + query.
// Synthesis extracts {symbol} from path (location: "path", required: true)
// and emits the queryParams[] entries with location: "query" after it.
{ "path": "/v2/stocks/{symbol}/bars", "method": "GET",
  "summary": "Historical OHLCV bars",
  "queryParams": [
    { "name": "timeframe", "required": true, "description": "1Min/5Min/1Day/...", "exampleValue": "1Day" },
    { "name": "start", "description": "RFC-3339 timestamp", "exampleValue": "2026-01-01" },
    { "name": "end", "description": "RFC-3339 timestamp" }
  ] }

// Path-param-only — queryParams omitted entirely.
// Synthesis emits params: [{ name: "id", location: "path", required: true }].
{ "path": "/competitions/{id}/leaderboard/download", "method": "GET",
  "summary": "Fetch leaderboard CSV" }

{ "path": "/v2/orders", "method": "POST",
  "summary": "Submit an order",
  "body": {
    "contentType": "application/json",
    "description": "Order request: symbol, qty, side, type, time_in_force",
    "schema": {
      "type": "object",
      "required": ["symbol", "qty", "side", "type", "time_in_force"],
      "properties": {
        "symbol": { "type": "string" },
        "qty": { "type": "string", "description": "Quantity as a string per Alpaca's API" },
        "side": { "type": "string", "enum": ["buy", "sell"] },
        "type": { "type": "string", "enum": ["market", "limit", "stop", "stop_limit"] },
        "time_in_force": { "type": "string", "enum": ["day", "gtc", "ioc", "fok"] }
      }
    }
  } }

// PATCH with path param + JSON body — both flow into synthesis.
// Synthesis emits params: [
//   { name: "orderId", location: "path", required: true },
//   { name: "body", location: "body", required: true, description: "Order patch: qty, limit_price, stop_price, time_in_force" }
// ]
{ "path": "/v2/orders/{orderId}", "method": "PATCH",
  "summary": "Replace an existing order",
  "body": {
    "contentType": "application/json",
    "description": "Order patch: qty, limit_price, stop_price, time_in_force",
    "schema": {
      "type": "object",
      "properties": {
        "qty": { "type": "string" },
        "limit_price": { "type": "string" },
        "stop_price": { "type": "string" },
        "time_in_force": { "type": "string", "enum": ["day", "gtc", "ioc", "fok"] }
      }
    }
  } }
\`\`\``,
      type: 'agent',
      dependsOn: ['elicit-target'],
      // Skipped when elicit-target classifies the request as a skill change
      // (no_api_change__recommend_skill_change) — the advisory path, no API edit.
      when: {
        expression: 'tasks.elicit-target.output.proceedWithApiChange == true',
        onMissingRef: 'skip',
      },
      inputBindings: {
        target: { kind: 'task_output', taskId: 'elicit-target' },
      },
      // Schema-first: derived from the same ApiDefinitionDraftSchema that
      // capability.binding.propose validates against — so a bad authKind /
      // shape error fails the runner's submit_output (retryable) instead
      // of cascading into the inline op two task hops later.
      //
      // The JSON projection is the LLM's hint; the validatorRef is the
      // authority. `toJsonSchemaSync` drops superRefine, so the cross-field
      // rules — callMode/auth coherence, and every endpoint schema being
      // self-contained — reach submit_output only through the ref. Without it a
      // `$ref` into a spec passes here and fails at propose, one hop after the
      // Runner could still have fixed it (Plan 206: one authority).
      outputContract: {
        schema: DRAFT_API_DEFINITION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        validatorRefs: ['capability.api-definition-draft'],
      },
      context: {
        strategy: 'scoped',
        contextPolicy: 'auto-optimize',
        learnings: 'active',
        capabilities: {
          // bind-capability is an operator-approved exploratory skill: search.web.search
          // locates docs/protocols for under-documented endpoints (e.g. a resumable-upload
          // flow), search.web.fetch retrieves OpenAPI specs (and other public docs), and
          // api.http.call is retained for testing live endpoints against the target API.
          operations: [
            'search.web.search',
            'search.web.fetch',
            'api.http.call',
            'api.definition.list',
            'memory.store.query',
          ],
        },
      },
    },
    {
      taskId: 'propose-binding',
      name: 'Propose Binding',
      goal: 'Validate the API definition draft and emit a capability_binding StagedChange for operator review.',
      type: 'operation',
      operation: 'capability.binding.propose',
      dependsOn: ['draft-definition'],
      // Skipped on the advisory path (its producer draft-definition was skipped).
      when: {
        expression: 'tasks.elicit-target.output.proceedWithApiChange == true',
        onMissingRef: 'skip',
      },
      inputBindings: {
        apiDefinition: {
          kind: 'task_output',
          taskId: 'draft-definition',
          path: 'apiDefinition',
        },
      },
      promoteOutputs: [{ kind: 'output_path', path: 'status', toState: 'binding_status' }],
    },
    {
      taskId: 'propose-store-install',
      name: 'Propose Store Install',
      goal: 'Stage the matched store listing as a store_install proposal for operator ratification.',
      type: 'operation',
      operation: 'store.listing.install',
      dependsOn: ['elicit-target'],
      // Runs only on the store path; drafting stays inexpressible there
      // (the store_install arm pins proceedWithApiChange to false).
      when: {
        expression: "tasks.elicit-target.output.scope == 'store_install'",
        onMissingRef: 'skip',
      },
      inputBindings: {
        catalogId: { kind: 'task_output', taskId: 'elicit-target', path: 'catalogId' },
        expectedVersion: {
          kind: 'task_output',
          taskId: 'elicit-target',
          path: 'expectedVersion',
        },
      },
      promoteOutputs: [{ kind: 'output_path', path: 'status', toState: 'install_status' }],
    },
  ],
  iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
  createdAt: PLATFORM_EPOCH,
  updatedAt: PLATFORM_EPOCH,
};

export const BIND_CAPABILITY_EVAL_SUITE = {
  goalCriteria: [],
  taskCriteria: {
    'propose-binding': [
      { name: 'definition-proposed', type: 'contains', inField: 'status', pattern: 'proposed' },
    ],
    'propose-store-install': [
      { name: 'store-install-proposed', type: 'contains', inField: 'status', pattern: 'proposed' },
    ],
  },
  trajectoryCriteria: [
    { name: 'step-count', type: 'trace_bound', metric: 'step_count', maxValue: 15 },
    { name: 'duration', type: 'trace_bound', metric: 'duration_ms', maxValue: 120000 },
  ],
  weights: { goal: 0, task: 0.7, trajectory: 0.3 },
  createdAt: PLATFORM_EPOCH,
  updatedAt: PLATFORM_EPOCH,
  createdBy: 'platform',
};

// ============================================================================
// Exports
// ============================================================================

/**
 * Platform skill bundles — complete bundles with manifest, workflow, and eval suite.
 */
export const PLATFORM_SKILL_BUNDLES: PlatformSkillBundleEntry[] =
  buildAuthoringPlatformSkillBundles({
    epoch: PLATFORM_EPOCH,
    composeWorkflow: COMPOSE_SKILL_WORKFLOW,
    composeEvalSuite: COMPOSE_SKILL_EVAL_SUITE,
    bindWorkflow: BIND_CAPABILITY_WORKFLOW,
    bindEvalSuite: BIND_CAPABILITY_EVAL_SUITE,
  });

export const ALL_PLATFORM_WORKFLOWS: PlatformWorkflowDef[] = PLATFORM_SKILL_BUNDLES.map(
  (b) => b.workflow,
);
