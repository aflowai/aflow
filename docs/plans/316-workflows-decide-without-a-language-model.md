# Plan 316 — Workflows decide without a language model: a typed decision step

**Status:** 🔨 P0–P4 built and proven live; P5 and draft-level editing open · **First backend:** TypeSafe AI's Jev (a "System One" decision model) · **First production consumer:** Publish Local Changes, which decides whether a review's findings want a fix round, records the answer as `afterReview`, and gates its push on it (Plan 315 D22), at the Jev bar set from §7's measurement of the loop's own decisions

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
- `each` — optional `{ items, question }`: one `yes_no` asked of every item of a list (at most 50), for a list whose length is known only when the step runs — a review's findings. Each item travels in its own question's instructions beside the claim, all in the same single pass. `questions` may then be absent; one of the two is required. An empty list asks nothing and needs no model.
- `model` — optional catalog reference; the catalog's default decision model when absent.

Output:

- `answers` — `Record<name, answer>`:
  - choice: `{ type, value: label, decidedValue, confidence, probabilities: Record<label, number>, decided }`
  - score: `{ type, value: expected score, decidedValue, confidence, probabilities: Record<level, number>, decided }`
  - yes_no: `{ type, value: p ≥ 0.5, decidedValue, probability: p, confidence: max(p, 1 − p), decided }`
- `each` — where asked: every item's `yes_no` answer in order, `selected` (the items answered true and decided), `selectedCount`, `undecidedCount`, and `selectedJson`, the selected items as text a later step can put in a brief.
- `model`, `usage { inputTokens, outputTokens }`, `latencyMs`.

For a `yes_no`, `confidence` is derived as the probability of the more likely outcome, so one threshold reads the same way on every question type. `decidedValue` is `value` where the answer is `decided` and null where it is not, so a route reads one comparison — `decidedValue == 'billing'` — that can sit beside another condition in a single `anyOf`, which `value` and `decided` read apart cannot.

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

## 7. Measurement — the loop's own decisions

**Status: measured** on the operator's stack with all three deciders (the run recorded on plan node 0f442b9a). The results and what each changed in Publish Local Changes are under **Results**, below.

**What it measures.** The choices Publish Local Changes makes for itself (Plan 315 D22), the per-finding judgement it was first built with, and the CI remedy choice Plan 321 makes by hand, against what was actually decided in this stream. Four questions:

- **After a failed check**: the check's account → what the next publication of the branch did. A change appended means `fix_commission`; the same head published as it stands means `recheck_on_timeout`.
- **Each review finding**: the finding → whether a later publication carried it `closed` (a defect, fixed) or `open` (left — accepted or dismissed, which the records do not tell apart).
- **After a review with findings**: the findings → `fix_before_merge` where a later change closed any of them, `publish_as_is` where they were carried on all open.
- **A failing CI job of PRs #91–#124**: the last 300 lines of the job's log (Plan 321 §P0's bound) → `rerun` where another attempt of the same run followed on the same commit, `merge_round` for a merge commit next, `resolutions_bump` for a next commit touching only `package.json` and `yarn.lock` under `resolutions`, and `code_fix` otherwise.

A case nothing followed is left unlabelled, not guessed. `operator_install_mismatch` is never inferred; it comes only from the operator's labels file, which overrides any inference. The report counts how many labels came from the operator and how many were inferred.

**Deciders.** Every decision model the catalog offers — Jev, and gpt-6-luna-decisions since Plan 319 — each through `AIClient.decide`, the call the decision operation makes, so whichever a space resolves the step to is measured on the same cases. The results below predate the second and were measured on Jev. Then a critique-then-verdict `generate_json` call — a critique, a verdict among the same options and a stated probability that the verdict is right — on gpt-6-luna, and the same call on claude-opus-5-5 as the agent baseline. A language model's stated probability is not calibrated; it is reported as what it is.

**Recorded per decider and question**: agreement with the operator's decision among the cases it decided; abstention at the bar chosen for it (the lowest bar in the 0.5–0.95 sweep at which agreement reaches the target, 90% by default); agreement over all cases with an abstention counted as not agreeing; errors apart from both; p50 and p95 latency; and cost per decision from the catalog's prices. Jev's whole sweep goes beside the table.

**Why a script and not the eval plane's dataset (Plan 269).** A golden case there is a run's input and output, labelled by the operator against a skill's suite. These cases are decisions spread across runs and across GitHub — a check's account against the next publication's input, a log against the next commit — and none of them is a run of one skill. So it is a script, as Plan 323 P0 was.

**Run it**, on the stack that holds the stream, with `AFLOW_API_KEY` set to an API key of the space's tenant and `gh` signed in:

```
yarn decisions:measure-loop collect --space <spaceId> --repo aflowai/aflow --prs 91-124
yarn decisions:measure-loop measure [--labels <operator-labels.json>] [--target 0.9]
```

### Results

The target is 90% agreement among the cases a decider decides. Each row is the decider at the bar the script chose for it: the lowest in the sweep that reaches the target. _n_ is the labelled cases of that question. Where the operator's run recorded no bar for a decider, the cell says so rather than inferring one.

| Question                                     | n   | Decider                          | minConfidence   | Agreement (decided) | Abstention   |
| -------------------------------------------- | --- | -------------------------------- | --------------- | ------------------- | ------------ |
| After a failed check                         | 2   | Jev                              | 0.50            | 100%                | 0%           |
|                                              |     | gpt-6-luna (critique first)      | not recorded    | 100%                | 0%           |
|                                              |     | claude-opus-5-5 (baseline)       | not recorded    | 100%                | 0%           |
| Each review finding: a defect, by evidence   | 46  | Jev                              | 0.90            | 100%                | 69.6%        |
|                                              |     | Jev, at 0.80                     | 0.80            | 89.3%               | 39.1%        |
|                                              |     | gpt-6-luna (critique first)      | 0.80            | 69.6%               | 0%           |
|                                              |     | claude-opus-5-5 (baseline)       | 0.90            | 100%                | 95.7%        |
| After a review: fix before merge or not      | 17  | Jev                              | 0.80            | 100%                | 17.6%        |
|                                              |     | Jev, at 0.50                     | 0.50            | 93.8%               | 5.9%         |
|                                              |     | gpt-6-luna (critique first)      | 0.90            | 100%                | 29.4%        |
|                                              |     | claude-opus-5-5 (baseline)       | 0.70            | 90%                 | 41.2%        |
| A failing CI job of PRs #91–#124: its remedy | 5   | Jev, gpt-6-luna, claude-opus-5-5 | none reaches it | 20% each            | not recorded |

Latency and cost per decision, each a range across the four questions:

| Decider                     | p50 latency | Cost per decision      |
| --------------------------- | ----------- | ---------------------- |
| Jev                         | 237–875 ms  | $0.00003–$0.0008       |
| gpt-6-luna (critique first) | 2.6–5.6 s   | about $0.00025–$0.0015 |
| claude-opus-5-5 (baseline)  | 6.2–7.8 s   | $0.016–$0.083          |

**What each result changed** (Plan 315 D22):

- **Each review finding — taken out of Publish Local Changes.** No decider reaches the target without abstaining on most findings. Jev agrees on every finding it decides only by abstaining on 69.6% of them, and at 0.80 it falls to 89.3%. gpt-6-luna decides every finding and agrees on 69.6%. claude-opus-5-5 abstains on 95.7%. By this section's own rule the step does not belong in the skill. A fix round — the conversation's or the shepherd's (Plan 315 D22) — is briefed from every finding of the review run, as the review reported them. The bounded list a publication hands on as `findings` serves the next pull request's record only. `each` stays on `ai.decision.decide` as an engine capability, with its tests.
- **After a review — kept, Jev at 0.80.** Jev agrees on every case it decides there and abstains on 17.6%, at a few hundred milliseconds and a fraction of a cent per decision. The bar was measured on Jev, and the step names no model: the space's decision model answers it. Another decider meets the bar unmeasured until it is asked the same cases — `yarn decisions:measure-loop` asks every decision model the catalog offers — and the bar moves only on that measurement. The critique-then-verdict baselines needed 0.90 and 0.70 for the same target, which is why one bar is never assumed to carry from one decider to another. claude-opus-5-5, the agent baseline, agrees on 90% while abstaining on 41.2%, at 6–8 seconds and two to three orders of magnitude the cost. The answer is recorded and the push gate follows it (Plan 315 D22): `afterReview` is `fix_before_merge`, `publish_as_is`, or `undecided` below 0.80, on the run and on the pull request with the review's findings. `fix_before_merge` keeps the branch local and the run completes with the decision and findings in its output; `publish_as_is` pushes without asking, standing in for an approving verdict, and the pull request lists the findings it leaves open; `undecided` is the one answer that asks the operator. The gate reads the scan and the folder's posture first, so no answer stands in for a range the scan did not clear or for an `always` folder (D9). A follow-up agent follows the answer, and sets it aside only by a recorded override — the operator's word, the `hands-off` label, or a shepherd rule such as the attempt budget reached — which the next publication records as `publish_as_is` with its reason and the answer it set aside. A publication never starts a publication. A task-started child that pauses is cancelled by its waiter, so a child publication stopping at its own approval could never be approved, and the depth of task-started runs is bounded. So the fix round on `fix_before_merge` belongs to the conversation, or to the shepherd once Plan 321 P1 lands, which publishes the branch again. The question was measured with a third option, `ask`, which no label named and which routed exactly as `publish_as_is` did; it was taken out, so the choice is `fix_before_merge` or `publish_as_is`, and an answer too unsure to be either is recorded as `undecided`.
- **After a failed check — removed from Publish Local Changes pending labelled `operator_install_mismatch` cases.** All three deciders agree on both of its two cases, and neither is an `operator_install_mismatch`: that label comes only from the operator's labels file, and the file names none yet. Two cases cannot place a bar — Jev's chosen 0.50 is the bottom of the sweep — and a question measured without one of its three answers has not been measured on the answer that stops for the operator. So the after-check decision is removed until the set holds labelled `operator_install_mismatch` cases. A failed check fails the run, waking Helmsman as it did before the decision, at `checks-failed` with the checks' own account. A check lost only to tests running out of their time is run again by rule. The question stays in `publishLocalChangesDecisions.ts`, and this script still asks it, so it can be measured again as cases accumulate. `ai.decision.decide` keeps its tests and every capability the step used.
- **CI remedy — not a decision task.** Every decider names the remedy actually taken — re-run, code fix, resolutions bump or merge round — for 20% of five failures. Plan 321 P1 decides on `when` rules, with a fix commission as the default for a failure no rule names, and the remedy is measured again once the set holds enough failures to say more.

Jev's per-finding question is measured from `scripts/loop-decision-set.mjs`, where it now lives beside the CI remedy question, since no skill asks either. The after-review question the skill asks, and the after-check question only this measurement asks for now, are imported from `publishLocalChangesDecisions.ts`.
