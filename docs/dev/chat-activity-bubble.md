# Chat Activity Bubble

How the activity indicator (spinner + label) works in the chat page, and the full catalog of session events the chat receives.

## Overview

The activity bubble is the spinner row at the bottom of the chat message list. It shows what the agent is doing while a session is running — e.g. "Thinking…", "Calling API…", "Running subflow…".

**Key files:**

| File                                                                                     | Role                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/web-product/src/ui/hooks/use-activity-bubble.ts`                               | Derives `ActivitySignal` from SSE events |
| `packages/web-product/src/ui/components/chat/ChatMessages.tsx`                           | Renders the activity row                 |
| `packages/web-product/src/ui/screens/space-chat.tsx`                                     | Wires events + status into the hook      |
| `packages/run-view/src/index.ts`                                                         | Builds `RunViewState` from event stream  |
| `apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/forwardChildEvent.ts` | Forwards child events to parent stream   |

## How the activity bubble works

```
SSE stream (session events)
    │
    ▼
useRunEvents()          ← subscribes to /v1/sessions/:id/events
    │
    ├──► runEventReducer()   → status, messages, requiredInput, …
    │
    └──► useActivityBubble() → ActivitySignal { label, stepName, stepType, … }
              │
              ▼
         ChatMessages         → renders spinner row (opacity tied to status)
```

### Signal lifecycle

1. **Optimistic label** — On user send, an optimistic "Thinking…" is shown immediately before any SSE events arrive.
2. **Step events** — `StepScheduled` / `StepStarted` create a signal with a schema-driven label (e.g. "Generating text…", "Searching memory…").
3. **Text streaming** — `AgentTextDelta` upgrades the label to "Writing…".
4. **Subflow delegation** — `SessionPaused` with `subflowWaiting: true` shows "Running subflow…". Subsequent `SubflowEventForwarded` events update with child progress.
5. **Terminal events** — `SessionCompleted`, `SessionFailed`, `SessionCancelled`, `StepCompleted`, `StepFailed`, `StepPaused` clear the signal.
6. **TTL expiry** — If no new event arrives within `ACTIVE_STEP_MAX_AGE_MS` (3 min), the signal auto-clears.

### Visibility control

The activity row is always mounted but uses `opacity` to show/hide:

```
visible when: runStatus === 'RUNNING' || runStatus === 'WAITING_ON_CHILD'
hidden when:  any other status (PAUSED, SUCCEEDED, FAILED, etc.)
```

### Label resolution priority

1. `ACTION_LABELS[operationId]` — schema-driven map (e.g. `ai.agent.turn` → "Thinking…")
2. `STEP_TYPE_FALLBACKS[stepType]` — per-executor fallback (e.g. `ai` → "AI processing…")
3. `humanizeToken(operationId)` — auto-generated from operation ID segments
4. `"Working…"` — last resort

### Step context carry-forward

`StepStarted` doesn't always include `stepName` or other metadata. The hook maintains a `stepContextRef` keyed by `stepExecutionId`, so metadata from `StepScheduled` carries forward to `StepStarted` and `AgentTextDelta` for the same step.

## Session event catalog

All event types the chat page can receive via SSE (`/v1/sessions/:id/events`).

### Session lifecycle

| Event              | Description                          | Activity bubble effect                                               |
| ------------------ | ------------------------------------ | -------------------------------------------------------------------- |
| `SessionQueued`    | Session created, waiting to start    | —                                                                    |
| `SessionStarted`   | Execution began                      | —                                                                    |
| `SessionResumed`   | Resumed after pause / user input     | —                                                                    |
| `SessionPaused`    | Awaiting user input or subflow       | Clears activity (unless `subflowWaiting: true` → "Running subflow…") |
| `SessionCompleted` | Finished successfully                | Clears activity                                                      |
| `SessionSucceeded` | Alias for completed                  | Clears activity                                                      |
| `SessionFailed`    | Terminated with error                | Clears activity                                                      |
| `SessionCancelled` | Explicitly cancelled                 | Clears activity                                                      |
| `SessionRetried`   | Being retried after failure          | —                                                                    |
| `SessionStalled`   | Queued but engine never picked it up | —                                                                    |

### Step lifecycle

| Event           | Description                                                                     | Activity bubble effect                                      |
| --------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `StepScheduled` | Step queued for execution (carries stepName, operationId, stepType, stepDetail) | Sets activity with resolved label                           |
| `StepStarted`   | Step execution began                                                            | Sets/updates activity (inherits context from StepScheduled) |
| `StepSucceeded` | Step completed successfully                                                     | — (not a terminal event for bubble purposes)                |
| `StepCompleted` | Step completed                                                                  | Clears activity                                             |
| `StepFailed`    | Step errored                                                                    | Clears activity                                             |
| `StepPaused`    | Step paused (e.g. user interaction within step)                                 | Clears activity                                             |

### Streaming / UI

| Event            | Description                                    | Activity bubble effect       |
| ---------------- | ---------------------------------------------- | ---------------------------- |
| `AgentTextDelta` | Progressive text chunk from agent output       | Upgrades label to "Writing…" |
| `SurfaceUpdate`  | Streaming surface mutations for interactive UI | —                            |

### Subflow / delegation

| Event                   | Description                                      | Activity bubble effect           |
| ----------------------- | ------------------------------------------------ | -------------------------------- |
| `SubflowEventForwarded` | Child event forwarded to parent stream (Plan 50) | Sets activity with subflow label |

### Safety

| Event                 | Description                 | Activity bubble effect |
| --------------------- | --------------------------- | ---------------------- |
| `GuardrailViolation`  | Guardrail rule triggered    | —                      |
| `GuardrailRunSummary` | Aggregate guardrail summary | —                      |

## Subflow event forwarding

When a parent session delegates to a child (e.g. helmsman → driver/runner), the orchestrator selectively forwards child events to the parent's stream as `SubflowEventForwarded` envelopes.

### Currently forwarded

- `StepScheduled` — always forwarded (carries stepName, operationId, stepType, stepDetail for unified timeline + activity bubble labels)
- `StepSucceeded` — only if it carries `agentMessage` or `displayOutput` metadata
- `StepFailed` — always forwarded (enables error visibility for child step failures)
- `SessionCompleted` / `SessionFailed` — always forwarded
- `SubflowEventForwarded` — recursive bubbling for nested subflows (up to 3 levels)

### NOT forwarded

- `StepStarted` — emitted by executor runtime (not orchestrator), would require executor-level forwarding
- `AgentTextDelta` — child streaming text (high volume, not forwarded to keep SSE lean)
- `SessionPaused` — handled separately by `bubbleChildPause`

### Envelope structure

```
SubflowEventForwarded.metadata = {
  sourceRunId:            // child session that emitted the original event
  sourceEventType:        // original event type (e.g. 'StepScheduled')
  sourceAgentId:          // child agent ID
  sourceStepId:           // child step ID
  sourceStepExecutionId:  // child step execution ID
  subflowStepName:        // parent's step name that triggered the subflow
  // Step-level metadata (for unified timeline rendering)
  stepName:               // human-readable step name from child
  operationId:            // fully qualified operation (e.g. 'ai.agent.turn')
  stepType:               // executor class (ai, memory, compute, etc.)
  stepDetail:             // content-focused detail (query, path, etc.)
  // Carried from original event
  agentMessage:           // forwarded from original event
  displayOutput:          // forwarded from original event
}
```

For nested subflows, the envelope is unwrapped so the outermost parent always sees the innermost source info — no double-nesting.

### Unified timeline rendering

Forwarded step events (`StepScheduled`, `StepSucceeded`, `StepFailed`) are rendered as first-class `StepGroup` cards in the Run Inspector timeline — the same format as parent session steps. A `delegateInfo` field on the StepGroup carries `role` (resolved from the parent step name or agent ID pattern), shown as a badge ("runner", "coach", "driver", "delegate").

Session-level forwarded events (`SessionCompleted`, `SessionFailed`) and `StepSucceeded` with `agentMessage` but no prior `StepScheduled` are still rendered as `SubflowEventCard`.

### Cybernetic role resolution

For cybernetic agents, delegate roles are resolved from:

1. Parent step name: `run-procedure` → "runner", `run-coach` → "coach"
2. Agent ID pattern: names containing "runner", "coach", "driver", "helmsman"
3. Fallback: "delegate"

Activity bubble role-based fallback labels:

- `run-procedure` / runner → "Executing task…"
- `run-coach` / coach → "Reviewing execution…"
- driver → "Preparing workflow…"
- helmsman → "Planning…"
- fallback → "Running delegate…"

## Known gaps / future work

- **No `StepStarted` from child sessions** — `StepStarted` is emitted by the executor runtime, not the orchestrator. Forwarding it would require changes to `ExecutorRuntime` or a pub/sub hook. `StepScheduled` provides the same metadata, so impact is minimal (activity bubble shows the right label from `StepScheduled`, just slightly earlier than actual execution start).
- **No streaming text from child sessions** — `AgentTextDelta` is not forwarded, so "Writing…" only shows for the parent agent's own turns.
- **No `systemRole` on session hot state** — role resolution uses parent step name and agent ID pattern matching rather than the authoritative `system_role` column from `agent_definitions`. Adding `systemRole` to `SessionHotState` would enable direct role lookup.
