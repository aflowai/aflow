# Plan 338 — The operator learns what waits on them

**Status:** P0 merged. P1 built: the listing rule, the merge-wait flag, the two caps in the schema, the sidebar count, the label table and the help articles. P2 built: the counts, the section and the ceiling test. P3 built: the measured reads, the folded sections, the dock open by default with a per-conversation memory, and the landing on the last conversation (D4's rule and window). P3's schedules round built the upcoming list with its count line, the due schedules in it, the Triggers expander and the card session links. Its exit on the live stack is open. P4's shortcut is not built.

**Builds on:** Plan 331 (D3.3, the asked-once rule, and the resident), Plan 332 (the overview, the column rule of D4, the open question of §8), Plan 337 (the decision card, written here by hand because 337 P3 is not merged), Plan 333 (D2's writing rules).

**Leaves alone:** every plan status and the column rule that places a step, the asked-once record and the note line it writes, the stream walk, the Action Center's resolve paths, the session URL.

**Changes `human.action_center.focus`:** P2 widens it to the ids the section lists. `ACTION_CENTER_FOCUS_ITEM_ID_PREFIXES` (`packages/schemas/src/operations/human.ts`) adds the five attention prefixes `plan-ask`, `plan-decision`, `workflow-task`, `workflow-write-approval` and `workflow-oauth-consent` to `proposal`, `step`, `gate` and `settings`. The schema's `itemId` pattern and the orchestrator's bare-id check both read that list. The orchestrator handler copies the kind and title the cached attention block lists for a non-proposal id onto the step output as `listed`. The chat renders every non-proposal focus as an `InlineFocusedItem` card with the item's kind, title and state. The card holds no answer control. It links a plan step to its node on the plan page and points every other item to Pending in the Workbench.

## Decision card

**What changes**

- Today: only the Plan page says that a plan step waits on the operator. The bell, the sidebar, the Workbench and the Helmsman do not.
- After: a blocked step is an Action Center item at once. The bell, the Workbench, a sidebar count and the Helmsman's turn all read it from there.

**Why**

- The operator reports three steps blocked on them (nodes `1dceee61`, `b4fc0e02`, `974fc175`) with no indicator anywhere.
- `listAskedNodes` lists a blocked node only after a wake has asked about it (`asks.ts`). No wake runs where the resident schedule is not armed (`resident.ts`).
- The Helmsman's turn carries no count of what waits on a person (`attentionBuilder.ts`).
- The Workbench starts collapsed, and the chat lands on a new conversation (`space-chat.tsx`).
- The labels name an action ("Needs you") where they should name a state (`plan-board.ts`).

**What it affects**

- `@aflow/cybernetic-runtime`: the listing rule in `plan/asks.ts`, the walk's merge-wait flag in `plan/store.ts`, the attention block in `attentionBuilder.ts`.
- `@aflow/server-runtime`: `planAskSource.ts` lists and resolves by the new rule, and the item title changes. The schedules routes list every upcoming schedule and order the Triggers page's rows, and `triggerArmedSource.ts` keeps the notices alone.
- `@aflow/schemas`: one table of state labels beside the plan column ids, and the two plan caps.
- `@aflow/web-product`: the sidebar's Plan count, the Workbench's default state and lazy sections, the chat's landing, the labels on the Plan page and in the Workbench, and the two reads onto the query cache. The schedules round adds the upcoming list with its count line, the expired rows behind **Show older** and the schedule cards' session links.
- `@aflow/platform-artifacts`: the help articles `concepts.ts`, `approvals.ts` and `automation.ts`.
- `docs/plans/332-the-plan-page-serves-the-operators-jobs.md`: §8 answered, and D5's rejection pointed here.
- Stored data: none.

**Risks**

- A space with many blocked proposals fills the approvals lane. Mitigation: the source lists at most 50, newest first, and the Plan page holds the rest with its total.
- The attention block grows on every turn. Mitigation: the section has a measured ceiling of 500 tokens, and it carries titles and ids only.
- An open Workbench mounts at least 15 reads that the chat does not hold today (§2, F14). Mitigation: only two sections mount on open, and P3 measures before it changes the default.
- Landing on the last conversation may surprise an operator who wanted a new one. Mitigation: the window is six hours, an ended conversation is never resumed, and **New chat** stays one click and one shortcut away.

**Open questions**

- Does a stranded step, open under a closed parent, become an item? Recommended: no. Approving it changes nothing (Plan 332 §1). The Plan page keeps it under its own reason.
- Does the attention block list items that belong to another conversation? Recommended: yes, as titles and ids to point at. The Helmsman only points, and pointing resolves nothing.
- Does the Workbench remember its state per space or per browser? Settled in D3. The dock's fold stays with its conversation in this browser. Which sections are open is kept per space for the page session, and a reload loses it. D3 says why not in `localStorage`.
- Does the chat resume a conversation that another member of the space opened? Recommended: no. It resumes only the reader's own.

**Not done on purpose**

- No new table, column or stored item. The item is read at list time.
- The resident schedule is not armed by this plan.
- No item body enters the Helmsman's context.
- The plan statuses, the column rule and the stream walk do not change.
- The session URL does not move to a new route.

**Done when**

- The operator approves or amends §3 from this card and the decisions under it.

## 1. Problem

Five things the operator raised are one problem: nothing outside the Plan page says that a decision waits.

1. Three plan steps stand blocked on the operator, and no indicator shows it.
2. The Helmsman does not know what waits on a person, so it cannot point the operator there.
3. The chat view mounts the Workbench collapsed on every landing.
4. The chat route lands on a new conversation, so the operator picks the last one by hand.
5. "Needs you" reads as a command. The operator asks for state labels, such as "Pending approval", and for icons over text.

A later round of P3 answers a sixth complaint, about schedules. It is the same problem for work that runs on its own: the operator cannot see what is about to run.

6. A schedule due to run in one minute showed nothing in the Workbench. The section listed only the schedules an agent set up in chat, and the operator had created this one. On the Triggers page, 49 expired rows buried the one schedule that mattered. A schedule card gave no way to reach the session its firing runs.

The facts below come from reading the code at `c04f0c9d`. Plans 160, 228 and 288 are not in this repository (`docs/plans/README.md`, _The earlier archive is not published_). This document cites the code that carries their rules instead.

## 2. What the code shows today

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **The Action Center lists asked nodes only.** `planAskSource.ts` (`packages/server-runtime/src/services/actionCenter/sources/`) lists `listAskedNodes` from `packages/cybernetic-runtime/src/plan/asks.ts`. That function keeps a node only where `isAsked` finds its revision in the Redis record `plan:resident:asked:…`. The list holds at most `PLAN_OPEN_ASKS_LIMIT`, 50, in tree order.                                                                                        |
| F2  | **Two places claim an ask.** The board walk `nextOnPlanBoard` in `plan/stream.ts` calls `claimAsk` for a node it answers `ask`. The close path in `plan/operations.ts` calls `claimAsk` when a merge is not attested. No other code writes the record.                                                                                                                                                                                                                               |
| F3  | **The walk runs only on a wake.** `requestResidentWake` in `plan/resident.ts` returns `no_resident` where the space has no resident schedule. A node that a Helmsman creates `blocked` is then never asked, and F1 never lists it.                                                                                                                                                                                                                                                   |
| F4  | **An ask record lapses.** `PLAN_ASKED_TTL_MS` is seven days (`asks.ts`). A node asked once and not answered leaves the Action Center when the record lapses, until a wake asks again.                                                                                                                                                                                                                                                                                                |
| F5  | **The item answers with two verbs only.** `planAskSource.resolve` accepts `approve` or `reject`. It opens the node, drops it, or closes a merge it judged. No free text reaches the resident. Plan 332 D5 rejected a Workbench item per blocked step because a free-text answer might read as a grant of scope. That concern does not arise for this item.                                                                                                                           |
| F6  | **The item lands in the approvals lane.** `planAskItem` sets kind `human_approval`. `partitionLanes` in `use-action-center-lanes.ts` puts it in `approvals`. `counts.actionable` adds approvals, inputs, connections and proposals. The operator's pick 6 removed Coach proposals (branch `aflow/ux-coach-badge`, fix round 2). The Workbench's **Needs attention** shows connections, approvals and inputs (`WorkbenchNeedsAttention.tsx`, citing Plan 228 §3.1).                   |
| F7  | **The bell and the chat already hold the Action Center.** `ActionIndicator.tsx` reads `useActionCenter` in every page header that shows the bell (`app-page-header.tsx`). The bell opens `/chat?workbench=1`. The chat page hides the bell (`ChatHeader.tsx`) and reads `useActionCenter` itself for the dock's badge (`space-chat.tsx`). The key is `['space', spaceId, 'action-center']`, and a refcounted broker keeps it live.                                                   |
| F8  | **A plan write wakes the Action Center.** `nodeWritten` in `plan/operations.ts` calls `publishActionCenterWake`. The topic in `routes/realtimeTopics/spaceActionCenter.ts` rebuilds on a wake, at most once per `REBUILD_FLOOR_MS`, 2,000 ms. No file in this checkout cites Plan 288. This is the wake path it names.                                                                                                                                                               |
| F9  | **The sidebar's Plan entry has no count.** `app-shell.tsx` pushes `{ label: 'Plan', icon: 'flag' }` and reads no Action Center state. Plan 332 §8 left the count open until the read's cost was measured.                                                                                                                                                                                                                                                                            |
| F10 | **The walk carries the note's first line only.** `store.walk` returns `PlanNodeSummary` rows (`plan/tree.ts`, `packages/schemas/src/cybernetic/plan.ts`), which hold `noteHead` and not the note. `listAskedNodes` therefore reads each kept node again with `store.find` to see its whole note and its merge-wait line.                                                                                                                                                             |
| F11 | **The Helmsman's turn has an attention block.** `buildCyberneticTurnOverrides` (`agentTurnIntegration.ts`) adds a volatile block keyed `HelmsmanAttention` on every turn. `buildHelmsmanAttention` (`attentionBuilder.ts`) builds it, cached per space by generation with a 60-second lifetime (`attentionCache.ts`). A plan write bumps the generation (`plan/operations.ts`).                                                                                                      |
| F12 | **The block carries no count of what waits on a person.** It holds the open plan tree (30 lines, each with its status), active runs, run attention items (`workflow_run_completed`, `_paused`, `_failed`, `_cancelled`), applets, Coach proposals with ids, and skill flags. No section counts Action Center items, plan asks or consents. `helmsmanPrompt.ts` teaches `human.action_center.focus` with an id taken from a listing, and no listing gives one.                        |
| F13 | **A collapsed dock mounts nothing.** `CollapsibleSide.tsx` renders the rail button when collapsed and the children only when open. `consoleOpen` starts `false` (`space-chat.tsx`). `?workbench=1` opens it once and leaves the URL.                                                                                                                                                                                                                                                 |
| F14 | **An open dock mounts these reads.** The table below lists them.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F15 | **The chat's session lives in a query parameter.** The chat writes `?session=<id>` on `/s/<slug>/chat` with `router.replace` (`space-chat.tsx`). `/s/<slug>/sessions/<id>` renders `RunDetailsPage`, not the chat (`apps/web-local/src/app/(dashboard)/s/[space]/sessions/[sessionId]/page.tsx`). `/s/<slug>` redirects to `/chat` (`space-index.tsx`).                                                                                                                              |
| F16 | **The chat can resume, and does not.** `useChatSessionRuns` takes `autoResumeLatest` and seeds the newest listed session where it is true (`components/chat/use-chat-session.ts`). `space-chat.tsx` passes `false`. The list loads at mount with `SESSION_LIST_LIMIT`, 10 (`lib/session-list-query.ts`). Each row carries `lastActivityAt`, `status` and `createdBy` (`lib/types.ts`).                                                                                               |
| F17 | **The space is remembered, the session is not.** `preferredSpaceSlug` is a 90-day cookie (`preferredSpace.ts`). No equivalent names a session.                                                                                                                                                                                                                                                                                                                                       |
| F18 | **The labels live in five tables.** `plan-board.ts` holds `PLAN_BOARD_COLUMNS`, `NEEDS_YOU_REASON_LABEL`, `PLAN_STATE_LABEL`, `PLAN_LANES` and the nouns in `planHeader`. The column ids `needs_you`, `in_flight`, `up_next`, `done` and `dropped` live in `packages/schemas/src/operations/plan/schemas.ts`. The item title `Blocked: <title>` or `Judge merge: <title>` lives in `planAskSource.ts`. The section title **Needs attention** lives in `WorkbenchNeedsAttention.tsx`. |
| F19 | **The orbs exist, and the plan page uses dots.** `StatusOrb.tsx` has the kinds `running`, `paused` ("Paused — action expected"), `completed`, `failed`, `inert`, `idle`, `searching` and `handed_off`. The plan page draws a state dot in `PLAN_STATE_COLOR` (`PlanParts.tsx`). Plan 332 on main has phases P0 to P6 and no P7.                                                                                                                                                      |
| F20 | **A merge wait is an item but not under Needs you.** A node `active` or `waiting` with `PLAN_NODE_MERGE_WAIT_LINE` in its note is listed as `Judge merge` (F1). The column rule places it under Up next or In flight by its status (`planBoardColumn`, Plan 332 D4).                                                                                                                                                                                                                 |

**F14 — what an open dock mounts.** "Shared" means the chat page holds the same query key before the dock opens, so the dock reads the cache. "New" means the dock makes the read.

| Mounted by                                          | Read                                                                                                                           | Shared or new                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `CyberneticProvider` (`cybernetic-provider.tsx`)    | `GET /api/spaces/:id` for directives, by raw `fetch`                                                                           | New, on every open, not cached                                                      |
| `EntityChatInspector` (`entity-chat-inspector.tsx`) | `GET /spaces/:id/cascades/:sessionId`, by raw `fetch`, where a conversation is open                                            | New, on every open, not cached                                                      |
| `EntityChatInspector`                               | the entity-events broker (`useSpaceEntityEvents`)                                                                              | New subscription. No other mount on the chat page holds it.                         |
| `Workbench.tsx`                                     | `useActionCenter` — `['space', id, 'action-center']`                                                                           | Shared (F7)                                                                         |
| `Workbench.tsx`                                     | `useSpaceWorkflowRuns` — `['space', id, 'workflow-runs', 'active']`, stale after 4 s                                           | New                                                                                 |
| `Workbench.tsx`                                     | `['space', id, 'workflows', 'all']` — `/workflows?archived=true`                                                               | New                                                                                 |
| `WorkbenchNeedsAttention`, recent conversations     | `useSpacePeople` — `['space', id, 'members']`                                                                                  | Shared where the transcript renders (`MessageAuthorProvider` in `ChatMessages.tsx`) |
| `WorkbenchApplets`                                  | `['space', id, 'applets']`, then one presence read                                                                             | New, two reads                                                                      |
| `WorkbenchSkills`                                   | one presence read per skill row with runs, and runs per skill only on expand                                                   | New, one per such row                                                               |
| `WorkbenchAgents`                                   | `useFlows` — `['space', id, 'agents']`                                                                                         | Shared (`space-chat.tsx`)                                                           |
| `WorkbenchIntegrations`                             | `useSpaceIntegrations` — definitions, bindings, credentials, MCP servers, MCP bindings, repository bindings, OAuth connections | New, seven reads                                                                    |
| `WorkbenchCoach`                                    | `useCoachSurface` — `/anomalies?onlyPending=true`, stale at once, and the Coach-surface broker                                 | New, one read and one subscription                                                  |
| `WorkbenchRecentConversations`                      | the Helmsman's session list — `sessionListKey(…, 'cybernetic-helmsman')`                                                       | Shared where the Helmsman is the selected flow (`use-chat-session.ts`)              |
| `WorkbenchRecentConversations`                      | `['space', id, 'action-center', 'session-invitations']` and one presence read                                                  | New, two reads                                                                      |

In these terms "heavy" means this today. An open dock makes at least 15 new HTTP reads and two new subscriptions. Four reads are shared. Two of the new reads bypass the shared cache and repeat on every open.

## 3. Decisions

### D1 — A blocked node is an Action Center item the moment it is blocked

**Options.**

- **(a) The source lists every waiting node at read time.** `planAskSource` lists every node that waits on a person under an open root. The ask record decides only whether the walk writes the `Waiting on you:` line.
- (b) Arm the resident in every space, so that the walk asks.
- (c) Write an item row when a node moves to `blocked`.

**Recommended: (a).** It is read-time and adds no storage. The asked-once rule still governs the note write and the walk's `ask` decision (F2). The item lands in the approvals lane (F6). The bell, **Needs attention** and the sidebar count follow from that, with no second mechanism.

**The rule.** `listAskedNodes` becomes `listWaitingNodes`. It keeps a node that is open, is not a `decide` node, lies under open branches only, and is `blocked` or carries the merge-wait line. It does not read the ask record. `findAskedNode` becomes `findWaitingNode` by the same rule, so `resolve` finds what `listOpen` listed. A `decide` node keeps its own item (`planDecisionSource.ts`). A stranded node is not listed, because the walk does not pass a closed node (`PlanTreeWalkOptions.statuses`, `plan/store.ts`).

**The bound and the cut.** The source lists at most `PLAN_OPEN_ASKS_LIMIT`, 50, newest first by `updatedAt`. Past 50 the list cuts, and the Plan page's Needs-you lane holds the rest with its total (Plan 332 P4). The decision source keeps its own cap, `PLAN_OPEN_DECISIONS_LIMIT`, 50 (`plan/operations.ts`). Both constants move to `@aflow/schemas`, so the client can mark a cut.

**The read's cost.** The walk gains a flag that says whether the note holds the merge-wait line (F10). Then `store.find` runs only for the 50 or fewer listed nodes, for their summary. A rebuild runs at most once per 2,000 ms (F8).

**The sidebar count (Plan 332 §8, answered here).** The Plan entry in `app-shell.tsx` shows the count of open items whose origin is `plan_ask` or `plan_decision`. It reads `useActionCenter`, the key the bell and the chat already hold (F7). The read is shared and adds no request. On a page whose header shows no bell, the sidebar's mount is the one broker subscription. The count is the sum of the two origins, over every such item whatever its audience. Where either origin holds as many items as its cap, the count gains a "+". The "+" says that list may have cut, not that it has. An origin of exactly 50 items reads "50+" with nothing cut. The item list carries no total, so the client cannot tell that case from a cut. The Plan page's Needs-you lane holds the exact total (Plan 332 P4).

**Plan 332 D5 is superseded on this point.** The item has two verbs and no free text (F5). P1 points 332's text here.

_Rejected:_ (b). It makes a schedule, a model turn and its spend the price of a badge. A space with the resident paused would show nothing again.

_Rejected:_ (c). It adds a stored row that must track every later write. The row would drift from the node it mirrors.

### D2 — The Helmsman knows what waits, as data, briefly

**Options.**

- **(a) A section in the per-turn attention block.** `buildHelmsmanAttention` gathers it, and `renderAttentionContext` renders it (F11).
- (b) The same section on a conversation's first turn only.
- (c) A field on the system prompt or `SpaceContext`.

**Recommended: (a).** The operator asked for the opening turn. The attention block is what the opening turn reads, and it renders again on every later turn. A count fixed at the first turn would be wrong by the next approval.

**The section.** One heading line holds a count per kind. Under it are up to five lines, newest first, each with a title of at most 120 characters, the item id, and the plan link where the item is a plan step.

```
Waiting on a person: 3 plan steps, 1 run gate, 0 consents. Point with the plan link or `human.action_center.focus`:
- plan step "P1 — the source lists every waiting node" [itemId: plan-ask:<nodeId>] /s/<slug>/plan?node=<nodeId>
```

The kinds are fixed. Plan steps are items with origin `plan_ask` or `plan_decision`. Consents are `needs_oauth_consent`. Run gates are the other kinds in the approvals and inputs lanes. Coach proposals keep their own section (F12).

**The source of the counts.** The builder runs in the orchestrator (`apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/agentTurn.ts`), not the server. It counts plan steps from the walk `loadActivePlanTree` already makes, as two sets that match the sidebar's two origins. One is the nodes D1's predicate keeps, imported from `asks.ts`, and it leaves out `decide` nodes. The other is the open `decide` nodes under open branches, by the rule `listOpenDecisions` lists by (`plan/operations.ts`). Each set stops at its source's cap of 50. Where either set holds 50, the count gains a "+", by the sidebar's rule. The walk sees every waiting node, but the builder marks the cap and not the cut, so it reads as the sidebar reads. For one state of the tree, the Helmsman's plan-step count and the sidebar's count therefore agree, digits and "+" alike. Two limits bound that claim. The sidebar's count can lag the tree by one rebuild (F8). The list route returns at most 200 items (`routes/action-center.ts`), so the claim holds where the space holds 200 open items or fewer. It counts gates and consents with count queries over the tables their sources read (`pausedStepSource.ts`, `workflowHumanTaskSource.ts`, `workflowWriteApprovalSource.ts`, `workflowOAuthConsentSource.ts`, `computeEgressSource.ts`). It does not call the aggregator.

**The ceiling.** The section holds at most 500 tokens by `estimateStringTokens` (`packages/schemas/src/runtime/tokenEstimate.ts`). A test renders five lines with 120-character titles and the longest item ids, and fails above 500. The 120-character cut is a prompt budget, measured, and not a write validation.

**The measurement.** These figures come from `estimateStringTokens` over the rendered section.

| Section                                                                           | Characters | Tokens |
| --------------------------------------------------------------------------------- | ---------- | ------ |
| The ceiling test: five plan-step lines, 120-character titles, a 64-character slug | 1,682      | 481    |
| The example above: 3 plan steps, 1 run gate, 0 consents, one line                 | 301        | 86     |
| Nothing waits: `Waiting on a person: 0 plan steps, 0 run gates, 0 consents.`      | 59         | 17     |

The figure for one live space is not recorded yet. No stack ran where P2 was built, so no live space could be read. The P2 exit records it.

**Not consumed.** These lines are not `attention_items` rows. A turn does not consume them, and they show until the item resolves.

**Staleness.** A session's pause and its resolution bump the attention generation. The projection worker decides from the session row, not from the events it flushes (`movesSessionGate`, `ProjectionWorker.ts`). It reads the row's prior status, current step, pause type and parked operation under `FOR UPDATE` in the upsert's transaction. It bumps after the row is durable, and only when the row enters a pause the count can hold as a gate, leaves it, or stands at one on another step. `mayHoldSessionGate` (`sessionGate.ts`) names that rule, and `PAUSED_SESSIONS_SQL` reads the same one. A gate pause is the user executor's ask or approve, or a pause typed `oauth_consent` or `approval`. A parent paused `subflow_waiting` holds its child's bubbled pause, and the count lists it at each level of the chain, so its pause and its resume bump too. A chat turn waiting for its next message (`user_input`) and every other pause type move nothing. A workflow run's pause, resume and end bump it through `emitRunUpdated` (`runEvents.ts`). A compute-egress request bumps nothing, so its count can lag by the cache's 60-second lifetime (F11).

_Rejected:_ item bodies in the context. A gate's request or a plan step's note costs thousands of tokens, and the Helmsman only points.

_Rejected:_ a prompt paragraph telling the Helmsman to look in the Action Center. It holds no data, so the Helmsman would call an operation to count what the builder already knows.

_Rejected:_ (b). See the recommendation.

_Rejected:_ (c). The system prompt is the cached prefix. A count that moves with every item would invalidate it.

_Rejected:_ calling the aggregator from the orchestrator. The aggregator lives in `@aflow/server-runtime`, builds whole items with summaries, and projects them per reader.

### D3 — The Workbench's default state in the chat view

**Options**, each with lazy sections:

- (a) Open by default on desktop.
- (b) A collapsed rail with the count badge and a one-line peek of the first pending item.
- **(c) The last state, remembered per browser, open the first time.**

**Lazy sections.** On open, only **Needs attention** and recent conversations mount. Skills, Applets, Agents, Integrations and Coach mount on expand. Their headers show without reading. Recent conversations reads workflow names from the workflows list today (`Workbench.tsx`). Under lazy sections the board still reads that list on open, so the names hold.

**Recommended: (c) with lazy sections.** The operator who keeps it open gets it open. The operator who closes it is not overruled on the next landing. A phone keeps the chat first, because there the Workbench is a mode (`space-chat.tsx`). The bell's `?workbench=1` still opens it.

**The measure, so the operator decides on numbers.** P3 measures first, on the live stack, and records it here.

| Mount                 | Reads at mount today (F14)                 | With lazy sections                                                                                   |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Dock open             | at least 15 new, 4 shared, 2 subscriptions | 5 new (directives, cascade, workflow runs, invitations, one presence read), 3 shared, 1 subscription |
| Each section expanded | —                                          | its own reads from the table in F14                                                                  |

P3 also moves the two raw `fetch` reads onto `useApiQuery`, so a second open reads the cache (`CLAUDE.md`, _Client server-state_).

**The measured reads.** No stack ran where P3 was built, so these come from `space-chat.landing.test.ts`. It renders the whole chat page in jsdom on a desktop width and replaces only the network, the realtime client and the router. It counts every HTTP read and every realtime subscription. The page's own reads include the session list, the agents and the Action Center. The space holds the Helmsman and one conversation of the reader's, unless a row says it holds none. "Before" is the code at `9928b8c3`. "After" is this phase.

| Mount                                                        | Before: HTTP reads, subscriptions | After: HTTP reads, subscriptions |
| ------------------------------------------------------------ | --------------------------------- | -------------------------------- |
| New chat, dock closed (the landing before)                   | 11, 1                             | —                                |
| New chat, dock open at landing, the conversation 7 hours old | —                                 | 16, 2                            |
| New chat in a space with no conversation, dock open          | —                                 | 15, 2                            |
| The dock opened by hand on a new chat                        | +16 new, +2 new, 5 shared         | +5 new, +1 new, 4 shared         |
| A named conversation (`?session=`), dock closed              | 15, 4                             | 15, 4                            |
| A named conversation, dock open at landing                   | —                                 | 21, 4                            |
| The dock opened by hand in a named conversation              | +17 new, +1 new, 5 shared         | +6 new, +0 new, 4 shared         |
| The dock opened by hand in a space with no conversation      | +15 new, +2 new, 5 shared         | +4 new, +1 new, 4 shared         |

The delta of the default is the "after" rows against the closed rows. A new chat now lands with 5 more reads and 1 more subscription than it did. A named conversation that lands open costs 6 more reads and no subscription. Opened by hand before, the same dock cost 16 or 17 reads and up to 2 subscriptions.

The 6 new reads in a conversation are the budget's 5 and the workflows list: the directives (`GET /spaces/:id`), the cascade, the active workflow runs, the session invitations, one presence read and `/workflows?archived=true`. The board reads the list because recent conversations names runs by it and the folded Skills header badges only the runs of the skills it lists. A new chat has no cascade. A space with no conversation has no presence read. The subscription is the entity-events stream, which a named conversation's page already holds. The 4 shared keys are the Action Center, `/users/me`, the members and the Helmsman's session list. The budget names 3 shared. `/users/me` is the fourth, and a shared key costs no request. The local edition's space gate already holds the space-detail key, so there the directives read is shared too. The harness does not mount the gate and counts it new. A new chat lands within the budget's 5 new reads and 1 subscription. A named conversation lands one read past it in the harness and within it in the local edition.

**No new request, and no poll.** Each of the 6 is a read the page at `9928b8c3` made when its dock opened by hand, so the default issues no request the page did not issue before this phase. The Coach's state is not among them. `/cybernetic/active-surface` and `/anomalies` are read only once the operator expands **Coach review**, as the test asserts. An earlier build of this phase read the active surface for the folded header and read it again at the snapshot's `nextTimeDerivedChangeAt`. That was a poll of about 15 seconds on every open dock, back to back under client clock skew. It is gone. The folded header now holds no read and no timer. It follows the Coach from the entity-events stream the board's run feed already holds, as the folds below say.

**The rule: a tab reads on events or on the operator's action, never on a timer.** The operator set it for this phase. A timer that must stay is a reviewed exception, named here with its reason. The Workbench's default open carries no poll in any section, not only in the Coach header. `space-chat.landing.test.ts` holds the rule. It opens the dock on a new chat and in a named conversation, runs the clock forward an hour and counts every read. The sweep covered every component the open dock mounts: the inspector, **Pending**, the other sources' proposals, the folded headers and recent conversations. It also covered their hooks, the brokers and the query client. No component in it passes `refetchInterval` or reads at a time it computes. Its reads follow the entity-events stream, the Action Center stream or the operator's hand. The timers that remain are these, and none of them reads on a clock while the page is connected:

- The coalescing window (`use-coalesced-invalidation.ts`, 250 ms) opens on an entity event and refetches once for its burst. The event starts the read, and the window only folds a burst into one.
- The brokers' teardown grace (250 ms) releases a stream a remount would take again. It reads nothing.
- The reconnecting notice (`use-connection-notice.ts`) waits 3 seconds before it says the stream dropped. It reads nothing.
- **Reviewed exception: reconnect backoff.** The entity-events and Action Center brokers reopen a dropped stream after 1 to 30 seconds, for at most 8 attempts. The realtime client reconnects its socket the same way and pings it every 25 seconds to keep it open. A dropped stream sends no event, so only a clock can retry it. Each backoff starts on the drop and stops once the stream is back.
- **Reviewed exception: retry backoff.** The query client retries a failed read twice, or after the `Retry-After` a 429 names. A failure starts it, and it stops at the cap.
- **Reviewed exception, outside the dock: the orchestrator's health.** The composer's `ConnectionNotice` reads `/health/orchestrator` every 15 seconds (`use-orchestrator-health.ts`). An orchestrator that has stopped sends no event, and the API keeps the stream open without it. So only a read can say that no orchestrator takes what the operator sends. The interval is half the orchestrator's 30-second lease, so a faster read shows a lapse no sooner. The test above sees it and counts nothing else.

Every other timer under the inspector mounts only on the operator's action: the run surface's pause and usage refresh waves under an expanded run in **Skills**, the OAuth popup under **Integrations** and the session timeline's stream on its own tab.

**What the code does.** The rule is `workbenchOpenOnLanding` (`lib/workbench-dock-memory.ts`). A new chat lands with the dock open. A conversation lands with the dock open unless this browser remembers that the operator folded it there. The memory is a list of those conversations' ids in `localStorage`, newest first, at most 200. Each open and each fold the operator makes is written for the conversation it was made in. A fold made in a new chat carries to the conversation the chat becomes. A phone keeps the chat first, and `?workbench=1` still opens the dock. The page decides once the landing of D4 has decided, so the dock does not open for a new chat and then fold for the conversation the chat returns to.

This departs from (c) as written. (c) keeps one last state per browser. The commission for P3 asked that a new conversation always open and that a fold stay with its conversation, so the memory is per conversation. An operator who folds the dock in one conversation still lands open on the next new chat.

**The folds.** `WorkbenchLazySection` (`WorkbenchSection.tsx`) renders a header alone and mounts the section only on expand. Its header carries the toggle, and the section's own header carries it once mounted. Which sections are open lives in `useWorkbenchFolds`, per space, which `EntityChatInspector` holds above its tab panels. An inactive panel unmounts the Workbench, and a move to a space whose detail is not cached unmounts the inspector itself. So the record lives at module level, keyed by space, and outlives both within the page session. A return to the tab, to the space or to the phone's Workbench keeps what was open. A reload loses it. _Rejected:_ the folds in `localStorage` per space. That record survives a reload, but it writes state the operator did not ask to keep. It would also open sections that a rename has since replaced, since the record keys them by title. Which sections are open is a glance within one visit, unlike the dock's fold, which the operator sets as a habit for a conversation. **Pending**, proposals from sources other than the Coach and recent conversations mount on open. **Schedules**, **Skills**, **Applets**, **Agents**, **Integrations** and **Coach review** are folded. Schedules is not named above. It reads `/schedules/upcoming`, and that read would put a new chat at 6 new reads, past the budget. The folded Coach header counts the Coach's proposals from the Action Center the board holds. It shows **Reviewing** with its **Watch** link for a review the entity-events stream has seen start and not end (`coachReviewFromEntityEvents`, `lib/coach-review-events.ts`). An `entity.coach.activated` starts a review, and an `entity.coach.completed` from the same Coach session ends it. The run feed already holds that stream, so the header adds no subscription. A Coach session that fails, is cancelled or stalls sends no completion. The same stream carries its `entity.session.status`, which the projection sends for every top-level session as its status moves. So the session's newest status ends the review too, where it is `FAILED`, `CANCELLED`, `CANCELLING`, `STALLED`, `SUCCEEDED` or `PAUSED`. A record keyed by `SessionStatusSchema` places each status, so a status added there fails to compile until it is placed. The active surface calls a paused Coach stalled, so a pause ends **Reviewing** as well, and a later `RUNNING` brings it back. A review that began before the stream did, and a stall, show nothing on the folded header. The expanded section reads both from the active surface. An expand keeps the folded header's **Reviewing** until that read lands, so the section shows no Idle in the meantime. The folded header shows no **Stalled** of its own, because the active surface ends a stall after a window, and that end is a time no event says. The folded Skills header shows the running and paused badges a skill row shows, over the active runs the board already reads. It badges a run only where the expanded list shows its skill. One rule decides both (`skillsFromWorkflows` and `skillRuns`, `WorkbenchSkills.tsx`). The list holds the space's workflows less the platform's own and the purged, and a run counts where its workflow is in that list. So a run of a platform workflow, a purged one or one the list does not hold is on neither. Until the list lands, the header shows no badge, as the list shows no skill. Recent conversations names a run's workflow from the same list. The board reads that list on open and hands it to Skills, so expanding Skills does not read it again. The folded Schedules header counts the `trigger_armed` notices in the Action Center the board holds, as **N set up by an agent lately**. A notice stays for 7 days and can outlive its schedule, so the header says what an agent did and the expanded list says what still runs. The expanded list holds every upcoming schedule whoever created it, soonest first, so an operator-created schedule is listed without a notice. _Rejected:_ the list kept to agent-armed schedules, as an earlier round decided. The operator's own words overrule it. An upcoming schedule is what the section exists to show, whoever set it. _Rejected:_ a list filtered to the schedules the operator would act on. No field says which those are, and every guess would hide a schedule that still runs. The list shows the soonest 20 (`UPCOMING_SCHEDULE_LIST_LIMIT`). Nothing caps how many schedules an operator creates, so a line under the list counts the rest, as **N more upcoming on Triggers**. _Rejected:_ a cap no space can pass. No ceiling bounds the schedules a space holds, so any number could still hide one silently. The empty list reads **No upcoming schedules**, so the two lines do not contradict each other. The expanded Integrations header counts what needs setup (`countIntegrationsNeedingSetup`, `WorkbenchIntegrations.tsx`). That rule joins the integrations whose readiness asks for setup with the Action Center's connection requests, keyed so one integration counts once. The folded header counts the connection requests alone. The board holds that lane, and its stream moves it when a request resolves. Nothing refreshes the readiness reads while the section is folded, so a folded count joined from them would keep a setup the operator has since done. Applets and Agents ask nothing of the operator, so their folded headers carry nothing. `CyberneticProvider` reads the directives through `useSpaceDetailQuery`, and `EntityChatInspector` reads the cascade through `useApiQuery` under `['session', id, 'cascade']`.

_Rejected:_ (a) without memory. It overrules an operator who closed it on purpose, on every landing.

_Rejected:_ (b). The peek is a second rendering of the first item, beside the card that resolves it. The badge already carries the count.

### D4 — Where the chat route lands

**Options.**

- (a) Always a new chat, with recent conversations one click away. This is today.
- **(b) The last conversation, where it is recent and not ended, with New chat one key away.**
- (c) A remembered last session per browser, as `preferredSpaceSlug` remembers the space (F17).

**Recommended: (b).** The rule is work to build, not a switch to flip. The chat resumes the reader's newest conversation where all of these hold:

- The reader opened it (`createdBy`).
- Its status is not terminal.
- Its `lastActivityAt` lies within `CHAT_RESUME_WINDOW_MS`, six hours.

Otherwise the chat lands new, as today.

**What exists, and what P4 adds.** `autoResumeLatest` seeds only the first listed row (F16). It cannot apply the `createdBy`, status and six-hour tests. The list holds the space's newest 10 sessions, so it may omit the reader's own conversation. P4 adds one of two things. One is a read that returns the reader's own last active conversation with those tests applied. The other is `useChatSessionRuns` extended to apply the same tests to the reader's own conversations.

**The URL stays canonical.** The conversation's URL is `/s/<slug>/chat?session=<id>`, and resuming writes it with `router.replace` (F15). Back and forward keep the history the operator made, and the landing adds no entry. The commission named `/s/<slug>/sessions/<id>` as the canonical form. That route is the run's detail page (F15), and it does not change.

**New chat.** The header's **New chat** stays (`ChatHeader.tsx`). It gains the shortcut Ctrl+Shift+O, or ⌘+Shift+O on a Mac. P4 checks it against the composer's keys.

**What the code does.** It builds the second option. `useChatSessionRuns` takes `landing: { readerId, readerSettled }` in place of `autoResumeLatest`. It lands only on a bare arrival, by `pickLandingConversation` (`lib/chat-landing.ts`). That picks the newest listed session the reader created, whose status has not ended, and whose `lastActivityAt` lies within `CHAT_RESUME_WINDOW_MS`, six hours. With none, the chat lands new. `ENDED_STATUSES` derives from `SessionStatusSchema`. A record keyed by the enum places each status, so a status added there fails to compile until it is placed. `SUCCEEDED`, `FAILED`, `CANCELLED`, `CANCELLING` and `STALLED` have ended.

- **The source.** The list is the selected agent's session list, the Helmsman's by default, which the chat already reads at mount, so the landing adds no request. The reader is `/users/me`, which the page already reads. The browser stores no conversation id, as (c) would. The list holds the selected agent's newest 10 sessions in the space, so a reader whose conversation others' newer ones have pushed out lands new.
- **A bare arrival only.** The page passes `landing` only when the arrival URL carries none of the parameters the chat reads (`isBareChatArrival`, `CHAT_INTENT_PARAMS`): `session`, `agentId`, `sim`, `persona`, `baseline`, `draft` and `workbench`. Any of them opens what it names, so a rehearsal link keeps its persona and baseline pin and the landing never overrides intent the URL carries.
- **A failed list.** A session-list read that fails ends the landing on a new chat. The greeting or the empty state shows, and the Workbench opens as it does on any new chat.
- **Once per mount.** The landing decides once, for the first agent the chat selects. An arrival URL that names a session spends it. So **New chat** after a resumed landing, or after a deep link, stays new, and switching agents still starts a new conversation.
- **The URL.** Resuming sets the conversation, and the page's URL sync writes `/s/<slug>/chat?session=<id>` with `router.replace`. A reload or a shared link names the conversation, and the landing adds no history entry.
- **A missing conversation.** A `?session=` the list does not hold is read directly. A read that fails clears the parameter and lands on a new chat, with no error shown. The landing does not then resume another conversation, because the URL named one.
- **While it decides.** The page shows neither the greeting nor the empty states until the landing has decided, as it does for a named session. A space with no agent to answer still shows **No assistant yet**. It has no session list to wait on, so the dock lands there as on any new chat, open.
- **Not built.** The Ctrl+Shift+O shortcut is not built. **New chat** stays one click away.

_Rejected:_ (a). It is the round trip the operator described.

_Rejected:_ (c). A browser's memory outlives the conversation. A session ended elsewhere or hours old would come back. Under (b), the status and six-hour tests run at landing, on what the server reports of the session then.

### D5 — One vocabulary of states across the Action Center, the Workbench and the Plan page

**Options.**

- **(a) One label table in `@aflow/schemas`, beside the column ids.** `PLAN_BOARD_COLUMNS` keeps its colours and reads its labels from it. The server writes the item title from it.
- (b) One table in `plan-board.ts`. The server cannot import it, so the item title would keep its own copy.

**Recommended: (a).** Every surface reads one table, the server's item title included.

| Column, lane or place  | Today                  | State label                  | Orb (`StatusOrb.tsx`) and dot |
| ---------------------- | ---------------------- | ---------------------------- | ----------------------------- |
| `needs_you`            | Needs you              | Pending approval             | `paused`, warning dot         |
| reason `blocked`       | Blocked                | Approval                     | —                             |
| reason `decide`        | Decision               | Decision                     | —                             |
| reason `stranded`      | Under a closed step    | Under a closed step          | —                             |
| `in_flight`            | In flight              | Running                      | `running`                     |
| `up_next`              | Up next                | Queued                       | `idle`                        |
| `done`                 | Done                   | Done                         | `completed`                   |
| `dropped`              | Dropped                | Dropped                      | `inert`                       |
| Plan state `needs_you` | Needs you              | Pending approval             | warning dot                   |
| Header count           | 3 need you             | 3 pending                    | —                             |
| Empty lane             | Nothing waits on you   | Nothing pending              | —                             |
| Item title, blocked    | `Blocked: <title>`     | `Pending approval · <title>` | —                             |
| Item title, merge wait | `Judge merge: <title>` | `Pending review · <title>`   | —                             |
| Workbench section      | Needs attention        | Pending                      | the count badge               |

The Workbench section holds connections and inputs as well as approvals (F6). One word that fits them all is **Pending**, and each card says its own kind.

**Verbs stay on the controls.** **Approve**, **Decide**, **Drop**, **Reopen** and **Close done** are actions, and they keep their names.

**Icons over text.** A dense row shows the dot in the state's colour, with the label as its accessible name. A header shows the orb. The plan page keeps its dots (F19). P1 does not put an orb on every row, because each orb is an SVG the page loads.

**A merge wait keeps its column.** Its item reads **Pending review** (F20). The column rule does not change.

_Rejected:_ (b). See the recommendation.

_Rejected:_ renaming the column ids. The ids belong to the API and the tests, and only their labels read badly.

## 4. What it affects

- `@aflow/cybernetic-runtime`: `plan/asks.ts` (`listWaitingNodes`, `findWaitingNode`, the exported predicate), `plan/store.ts` (the walk's merge-wait flag), `attentionBuilder.ts` (the counts and the section).
- `@aflow/server-runtime`: `planAskSource.ts` (the listing, the resolve lookup, the title from the table), `routes/schedules/upcoming.ts` and `registerRoutes.ts` (`GET /v1/schedules/upcoming`, which replaces `GET /v1/schedules/chat`), `routes/schedules/list.ts` (the order and cursor of `GET /v1/schedules`), `triggerArmedSource.ts` (the notices alone).
- `@aflow/web-product`, the schedules round: `WorkbenchSchedules.tsx` and `use-space-schedules.ts` (the upcoming list and its count line), `space-triggers.tsx` (the expired rows behind **Show older**), `schedule-card.tsx` (the session links).
- `@aflow/schemas`: the label table, `PLAN_OPEN_ASKS_LIMIT` and `PLAN_OPEN_DECISIONS_LIMIT` in `operations/plan/schemas.ts`.
- `@aflow/web-product`: `app-shell.tsx` (the Plan count), `plan-board.ts` and the plan components (labels), `WorkbenchNeedsAttention.tsx` (**Pending**), `Workbench.tsx` (lazy sections), `space-chat.tsx` (the remembered dock state, the landing), `cybernetic-provider.tsx` and `entity-chat-inspector.tsx` (the two reads onto `useApiQuery`), `ChatHeader.tsx` (the shortcut).
- `@aflow/platform-artifacts`: `helpCenter/articles/concepts.ts` (the Plan entry's labels), `approvals.ts` (**Needs attention**, the Workbench's default, the landing) and `automation.ts` (the Schedules section).
- `docs/plans/332-the-plan-page-serves-the-operators-jobs.md`: §8 answered, and D5's rejection pointed here.
- Stored data: none. No migration, no new key, no new table.

## 5. How it is proven

Each case fails if the change is wrong.

- **No wake needed.** A space with no resident schedule creates a `blocked` node. The Action Center lists its item within one rebuild, and `counts.actionable` rises by one.
- **The record does not gate the list.** A blocked node whose ask record has lapsed is still listed.
- **The note is written once.** A wake over a listed node writes `Waiting on you:` once per revision, as today.
- **The cut.** A space with 60 blocked nodes and no open `decide` node lists the 50 newest, and the sidebar reads "50+". With two open `decide` nodes added, it reads "52+". A space with exactly 50 blocked nodes also reads "50+". In each case the Helmsman's heading shows the same plan-step count.
- **No stranded item.** An open node under a closed parent is not listed.
- **Resolve finds what list shows.** Approving a listed node that was never asked opens it.
- **The sidebar adds no request.** With the bell mounted, the Plan count adds no HTTP read.
- **The section's ceiling.** Five lines at the longest title and id render at 500 tokens or fewer by `estimateStringTokens`.
- **No body.** The section holds no item summary and no note.
- **The section moves.** After an approval, the next turn's count drops by one.
- **Lazy sections.** Opening the dock fires none of the integrations reads. Expanding Integrations fires them.
- **Memory.** Closing the dock and reloading lands collapsed. A new browser lands open.
- **The landing.** A conversation of the reader's, active two hours ago, opens on `/chat`. One active seven hours ago, one ended, or one another member opened, lands new.
- **History.** After the landing resumes, Back leaves the chat, as it did before.
- **One table.** Changing a label in the schema table changes the board, the overview, the item title and the Workbench.
- **Every upcoming schedule.** A schedule the operator created, due in one minute, is listed first in the Workbench's Schedules section. With 9 upcoming and 2 listed, the section reads **7 more upcoming on Triggers**.
- **A due schedule stays listed.** An active schedule whose firing was due 12 minutes ago has not fired yet. It leads the Workbench's Schedules section, and its line reads **due 12 min ago**, not **next due now**.
- **Expired rows fold.** A space with 49 expired renewals, one paused schedule and one active schedule shows the active and paused ones first on Triggers. Five expired rows follow, then **Show older (44)**.
- **The first page holds what runs.** A space holds three schedules that can still run and 120 expired renewals created after them. The Triggers page's first page of 100 lists all three before any expired row.
- **The session link.** A card links its armed session, else its last run. A card read beside the conversation its firing wakes says **Wakes this conversation** and links nowhere. No card links the conversation that created it.

## 6. Phases — proposed, built only after this document merges

**P0 — This document and its index row.** _Exit:_ the operator approves or amends §3.

**P1 — The item, the bell, the sidebar count and the vocabulary (D1, D5).** It holds the listing rule, the merge-wait flag, the resolve lookup, the two constants in the schema, the sidebar count, the label table and every label in D5's table. It updates the help articles and points Plan 332 §8 and D5 here. _Exit:_ on the live stack, the operator's three blocked steps show in the bell, under **Pending** in the Workbench and as the Plan entry's count, with no wake.

_Delivered (P1)._ The items below were built.

- **The listing rule.** `listWaitingNodes` and `findWaitingNode` in `plan/asks.ts` list by the exported predicate `isWaitingPlanNode`. The ask record does not gate them, and it still governs the walk's ask and its note line. The source lists at most `PLAN_OPEN_ASKS_LIMIT`, newest first by `updatedAt`, with ties by id.
- **The merge-wait flag.** The summary columns in `plan/store.ts` select `strpos(note, PLAN_NODE_MERGE_WAIT_LINE) > 0`, so the walk returns `mergeWait: true` on `PlanNodeSummary`. A node's children carry it too, from the same columns. The note itself stays in the row. `store.find` runs only for the listed nodes.
- **The schema.** `PLAN_OPEN_ASKS_LIMIT`, `PLAN_OPEN_DECISIONS_LIMIT`, `PLAN_STATE_LABELS` and `planItemTitle` live in `operations/plan/schemas.ts`. `planNoteHoldsMergeWait` lives beside the merge-wait line.
- **The labels.** `PLAN_BOARD_COLUMNS`, `NEEDS_YOU_REASON_LABEL`, `PLAN_STATE_LABEL`, `planHeader` and `PLAN_LANES` read the table. The header and the plan list name every column count by its column's label, such as "3 running" and "2 queued". The plan state `in_flight` reads **Running**, so the plan list and its columns agree. The item title is **Pending approval · …** or **Pending review · …**. The Workbench section is **Pending**.
- **A blocked root.** A node's own `blocked` status makes it a waiting node wherever states derive, by `planRootWaits` in the schema. `planRootState` reads `needs_you` for a blocked root with or without steps. `counts.needsYou` counts the root, and `steps` does not. The overview lists it in the `needs_you` lane with reason `blocked`, and `planCards` puts it first in its board's column. `listWaitingNodes` already lists it, because the walk reads the roots. Before this, a blocked root with no steps read `empty`, as node `0a16ef72` did on the live stack.
- **The sidebar count.** `usePlanPendingCount` and `PlanNavCount` read `useActionCenter`. The entry shows the count only where the active space is the route's space, so a space switch never shows the previous space's count.
- **Markdown.** A plan item's title and summary render as markdown on its card (`HitlResolution` takes `titleSlot` and `summarySlot`) and on every row of **Pending** (`ItemText.tsx`, `InlineMarkdown`). Items from other sources keep their plain text, because an underscore in an operation id is not emphasis. The sidebar entry shows digits and the word "pending", and no step text reaches it.
- **Tests.** `planWaitingNodes.test.ts` covers no wake, a lapsed record, the cut at 60 and at exactly 50, a stranded node and the merge-wait flag. `planStoreReads.pg.test.ts` covers the flag against Postgres. `planAskSourceWaiting.test.ts` covers approving a node that was never asked and the item title. `PlanNavCount.test.ts` shows the count adds no HTTP read beside the bell and rises by one on a rebuild. `plan-pending-count.test.ts` covers "50+", "52+" and exactly 50. `planVocabulary.test.ts` changes the table and reads the board, the overview, the item title and the Workbench. `ItemText.test.ts` covers markdown on the card and the Workbench rows.

- **Preview.** The review sees the items rendered on two pages. The first is the chat page with the Workbench open, `/s/<slug>/chat?workbench=1`, with a blocked step under **Pending**. The second is the Action Center as the header of another page shows it, such as `/s/<slug>/plan`: the bell with its count, which opens the first page, and the sidebar's Plan count. A space with one blocked step whose title holds markdown shows the item with its title rendered.

_Follow-up (P1), from the reviews of PRs #266 and #275._

- **The summary's cut.** `planItemSummary` ends a cut summary with the ellipsis a cut title ends with, so a long decision no longer ends silently. A cut in prose leaves no inline construct open, by the title's rule. The cut moves back to a point where none stands open only within the last 80 characters of the limit. Past that, it falls at the limit and escapes each opener left open, so a stray backtick, `<`, `[` or `*` costs a backslash and never the paragraph. A cut inside a fence closes the fence and puts the ellipsis on the line below it. Both plan sources call it, so a waiting node and a decision over one text cut at one place.
- **The "+" mark.** The Action Center cache records whether its list came from the stream's snapshot (`wholeOn` on the cached payload, `listIsWhole` on `useActionCenter`). The server builds the snapshot from source reads, and each source caps its own read. The route's limit of 200 does not cut it, so "whole" means only that no cut at 200 has happened. `planPendingCount` marks a cut at either source's cap always. It marks a list of 200 items only where the REST read stands, which the route may have cut. So a snapshot of 200 items or more shows no false "+". `wholeOn` holds the number of the stream that sent the snapshot. The broker's `currentStream` gives a new number on each disconnect, reconnect and new subscription. A REST refetch keeps the flag while that stream is still the one in use, since it has delivered every change since its snapshot. Otherwise the refetch is the newest read and replaces the flag. That covers a stream that is down, and a reconnected stream whose new snapshot has not yet landed. Whichever lands first decides, so a route-cut refetch is never marked whole. `keepWhole` in `action-center-cache.ts` decides it, and the query runs it as its `structuralSharing`, so every write to the key passes through it. The flag also drops where the refetch holds 200 items and fewer than the whole list held, which says the route cut it.
- **The focus note.** `ACTION_CENTER_FOCUS_CARD` in `operations/human.ts` names, by prefix, what the focused card can do. Only a proposal's card answers in chat. A plan step's card links to the plan page, and every other card points to Pending in the Workbench. `actionCenterFocusNote` writes the tool result's note from it, and `InlineFocusedItem` links to the plan by the same table. The agent is told to end its turn and wait only for a proposal. For every other card it is told the card has no answer control.
- **Tests.** `planAskSourceWaiting.test.ts` cuts prose, an inline construct and a fence through both sources and compares the two summaries. It also cuts a stray backtick, a `<` before a letter, an unbalanced `[` and an intra-word `*` at the limit with the opener escaped. `planStateLabels.test.ts` covers the same for a title. `planDecisionSource.test.ts` covers a goal cut with the ellipsis. `plan-pending-count.test.ts` covers no "+" on a snapshot of 250 items and a "+" at each source's cap. `humanActionCenterFocus.test.ts` covers the note for each prefix. `action-center-cache.test.ts` drives a bare QueryClient wired as the hook wires it. It covers the flag through the snapshot, `withItems` merges and removals, and a refetch with the stream up. It also covers a refetch with the stream down and a refetch the route cut. A route-cut refetch that lands after a reconnect but before the new snapshot drops the flag, and a snapshot that lands first keeps it. `action-center-broker.test.ts` covers a new stream number on a reconnect and on a resubscribe.

**Open:** the phase exit on the live stack.

**P2 — The Helmsman knows what waits (D2).** It holds the counts, the section and the ceiling test, and records the measured tokens in D2. _Exit:_ asked "is anything waiting on me?", a Helmsman names the count and points at the plan link without a tool call.

_Delivered (P2)._ The items below were built.

- **The section.** `waitingOnPerson.ts` in `@aflow/cybernetic-runtime` holds the data, the reads and the rendering. `buildHelmsmanAttention` gathers it into `waitingOnPerson`, and `renderAttentionContext` renders it after the plan. The heading counts plan steps, run gates and consents. Up to five lines follow, newest first. Each line holds a title cut to 120 characters, the item's `[itemId: …]` and, for a plan step, `/s/<slug>/plan?node=<nodeId>`. A count that fails to read is named as unread, never shown as zero.
- **The plan-step count.** `loadActivePlanTree` returns the tree and the waiting steps from its one walk. `selectWaitingNodes` (`asks.ts`) and `selectOpenDecisions` (`operations.ts`) are the rules the two plan sources list by, and the builder calls the same functions. `pendingPlanStepCount` in `@aflow/schemas` turns the two sets into the count, and the sidebar's `planPendingCount` reads it too.
- **The gate and consent counts.** `readWaitingGates` reads the five sources' tables in one transaction. It returns a count per kind and the newest five rows of each, and it never calls the aggregator. Postgres reads a paused request's kind from the payload its ref holds inline. So a conversation waiting for its next message counts as no gate. A consent that a workflow run owns counts once, under the run.
- **Shared with the sources.** `ACTION_CENTER_ITEM_ID_PREFIX` names each source's id prefix. `humanRequestTitle`, `oauthConsentTitle`, `writeApprovalTitle`, `pausedRequestTitle` and `computeEgressTitle` give each item its title. The sources build their items from these, and the section names an item by the same id and title.
- **The builder's size.** `attentionBuilder.ts` stood two lines under its large-file tolerance. The anomaly reads move unchanged to `attentionAnomalies.ts`, which makes room for the section.
- **Tests.** `waitingOnPerson.test.ts` covers the ceiling, the pointer line, the count at 49, 50 and 52 waiting nodes against the sidebar's rule, the absence of any summary or note, and the drop after an approval. `waitingOnPersonGates.pg.test.ts` covers the gate and consent counts against Postgres and the drop after an approval.

**Where the counts may differ from the Action Center.** These are deliberate, and each is small.

- A parent paused `subflow_waiting` holds its child's ref, and `pausedStepSource` lists it by the child's request. The count reads that request's kind from the paused child holding the same ref, down the chain to a depth of 10. A chain whose child row is gone, holds another ref or runs deeper is not counted.
- A consent run counts among the newest 200 runs paused `needs_oauth_consent`, the window `workflowOAuthConsentSource` cuts before it drops a run with no consent. A run whose resume contract is stored outside its ref counts unread, so a stored contract with no consent still counts.
- A compute-egress request does not bump the attention generation, so its count can lag by the cache's 60 seconds (F11). A session's pause or its resolution bumps it at the row's `PAUSED` edge, and a workflow run's transition bumps it through `emitRunUpdated`.
- The section counts the five sources this plan names. Session invitations, browser handoffs and integration-host requests also sit in the approvals and inputs lanes, and they are not counted.

**Open:** the measured tokens of one live space in D2, and the phase exit on the live stack.

**P3 — The Workbench's default (D3), the measurement first.** It records the measured reads of both columns of D3's table first. It then builds the lazy sections, the remembered state and the two reads onto the cache. _Exit:_ the operator reads the numbers and keeps or changes the recommendation. The dock then opens as decided. _Exit, the schedules round:_ on the live stack, the operator opens **Schedules** in the Workbench a minute before the Local PR Shepherd fires. The Shepherd leads the list and stays listed while its firing is due. On Triggers it sits above every expired row, and its card opens the session its firing runs.

_Delivered (P3)._ The commission for P3 took D4's resume rule and window into this phase. The items below were built.

- **The measure.** D3 records the reads before and after, from `space-chat.landing.test.ts`. A new chat lands within D3's budget, so the default shipped. A named conversation lands one read past it in the harness, for the workflows list. Every read the open dock adds is one the dock made before this phase. No folded header reads or holds a timer, and the open dock reads nothing on a clock. D3 names the reviewed exceptions.
- **The folds and the cache.** Six sections fold behind `WorkbenchLazySection`. The directives and the cascade read through the query cache. D3 says which mount on open.
- **The default.** `workbenchOpenOnLanding` opens the dock on a new chat, and a fold the operator makes stays with its conversation in this browser. D3 says how.
- **The landing.** `pickLandingConversation` and the `landing` option of `useChatSessionRuns` return the reader to their last conversation within six hours. D4 says how.
- **The escape pair (from the review of PR #287).** `inlineMarkdownCut`'s escape path cut at the raw budget, so a cut between a backslash and the character it escapes left a lone backslash before the ellipsis. `outsideEscapePair` (`vocabulary.ts`) now moves that cut back one character. An even run of backslashes pairs with itself and keeps its cut.
- **Help.** `approvals.ts` says the Workbench opens on a new chat, keeps a fold per conversation, and folds its inventory. It also says where **Chat** lands. `automation.ts` says **Schedules** starts folded.
- **Help, the wording round.** `approvals.ts` says an opened section stays open across a switch of the inspector's tabs, per space, until a reload. It also says the section stays open across a move to another space and back, and across the phone's Chat | Workbench toggle. It quotes the folded Schedules header as **N set up by an agent lately** and the empty list as **No active schedules set up in chat**. `automation.ts` quotes the same two lines and names the link **Triggers**.
- **Tests.** `workbench-dock-memory.test.ts` covers a new conversation landing open, a remembered fold for an existing one, the phone and the memory's limit. `chat-landing.test.ts` covers the window's edge, an ended conversation, `CANCELLING` included, every status of the enum and another member's. `coach-review-events.test.ts` covers a review's start and end by session. `space-chat.landing.test.ts` renders the page. It covers the dock open on a new chat, in a space with no agent too, a remembered fold, a fold written by hand and the phone. It also covers the 6 reads an open dock adds and Integrations read only on expand. The folded Skills header badges live runs and leaves a platform workflow's run out. The folded Coach header shows a review the entity-events stream starts and drops it when it ends, with no read. The folded Schedules header says an agent set one up from a `trigger_armed` notice, with no read. The folded Integrations header counts a connection request with no read. Folded again after an expand, it counts the connection requests alone, and it drops a request the stream resolves. `WorkbenchIntegrations.test.ts` counts an integration once when it is unready and asked for. The Coach's state is read only once **Coach review** expands. An expand under **Reviewing** keeps it, with its **Watch** link, until the active-surface read lands. For the landing it covers a conversation 2 hours old resumed by replace, one 7 hours old, another member's, and a missing `?session=` falling back to a new chat. `planStateLabels.test.ts` cuts a title at the ceiling among escaped stars and among escaped backslashes.
- **Tests, the fold memory.** `space-chat.landing.test.ts` expands **Integrations**, switches to **Session timeline** and back, and finds the section still open. It also unmounts the page, lands in the same space again and finds the section open. Its folded Schedules case expects **1 set up by an agent lately**.
- **The upcoming schedules.** `GET /v1/schedules/upcoming` (`routes/schedules/upcoming.ts`) replaces `GET /v1/schedules/chat`. It lists the space's active schedules with any next firing and no end behind, soonest first, whoever created them. A due or late firing stays listed and leads the list. It answers the soonest 20 and a `total` of every upcoming schedule. The Workbench's Schedules section reads it through `useUpcomingSchedules` and counts what the cap leaves out. D3 says why.
- **The Triggers page expander.** The page lists the schedules that can still run first. It shows the 5 most recent expired ones below them, and **Show older (N)** opens the rest. A renewing cron leaves an expired row behind per renewal, so that list grows without end. _Rejected:_ every row, unbounded. The operator's own complaint was too many rows, and 49 expired ones buried the schedule that mattered. _Rejected:_ pages of expired rows. Paging is heavier than one expander for the common case, a handful of expired rows.
- **The Triggers page's first page.** `GET /v1/schedules` (`routes/schedules/list.ts`) orders every row that can still run before the expired ones, each group newest first. The page reads its first 100 rows. Ordered by creation alone, expired renewals filled that page, so the schedules the count line sends the operator to could be missing. A row can still run where it is paused, or active with no end behind. That rule matches `scheduleState` on the page. The cursor carries the row's group, its creation and its id. _Rejected:_ a limit that skips expired rows. The page would then never show the expired rows that **Show older** opens.
- **The schedule-card session links.** A card links the armed session its firing wakes, else the session its last firing ran (`scheduleRunSession`, `schedule-card.tsx`). The links read **Open the armed session** and **Open the last run**. Where that session is the conversation beside the Workbench, the card says **Wakes this conversation** and links nowhere. The conversation that created a schedule is never the link. _Rejected:_ a link to the conversation that created the schedule. The operator asked for the session that will run, and a firing does not run there unless it is also the target. That conversation is also often the page the operator is reading.
- **Help, the schedules round.** `automation.ts` says the Schedules section lists every upcoming schedule, soonest first, with the count line and the session link. It quotes the empty list as **No upcoming schedules**. `approvals.ts` says the open section lists the schedules the operator created, and quotes the same empty list.
- **Tests, the schedules round.** `upcomingRoute.test.ts` covers the tenant and space scope, a creator-blind condition, the order, the cap and the count read under the same condition. `listRoute.test.ts` covers the list's order, its cursor and a refused cursor. `list.pg.test.ts` puts 120 expired renewals after three rows that can still run, and finds all three first on a page of 100. `schedule-card.render.test.ts` covers the Triggers expander, the session links, the operator-created row and the count line.
- **The due schedules (the fourth schedules round).** `GET /v1/schedules/upcoming` asked for a next firing after now, so a schedule disappeared from the section in the minute it was due. The evaluator had not yet claimed that firing, and a schedule whose evaluator lags stayed hidden for as long as it lagged. The read now asks for any next firing, so a due or late schedule leads the list. A fired one-shot and a chain at its end leave `active`, so they stay out. _Rejected:_ a grace window after the firing time. Any window hides a schedule that lags past it, and that schedule needs the operator most.
- **The status line.** The card's timing line said **due now** for any firing in the past, and the Workbench's line read **next due now**. A firing a minute or more late now reads **due 12 min ago** or **due 3 h ago** on both surfaces, and a due one drops **next**. A firing seconds ahead reads **in 1 min**, where it read **in 0 min**.
- **Tests, the fourth schedules round.** `upcomingRoute.test.ts` covers the condition with no lower bound on the next firing and a due row listed first. `schedule-card.render.test.ts` covers the due, late and hours-late lines in the Workbench, the late line on Triggers and a firing seconds ahead.
- **Preview.** The chat page, `/s/<slug>/chat`, shows both. A new chat lands with the Workbench open, **Pending** on top and the inventory folded. In a space where the reader spoke in the last six hours, `/s/<slug>/chat` returns to that conversation and the address gains `?session=<id>`.

**Open:** the measured reads on the live stack, and the phase exits of P3 and P4 there.

**P4 — Where the chat lands (D4).** It holds the resume rule, the window constant and the shortcut. It builds the read or the hook extension that D4 names. _Exit:_ on the live stack, the operator moves from the Plan page to Chat and back, and lands in the conversation they left. P3 built the rule, the window and the hook extension. The shortcut is left.
