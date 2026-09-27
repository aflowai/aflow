# Flow Execution Sequence Diagram

Paste the Mermaid code below into [mermaid.live](https://mermaid.live) or any Mermaid-compatible renderer.

## Full Flow Execution Lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant User as User / Client
  participant API as Fastify Server
  participant PS as PayloadStore
  participant CS as Redis: aflow:control
  participant CC as ControlConsumer
  participant FES as FlowExecutionService
  participant HS as Redis: Hot State
  participant ES as Redis: run_events
  participant JS as Redis: aflow:jobs:{type}
  participant Exec as Executor (AI/API/...)
  participant RS as Redis: aflow:results
  participant RC as ResultConsumer
  participant PG as PostgreSQL
  participant SSE as SSE → Web UI

  rect rgb(232, 244, 248)
    Note over User,API: 1. Run Creation
    User->>API: POST /v1/runs { flowId, input }
    API->>PS: store(input) → inputRef
    API->>CS: addControlMessage({ type: start_run, runId, flowId, inputRef })
    API-->>User: { runId, status: QUEUED, eventsUrl }
  end

  rect rgb(255, 243, 224)
    Note over CC,FES: 2. Orchestrator Picks Up Run
    CC->>CS: readControlMessages()
    CS-->>CC: { type: start_run, runId, ... }
    CC->>FES: startRun({ tenantId, runId, flowId, inputRef })
    FES->>PG: fetchFlowDef(flowId, version)
    PG-->>FES: FlowDefinition (steps, edges, config)
    FES->>FES: resolveStepInput(startStep)
    FES->>HS: atomicCreateRun(runState, stepState)
    FES->>ES: FlowRunStarted + StepScheduled events
    FES->>JS: addStepJob(StepJobMessage)
    CC->>CS: ackControlMessage(id)
  end

  rect rgb(243, 229, 245)
    Note over JS,Exec: 3. Executor Processes Step
    Exec->>JS: readStepJobs(stepType)
    JS-->>Exec: StepJobMessage { stepExecutionId, operationId, inputRef }
    Exec->>PS: resolve(inputRef) → input data
    Exec->>HS: updateStepState(STARTED)
    Exec->>ES: StepStarted event
    Note over Exec: Execute operation<br/>(AI call, HTTP request, etc.)
    Exec->>PS: store(output) → outputRef
    Exec->>RS: addStepResult({ status: SUCCEEDED, outputRef })
    Exec->>JS: ackStepJob(messageId)
  end

  rect rgb(255, 243, 224)
    Note over RC,FES: 4. Orchestrator Applies Result
    RC->>RS: readStepResults()
    RS-->>RC: StepResultMessage { runId, stepExecutionId, status, outputRef }
    RC->>FES: applyResult(tenantId, result)
    FES->>HS: updateStepState(SUCCEEDED, outputRef)
    FES->>ES: StepCompleted event
    FES->>FES: resolveNextStep(stepDef, 'success')
    RC->>RS: ackStepResult(id)
  end

  rect rgb(232, 244, 248)
    Note over FES,JS: 5. Schedule Next Step (repeat 3-4)
    FES->>FES: resolveStepInput(nextStep)
    FES->>HS: atomicScheduleStep(nextStepState)
    FES->>ES: StepScheduled event
    FES->>JS: addStepJob(nextStepJobMessage)
    Note over FES,Exec: Steps 3-4 repeat for each step in the flow
  end

  rect rgb(232, 248, 232)
    Note over FES,PG: 6. Run Completion
    FES->>HS: atomicCompleteStep(SUCCEEDED, finalOutputRef)
    FES->>ES: FlowRunSucceeded + FlowRunCompleted events
    FES->>HS: markRunDirty()
    Note over PG: ProjectionWorker (background)
    HS-->>PG: Flush terminal run to Postgres
  end

  rect rgb(248, 232, 235)
    Note over ES,SSE: 7. Real-time Events to UI (continuous)
    SSE->>ES: readRunEvents(cursor)
    ES-->>SSE: RunEvent[]
    SSE-->>User: event: run_event, data: { ... }
    Note over SSE,User: Client reconnects via Last-Event-ID
  end
```

## Agent Turn Sequence (when step is an AI agent)

```mermaid
sequenceDiagram
  autonumber
  participant FES as FlowExecutionService
  participant HS as Redis: Hot State
  participant ES as Redis: run_events
  participant JS as Redis: aflow:jobs:ai
  participant AI as AI Executor
  participant RS as Redis: aflow:results
  participant TJS as Redis: aflow:jobs:{toolType}
  participant Tool as Tool Executor

  Note over FES,AI: Agent Turn
  FES->>JS: addStepJob(agent_turn)
  AI->>JS: readStepJobs(ai)
  Note over AI: LLM decides: invoke_step(toolStepId)
  AI->>RS: addStepResult({ status: SUCCEEDED, decision: invoke_step })

  FES->>FES: applyAgentDecision()
  FES->>HS: atomicScheduleStep(toolStep)
  FES->>ES: StepScheduled event
  FES->>TJS: addStepJob(toolStep)

  Tool->>TJS: readStepJobs(toolType)
  Note over Tool: Execute tool operation
  Tool->>RS: addStepResult({ status: SUCCEEDED, toolOutput })

  FES->>FES: applyResult() → tool completed
  Note over FES: Schedule next agent turn with tool results
  FES->>JS: addStepJob(next_agent_turn)

  Note over AI: LLM decides: complete(finalAnswer)
  AI->>RS: addStepResult({ status: SUCCEEDED, decision: complete })
  FES->>FES: applyAgentDecision() → agent done
  FES->>FES: resolveNextStep() → continue flow
```
