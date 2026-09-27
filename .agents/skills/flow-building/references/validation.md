# Flow Validation Pipeline

Source of truth: `packages/schemas/src/artifact/flowValidation.ts`

## 5-layer validation

Validation runs in strict sequence. Each layer catches different classes of errors.

### Layer 1 — Shape validation

Checks basic structure: required fields present, correct types, no duplicates.

| Rule ID                 | Level | What it checks                                  |
| ----------------------- | ----- | ----------------------------------------------- |
| `MISSING_FLOW_ID`       | error | `flowId` is empty or missing                    |
| `INVALID_FLOW_ID`       | error | `flowId` doesn't match `^[a-z][a-z0-9_-]*$`     |
| `MISSING_FLOW_NAME`     | error | `metadata.name` is empty or missing             |
| `NO_STEPS`              | error | `steps` array is empty                          |
| `MISSING_START_STEP`    | error | `startStepId` is empty or missing               |
| `MISSING_STEP_ID`       | error | A step has no `stepId`                          |
| `MISSING_STEP_TYPE`     | error | A step has no `stepType`                        |
| `MISSING_OPERATION`     | error | A step has no `operation`                       |
| `DUPLICATE_STEP_ID`     | error | Two steps share the same `stepId`               |
| `DUPLICATE_VARIABLE_ID` | error | Two state variables share the same `variableId` |

### Layer 2 — Consistency validation

Checks graph integrity: transitions point to real steps, all steps reachable.

| Rule ID                     | Level   | What it checks                                           |
| --------------------------- | ------- | -------------------------------------------------------- |
| `INVALID_START_STEP`        | error   | `startStepId` not found in `steps[]`                     |
| `INVALID_TRANSITION_TARGET` | error   | `onSuccess`/`onFailure` references non-existent step     |
| `INVALID_RESUME_TARGET`     | error   | `onResume.continueToStepId` references non-existent step |
| `UNREACHABLE_STEP`          | warning | Step not reachable from `startStepId` via BFS            |

### Layer 3 — Binding validation (requires catalog)

Checks operations exist and required inputs are configured. Only runs when catalog is provided.

| Rule ID                      | Level   | What it checks                                |
| ---------------------------- | ------- | --------------------------------------------- |
| `UNKNOWN_OPERATION`          | warning | Operation not found in catalog                |
| `STEP_TYPE_MISMATCH`         | warning | Step's `stepType` doesn't match operation's   |
| `UNMAPPED_REQUIRED_INPUT`    | error   | Required input not in config and not internal |
| `INVALID_ENUM_VALUE`         | warning | Static config value not in enum               |
| `UNDECLARED_OUTPUT_VARIABLE` | error   | `outputMapping` targets undeclared variable   |

**Agent tool step bypass**: Steps that are children of `ai.agent.turn` (tool steps in the graph) skip input coverage checks — the agent provides inputs at runtime.

### Layer 4 — Expression validation

Checks `${state.varName}` references resolve to declared variables.

| Rule ID                | Level | What it checks                                        |
| ---------------------- | ----- | ----------------------------------------------------- |
| `UNKNOWN_VARIABLE_REF` | error | `${state.foo}` where `foo` is not in `stateVariables` |

Backtick-wrapped code blocks are excluded from reference scanning.

### Layer 5 — Zod input validation

Validates static config values against the operation's `inputZod` schema.

| Rule ID                       | Level | What it checks                           |
| ----------------------------- | ----- | ---------------------------------------- |
| `STEP_INPUT_VALIDATION_ERROR` | error | Static config value fails Zod validation |

Only checks fields with fixed values — fields using `${...}` refs are skipped (resolved at runtime).

## Using validation

```typescript
import { validateFlowDefinition } from '@aflow/schemas';

const result = validateFlowDefinition(flowDef, catalogEntries);
// result: { valid, issues[], errorCount, warningCount, stepCount, stateVariableCount }
```

Or via the platform: `flow.manage.validate` operation validates a flow definition and returns structured issues.

## Validation via MCP

To validate a flow during development:

```
mcp__aflow-local__run_operation({ operationId: "flow.manage.validate", input: { flowConfig: {...} } })
```
