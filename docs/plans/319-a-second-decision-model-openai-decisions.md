# Plan 319 — A second decision model: OpenAI's Decisions API behind the same step

**Status:** 🔨 P0–P3 built and the profiles verified live; P4 open · **Builds on:** Plan 316 (`ai.decision.decide`)

## 1. Problem

Every decision step ran on one vendor. A space without a TypeSafe key could not run a decision skill — the step failed closed — and a skill shared through the Store carried that requirement to everyone who installed it.

OpenAI's Decisions API, in public beta since 2026-10-06, answers the same kind of question: a decision-tuned GPT-6 Luna that takes questions with a fixed answer space and returns typed answers with probabilities, over text **and images**. Every space that already holds an OpenAI key can run decisions with no new account.

## 2. The contract

Read from the `openai` SDK's published types (7.30+, `client.decisions.create`) and OpenAI's guide:

- `POST /v1/decisions` with `model` (`gpt-6-luna`, the only one), `input` (a string, or user messages of `input_text` and `input_image` parts — base64 data URLs or public HTTPS URLs, at most 128 images per request) and `questions` (1–200).
- Three question types, each with a required string `instructions` and an optional `name` the answer echoes: `predicate` (→ `probability`), `choice` (2–255 typed `{ value, description? }` → `choice`, `confidence`, per-value `probabilities`), `score` (ordered `{ label, description? }` levels → `score` as the probability-weighted index, `confidence`, per-level `probabilities`).
- Any question may come back as `{ type: "refusal", name }` while the others are answered.
- Answers come back in question order. Usage reports input and output tokens; only input is billed, at $0.10 per million.
- OpenAI makes no calibration claim: the guide says to set thresholds from labelled examples.

## 3. Decisions

**D1 — Same operation, second provider.** OpenAI's decision model is the catalog entry `gpt-6-luna-decisions` (alias `luna-decisions`, sending `gpt-6-luna`) with the `decision` capability, behind the existing `ai.decision.decide`, using the space's existing OpenAI credential. No new operation and no skill change when a space switches models. The adapter calls the endpoint through the OpenAI SDK client's generic `post`, so authentication, retries and error normalisation are the adapter's existing ones and the SDK major version does not move. _Rejected:_ an operation per vendor — a skill would name its vendor, which Plan 316 D1 exists to avoid.

**D2 — What a decision model can do is catalog data, measured.** Every model with the `decision` capability carries a profile — `questionsPerCall` (absent where none is stated), `imageContext`, `confidence: 'calibrated' | 'self_reported'` — and a contract test holds that every decision model has one and no other model does. `yarn models:verify-decisions` checks each profile against the live API: all three question types in one call, exactly the per-call limit accepted and one more refused, an image read where the profile says so. Calibration is not probed: a handful of calls cannot measure it, an eval batch can (P4).

**D3 — The step's vocabulary maps one-to-one.** Both models answer all three question types natively, so the mapping is names only: `yes_no` ↔ `predicate`, the option record ↔ typed `choices`, levels ↔ labelled `levels`. Where the step leaves instructions optional the adapter states them from what the question carries — a yes/no's criteria become "True when … / False when …". A request with more questions than `questionsPerCall` is split into parallel calls over the same state and merged, usage summed; questions are independent by contract, so the split changes no answer.

**D4 — A refusal is an answer that is never decided.** The step's answer union gains `{ type: 'refusal', decided: false }`. A route on `decided == false` — the one a workflow keeps for uncertain answers — takes a refusal, and a route on a value finds no value and is skipped. No new routing concept.

**D5 — The output says what its confidence is.** The step's output carries `calibration: 'calibrated' | 'self_reported'` from the profile. Where a skill names its model and puts a `minConfidence` on a question, a model whose confidence is self-reported raises an **advisory** (`decision_confidence_self_reported`), not an error: a threshold on self-reported confidence is the operator's call to make knowingly.

**D6 — A space chooses its decision model.** `modelDefaults.decision` in the space directives names the model. Like the Clerk it does not inherit `default` — a chat model cannot answer a decision — so unset resolves to the first catalog decision model whose provider the space holds a key for, passing over models that read no images when the step carries one. The Agent settings page gains a Decisions row: "Auto · first decision model with a key", or a decision model by its alias.

**D7 — A skill that cannot decide says so before it runs.** A decision step requires the `decision_model` setup token, satisfied by a key for any decision model's provider under Auto, and only by the assigned model's provider when the space assigns one. A skill whose decision steps no key can answer reads `needsSetup` with a connect-provider remedy instead of reporting ready and failing at its first decision step. The provider list is pinned to the catalog's decision models by a contract test. The composer's Models & reasoning menu carries the same Decisions row as the settings page.

**D7 — Images when the model reads them.** The step takes `images`: up to 128 stored-media references, the form every media operation already returns — never inline bytes in a step message. The executor resolves them with the media source resolver and the adapter sends them as data URLs. Sending images to a model without `imageContext` is refused by the client, and by skill validity (`decision_model_reads_no_images`) when the skill names that model.

**D8 — The two are compared, not assumed equal.** The same labelled decision sets run through both models — accuracy against labels, abstention at a threshold, a reliability curve of stated confidence against observed accuracy, latency and cost per decision — on the eval batch and judge-scorecard machinery. The result picks the recommended default and is re-run when either model changes.

## 4. Affected packages and contracts

`packages/ai-client` (the decision profile, the OpenAI decisions adapter, request splitting, refusals, image passing, `models:verify-decisions`), `packages/schemas` (the step's `images`, refusal answers and `calibration`; the `decision` model default; the shared media source reference, moved to its own module), `apps/aflow-executor-ai` (model resolution, image resolution; now depends on `@aflow/cybernetic-runtime` for the directives loader), `packages/cybernetic-runtime` (the two decision-model diagnostics), `packages/web-product` (the Decisions row).

Stored data: the optional `modelDefaults.decision`. A step whose output is read by a route now also carries `calibration`, and its answers may include a refusal.

## 5. Phases

### P0 — The contract

**Delivered** from the SDK's types and the guide (§2), and confirmed by `models:verify-decisions` on 2026-10-17: `luna-decisions` answers all three question types in one call, accepts 200 questions and refuses 201, and reads an image with the state; `jev` answers all three types in one call.

### P1 — Behind the step

**Delivered:** the profile and contract test, the adapter, splitting, refusals, `calibration`, the calibration advisory.

### P2 — A space chooses

**Delivered:** `modelDefaults.decision`, credential-aware resolution, the Decisions row.

### P3 — Images

**Delivered:** `images` on the step, resolution, the client refusal and the validity error. **Open:** images authored through compose-skill's decision task, which today lowers its consumed outputs to the text state only.

### P4 — The comparison

**Open.** The D8 measurement on a ticket-triage set and a judge rubric, recorded with the recommended default and its reason.

## 6. How it is proven

- The triage skill from Plan 316 runs every branch the same on both models.
- A model that declines a question routes it to the fallback.
- With only an OpenAI key, a decision step with no model runs on `luna-decisions`; with both keys it runs on `jev` unless it carries images.
- A step sending images to `jev` is refused before any call, naming a model that reads them.
- `models:verify-decisions` fails when a vendor's live behaviour departs from its recorded profile.
