# Workflow, Step & State Variable Schemas

Source of truth: `packages/schemas/src/artifact/`

The artifact-layer types are still named `FlowDefinition` / `flowId` for legacy reasons (Plan 90 deferred the rename to a later phase). At the storage and API surface they appear as `agent` (classic) or are embedded inside a `SkillManifest` (cybernetic). Field shapes below apply to both registers.

## FlowDefinition (= workflow)

| Field               | Type                         | Required         | Notes                                                      |
| ------------------- | ---------------------------- | ---------------- | ---------------------------------------------------------- |
| `schemaVersion`     | number                       | default: 1       |                                                            |
| `flowId`            | FlowId (branded string)      | **yes**          | Pattern: `^[a-z][a-z0-9_-]*$`                              |
| `version`           | FlowVersion (branded number) | no               |                                                            |
| `metadata`          | FlowMetadata                 | **yes**          | Must include `name`                                        |
| `stateVariables`    | StateVariable[]              | default: []      |                                                            |
| `steps`             | StepDefinition[]             | **yes** (min 1)  |                                                            |
| `startStepId`       | string                       | **yes**          | Must match a `stepId` in `steps`                           |
| `allowedOperations` | OperationId[]                | default: []      | Restrict which ops agent can use                           |
| `supportedModes`    | FlowRunMode[]                | default: ['api'] | `'api' \| 'chat' \| 'mcp' \| 'voice'`                      |
| `defaultBudgets`    | object                       | no               | `{ maxCostCents?, maxTokens?, maxDurationMs?, maxSteps? }` |
| `status`            | enum                         | default: 'draft' | `'draft' \| 'published' \| 'archived'`                     |

### FlowMetadata

| Field         | Type              | Required       |
| ------------- | ----------------- | -------------- |
| `name`        | string (1-256)    | **yes**        |
| `description` | string (max 2000) | no             |
| `author`      | string            | no             |
| `category`    | string            | no             |
| `tags`        | string[]          | no             |
| `public`      | boolean           | default: false |
| `system`      | boolean           | default: false |

## StepDefinition

| Field           | Type                    | Required              | Notes                                                                                                                            |
| --------------- | ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `stepId`        | StepId                  | **yes**               | Unique within flow                                                                                                               |
| `stepType`      | StepType                | **yes**               | `'ai' \| 'api' \| 'compute' \| 'eval' \| 'flow' \| 'guardrail' \| 'mcp' \| 'memory' \| 'platform' \| 'search' \| 'ui' \| 'user'` |
| `operation`     | OperationId             | **yes**               | Must match catalog                                                                                                               |
| `name`          | string (1-128)          | no                    |                                                                                                                                  |
| `description`   | string (max 500)        | no                    |                                                                                                                                  |
| `config`        | Record<string, unknown> | default: {}           | Static config + `${state.var}` refs                                                                                              |
| `outputMapping` | Record<string, string>  | no                    | Maps output fields to state variable paths                                                                                       |
| `outputOptions` | object                  | no                    | `{ displayToUser?: boolean }`                                                                                                    |
| `retryPolicy`   | RetryPolicy             | no                    | Override workflow default                                                                                                        |
| `timeout`       | TimeoutPolicy           | no                    | Override workflow default                                                                                                        |
| `optional`      | boolean                 | default: false        | Can skip on error                                                                                                                |
| `condition`     | string (max 1000)       | no                    | Gate expression                                                                                                                  |
| `tags`          | string[]                | default: []           |                                                                                                                                  |
| `role`          | StepRole                | default: 'standard'   | Typed dispatch role (cybernetic — see below)                                                                                     |
| `onSuccess`     | OnSuccess               | default: { next: [] } | Transition on success                                                                                                            |
| `onFailure`     | OnFailure               | default: { next: [] } | Transition on failure                                                                                                            |
| `onResume`      | OnResume                | no                    | Resume behavior                                                                                                                  |

### StepRole (Plan 104b)

Source: `packages/schemas/src/artifact/stepDefinition.ts`. Replaces tag-based dispatch (`tags.includes('workflow_task')`).

| Value                    | Meaning                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `standard`               | Default. Used by classic agents and any non-cybernetic step.                           |
| `workflow_bootstrap`     | Cybernetic: seeds run state once before tasks dispatch.                                |
| `workflow_task`          | Cybernetic: a task scheduled by the graph-compiled scheduler with a `TaskContextSpec`. |
| `workflow_parallel_join` | Cybernetic: a join point that gathers fan-out task outputs before continuing.          |

For cybernetic skills, see `cybernetic-skill-authoring` references (`task-context.md`).

### Transitions

Two equivalent forms — **flat array preferred**:

```json
// Preferred: flat array
"onSuccess": [{ "stepId": "next-step", "priority": 50 }]

// Also valid: wrapped form (legacy)
"onSuccess": { "next": [{ "stepId": "next-step", "priority": 50 }] }
```

Terminal step (flow ends): `"onSuccess": []` or `"onSuccess": [{ "stepId": null }]`

**NextStepEdge fields:**

- `stepId`: StepId | null (null = terminal)
- `description?`: string
- `when?`: string (condition expression)
- `priority`: number (0-100, default: 50)

**OnResume:**

- `continueToStepId?`: StepId (if omitted, evaluates `onSuccess.next`)

## StateVariable

| Field          | Type               | Required        | Notes                                              |
| -------------- | ------------------ | --------------- | -------------------------------------------------- |
| `variableId`   | StateVariableId    | **yes**         | Pattern: `^[a-zA-Z][a-zA-Z0-9_]*$`                 |
| `name`         | string (1-256)     | **yes**         | Human-readable                                     |
| `description`  | string (max 2000)  | no              |                                                    |
| `typeSchema`   | JSON Schema object | **yes**         | e.g., `{ "type": "string" }`                       |
| `semanticType` | SemanticType       | default: 'text' | See enum below                                     |
| `lifecycle`    | VariableLifecycle  | default: {}     | `{ isInput?, isOutput?, persistOnPause? }`         |
| `inputRole`    | enum               | no              | `'primary' \| 'config'` (only when `isInput=true`) |
| `required`     | boolean            | default: false  |                                                    |
| `defaultValue` | unknown            | no              |                                                    |
| `sensitive`    | boolean            | default: false  | Mask in logs                                       |
| `immutable`    | boolean            | default: false  | Read-only after set                                |
| `example`      | unknown            | no              |                                                    |

### SemanticType enum

`'text' | 'markdown' | 'code' | 'json' | 'table' | 'chart' | 'image' | 'audio' | 'video' | 'file' | 'url' | 'html' | 'datetime' | 'number' | 'boolean' | 'list' | 'keyvalue' | 'progress' | 'status' | 'eval_result' | 'eval_suite' | 'guardrail_policy' | 'guardrail_violations' | 'custom'`

### Input contract rules

- At most **one** variable can have `inputRole: 'primary'`
- Primary resolution order: explicit `inputRole: 'primary'` > first required text-like input > first required input > sole input > none
- Workflow callers use standard envelope: `{ input: <value>, config?: { key: value } }`
- Bare scalars (string, number, boolean) auto-map to primary input
- Config keys must match `variableId` of declared config variables

## Where workflows live (declarative authoring)

| Register              | Stored as                                                                                  | Authored via                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Classic**           | `agent_definitions` table (one row = one workflow + I/O)                                   | `agent.manage.create` / `agent.manage.update` (catalog ops)                                |
| **Cybernetic**        | Embedded in a `SkillManifest` bundle, stored under `/skills/{slug}/` in space memory       | `skill.compose.propose` (emitted by the `compose-skill` workflow); never authored directly |
| **Platform** (system) | Code-backed in `packages/platform-artifacts` and resolved by a registry overlay (Plan 106) | Edit the registry source, redeploy. No per-tenant seeding.                                 |

For cybernetic-only fields (`SkillManifest`, `EvalSuite`, `TaskContextSpec`, activation), see `cybernetic-skill-authoring`.
