## Flow execution architecture (FlowExecutionService → StepService → handlers)

This document describes the **mechanics that apply to all steps**, the **event-driven transition model**, and the **contracts required to add new handlers safely**.

This is the stable “how the engine works” reference. For historical/background context, see `docs/plans/aflow/step-service-boundaries-and-events.md` and `docs/plans/aflow/state-variable-first-agent-input-delta.md`.

---

## Core principles (non‑negotiable)

- **State variables are the main data flow**
  - User input and step outputs live in `runtimeState.variables`.
  - Handlers read from resolved inputs (derived from state variables), not from raw API payloads.

- **One canonical outcome model**
  - Every step ultimately results in exactly one of:
    - **complete** (succeeded)
    - **fail** (failed)
    - **waitForInput** (paused)
  - Only `StepService` translates those outcomes into **durable hot state + run events**.

- **Event-driven transitions**
  - Steps don’t “call the next step”. They produce outcomes → events are emitted → the engine schedules next steps based on the flow graph.

- **Separation of concerns**
  - **FlowExecutionService**: run lifecycle + scheduling + transitions.
  - **StepService**: universal step mechanics (gating, pause/complete/fail, output mapping, canonical event emission).
  - **Handlers**: operation business logic only; no direct Redis mutations; no bespoke pause payloads.

- **Targeted pause/resume**
  - Pauses request **specific variable IDs** (`missingVariables`).
  - Resume fills those exact variable IDs via `{ input: { [variableId]: value } }`.

- **Idempotency and safety**
  - Step results are processed idempotently (terminal steps are not re-applied).
  - The engine must not get stuck in `RUNNING` due to “job enqueue failed” or partial updates; durable state and events move together.

---

## System layers and responsibilities

### FlowExecutionService (engine / orchestrator)

Primary responsibilities:

- **Run lifecycle**
  - `startRun`: initialize run hot state, initialize runtime variables from API input, schedule first step.
  - `resumeRun`: write provided variable values into runtime state, clear pause markers, and schedule continuation.
  - `cancelRun`: set terminal state and emit the right terminal event.

- **Scheduling and transitions**
  - Schedule steps (`StepScheduled`) and enqueue executor jobs (or dispatch inline operations).
  - On result consumption (`applyResult`), decide the next transition:
    - success → `resolveNextStep(stepDef, 'success')`
    - failure → retry / onFailure route / terminal fail
    - pause → unify into `input_required`

Non-responsibilities:

- Operation-specific input schema validation, bespoke pause payloads, or output mapping logic spread across step types.

Implementation home:

- `apps/aflow-orchestrator/src/services/FlowExecutionService/`

### StepService (universal step mechanics)

`StepService` is the single place that:

- **Gates execution** if required state variables are missing (pre-exec gating).
- **Pauses** runs with one canonical pause model (`input_required`).
- **Completes** steps and emits `StepSucceeded`.
- **Fails** steps and emits `StepFailed` (and optionally run-level failure events).
- Optionally **applies output mapping** and includes `runtimeStatePatch` for UI/debugging.

Implementation home:

- `apps/aflow-orchestrator/src/services/StepService/`
  - `types.ts` (contracts)
  - `StepService.ts` (canonical implementations)

### Handlers (operation business logic)

Handlers:

- Receive **resolved and validated inputs** (no raw API input dependency).
- Perform the operation.
- Return a canonical outcome (`complete` / `fail` / `waitForInput`).

Handlers must NOT:

- Mutate Redis hot state directly.
- Emit run events directly.
- Implement their own pause reasons or resume schemas.

---

## Universal mechanics (applies to all steps)

### 1) Runtime state and variable definitions

The run has:

- **Values**: `runtimeState.variables[variableId] = { ref, updatedAtMs, updatedBy, version }`
- **Definitions** (metadata): base + optional **run-local overlay** merged into “effective” definitions.

Why definitions matter:

- Pre-exec gating: “which variables are required?”
- Pause UX: “what label/schema do we show to clients?”
- Validation and resolution: “what schema does this variable represent?”

### 2) Config resolution and pre-execution gating

Before a step executes, the engine resolves `${state.*}` bindings in step config and detects unresolved references.

If required variables are unresolved:

- The step does not execute.
- The run is paused via **one** mechanism: `StepService.waitForInput(...)`.

The pause payload is canonical:

- Run hot state:
  - `status = 'PAUSED'`
  - `pauseReason = 'input_required'`
  - `requestedInputRef = <payloadRef or inline:...>`
- A `FlowRunPaused` event is emitted with:
  - `metadata.prompt` (optional)
  - `metadata.missingVariables` (**array of objects** with `variableId`, optional `name/typeSchema/...`)

### 3) Pause/resume contract (client-facing)

When paused, the run presents required input as:

- `missingVariables: [{ variableId, name?, description?, typeSchema?, semanticType?, required: true }]`
- `prompt?: string`

The client must resume with:

```json
{
  "stepExecutionId": "<paused stepExecutionId>",
  "input": {
    "<variableId>": "<value>"
  }
}
```

Never send `{ prompt: "..." }` / `{ message: "..." }` unless those are literal variable IDs declared by the pause.

### 4) Success path (complete)

On success, the canonical mechanics are:

- Mark step hot state: `SUCCEEDED`
- Apply output mapping (if any) to update `runtimeState.variables`
- Emit `StepSucceeded` with:
  - `outputRef` (optional)
  - `runtimeStatePatch` (recommended for UI/debugging)
- Transition:
  - terminal → emit `FlowRunSucceeded` and set run hot state `status = 'SUCCEEDED'`
  - non-terminal → schedule next step

### 5) Failure path (fail)

On failure, the engine decides one of:

- **Retry** (if policy allows): emit `StepFailed` (with retry metadata), schedule a retry timer.
- **onFailure route**: emit `StepFailed`, schedule the configured failure next step.
- **Terminal fail**: emit `StepFailed` + `FlowRunFailed`, set run hot state `status = 'FAILED'`.

Important: even “non-executor” failures (e.g. enqueue failure, serialization) must still be routed through the same failure machinery so runs do not get stuck.

---

## Events and transitions (what gets emitted, and why)

These are the key events produced during execution:

- **`FlowRunQueued`**: run was created/queued.
- **`FlowRunStarted`**: run began processing.
- **`StepScheduled`**: a step execution was scheduled (job enqueued or inline op dispatched).
- **`StepSucceeded`**: step completed successfully.
- **`StepFailed`**: step completed with failure.
- **`FlowRunPaused`**: run paused due to required input (`pauseReason='input_required'`).
- **`FlowRunResumed`**: run resumed after input was provided.
- **`FlowRunSucceeded`**: run reached a terminal success.
- **`FlowRunFailed`**: run reached a terminal failure.
- **`FlowRunCancelled`**: run was cancelled.
- **`FlowRunStalled`**: engine detected corrupt or unprocessable hot state (circuit breaker).

Transition rule of thumb:

- **Only** the engine decides what step(s) to schedule next based on the flow definition graph (`onSuccess` / `onFailure`).
- Handlers do not make transition decisions. They only produce outcomes.

---

## StepService contracts (what every handler plugs into)

### StepOutcome (handler → StepService)

Every handler returns one of:

```ts
export type StepOutcome =
  | { kind: 'complete'; output?: unknown; outputRef?: string }
  | { kind: 'fail'; error: { code: string; message: string; details?: unknown } }
  | {
      kind: 'waitForInput';
      requiredVariables: Array<{
        variableId: string;
        name?: string;
        description?: string;
        typeSchema?: Record<string, unknown>;
        semanticType?: string;
        required: true;
      }>;
      prompt?: string;
      eventMeta?: Record<string, unknown>;
    };
```

### waitForInput is the only pause mechanism

All mid-run pauses funnel through:

- `StepService.waitForInput(requiredVariables, { prompt?, eventMeta?, ... })`

That creates a canonical `requestedInputRef` payload and emits `FlowRunPaused` with structured `missingVariables`.

---

## How to add a new handler (future-proof checklist)

### 1) Define the operation and its schema

- Add/confirm the operation exists in the catalog and has:
  - input schema
  - output schema (if applicable)
  - step type association (which executor processes it)

### 2) Decide the state-variable interface

- Identify the **variable IDs** that the operation needs.
- Ensure they are declared in `flowDef.stateVariables` or are introduced via a run-local overlay (when they are step-scoped like agent chat input).

### 3) Implement the handler as “pure business logic”

The handler should:

- Read from already-resolved inputs.
- If a required variable is missing, return:
  - `kind: 'waitForInput'` with `requiredVariables: [{ variableId: '...', ... }]`
- On success, return:
  - `kind: 'complete'` (and optionally `outputRef`)
- On failure, return:
  - `kind: 'fail'` with a stable error code and message.

### 4) Do not re-implement platform mechanics

Do not:

- Emit run events directly.
- Update `RunHotState`/`StepHotState` directly.
- Invent pause reasons or resume schemas.

Instead:

- Rely on StepService for pause/complete/fail and for output mapping/event emission.

### 5) Add tests / smoke checks

Recommended checks:

- Start a run that reaches the handler.
- Force a pause and confirm the pause event includes:
  - `pauseReason='input_required'`
  - `missingVariables: [{ variableId: ... }]` (object shape)
- Resume with `{ [variableId]: value }` and confirm the next step sees the value.
- Verify `/v1/runs/:runId/debug` and `/v1/runs/:runId/state` show the expected runtime variable updates.

Docs/tools:

- `docs/dev/debugging-runs.md`

---

## Code entry points (where to start reading)

- **Engine (scheduling + result consumption)**: `apps/aflow-orchestrator/src/services/SessionOrchestrator/`
  - `scheduleStep(...)`
  - `applyResult(...)`
  - `startRun(...)` / `resumeRun(...)`

- **Universal step outcomes**: `apps/aflow-orchestrator/src/services/StepService/StepService.ts`
  - `resolveAndGate(...)`
  - `waitForInput(...)`
  - `completeStep(...)`
  - `failStep(...)`
  - `applyOutputAndComplete(...)`

- **Contracts**: `apps/aflow-orchestrator/src/services/StepService/types.ts`

- **Web pause/resume contract**:
  - reducer: `packages/run-view/src/index.ts`
  - resume payload builder: `packages/web-product/src/ui/screens/space-chat.tsx`
