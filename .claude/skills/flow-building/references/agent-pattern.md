# Agent Turn Pattern (Classic Register)

Source of truth: `packages/schemas/src/runtime/agentTurn.ts`

> **Scope.** This document describes the _classic_ `ai.agent.turn` pattern, where an agent step decides the next tool to call. In **cybernetic skills** the orchestration model is different: work is graph-compiled into typed `workflow_task` steps dispatched by the scheduler, not by an agent's free choice. See `cybernetic-skill-authoring/references/skill-bundle.md` and `task-context.md`. Inside a cybernetic Runner task you may still find an `ai.agent.turn` step doing the actual LLM call, but it does _not_ drive top-level orchestration.

## How classic agents work (Plan 19)

The AI agent is a **decision step**, not an orchestration loop:

1. `ai.agent.turn` step receives prompt + conversation history + available tools
2. Agent decides: invoke a tool step, invoke multiple tool steps, request user input, or complete
3. Orchestrator schedules the chosen step(s) as regular `StepExecution`s
4. Tool results return to orchestrator, which schedules the next agent turn
5. `parentStepExecutionId` links tool steps to their agent turn

```
agent turn → decides "invoke_step: api-fetch" → orchestrator runs api-fetch
    ↑                                                    │
    └──── next agent turn receives tool result ←─────────┘
```

## Agent roles (Plan 51)

| Role        | Purpose                     | requestInputPolicy               | completionPolicy                       |
| ----------- | --------------------------- | -------------------------------- | -------------------------------------- |
| `assistant` | Conversational, user-facing | `allowed` (can ask freely)       | `open_ended` (never needs to complete) |
| `subagent`  | Bounded delegated task      | `blocked_only` (only when stuck) | `must_complete_or_block`               |

`agentRole` is the **exclusive source of truth**. Policies auto-apply from role but can be overridden explicitly.

## Agent turn decisions

The agent outputs exactly one decision per turn:

### `invoke_step` — Call a single tool

```json
{ "action": "invoke_step", "stepId": "api-fetch", "args": { "url": "..." }, "reasoning": "..." }
```

### `invoke_steps` — Call multiple tools in parallel

```json
{
  "action": "invoke_steps",
  "calls": [
    { "stepId": "api-fetch", "args": { "url": "..." } },
    { "stepId": "memory-read", "args": { "key": "..." } }
  ],
  "reasoning": "..."
}
```

### `pause_for_input` — Ask the user

```json
{
  "action": "pause_for_input",
  "message": "What format?",
  "responseOptions": { "type": "single", "options": [{ "value": "json" }, { "value": "csv" }] }
}
```

For subagents: `blockingReason` and `blockingCategory` are required.

### `complete` — Finish the flow

```json
{ "action": "complete", "result": { "answer": "..." }, "message": "Done!" }
```

## AgentStepConfig (in flow step.config)

Key fields for configuring an agent step:

| Field                 | Type                                     | Notes                                                              |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `model`               | string                                   | e.g., `'gpt'`, `'sonnet'`, `'flash'`                               |
| `agentRole`           | `'assistant' \| 'subagent'`              | default: 'assistant'                                               |
| `systemPrompt`        | string (max 100k)                        | Agent persona/instructions                                         |
| `prompt`              | string (max 100k)                        | Usually `${state.prompt}` ref                                      |
| `temperature`         | number (0-2)                             | default: 0.1                                                       |
| `requestInputPolicy`  | enum                                     | Override role default                                              |
| `completionPolicy`    | enum                                     | Override role default                                              |
| `finalOutputSchema`   | JSON Schema                              | Subagent output contract                                           |
| `completionPrompt`    | string (max 4k)                          | Subagent finish instructions                                       |
| `catalog`             | CatalogConfig                            | `{ stepTypes?, excludeOperationIds?, excludeGroupIds? }`           |
| `turnPolicy`          | AgentTurnPolicy                          | `{ maxToolCallsPerTurn?, allowParallel?, budgetHints? }`           |
| `reasoningContinuity` | `'off' \| 'tool_loop' \| 'conversation'` | default: `'off'` — provider-native reasoning continuity (Plan 259) |

### `reasoningContinuity` (Plan 259)

Controls whether provider-native reasoning state (Anthropic thinking blocks, Gemini thought
signatures, Fireworks `reasoning_content`) is carried across tool turns so the model continues its
reasoning instead of re-deriving it after each tool result. Orthogonal to reasoning effort: effort
controls how much the current response reasons; continuity controls whether that reasoning is
retained.

Effort itself is bounded by the model. Each catalog entry declares the rungs its provider accepts
(`ModelReasoningProfile.supported`), and the client clamps a request to the nearest one — so asking
for an effort a model does not implement runs at a supported level rather than failing, and some
models have no `off` rung at all. Pickers offer only what the resolved model accepts.

- `off` (default) — retain only the minimum provider state needed to keep the active tool-use
  exchange valid.
- `tool_loop` — retain native reasoning across the current assistant tool-use turn (since the last
  user instruction); reset when a new instruction starts.
- `conversation` — reserved; not yet supported (authoring it fails validation).

**Capability-gated and fail-loud.** `tool_loop` is supported only on reasoning-capable Anthropic and
Fireworks models. Authoring an unsupported mode (e.g. `tool_loop` on OpenAI/OpenRouter/Gemini, or any
`conversation`) fails the step before any provider call with a non-retryable
`AI_REASONING_CONTINUITY_UNSUPPORTED` — it never silently downgrades. Leave it `off` unless you are
deliberately trading more retained context (cost, provider coupling) for continuity on a long,
tool-heavy run.

### CatalogConfig — controlling what tools the agent sees

```json
{
  "stepTypes": ["api", "memory", "flow"],
  "excludeOperationIds": ["platform.catalog.get_schema"],
  "excludeGroupIds": ["ai.media"]
}
```

## Workflow pattern: agent with tool steps

```json
{
  "steps": [
    {
      "stepId": "agent",
      "stepType": "ai",
      "operation": "ai.agent.turn",
      "config": {
        "model": "sonnet",
        "agentRole": "assistant",
        "systemPrompt": "You help users with...",
        "prompt": "${state.prompt}"
      },
      "onSuccess": [{ "stepId": "api-call" }, { "stepId": "memory-read" }]
    },
    {
      "stepId": "api-call",
      "stepType": "api",
      "operation": "api.http.call",
      "config": {},
      "onSuccess": [{ "stepId": "agent" }],
      "onFailure": [{ "stepId": "agent" }]
    },
    {
      "stepId": "memory-read",
      "stepType": "memory",
      "operation": "memory.store.get",
      "config": {},
      "onSuccess": [{ "stepId": "agent" }],
      "onFailure": [{ "stepId": "agent" }]
    }
  ],
  "startStepId": "agent"
}
```

Key pattern: **tool steps always loop back to agent** (both onSuccess and onFailure). The agent decides what to do next.

## Context engineering (Plan 82)

Agent conversations are automatically managed:

- **Stale clearing**: Old tool results replaced with one-line summaries after N turns
- **Progressive summarization**: When history approaches context window, older turns are compressed via LLM summary
- **Token tracking**: Every turn reports system/context/history token estimates

These are configured via `clearingPolicy` and `compressionPolicy` in the agent step config. Defaults are sensible — only override if you have a specific reason.
