# Plan 327 — The operator is reachable away from the machine

## Decision card

**What changes**

- Today: the operator can reach Aflow only from a browser on the machine that serves it. A run that waits on them while they are away keeps waiting.
- After: an agent can send the operator a Slack message, with an Action Center item as a card. The operator can answer from the phone and talk to the Helmsman there.

**Why**

- A run that waits on an approval at 01:00 still waits at 09:00. The resident Helmsman (Plan 331) can see the stuck node but cannot tell the operator.
- "Status?" or "why did that fail?" needs the laptop today.

**What it affects**

- `packages/schemas`: the `channel` step type and stream, `channel.message.send`, `channelLaneComposed`, the ownership rule and the import guard.
- `packages/redis`: a refusal in `addStepJob` for a `channel` step when the channel lane is absent. No other lane changes.
- `apps/aflow-orchestrator`: its dispatch paths answer every lane refusal as they answered the coding lane's. No lifecycle changes.
- `packages/server-runtime` and `apps/server`: the channel lane's Redis identity, `channelexec`, applied as the host lane's is. Its credential, `PHOENIX_CHANNEL_REDIS_PASSWORD`, is minted by the channel setup.
- `packages/database`: one tenant migration that adds the `channel.message` capability group to the system profiles.
- `packages/platform-artifacts`: the Helmsman's placement of the operation, and a help article on setting up Slack.
- `apps/aflow-channel-slack`: a new optional app that holds the Slack connection and its own local store.
- The operator, who links one Slack user at setup.

**Risks**

- An agent may send the operator too many messages. Mitigation: the recipient is derived and never chosen. A repeat send in one run fails, so the loop guards meet a ceiling.
- Content in the conversation may try to approve something. Mitigation: free text never approves, and only the buttons the D3 table allows resolve an item.
- The app's API key may resolve more than the phone should. Mitigation: the D3 table is the app's ceiling, and a server-side trust level is the P3 answer.
- A retried send may post twice. Mitigation: the send is idempotent on the step execution.

**Open questions**

- How late is a late message? Recommended: ten minutes for P2, measured from the `inbound` record (§8).
- Where does the app keep its records? Recommended: a local store beside its configuration, not a Postgres schema (D6).
- Who decides when the resident sends? Recommended: Plan 331. It sends plan decisions and plan asks as text until the trust level exists.

**Not done on purpose**

- No hook fires when a run stops. No background task looks for things to send.
- The orchestrator's run lifecycle, session hot state and every tenant table stay as they are.
- `channel.message.ask` is not built. A paused wake would let a second wake of the space start.
- A plan decision or a plan ask cannot be decided from the phone until the trust level (D5) exists.
- Missed Slack messages are not recovered. History catch-up is P3.

**Done when**

- The operator accepts or amends D1 to D7 from this card and the decisions under it.
- Each phase meets its exit in §5, and the proofs in §6 pass.

**Status:** Design, reviewed against the code on main at `b4426a4a`. P0, P1 and P2 are built, and their as-built notes are in §5. P3 is not built.

**Builds on:** Plan 331 (the resident Helmsman, which watches the space and decides when the operator must act), Plan 324 (how the Helmsman finds an operation without carrying it), Plan 253 (the write approval card and its grant), the host lane (an executor that ships outside the image and is composed only where it is configured), and `yarn mcp:setup` (a local client of the API that holds its own key).

**Leaves alone:** the orchestrator's run lifecycle, session hot state, the Action Center's items and its resolve boundary, every tenant table, and `user.notification.email`. P0 widened the orchestrator's lane refusal checks to every lane refusal, and the P0 notes say why.

**How to read the review notes.** Each decision ends with a review note: confirmed, amended or questioned, with the code it rests on. A note that says "line N" names the line in this document at `b4426a4a`. Where a decision is amended, its text above the note already reads as amended.

## 1. Problem

The operator can reach Aflow only from a browser on the machine that serves it. When the operator walks away, nothing reaches them. A run that waits on an approval at 01:00 still waits at 09:00. The resident Helmsman (Plan 331) can see that a node is stuck, but it has no way to tell the operator.

The operator also cannot ask anything from a phone. "Status?" or "why did that fail?" needs the laptop.

## 2. Constraints

- **Nothing runs unless an agent or a skill asked for it.** No hook fires when a run stops. No background task looks for things to send. The resident decides when to reach the operator, and that logic is Plan 331's, not this plan's.
- **The engine does not change.** No orchestrator code, no hot state field and no tenant table is added for channels.
- **Absent means absent.** An install without the channel app has no channel code running, no channel rows and no channel operation in the catalog. Deleting the app leaves a platform that builds and passes its tests.
- **This plan builds the mechanics only.** It gives an agent a way to send, and the operator a way to answer. It does not decide what is worth sending.

## 3. Decisions

### D1 — A channel is an executor lane, served by an optional app

Channel operations have their own step type, `channel`, served by the stream `aflow:jobs:channel`. One optional app, `apps/aflow-channel-slack`, consumes that stream and holds the Slack connection. It is the executor and the inbound listener in one process.

The lane is composed as the host lane is (`hostLaneComposed`, `packages/schemas/src/edition/descriptor.ts`). `channelLaneComposed` answers `present` only when the platform holds the channel lane's credential, `PHOENIX_CHANNEL_REDIS_PASSWORD`. That credential is the app's own Redis identity, provisioned as the host executor's is. It can claim channel jobs and report their results, and nothing else. When the lane is absent, `isOperationComposed` withholds every `channel.*` operation from the catalog (`packages/schemas/src/edition/composedOperations.ts`). An agent never sees a tool that can only fail.

The app ships outside the image, as the host executor does. The ownership manifest classes it `optional-pack`. A new guard test fails on any core file that imports it (D7).

_Rejected — a hook when a run stops:_ every run would pay for a feature most installs never use, and the person would be told about every run.

_Rejected — a notification outbox with a delivery task:_ rows would be written for people who never linked a channel, and a background task would run on every install.

_Rejected — composing the lane on the app's own file:_ the server and the orchestrator read the descriptor from their own environment. In the appliance they run in a container that cannot see `~/.aflow/channel-slack.env`.

**Review — amended.**

- Line 26 named the stream `jobs:channel`. `StreamKeys.jobStream` builds `aflow:jobs:<stepType>` (`packages/schemas/src/runtime/streamMessages.ts` line 73), so the name now reads `aflow:jobs:channel`.
- Line 28 composed the lane on the app's configuration file. `hostLaneComposed` keys on `PHOENIX_HOST_REDIS_PASSWORD` in the platform's environment (`descriptor.ts` line 140), not on a file. That credential is the paired executor's Redis identity. It is minted at first boot (`packages/server-runtime/src/bootstrap/instanceConfig.ts` line 99) and applied at pairing (`packages/server-runtime/src/routes/hostPairing.ts` line 204).
- Line 28 also never said how the app reaches Redis. The amended text keys composition on a channel credential of the same kind, which answers both points.
- Line 30 said the manifest's guards fail on a core file that imports an `optional-pack` path. They do not. `survivesCoreCut` keeps `optional-pack` (`packages/schemas/src/edition/ownershipLookup.ts` line 37). The closure guard fails only on edges into a class the cut drops (`packages/schemas/src/edition/ownershipClosure.test.ts`). The import guard is new work, and D7 names it.
- The class itself is right. The host executor is `local` (`packages/schemas/src/edition/ownership.ts` line 118). A Slack channel can serve the hosted edition too (P3), so `optional-pack` fits.

### D2 — One operation: `channel.message.send`

The input is `{ text, itemId? }`. `text` is what the agent wants the operator to read. `itemId` names an open Action Center item to attach as a card (D3).

- **The recipient is derived.** It is the person the calling run works for: the run's `createdBy`, which every job carries as `credentialOwnerId`. For a resident wake, that is the person who created the resident schedule. The agent never names a recipient.
- **The recipient must be the linked operator.** When they are not, or no link exists, the step fails with a teaching error that names Settings → Channels.
- **The send is synchronous.** The executor posts to Slack and returns `{ delivered: true, messageRef }`. A provider error fails the step, and the existing step retry applies.
- **It is idempotent on the step execution.** A retried step whose message was already posted returns the first `messageRef` and posts nothing.
- **A repeat is a failure.** A send whose text and `itemId` match one the same run has already delivered fails with a teaching error. The loop guards count failures, so a model that repeats itself meets a ceiling.

The operation is discoverable for the Helmsman and grantable to Runners and skill steps (Plan 324). Its `whenToUse` says: "the operator must act and may be away from the machine". Its `whenNotToUse` says: "progress reports nobody asked for".

_Rejected — `channel.message.ask`, a send that pauses for the answer:_ a resident wake that paused would give up the space's wake guard, because a paused wake does not count as in flight (Plan 331 D1). The next heartbeat would start a new wake. An answer from the phone would then resume the old wake beside the new one, and two wakes of one space would run at once. A question already exists as an Action Center item, and D3 puts that item on the phone.

_Rejected — a recipient field:_ an agent that chooses recipients is an exfiltration path and a spam path.

**Review — confirmed, with one reason replaced and one rule added.**

- Line 40, the recipient, is confirmed. A schedule's run starts with `createdBy: creatorUserId` (`apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts` line 894). Every dispatch stamps the run's `createdBy` on the job as `credentialOwnerId` (`apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/scheduleStep.ts` line 726). The executor reads it there, as the write approval gate already does (`apps/aflow-executor-api/src/handlers/api/writeApprovalGate.ts` line 161).
- Line 43, the idempotency key, is confirmed. A retry re-dispatches the same `stepExecutionId`, and only the job's `idempotencyKey` carries the attempt (`apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/timers.ts`, the retry job). Keying on the step execution is what makes a retry post once.
- The repeat rule is added after line 43. A second call from the agent is a new step execution, so the idempotency key cannot catch it. CLAUDE.md records a Runner that re-sent one draft 130 times because every call succeeded.
- Line 47 gave the wrong reason for rejecting `ask`. `IN_FLIGHT_STATUSES` leaves out `PAUSED`, and its comment says a paused wake "does not hold the next one back" (`packages/cybernetic-runtime/src/plan/resident.ts`). The rejection stands on the overlap it would cause instead. `claimResidentWake` exists to prevent that overlap.

### D3 — An Action Center item becomes a card the operator can decide from

When `itemId` is given, the app reads the item through the API (`GET /v1/spaces/:spaceId/action-center/:itemId`). It renders the item with the buttons the table below allows. A tap calls the same resolve route the web app calls (`POST /v1/spaces/:spaceId/action-center/:itemId/resolve`), with the item's `origin` as the app read it. Then the app edits the card to say what was decided and by whom.

The table keys on the item's origin as well as its kind. The app's key is not an interactive sign-in, and some sources refuse every resolver that is not one.

| Item                                                                                                     | On the phone                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `human_input` from a paused step (origin `step`), with a flat schema                                     | Buttons for an enum or a boolean. A thread reply for a string.    |
| `human_approval` from a paused step (origin `step`)                                                      | Approve or deny.                                                  |
| `write_approval`, target `api`, tier `low` or `medium`, with a preview, origin `step` or `workflow_task` | Approve or deny, with the preview Plan 253 already computes.      |
| Every other item, a plan decision and a plan ask included                                                | The card says what waits and that it needs the operator at Aflow. |

A tap on an item that is no longer open gets the resolve route's own answer, and the card says the item was already decided. Free text never approves anything.

_Rejected — "reply YES to approve":_ the approval would be parsed out of prose, which any content reaching the conversation could inject.

**Review — amended.**

- Line 53 is confirmed. Both routes exist as named (`packages/server-runtime/src/routes/action-center.ts` lines 113 and 156). The resolve body carries the `origin` the client observed. A mismatch answers `409 STALE_ACTION_CENTER_ITEM` with the latest item (lines 197 to 210). That 409 is line 64's "already decided" only when the latest item is no longer open. It can also mean the item is still open and its origin has moved on, such as a step paused again. P2 settles that case (§5, P2 as built). The amended text says the app sends the origin it read.
- Lines 57 to 62 keyed the table on kind alone, which puts dead buttons on the resident's own asks. A plan decision is a `human_input` item (`packages/server-runtime/src/services/actionCenter/sources/planDecisionSource.ts` line 175). A plan ask is a `human_approval` item (`packages/server-runtime/src/services/actionCenter/sources/planAskSource.ts` line 26). Both refuse a resolver that is not an interactive user (lines 100 and 64). An API key never is one (`packages/server-runtime/src/utils/interactiveUser.ts`, `INTERACTIVE_AUTH_METHODS`).
- The paused-step source accepts the key. It stamps the resume `activatedByPerson` from `isPersonPrincipal` (`packages/server-runtime/src/services/actionCenter/sources/pausedStepSource.ts` line 143). So the first two rows name origin `step`.
- Line 61 named `write_approval` tier `medium` only. The request is a union of three targets, and only `api` carries a tier (`packages/schemas/src/runtime/requestedInput.ts`, `WriteApprovalRequestPayloadSchema`). A space's policy can also gate `low` (`requiresWriteApproval`, `packages/schemas/src/models/apiDefinition.ts` line 285). The row now names the target and both tiers. A `browser` or `local_model` approval shows no buttons.
- The ceiling is the app's alone, as D5 says. A write approval's `resolverPolicy` names roles, not sign-in methods (`packages/schemas/src/models/actionCenter.ts`, `ResolverPolicySchema`). The resolve route would accept a `high` approval from the app's key.

### D4 — A message from the operator continues a Helmsman conversation

A direct message to the bot starts a Helmsman conversation in the operator's home space (`POST /v1/sessions?spaceId=…` with target `{ kind: "platform-role", systemRole: "cybernetic-helmsman" }` and mode `api`). A reply in that message's Slack thread continues the same session (`POST /v1/sessions/:sessionId/resume` with `{ stepExecutionId, input: { input: text } }`). `stepExecutionId` is the paused step that the last `SessionPaused` event named. The app records each thread against its session.

The app relays the answer by watching that session's events until it pauses with the agent's reply (`agentResponse` on `SessionPaused`). It watches only sessions it started, and stops when the reply is posted. This is a client reading its own conversation, as the web app does.

- **A message is handled once.** The app records each Slack event id, and a redelivered event does nothing.
- **A late message asks first.** A message older than ten minutes when it reaches the app is not sent to the Helmsman. The app replies "This arrived late. Run it now?" with **Run it now** and **Discard**.
- **Missed messages are not recovered in this plan.** Slack delivers what it delivers while the app is connected. History catch-up is P3.

**Review — amended.**

- Line 70 omitted two things the routes require (`packages/server-runtime/src/routes/runs.ts`). A start from an API key may not use mode `chat`, which `refusedStartMode` keeps for an interactive sign-in. Mode `api` is the default, and it is attended because the key is a person's principal.
- The resume body requires `stepExecutionId` as its pause-point guard (`ResumeSessionRequestSchema`). Line 70 now names it and where the app reads it.
- Line 72 is confirmed. The agent's reply rides the pause event's metadata as `agentResponse` (`apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/applyAgentDecision.ts` line 1016).
- Lines 74 to 76 are confirmed as stated.

### D5 — One operator per install, linked at setup

`yarn channel:slack setup` writes the app's configuration file. That holds the Slack bot token, the app-level token for Socket Mode and the channel lane's Redis credential (D1). It also mints a user API key for the instance owner, as `yarn mcp:setup` does (`scripts/mcp-local-setup.mjs`). The key expires after 365 days, and the app says so in Slack before it does. The file lives at `~/.aflow/channel-slack.env`, mode `0600`.

Setup prints a one-time code. The operator sends that code to the bot from Slack, and the app links that Slack user to the key's user. From then on the app serves only that Slack user. Anyone else gets one fixed reply. No turn runs, and no message text is stored.

The app acts with the operator's API key, so it can do what an MCP client with that key can do today. The D3 table is the app's own ceiling.

_Rejected — the operator's browser session as the app's credential:_ whoever holds the unlocked phone would inherit every step-up the browser login has.

_Open — a server-side trust level for "a person, not at the machine":_ it would let the resolve route refuse kinds above the ceiling itself, instead of trusting the app. It would also be the way to decide the resident's plan decisions and asks from the phone, which D3 cannot offer today. It is P3, and it is the only core change this feature may need later.

**Review — amended.**

- Line 80 said the key belongs to "the person running setup". `mcp-local-setup.mjs` mints the key with `PHOENIX_INSTANCE_SECRET`, so it belongs to the instance owner. It refuses any edition but the local one (`editionRefusal`), and the key it mints expires (`KEY_EXPIRES_IN_DAYS = 365`). The text now names the owner and the expiry.
- The parts to reuse are the minting, `existingKeyVerdict` and `writeAuthFile`, which writes mode `0600`.
- Line 80 now also lists the Redis credential, which D1's amendment adds.
- Line 84 is confirmed. The ceiling is the app's alone (D3 review).
- Line 88 is confirmed as open. The D3 review shows it also gates the resident's own asks, so the line now says so.

### D6 — The app owns its storage

The app keeps its records in a local store of its own, beside its configuration under `~/.aflow/`, mode `0600`. It creates and migrates that store itself, with its own migration ledger, when it starts. It holds no Postgres credential. The records are:

- `link`: the Slack user, the Aflow user and tenant, the home space, and when it was linked.
- `inbound`: each Slack event id (unique), when it was sent, when it arrived, and its outcome.
- `thread`: each Slack thread and the session it continues.
- `card`: each card's Slack message reference and the item it shows.
- `sent`: each send's run, step, `messageRef` and text, for D2's idempotency and repeat rule.

Removing the app and its store leaves nothing behind in the platform.

_Rejected — tenant tables:_ they would exist in every install, used or not.

_Rejected — a Postgres schema of the app's own, `channel_slack`:_ the app runs outside the image as the operator's user. To create a schema it would hold a database credential that reaches every tenant schema.

**Review — questioned, with a recommendation written in.**

- Line 92 put the records in a Postgres schema the app creates. The host executor, the precedent this plan follows, "holds neither the wrapping key nor the instance secret". Its credential is good for claiming host jobs only (`instanceConfig.ts` lines 188 to 191).
- An app that creates a Postgres schema needs a role that may create one, and in this stack that is the platform's own role. Line 92 named no such credential and no limit on it.
- The recommendation is a local store, written in above. One operator and five small record sets need no shared database. The operator may prefer a Postgres role confined to `channel_slack` instead, and §8 asks that question.
- Line 96 now records when an event arrived as well as when it was sent. §8's late threshold needs both.
- Line 98 now keeps the text sent, which D2's repeat rule compares.

### D7 — Absent is proven, not claimed

- A new guard test fails on any core file that imports `apps/aflow-channel-slack`.
- A build with the app deleted compiles, and its tests pass.
- With the lane absent, `channel.message.send` is not in the catalog, and a direct dispatch of a `channel` step is refused as an uncomposed operation. The refusal sits in `addStepJob`, beside the lane breaker every dispatch path already meets.
- The refusal asks about the channel lane only. It returns nothing for any other step type, as `codeLaneBreakerRefusal` returns nothing for a step type that is not `code`. Every other lane keeps today's dispatch behaviour.

**Review — amended.**

- Line 106 is new work, not an existing guard (D1 review).
- Line 107 is confirmed as stated.
- Line 108 is half true today. The catalog withholds an uncomposed operation in search, in schema reads, in promotion and in the Helmsman's surface. The code is `catalogSearch.ts`, `getSchema.ts` and `catalogToolPromote.ts` under `apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/`, and `packages/platform-artifacts/src/helmsmanSurface.ts`.
- No dispatch path asks the same question. With no executor, `addStepJob` throws `NoExecutorAvailableError` and the step parks as `StepWaitingOnExecutor` (`apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/executorWait.ts`). A skill step naming `channel.message.send` would wait, not be refused.
- The amended text puts the refusal in `addStepJob` (`packages/redis/src/streams/jobs.ts` line 37), where `codeLaneBreakerRefusal` already sits. That changes `packages/redis`, not the orchestrator.
- The refusal is scoped to the `channel` step type. It reads `channelLaneComposed` from the platform's environment, as `codeLaneBreakerRefusal` reads its own switch (`packages/schemas/src/runtime/codeLaneBreaker.ts` line 79).
- An absent `code`, `host` or `browser` lane still parks, as it does today. A composed channel lane with no executor online also parks. So no existing lane's run lifecycle changes, and the "Leaves alone" line holds.

## 4. What it affects

**Core, kept small:**

- `packages/schemas`:
  - the `channel` step type, in the step type list (`artifact/operationDefinition.ts`, `StepTypeSchema`) and the stream list (`runtime/streamMessages.ts`, `EXECUTOR_JOB_STEP_TYPES`).
  - the `channel.message.send` registration, with `whenToUse` and `whenNotToUse`.
  - `ChannelLaneSchema` and `channelLaneComposed` in `edition/descriptor.ts`, with the `channelLane` field in `EditionDescriptorSchema` and in `EditionSummarySchema`'s lanes.
  - the `channel` case in `isStepTypeComposed`, and the `channelLane` field in `ComposedLanes` (`edition/composedOperations.ts`).
  - the ownership manifest rule for the app, and the guard test that fails on a core import of it.
- `packages/redis`: the uncomposed channel lane refusal in `addStepJob`, for the `channel` step type only (D7).
- `packages/server-runtime`: `PHOENIX_CHANNEL_REDIS_PASSWORD` in the instance configuration, and the Redis identity it names, applied as `hostPairing.ts` applies the host's (D1).
- `packages/database`: one tenant migration that adds the `channel.message` capability group to the system profiles (CLAUDE.md, schema-first step 4).
- `apps/aflow-orchestrator`: no change. Step routing derives the stream from the step type.
- `packages/platform-artifacts`: the Helmsman's placement of `channel.message.send` as discoverable, and a help article on setting up Slack.

**The app, all new:** `apps/aflow-channel-slack`, with the lane consumer, the Socket Mode listener, the card renderer, its store and migrations, and the setup script.

**Review — amended.**

- Line 115 is confirmed, with the lists named. `StepTypeSchema` is the step type list (`operationDefinition.ts` line 17). `EXECUTOR_JOB_STEP_TYPES` is the stream list (`streamMessages.ts` line 833).
- Adding `channel` to that list makes every install create its consumer group and an empty stream key (`packages/redis/src/streams/consumerGroups.ts`). `host` already does the same. An empty key runs no code, so the constraint at line 19 holds.
- Line 117 is amended. The descriptor schema, the client summary and `ComposedLanes` each list the lanes by name, so each gains `channelLane`.
- Line 119 is confirmed. The migration writes the group name into every install's system profiles. It grants nothing where the lane is absent, and it adds no row.
- Line 120 is confirmed, and its condition holds. `addStepJob` writes to `StreamKeys.jobStream(validatedJob.stepType)` (`jobs.ts` line 51), and `scheduleStep` passes `stepDef.stepType` from the registry. The orchestrator's one lane-specific branch is the host binding gate (`scheduleStep.ts` line 197), which a channel step does not need.
- The `packages/redis` and `packages/server-runtime` items are new, from D7 and D1.
- Line 123 now names a store, not a schema (D6).

## 5. Phases

**P0 — Send.** The lane, its Redis identity and its composition, the uncomposed channel lane refusal, the import guard, `channel.message.send` with text only, setup and linking.

_Exit:_ in a Helmsman conversation in the app, the operator says "send me a message on Slack saying hello". The phone receives it. On an install without the channel credential, the operation is not in the Helmsman's catalog, and D7's three proofs pass. A second identical send in the same run fails.

**P1 — Cards.** `itemId`, the D3 table, the tap that resolves, and the card edited after.

_Exit:_ an API task in a skill run parks on a medium-tier write approval. `workflowWriteApprovalSource` shows it as a `write_approval` item of origin `workflow_task`. A Helmsman sends that item. The operator approves it from the phone, and the paused task runs again. A second tap is answered "already decided". A high-tier approval sent the same way shows no buttons. A plan decision sent the same way shows no buttons and says it needs the operator at Aflow.

**P2 — Conversation.** D4: a direct message starts a conversation, a thread continues it, and the answer is relayed.

_Exit:_ "status?" sent from the phone gets the Helmsman's answer in its thread. A reply in that thread continues the same session. A redelivered event is handled once. A message held back past ten minutes asks before it runs.

**P3 — Later, each its own decision:** the server-side trust level (D5), history catch-up after the laptop sleeps, several profiles on one install (Plan 335), the hosted edition's Slack app, and other providers.

**Review.**

- **P0 — re-cut.** Line 127 left out the Redis identity, the dispatch refusal and the import guard. Line 129's exit asks for D7's proofs, which need all three, so they move into P0. The exit now names the credential, not the file (D1). It also proves D2's repeat rule.
- **P1 — confirmed, with one exit added.** A skill run's write approval is a `write_approval` item of origin `workflow_task`, built by `buildWriteApprovalCard` (`packages/server-runtime/src/services/actionCenter/sources/workflowWriteApprovalSource.ts`). Its resolve reads only the resolver's user id, so it accepts the app's key. An approval runs the paused task again, so the exit says that rather than "the run resumes". The added exit proves the plan-item row of the D3 table.
- **P2 — confirmed.** The exit stands. D4's amendment changes the calls, not what is proven.
- **P3 — confirmed.** The trust level matters more than line 139 implies. Without it, nothing the resident asks through the plan board can be decided from the phone (D3 review). It should be the first P3 item decided.

**P0 as built.**

- **The lane.** `channel` is in `StepTypeSchema` and `EXECUTOR_JOB_STEP_TYPES`, so its stream is `aflow:jobs:channel`. `channelLaneComposed` answers `present` only where `PHOENIX_CHANNEL_REDIS_PASSWORD` is set. The descriptor, the client summary and `ComposedLanes` carry `channelLane`, and `isStepTypeComposed` has its case.
- **The credential is minted by the channel setup, not at first boot.** The host credential is minted at every appliance's first boot. A channel credential minted the same way would compose the lane on every install and break "absent means absent". `yarn channel:slack setup` appends it to the platform's `instance.env`, and the stack composes the lane on its next start. In the appliance, bootstrap cuts it into the worker's `wrapping-key.env` where present, so the orchestrator composes the lane as the API does.
- **The Redis identity.** `channelexec` holds `aflow:jobs:channel` and the executor runtime's own key families, each one the host grant also holds. It holds no other lane's stream, no write-approval grant and no browser hand-off. `instance-init` writes it into the ACL file, a full start applies it, and every server start asserts its grant.
- **The refusal.** `addStepJob` throws `ChannelLaneAbsentError` (`LANE_NOT_COMPOSED`, `permission`, not retryable) for a `channel` step where the lane is absent. Every other step type passes through unchanged.
- **The orchestrator changed, by one class.** Its dispatch paths caught `CodeLaneDisabledError` by name, so a channel refusal would have reached the agent as an internal error. `LaneRefusalError` is now the base of both refusals, and the four checks name it. The run lifecycle is unchanged.
- **The operation.** `channel.message.send` takes `{ text }` only, strict. It is registered with the `whenToUse` and `whenNotToUse` D2 names, in the bundle `operator_messages`, and discoverable for the Helmsman. Migration 236 adds `channel.message` to the system profiles.
- **Idempotency is keyed on the run and the logical execution.** On a session's step the logical execution is the step execution, which a retry keeps. On a workflow task a retry is a new step execution, and the logical execution is what stays the same. That id is `task:<taskId>` in every run of the task, so the run is part of the key. Without it, each later run of a workflow task returned the first run's `messageRef` and sent nothing.
- **A post that drew no answer is not retried.** A transport failure, the fifteen-second timeout, an HTTP 5xx or an answer whose body cannot be read may follow Slack's acceptance of `chat.postMessage`. The step fails with `CHANNEL_DELIVERY_UNKNOWN`, not retryable, and says Slack may have posted it. The app records the send without a `messageRef`, so a later attempt at the step, or the same text again in the run, fails the same way and posts nothing. A transport failure or a 5xx on `conversations.open` posts nothing and stays retryable. An HTTP 429 is a refusal and stays retryable.
- **A send is claimed before it leaves.** The runtime runs channel sends four at a time, so parallel tool calls from one turn can carry the same text. The check for a prior send and the record of this one are one synchronous step in the store. Of two sends that arrive together, the second fails with `CHANNEL_MESSAGE_REPEATED` and posts nothing. A send that fails before it posts releases its claim, so a retry may post. Sent records past the 30-day retention are pruned on every claim as well as when the store opens.
- **Settings → Channels does not exist yet.** The not-linked error does not name it, though D2 asks for it. It names `yarn channel:slack setup` and the help article `/help/slack-channel`, which are how an operator links in P0. The operation's pitfall names setup too.
- **The app** keeps `link` and `sent` in `~/.aflow/channel-slack.store.json`, mode 0600, with its own migration ledger. `inbound`, `thread` and `card` arrive with P1 and P2. Socket Mode handles direct messages for linking only. A linked operator who writes to the bot gets one fixed reply, because conversation is P2. The app reads the link code when it starts, so a code from a later setup run links only after the app restarts. Setup and the help article say so.
- **D7's proofs.** `packages/schemas/src/edition/channelSlackAbsence.test.ts` fails on any file outside the app that imports it. The same file shows that nothing a build reads names the app once the cut's own transforms remove it. The app is not in the root `tsconfig.json` references, so `tsc -b` needs nothing from it. `ownershipGuard.test.ts` excuses an absent `optional-pack` path only where an edition absence guard names it, so the suite passes with the app deleted and still fails on a mistyped or stale pack path. `channelLaneDispatchGate.test.ts` and `helmsmanSurface.test.ts` hold the third proof.
- **Not proven here.** The P0 exit needs a Slack workspace and a phone, and no live send ran in this build. It stays open until the operator runs it.

**P1 as built.**

- **The input.** `channel.message.send` takes `{ text, itemId? }`, still strict. The app reads the item with `GET /v1/spaces/:spaceId/action-center/:itemId` in the job's own `spaceId`, so an agent cannot send an item from another space. A missing item fails `CHANNEL_ITEM_NOT_FOUND` and a decided one `CHANNEL_ITEM_NOT_OPEN`, both not retryable and before anything is claimed or posted. An API that does not answer fails `CHANNEL_ITEM_UNREADABLE`, retryable. D2's repeat rule now matches the text and the `itemId` together.
- **The table.** `planCard` (`apps/aflow-channel-slack/src/cards.ts`) is D3's table as reviewed. A flat `human_input` schema is a boolean, an enum of up to 25 plain values (Slack's limit for one row of buttons) or a string. A schema with no type reads as a string, as the web app's answer form reads it. The "preview" of a write approval is the API extension Plan 253's gate builds: the method, the host, the endpoint, the tier and the redacted body when the call has one. A control also needs its action in the item's `allowedActions`, which the API computes for the key's user. That narrows the table and never widens it.
- **The tap.** A button carries only a control id. The resolution comes from the `card` record the app wrote when it posted, so a tap cannot ask for more than the card offered. It is sent to `POST …/resolve` with the origin as the app read it. The card is then edited to say what was decided and by whom, as the Slack user who tapped. A 409 or a 404 from the route is "already decided", and the card says so with the route's own message. A refusal such as a 403 takes the buttons off and says the item needs Aflow. A failure that may succeed if sent again leaves the card as it was, and the thread says which kind it was. A connection that never opened decided nothing, and the app says so. A timeout after the request left, a broken connection or a 5xx such as `DISPATCH_FAILED` may have been applied. The app says the item may already be decided and asks the operator to check it at Aflow before answering again (`RouteRefusal.outcomeUnknown`). Two taps that land together send one, and the other is told to wait. A tap on a card that already has an outcome is not sent to the route. The app answers it "already decided" in the thread from the card's record, so the card keeps the note that says what was decided and by whom.
- **Free text.** A reply in a card's thread answers only a string question. On every other card it resolves nothing, and the app answers in the thread: it points to the button, or to Aflow where the card has none. A reply under a settled card decides nothing either. An answer the route refuses as invalid (422) leaves the card open. The app gives the route's reason in the thread, and the operator can reply again. The answer goes to the route as the operator typed it. `slackText.ts` reads Slack's wire encoding back: entities, links, channel links and mentions. Slack sends a mention as the member ID alone, so it arrives as `@U…`.
- **The store.** Migration `0002-cards` adds the `card` records, pruned at the same 30 days as `sent`. Each holds the item, the origin read, the controls offered and the blocks an edit keeps.
- **PR #273's two findings.** The Slack calls now end when the step's signal does, inside their own fifteen-second bound. That signal is the one the executor runtime aborts at the step's timeout and on the orchestrator's abort. A post cut short that way fails as `CHANNEL_DELIVERY_UNKNOWN`, not retryable, as the handler's own result. The runtime reports a timeout only when a handler throws, so the step no longer waits out a slow post and then fails as a retryable `STEP_TIMEOUT`. A signal that ended before a request left posts nothing and stays retryable. The item read takes the same signal. Setup's owner key is now used: the app reads and resolves items with it, and calls nothing else with it. Setup and the help article say so.
- **Slack's side.** The app now needs interactivity turned on in the Slack app. With Socket Mode it needs no request URL. The help article's setup steps say so.
- **Not proven here.** P1's exit needs a live skill run, a Slack workspace and a phone, and none ran in this build. Unit tests hold §6's two P1 proofs and the second-tap and high-tier parts of the exit. `cards.test.ts` holds the ceiling. `cardActions.test.ts` holds free text, the second tap and the edited card. `sendCard.test.ts` holds the high-tier card, the plan decision card and the step bound.

**P2 as built.**

- **The route.** `inbound.ts` asks each direct message four things in order. An event of the linked operator's already recorded does nothing, a redelivered link code included. A link code or a stranger is answered by linking. A stranger gets the fixed reply, no turn runs and the app records nothing of theirs. An event that links is recorded in the same synchronous step as the link, so its redelivery does nothing. A reply under a card goes to the card, so free text still approves nothing. Everything else is the conversation's (`conversation.ts`). A link code the linked operator sends again is answered by linking and never reaches the Helmsman.
- **The start.** A direct message outside a thread calls `POST /v1/sessions?spaceId=…` with target `{ kind: "platform-role", systemRole: "cybernetic-helmsman" }`, mode `api` and `input: { input: text }`. The text is the text as typed, read back from Slack's wire encoding. Mode `api` is what `refusedStartMode` admits from a key. The key is the owner's, and the link must name the key's user, so the conversation acts with the operator's own posture and nothing is widened for the channel. The home space is the one the web app opens first: the tenant's `defaultSpaceId` where the account reaches it, else the first space it reaches.
- **The thread.** The thread under the message is recorded against its session. A message claims a new thread in one synchronous step before it starts the session, so two messages that arrive together for one thread start one session. The second is told the Helmsman is still answering. A reply in that thread calls `POST /v1/sessions/:sessionId/resume` with `{ stepExecutionId, input: { input: text } }`. `stepExecutionId` is the step the last `SessionPaused` named. Where the thread does not hold it, the app reads it from the session's newest events. It skips a pause the thread has already resumed, because the events name that pause until the Helmsman answers. A resume the route refuses as `409` says the conversation moved on at Aflow, and the next reply reads the pause again. A reply sent while the Helmsman is still answering is not sent, and the app says so. A reply in an ended conversation says to start another.
- **The answer.** The app reads the session's newest events (`GET /v1/sessions/:sessionId/events`) every two seconds until the session pauses with a step it has not answered, or ends. A pause that waits for the person carries `agentResponse`, or names `ai.agent.chatInput.*` among its missing variables, and the app posts its text into the thread. A pause that does not wait for the person is said once to need the operator at Aflow, and a failed post of that notice does not end the watch. A watch that fails leaves the thread waiting, so the next reply reads the pause from the session. An answer longer than Slack's 40,000 characters once escaped is cut between whole escapes, and says the rest is at Aflow. The app records the pause it answered before it posts, so a watch that starts again after a restart never posts one answer twice. A turn longer than 30 minutes stops the watch, and the thread says the answer is at Aflow.
- **Once.** The `inbound` record holds each event id, unique, and the channel and timestamp of its message. It is written before anything acts on the event, in one synchronous step. A redelivered event does nothing, and so does the same message under another event id. The start and the resume also carry `slack-event:<eventId>` as their `Idempotency-Key`.
- **Late.** The age is the arrival time less the message's own Slack timestamp, both kept on the `inbound` record with the age. A message older than ten minutes is not sent. The app asks "This arrived late. Run it now?" in its thread with **Run it now** and **Discard**, and keeps the text only until the operator chooses. **Run it now** sends the text with a line that says when it was sent and that the operator chose to run it late, so the Helmsman reads the message as old. **Discard** sends nothing and drops the text. The record keeps the choice for §8's measurement. A second tap on the question is answered from the record.
- **An unknown outcome is not sent again.** A start or a resume that may have reached Aflow says so in the thread and asks the operator to check at Aflow before sending again. One that never connected says nothing reached the Helmsman.
- **The store.** Migration `0003-conversations` adds `inbound` and `thread`, pruned at the same 30 days. A thread that still waits for an answer is kept.
- **The owner key's use widens with D4.** The app now also reads `GET /v1/tenant` and `GET /v1/spaces`, and calls the session start, resume and event routes. It calls nothing else with the key. Setup and the help article say so.
- **PR #279's three findings.** A `409` is "already decided" only when the item is no longer open. The app takes the item the route sent back, or reads it again when none came. An open item gets a card that says it changed at Aflow, is still open and needs the operator there, and a later tap is answered "out of date". An item it cannot read again leaves the card open and asks the operator to check at Aflow. A tap on a message with no card record is answered in its thread: the app holds no record, nothing was decided, and the Action Center decides it. A tap on a button a card does not offer is answered too. The pitfall on `channel.message.send` now says the repeat rule matches the text and the `itemId` together.
- **Not proven here.** P2's exit needs a Slack workspace, a phone and a running Helmsman, and none ran in this build. `conversation.test.ts` holds §6's P2 proofs through the app's own API client, against a fake Aflow that keeps the session routes' rules. A start in mode `chat` or a resume without the paused step is refused there, and none is.

## 6. How it is proven

- **Nothing without a call.** With the app running, a run that never calls `channel.message.send` sends nothing and writes no record in the app's store.
- **Absent is absent.** D7's three proofs.
- **The recipient is never chosen.** No `channel.*` operation accepts a user, chat or channel id, and a guard test fails on one that does.
- **A retry posts once.** A step retried after its message was posted returns the first `messageRef`.
- **Each run posts its own.** A second run of the same workflow task posts again, and a retried step within that run posts nothing.
- **A lost answer posts once.** A timeout after Slack took the post fails not retryable, and neither a retry nor a resend of the text posts again.
- **A repeat fails.** A second send of the same text in the same run fails, and the first is the only message posted.
- **Free text approves nothing.** "yes" typed in a card's thread leaves the item open, and the app points to the button.
- **The ceiling holds.** Every item outside the D3 table renders with no buttons, a plan decision and a plan ask included.
- **A stranger gets nothing.** A message from an unlinked Slack user runs no turn and stores no text.
- **The phone reaches the Helmsman.** A message from the linked operator starts a Helmsman conversation, and the answer arrives in its thread. A reply in that thread continues the same session.
- **The session routes' rules hold.** The start uses mode `api` from the owner's key, and each resume names the paused step.
- **Once.** A redelivered event starts no second conversation and posts no second answer.
- **Late asks first.** A message older than ten minutes runs only on **Run it now**, and the Helmsman reads when it was sent.

## 7. What exists to reuse

- The lane's composition: `hostLaneComposed` in `packages/schemas/src/edition/descriptor.ts`, and its case in `packages/schemas/src/edition/composedOperations.ts`.
- The lane's Redis identity: `PHOENIX_HOST_REDIS_PASSWORD` in `packages/server-runtime/src/bootstrap/instanceConfig.ts`, applied by `packages/server-runtime/src/routes/hostPairing.ts`.
- The dispatch choke point: `addStepJob` and `codeLaneBreakerRefusal` in `packages/redis/src/streams/jobs.ts`.
- The setup script's key minting and file handling: `scripts/mcp-local-setup.mjs`.
- The approval preview a P1 card shows: `apps/aflow-executor-api/src/handlers/api/writeApprovalGate.ts`, rendered by `buildWriteApprovalCard` in `packages/server-runtime/src/services/actionCenter/sources/pausedStepSource.ts`.
- The item read and resolve routes: `packages/server-runtime/src/routes/action-center.ts`.

## 8. Open questions

- **The late threshold.** Ten minutes is the starting value. Measure how often the app asks and how often the operator discards.
  - Recommended: keep ten minutes for P2. Record each late message's age and the operator's choice in `inbound` (D6). Lower the threshold where the operator chooses **Run it now** for most of them. Raise it where they discard most.
- **The resident's policy.** When the resident sends, and what, is Plan 331's to decide. This plan only measures what was sent and what was decided from the phone.
  - Recommended: the policy stays with Plan 331. Plan 331 should know one limit before it writes one. A plan decision or a plan ask sent as a card cannot be decided from the phone (D3). So the resident sends those as text that points to Aflow, until the trust level (D5) exists.
  - Recommended: measure from the `sent` and `card` records, joined to the resolve audit by item id.
- **Where the app keeps its records.** D6 now recommends a local store over a Postgres schema of the app's own.
  - Recommended: the local store. Choose a Postgres role confined to `channel_slack` only if the hosted edition's Slack app (P3) needs the records where several processes can read them.
- **The decision card.** The card at the top records the decisions as the review amended them.
  - Recommended: rewrite the card wherever the operator refuses an amendment, so it records the decisions as they stand.
