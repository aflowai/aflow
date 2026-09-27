# Task Context, Step Roles & Graph Contracts

Cybernetic execution is graph-compiled: each task is dispatched by the scheduler with a sealed scope. This document covers the per-task contract, the typed step-role enum that drives dispatch, the runtime graph validator, and the cross-task typed channels that move data between tasks.

## StepRole (Plan 104b)

Source: `packages/schemas/src/artifact/stepDefinition.ts` (`StepRoleSchema`).

Replaces tag-based dispatch (`tags.includes('workflow_task')`).

| Value                    | Meaning                                                                                             | Notes                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `standard`               | Default. Used in classic agents and any non-cybernetic step.                                        | Cybernetic skills use this only for utility steps that aren't tasks (rare). |
| `workflow_bootstrap`     | Seeds run-level state once before tasks dispatch (e.g., reading run inputs, setting up the ledger). | Exactly one per workflow, conventionally `startStepId`.                     |
| `workflow_task`          | A task scheduled by the graph-compiled scheduler with a `TaskContextSpec`.                          | The Runner gets a sealed scope and the declared tools only.                 |
| `workflow_parallel_join` | A join step gathering fan-out task outputs before continuing.                                       | Pairs with parallel tasks declaring it as their downstream target.          |

## TaskContextSpec

Source: `packages/schemas/src/cybernetic/context.ts` (`TaskContextSpecSchema`, lines 146–214).

Every `workflow_task` step declares a `TaskContextSpec` in its `config.contextSpec` (or as a top-level field — check the schema). This is the contract between the Driver, the Runner, and the orchestrator about what this task needs.

| Field               | Type                              | Notes                                                                                                      |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `strategy`          | `static` \| `scoped` \| `curated` | `static`: deterministic context. `scoped`: subset of space context. `curated`: Coach-tuned context bundle. |
| `tools`             | `OperationId[]`                   | Concrete operations the Runner may invoke.                                                                 |
| `toolGroups`        | string[]                          | Capability groups (`stepType.group`) — broader than individual ops; resolved per the capability profile.   |
| `capabilities`      | `TaskCapabilityGrant`             | Structured grants for APIs and MCP servers (see below).                                                    |
| `staticRefs`        | string[]                          | Pinned doc/memory references included verbatim in context.                                                 |
| `search`            | array of search specs             | Memory/embedding queries the Runner can issue against curated indices.                                     |
| `learnings`         | object                            | Slot for Coach-curated lessons applicable to this task.                                                    |
| `priorResults`      | object                            | Whether/how to surface results from upstream tasks in the graph.                                           |
| `budget`            | object                            | Per-task budget caps (steps, tokens, duration).                                                            |
| `attentionFunction` | optional                          | Strategy for how the Runner narrows its focus mid-task.                                                    |
| `contextPolicy`     | `auto-optimize` \| `pinned`       | If `pinned`, the Coach is not allowed to refine this task's context spec.                                  |

### TaskCapabilityGrant

Source: `packages/schemas/src/cybernetic/context.ts` (`TaskCapabilityGrantSchema`).

Bind-time, the task declares exactly which integrations it may reach (Plan 155 §10 — APIs and MCP servers share one unified `integrations[]` array discriminated by `sourceKind`):

```json
{
  "operations": ["memory.store.get"],
  "integrations": [
    {
      "sourceKind": "api",
      "integrationId": "stripe-payments",
      "bindingId": "stripe-prod",
      "capabilityId": "stripe-payments",
      "toolNames": [{ "toolName": "charges.create" }]
    },
    {
      "sourceKind": "api",
      "integrationId": "internal-crm",
      "bindingId": "crm",
      "capabilityId": "internal-crm",
      "allTools": true
    },
    {
      "sourceKind": "mcp",
      "integrationId": "kaggle",
      "bindingId": "kaggle",
      "capabilityId": "kaggle",
      "toolNames": [{ "toolName": "search_competitions" }]
    }
  ]
}
```

Granular grants are preferred. `allTools: true` is an escape hatch for trusted internal definitions. See [`docs/dev/integrations-and-capabilities.md`](../../../../docs/dev/integrations-and-capabilities.md) for the full grant shape and the discovery/promotion model.

## Graph contract runtime (Plan 123)

Source: `packages/schemas/src/artifact/flowValidation.ts` and the `validateWorkflowGraph` helper.

Every workflow is contract-validated **at write time and assembly time**. Cybernetic-specific contracts (on top of the standard 5-layer pipeline from `flow-building/references/validation.md`):

- **Input bindings**: each task declares the upstream outputs it consumes; the graph compiler verifies references resolve and types match.
- **Output schemas**: each task declares a JSON Schema for its outputs; the runtime validates produced payloads at the Ajv boundary.
- **Source coverage**: every required input has a declared source (bootstrap, upstream task, or run input). `compose-skill.validate_source_coverage` enforces this.
- **Capability grants vs operations**: tools listed in `TaskContextSpec.tools` must be covered by the capability profile _and_ at least one capability grant. `compose-skill.validate_capability_grants` enforces this.
- **Eval-vs-workflow coverage**: when the bundle carries an eval suite, task-scoped criteria must name real taskIds and reference output fields the task actually produces — enforced as skill-validity diagnostics (`eval_field_not_produced` and friends), recomputed at read (Plan 190).

A bundle that fails any of these is rejected before becoming a `skill_compose` `StagedChange`.

## Cross-task typed channels (Plan 129)

Plan 129 introduces typed _channels_ that flow data between tasks instead of relying on shared state variables. Channels carry:

- A **producer task** and **consumer task(s)**.
- A **shape contract** (JSON Schema) validated at both ends.
- An **emission policy** (single, stream, optional).

Channels make parallel fan-out/fan-in safe: a `workflow_parallel_join` step gathers channel outputs from sibling tasks rather than fishing values out of run state. State variables remain valid for ambient run state (cost ledger, identity, configuration), but task-to-task data should prefer channels.

Use channels when:

- Two tasks have a producer/consumer relationship and the data is large or needs validation.
- You're authoring a parallel section that joins back together.

Skip channels and use state for:

- Shared run-wide settings.
- Sentinels (e.g., a `cost_so_far` accumulator).

## Pause, resume, and failure (Plans 130, 131)

- **Pause**: human tasks (`stepType: 'user'` or any task that emits a pause signal) automatically pause the run. The pause bubbles to the Helmsman, which relays to the operator. `agent.control.resume` resumes from frozen task state.
- **Failure isolation**: by default `failureMode: 'isolate'` — a failing task blocks its dependents but lets siblings run. `cancel_siblings` is opt-in for tightly coupled fan-out.
- **Delegation liveness** (Plan 131): the Helmsman tracks delegated runs and can detect stalls, recover, or surface failures.

## Quick checklist when designing a task

1. What's the **goal** of this task in one sentence?
2. What **upstream task outputs / run inputs** does it consume? Declare as input bindings.
3. What does it **produce**? Declare an output schema.
4. What **operations and capability grants** does it need? List in `TaskContextSpec`.
5. Is it **parallelizable** with siblings? If so, plan the `workflow_parallel_join`.
6. What is the **failure mode**? Isolate (default) or cancel siblings?
7. What **eval criteria** measure this task's contribution to the skill outcome?

These map directly to fields `compose-skill` will fill in during `draft-task-graph`.
