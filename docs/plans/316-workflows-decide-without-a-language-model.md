# Plan 316 — Workflows decide without a language model: a typed decision step

**Status:** 🔨 P0–P4 built and proven live; P5 and draft-level editing open · **First backend:** TypeSafe AI's Jev (a "System One" decision model)

## 1. Problem

A skill that has to route, triage, gate or score on a judgement has two ways to do it today, and both are wrong for the job.

- **A `when` predicate** compares a typed value that already exists. It cannot read a support ticket and say which team owns it.
- **An agent or `ai.text.generate_json` step** can, but it pays a reasoning model's latency and price for every item and returns an answer with no calibrated confidence. A workflow has no honest way to say "sure enough to act, otherwise escalate".

Nothing in the engine produces a calibrated confidence. The eval judge returns `pass | fail | unclear` from a `generate_json` call; write risk is a static tier. The slots for typed decisions exist and are empty: the guardrail `classifier` rails are validated but never executed, and a workflow's fork is an unvalidated `when` string whose path is never checked against what the producing step emits.

Decision models now exist that fit the gap. Jev reads a `state` (text, JSON object or array) and a set of named questions and answers every question in one parallel pass, each with a typed value and a calibrated probability distribution. There are three question types: `choice` (one of up to 255 labelled options), `score` (an expected position on a 2–10 level rubric) and `noul` (the probability that a statement is true), which the operation calls `yes_no`. It cannot write text, by construction. Latency is in the tens to hundreds of milliseconds and input is priced far below a chat model.

## 2. Decisions

**D1 — One provider-neutral operation, `ai.decision.decide`.** A state and named questions in; typed answers with probabilities and confidence out. Jev is the first model behind it, recorded in the model catalog under a new `decision` capability; the operation never names a vendor. _Rejected:_ calling the vendor through the API mesh (loses typed outputs, usage accounting and catalog governance, and every author hand-writes the wire format); a Jev-named operation (a model leaving the lineup would rename a step inside every skill that uses it).

**D2 — The operation is a runtime primitive, not an agent tool (`agentTool: false`).** A decision model earns its keep when the questions are written once and asked many times with no language model in the loop. An agent that writes the options, calls the decider and reads the answer has already paid for a reasoning turn, so the saving is gone. Helmsman, Runner and the host harness do not call it; they author it into skills. No capability group, no tool tier, no harness exposure.

**D3 — Abstention is data.** Each question may carry `minConfidence`. An answer below it is returned with `decided: false` and the step still succeeds: the decider did its job, and the workflow's escalation branch is the consumer. A malformed request, a missing credential or a provider error is a failure.

**D4 — The fork is carried by the schema, not by prompt prose.** The compose draft gains a `decision` task kind: the state bindings, the questions, `routes` (a question's choice label, or a score or probability threshold, mapped to the tasks it enables) and `onUndecided` (the task that runs when a routed question abstains). The assembler lowers it into an `ai.decision.decide` operation task plus generated `when` predicates on the routed tasks, so the scheduler gains nothing. Route validation — every label real, every threshold in range, `onUndecided` present when a routed question has a `minConfidence` — returns structured diagnostics the drafter corrects from. _Rejected:_ teaching compose-skill to hand-write an operation task and `when` strings; that is prompt prose, and the path is unchecked.

**D5 — `when` is checked against the producer's output shape.** A predicate reading `tasks.<id>.output.<path>` of an operation task is validated against that operation's output schema. This is general, and it is what keeps a hand-written fork honest on the path that does not go through compose-skill: Helmsman patching a workflow directly.

**D6 — Step-only primitives are findable by authors.** Catalog search hides `agentTool: false` operations, so Helmsman patching a workflow cannot find the decider. `catalog.tool.search` takes `workflowSteps: true` to also return step-only operations, marked `opTaskOnly` as step-only MCP tools already are, ranked against their own index and never placed in `suggestedPromoteCall`.

**D7 — Credentials are the space's or tenant's own, like every other model provider.** A `typesafe` credential provider with one API key, resolved through the existing credential resolver. No key fails closed with the existing missing-credential error. _Rejected for now:_ emulating decisions with `generate_json` when no key exists — it would return uncalibrated confidences that look calibrated.

**D8 — The judge may use a decider, and it is measured before it counts.** A binary rubric entry maps onto a `yes_no` question; an answer inside the abstention band is `unclear`. A judge criterion may name a decision model, and the judge scorecard measures it against labelled data exactly as it measures a language-model judge. Judges stay advisory until measured.

**D9 — Guardrail classifier rails execute through the same operation, opt-in per rail.** A decider reads the state it is given and can be steered by it, so it is never the only gate on a security decision.

## 3. The operation

Input:

- `state` — a string, JSON object or array.
- `questions` — `Record<name, question>`, one of:
  - `{ type: 'choice', instructions?, options: Record<label, description | null>, minConfidence? }`, 2–255 options
  - `{ type: 'score', instructions?, levels: (description | null)[], minConfidence? }`, 2–10 levels, index 0 lowest
  - `{ type: 'yes_no', instructions?, criteria?: { true?, false? }, minConfidence? }`
- `model` — optional catalog reference; the catalog's default decision model when absent.

Output:

- `answers` — `Record<name, answer>`:
  - choice: `{ type, value: label, confidence, probabilities: Record<label, number>, decided }`
  - score: `{ type, value: expected score, confidence, probabilities: Record<level, number>, decided }`
  - yes_no: `{ type, value: p ≥ 0.5, probability: p, confidence: max(p, 1 − p), decided }`
- `model`, `usage { inputTokens, outputTokens }`, `latencyMs`.

For a `yes_no`, `confidence` is derived as the probability of the more likely outcome, so one threshold reads the same way on every question type.

Wire: `POST {base}/v1/systemone` with `Authorization: Bearer <key>`, body `{ state, questions, model }`, where the neutral names map onto the provider's (`options` → `criteria` for a choice, `levels` → `criteria` for a score, `yes_no` → `noul`). The response carries `model`, `answers` and `usage { input_tokens, output_tokens }`; the request id is in `x-typesafe-request-id`. `GET /v1/models` lists the account's models and serves as the credential probe.

## 4. Affected packages and contracts

`packages/ai-client` (the `typesafe` provider, `decide` on the adapter and client, catalog entry, `decision` capability, credential probe), `packages/schemas` (credential provider, operation schemas and registration, compose draft `decision` task kind, catalog step marking), `packages/credential-resolver` (BYOK provider set), `apps/aflow-executor-ai` (handler, credential mapping), `packages/cybernetic-runtime` (route validation, `when` shape check, judge backend), `apps/aflow-orchestrator` (assembler lowering, catalog search in authoring context, guardrail rails), `packages/platform-artifacts` (compose-skill's one line naming the decision task; an example skill), `packages/server-runtime` (catalog provider list).

No stored data changes shape. A new credential provider id and a new operation id appear.

## 5. Phases

### P0 — Wire format

The request and response shapes in §3, taken from the provider's published SDK. Exit: a recorded response fixture that the adapter tests replay, and one live call through the adapter with a real key that matches it.

**Delivered**: the wire shapes are read from the published TypeScript SDK's declarations and replayed as a fixture in the adapter tests, and a live call through the adapter matches them. The live API pins `jev-1.13.0` (`jev-latest` resolves to it), refuses an unknown model and a `noul` with neither instructions nor criteria, and nests a refusal's message under `detail`; the schema now refuses the claimless yes/no before it is sent, and the adapter reads the nested message. `GET /v1/models` distinguishes a good key from a rejected one.

### P1 — Client and credential (D1, D7)

`typesafe` in the AI provider and credential provider enums, the credential registry entry, the BYOK set and the executor's credential mapping; the adapter implements `decide` and refuses every text method; `AIClient.decide` resolves the model through the catalog and refuses a model without the `decision` capability; the credential probe lists models. Exit: adapter tests over the fixture, including the name mapping, `yes_no` confidence derivation and error classification (401 not retryable, 429 retryable).

**Delivered** as described. The models route derives its provider enum from `AIProviderSchema` instead of restating it, and the credential sits in its own `decision` category so a TypeSafe key can never satisfy the chat-model requirement.

### P2 — The operation (D2, D3)

Schemas, registration with `usage` written for skill authors, the handler, usage and cost reporting. Exit: the handler's tests cover `decided` on both sides of `minConfidence` per type and a failing credential; `run_operation ai.decision.decide` on a local stack returns typed answers.

**Delivered**: `decided` per type lives in `resolveDecisionAnswers` (ai-client) and is tested there, including the inclusive threshold, a choice outside the options and an answer of the wrong type. Migration 210 grants `ai.decision:read` to every system profile. A live decision-judge call through `AIClient` prices from the catalog and folds into a `JudgeVerdict`. **Open**: the local-stack call through the executor.

### P3 — Authoring (D4, D5, D6)

The `decision` draft task kind, its lowering and route validation; `when` checked against operation output schemas; step-visible catalog search in authoring context; one line in compose-skill naming the decision task; an example skill (triage → route → escalate on abstention). Exit: asking Helmsman for "a skill that triages incoming support tickets and escalates the unclear ones" produces a `decision` task with routes, and its run takes the escalation branch on an abstaining answer; a patched fork on a non-existent output path is refused.

**Delivered**: the draft's `when` also takes `{ anyOf }` / `{ allOf }`; `TaskGraphDraftSchema` validates decision routes in its `superRefine` and expands decision tasks in a `transform`, so every consumer of a parsed draft sees operation tasks only; the assembler test proves the assembled triage workflow is valid as a skill; `when_output_path_unknown` names the fields that do exist; `workflow.manage.patch` names `workflowSteps` in its pitfalls. A draft task can consume a run input (`{ runInput, bindAs }`), declared once in the workflow's `runInputs`; without it compose-skill put an LLM classifier in front of the decision to have something to consume. A task may be enabled by several routes and by `onUndecided` when the guard stays a single level — "matches, or was not decided" is a flat `anyOf`. A bind-free literal at a record-shaped op position (a decision's `questions`) is validated whole.

**Proven live**: asked for a ticket-triage skill, compose-skill authored a root `decision` task reading the `ticket` run input with `minConfidence` 0.7, routing billing and technical to responders and "unclear" or undecided to an escalation agent. Five runs took the right branch each: a clear billing ticket, a clear technical one, a vague one (answered "unclear" at 0.99), a mixed one (answered "unclear" at confidence 0.47 — undecided), and, after Helmsman patched in a refund question, a refund request (billing and refund handler) beside a plain billing question (billing only).

**Open — decisions are not editable as decisions once assembled.** A patch edits the lowered operation task and its generated guards: Helmsman needed about eight attempts and succeeded only because the validators named each error. Editing at the draft level is the fix, and it waits on compose-skill learning to modify an existing skill. No example platform skill ships; the live compose runs stand in for it.

### P4 — Judge backend (D8)

A judge criterion may name a decision model; abstention is `unclear`. Exit: an eval batch judged by a decider produces a scorecard beside the language-model judge on the same labels.

**Delivered**: `callJudgeModel`, the one judge call every path shares, sends a decision model a `yes_no` per rubric entry over the evidence (the rubric is never part of the state) and folds the answers into the same `JudgeVerdict`. A rubric entry's `minConfidence` sets its abstention band; it is part of the rubric, so it moves the judge's version. The language-model prompt is byte-identical. **Open**: the scorecard comparison, which needs a key and labelled data.

### P5 — Guardrail classifier rails (D9)

The `classifier` rails execute through the operation when a rail opts in. Exit: a `topic_boundary` rail refuses an off-topic input in a test and fails closed when the decider errors.

**Open, and three things must be settled first.** (1) Most triggers hand the gate a payload _reference_ (`on_run_input`, `on_tool_output`, `on_run_output`), which the rule rails read as a string; a classifier needs the content, so the gate needs the payload store and a bound on what it resolves. (2) The gate runs in the orchestrator with no credential owner in `GuardrailContext`; the decision call resolves a key through the space, as eval grading does, so `spaceId` becomes required for a classifier rail and a rail without one fails by its `failBehavior`. (3) A blocking rail sits on the hot path of every step it covers; its `timeoutMs` bounds the decision call, and an abstention is treated as a violation under `fail_closed` and a pass under `fail_open`.

## 6. How it is proven

- A skill whose decision abstains runs its escalation branch, and one whose decision is confident does not. If `decided` were computed wrongly, or the lowering produced the wrong `when`, one of these runs takes the wrong branch.
- A draft whose route names a label the question does not offer is refused with a diagnostic naming the label.
- A fork reading `tasks.triage.output.answers.team.valeu` is refused at validation, not skipped at run time.
- The operation never appears in an agent's tool list, and does appear in authoring search.
