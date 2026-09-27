---
name: flow-building
description: Background knowledge for building, editing, and debugging Aflow flow definitions and agent configurations. Covers flow schema, step definitions, state variables, agent turn lifecycle, validation pipeline, and input contracts.
user-invocable: false
---

# Flow & Agent Building Guide

This skill provides the domain knowledge needed to correctly build flows and configure agents on the Aflow platform.

## Quick orientation

A **flow** is a graph of **steps** connected by **transitions**. Each step executes one **operation** (from the catalog). **State variables** carry data between steps. **Agent steps** (`ai.agent.turn`) are decision points — the agent picks the next step(s) from the graph.

## Canonical examples

**Always consult `packages/database/src/seeds/capabilityFlows.ts`** before building flows. It contains 6 production capability flows (orchestrator, flow-builder, api-configurator, media-creator, mcp-runner, ml-prediction-agent) that are maintained alongside the platform code and always reflect the latest patterns.

## Common mistakes (fix these first)

| Mistake                                            | Fix                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Missing `startStepId` or it doesn't match any step | Must reference an existing `stepId` in `steps[]`                                    |
| Transition target references non-existent step     | All `onSuccess`/`onFailure` `stepId` values must exist in `steps[]`                 |
| Unreachable steps                                  | Every step must be reachable from `startStepId` via BFS                             |
| Passing `{ prompt: "hello" }` as flow input        | Use standard envelope: `{ input: "hello" }` or `{ input: "hello", config: {...} }`  |
| Duplicate `stepId` or `variableId`                 | Must be unique within the flow                                                      |
| Using old operation names                          | Use canonical `stepType.group.verb` IDs (e.g., `ai.agent.turn` not `ai.agent_turn`) |
| Agent tool steps with hardcoded config             | Tool steps called by agents get inputs at runtime — don't validate their config     |
| Non-terminal flow with no transitions              | At least one step needs `onSuccess` pointing somewhere, or flow ends immediately    |
| `outputMapping` targets undeclared variable        | Target must exist in `stateVariables[]`                                             |
| `${state.foo}` references non-existent variable    | Variable must be declared in `stateVariables[]`                                     |

## Key schemas — see references/

For detailed schema fields, validation rules, and agent turn configuration, see:

- [schema.md](references/schema.md) — Flow, step, and state variable schemas with all fields
- [agent-pattern.md](references/agent-pattern.md) — Agent turn lifecycle, roles, policies, decision actions
- [validation.md](references/validation.md) — 5-layer validation pipeline with all rule IDs
