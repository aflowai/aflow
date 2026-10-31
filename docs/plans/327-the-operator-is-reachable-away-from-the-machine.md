# Plan 327 — The operator is reachable away from the machine

**Status:** Design. No phase is built.

**Builds on:** Plan 331 (the resident Helmsman, which watches the space and decides when the operator must act), Plan 324 (how the Helmsman finds an operation without carrying it), Plan 253 (the write approval card and its grant), the host lane (an executor that ships outside the image and is composed only where it is configured), and `yarn mcp:setup` (a local client of the API that holds its own key).

**Leaves alone:** the orchestrator, session hot state, the run lifecycle, the Action Center's items and its resolve boundary, every tenant table, and `user.notification.email`.

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

Channel operations have their own step type, `channel`, served by the stream `jobs:channel`. One optional app, `apps/aflow-channel-slack`, consumes that stream and holds the Slack connection. It is the executor and the inbound listener in one process.

The lane is composed as the host lane is (`hostLaneComposed`, `packages/schemas/src/edition/descriptor.ts`). `channelLaneComposed` answers `present` only when the app's configuration file exists. When the lane is absent, `isOperationComposed` withholds every `channel.*` operation from the catalog (`packages/schemas/src/edition/composedOperations.ts`). An agent never sees a tool that can only fail.

The app ships outside the image, as the host executor does. The ownership manifest classes it `optional-pack`, so its guards fail on any core file that imports it.

_Rejected — a hook when a run stops:_ every run would pay for a feature most installs never use, and the person would be told about every run.

_Rejected — a notification outbox with a delivery task:_ rows would be written for people who never linked a channel, and a background task would run on every install.

### D2 — One operation: `channel.message.send`

The input is `{ text, itemId? }`. `text` is what the agent wants the operator to read. `itemId` names an open Action Center item to attach as a card (D3).

- **The recipient is derived.** It is the person the calling run works for: the run's `createdBy`. For a resident wake, that is the person who created the resident schedule. The agent never names a recipient.
- **The recipient must be the linked operator.** When they are not, or no link exists, the step fails with a teaching error that names Settings → Channels.
- **The send is synchronous.** The executor posts to Slack and returns `{ delivered: true, messageRef }`. A provider error fails the step, and the existing step retry applies.
- **It is idempotent on the step execution.** A retried step whose message was already posted returns the first `messageRef` and posts nothing.

The operation is discoverable for the Helmsman and grantable to Runners and skill steps (Plan 324). Its `whenToUse` says: "the operator must act and may be away from the machine". Its `whenNotToUse` says: "progress reports nobody asked for".

_Rejected — `channel.message.ask`, a send that pauses for the answer:_ a resident wake that paused would hold the space's wake guard (Plan 331 D1), so the next heartbeat would be skipped until the operator answered. A question already exists as an Action Center item, and D3 puts that item on the phone.

_Rejected — a recipient field:_ an agent that chooses recipients is an exfiltration path and a spam path.

### D3 — An Action Center item becomes a card the operator can decide from

When `itemId` is given, the app reads the item through the API (`GET /v1/spaces/:spaceId/action-center/:itemId`). It renders the item with the buttons its kind allows. A tap calls the same resolve route the web app calls (`POST /v1/spaces/:spaceId/action-center/:itemId/resolve`). Then the app edits the card to say what was decided and by whom.

The app offers buttons only for these kinds:

| Item                                            | On the phone                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `human_input` with a flat schema                | Buttons for an enum or a boolean. A thread reply for a string.    |
| `human_approval`                                | Approve or deny.                                                  |
| `write_approval`, tier `medium`, with a preview | Approve or deny, with the preview Plan 253 already computes.      |
| Every other kind                                | The card says what waits and that it needs the operator at Aflow. |

A tap on an item that is no longer open gets the resolve route's own answer, and the card says the item was already decided. Free text never approves anything.

_Rejected — "reply YES to approve":_ the approval would be parsed out of prose, which any content reaching the conversation could inject.

### D4 — A message from the operator continues a Helmsman conversation

A direct message to the bot starts a Helmsman conversation in the operator's home space (`POST /v1/sessions`). A reply in that message's Slack thread continues the same session (`POST /v1/sessions/:sessionId/resume` with `input: { input: text }`). The app records each thread against its session.

The app relays the answer by watching that session's events until it pauses with the agent's reply (`agentResponse` on `SessionPaused`). It watches only sessions it started, and stops when the reply is posted. This is a client reading its own conversation, as the web app does.

- **A message is handled once.** The app records each Slack event id, and a redelivered event does nothing.
- **A late message asks first.** A message older than ten minutes when it reaches the app is not sent to the Helmsman. The app replies "This arrived late. Run it now?" with **Run it now** and **Discard**.
- **Missed messages are not recovered in this plan.** Slack delivers what it delivers while the app is connected. History catch-up is P3.

### D5 — One operator per install, linked at setup

`yarn channel:slack setup` writes the app's configuration file. That holds the Slack bot token and the app-level token for Socket Mode. It also mints a user API key for the person running setup, as `yarn mcp:setup` does (`scripts/mcp-local-setup.mjs`). The file lives at `~/.aflow/channel-slack.env`, mode `0600`.

Setup prints a one-time code. The operator sends that code to the bot from Slack, and the app links that Slack user to the key's user. From then on the app serves only that Slack user. Anyone else gets one fixed reply. No turn runs, and no message text is stored.

The app acts with the operator's API key, so it can do what an MCP client with that key can do today. The D3 table is the app's own ceiling.

_Rejected — the operator's browser session as the app's credential:_ whoever holds the unlocked phone would inherit every step-up the browser login has.

_Open — a server-side trust level for "a person, not at the machine":_ it would let the resolve route refuse kinds above the ceiling itself, instead of trusting the app. It is P3, and it is the only core change this feature may need later.

### D6 — The app owns its storage

The app keeps its records in its own Postgres schema, `channel_slack`, outside every tenant schema. It creates and migrates that schema itself, with its own migration ledger, when it starts. The tables are:

- `link`: the Slack user, the Aflow user and tenant, the home space, and when it was linked.
- `inbound`: each Slack event id (unique), when it was sent, and its outcome.
- `thread`: each Slack thread and the session it continues.
- `card`: each card's Slack message reference and the item it shows.
- `sent`: each step execution's `messageRef`, for D2's idempotency.

Removing the app and its schema leaves nothing behind in the platform.

_Rejected — tenant tables:_ they would exist in every install, used or not.

### D7 — Absent is proven, not claimed

- A guard test fails on any core file that imports `apps/aflow-channel-slack`.
- A build with the app deleted compiles, and its tests pass.
- With the lane absent, `channel.message.send` is not in the catalog, and a direct dispatch is refused as an uncomposed operation.

## 4. What it affects

**Core, kept small:**

- `packages/schemas`:
  - the `channel` step type, in the step type list (`artifact/operationDefinition.ts`) and the stream list (`runtime/streamMessages.ts`).
  - the `channel.message.send` registration, with `whenToUse` and `whenNotToUse`.
  - `ChannelLaneSchema` and `channelLaneComposed` in `edition/descriptor.ts`, and the `channel` case in `composedOperations.ts`.
  - the ownership manifest rule for the app.
- `packages/database`: one tenant migration that adds the `channel.message` capability group to the system profiles (CLAUDE.md, schema-first step 4).
- `apps/aflow-orchestrator`: no change, if step routing derives the stream from the step type. If it does not, the stream name is the only line added.
- `packages/platform-artifacts`: the Helmsman's placement of `channel.message.send` as discoverable, and a help article on setting up Slack.

**The app, all new:** `apps/aflow-channel-slack`, with the lane consumer, the Socket Mode listener, the card renderer, its schema and migrations, and the setup script.

## 5. Phases

**P0 — Send.** The lane, its composition, `channel.message.send` with text only, setup and linking.

_Exit:_ in a Helmsman conversation in the app, the operator says "send me a message on Slack saying hello". The phone receives it. On an install without the configuration file, the operation is not in the Helmsman's catalog, and D7's three proofs pass.

**P1 — Cards.** `itemId`, the D3 table, the tap that resolves, and the card edited after.

_Exit:_ a skill run parks on a medium-tier write approval. A Helmsman sends its item. The operator approves it from the phone, and the run resumes. A second tap is answered "already decided". A high-tier approval sent the same way shows no buttons.

**P2 — Conversation.** D4: a direct message starts a conversation, a thread continues it, and the answer is relayed.

_Exit:_ "status?" sent from the phone gets the Helmsman's answer in its thread. A reply in that thread continues the same session. A redelivered event is handled once. A message held back past ten minutes asks before it runs.

**P3 — Later, each its own decision:** the server-side trust level (D5), history catch-up after the laptop sleeps, several profiles on one install (Plan 335), the hosted edition's Slack app, and other providers.

## 6. How it is proven

- **Nothing without a call.** With the app running, a run that never calls `channel.message.send` sends nothing and writes no row in `channel_slack`.
- **Absent is absent.** D7's three proofs.
- **The recipient is never chosen.** No `channel.*` operation accepts a user, chat or channel id, and a guard test fails on one that does.
- **A retry posts once.** A step retried after its message was posted returns the first `messageRef`.
- **Free text approves nothing.** "yes" typed in a card's thread leaves the item open, and the app points to the button.
- **The ceiling holds.** Every kind outside the D3 table renders with no buttons.
- **A stranger gets nothing.** A message from an unlinked Slack user runs no turn and stores no text.

## 7. What exists to reuse

The branch `plan/326-operator-channels` built an earlier shape of this plan into the engine, and that shape is rejected (§3, D1). Read it for the rules, never merge it or check it out (`git show plan/326-operator-channels:<path>`):

- the late-message and duplicate rules: `packages/server-runtime/src/channels/inbound/dispatcher.ts` and `packages/database/src/repositories/channelInbound.ts`.
- the approval preview values, if P1 shows the existing preview is not enough to decide on: `apps/aflow-executor-api/src/handlers/api/writeApprovalGate.ts`.
- the phone experience the design aims at: §3 of that branch's `docs/plans/327-the-operator-is-reachable-away-from-the-machine.md`.

## 8. Open questions

- **The late threshold.** Ten minutes is the starting value. Measure how often the app asks and how often the operator discards.
- **The resident's policy.** When the resident sends, and what, is Plan 331's to decide. This plan only measures what was sent and what was decided from the phone.
