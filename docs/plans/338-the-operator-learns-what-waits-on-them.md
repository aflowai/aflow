# Plan 338 — The operator learns what waits on them

**Status:** P0 merged. P1 built: the listing rule, the merge-wait flag, the two caps in the schema, the sidebar count, the label table and the help articles. P2 to P4 are not built.

**Builds on:** Plan 331 (D3.3, the asked-once rule, and the resident), Plan 332 (the overview, the column rule of D4, the open question of §8), Plan 337 (the decision card, written here by hand because 337 P3 is not merged), Plan 333 (D2's writing rules).

**Leaves alone:** every plan status and the column rule that places a step, the asked-once record and the note line it writes, the stream walk, the Action Center's resolve paths, `human.action_center.focus`, the session URL.

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
- `@aflow/server-runtime`: `planAskSource.ts` lists and resolves by the new rule, and the item title changes.
- `@aflow/schemas`: one table of state labels beside the plan column ids.
- `@aflow/web-product`: the sidebar's Plan count, the Workbench's default state and lazy sections, the chat's landing, the labels on the Plan page and in the Workbench.
- `@aflow/platform-artifacts`: the help articles `concepts.ts` and `approvals.ts`.

**Risks**

- A space with many blocked proposals fills the approvals lane. Mitigation: the source lists at most 50, newest first, and the Plan page holds the rest with its total.
- The attention block grows on every turn. Mitigation: the section has a measured ceiling of 500 tokens, and it carries titles and ids only.
- An open Workbench mounts at least 15 reads that the chat does not hold today (§2, F14). Mitigation: only two sections mount on open, and P3 measures before it changes the default.
- Landing on the last conversation may surprise an operator who wanted a new one. Mitigation: the window is six hours, an ended conversation is never resumed, and **New chat** stays one click and one shortcut away.

**Open questions**

- Does a stranded step, open under a closed parent, become an item? Recommended: no. Approving it changes nothing (Plan 332 §1). The Plan page keeps it under its own reason.
- Does the attention block list items that belong to another conversation? Recommended: yes, as titles and ids to point at. The Helmsman only points, and pointing resolves nothing.
- Does the Workbench remember its state per space or per browser? Recommended: per browser. The operator moves between spaces in one browser and expects one habit.
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

The facts below come from reading the code at `c04f0c9d`. Plans 160, 228 and 288 are not in this repository (`docs/plans/README.md`, _The earlier archive is not published_). This document cites the code that carries their rules instead.

## 2. What the code shows today

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **The Action Center lists asked nodes only.** `planAskSource.ts` (`packages/server-runtime/src/services/actionCenter/sources/`) lists `listAskedNodes` from `packages/cybernetic-runtime/src/plan/asks.ts`. That function keeps a node only where `isAsked` finds its revision in the Redis record `plan:resident:asked:…`. The list holds at most `PLAN_OPEN_ASKS_LIMIT`, 50, in tree order.                                                                                        |
| F2  | **Two places claim an ask.** The board walk `nextOnPlanBoard` in `plan/stream.ts` calls `claimAsk` for a node it answers `ask`. The close path in `plan/operations.ts` calls `claimAsk` when a merge is not attested. No other code writes the record.                                                                                                                                                                                                                               |
| F3  | **The walk runs only on a wake.** `requestResidentWake` in `plan/resident.ts` returns `no_resident` where the space has no resident schedule. A node that a Helmsman creates `blocked` is then never asked, and F1 never lists it.                                                                                                                                                                                                                                                   |
| F4  | **An ask record lapses.** `PLAN_ASKED_TTL_MS` is seven days (`asks.ts`). A node asked once and not answered leaves the Action Center when the record lapses, until a wake asks again.                                                                                                                                                                                                                                                                                                |
| F5  | **The item answers with two verbs only.** `planAskSource.resolve` accepts `approve` or `reject`. It opens the node, drops it, or closes a merge it judged. No free text reaches the resident. Plan 332 D5 rejected a Workbench item per blocked step because a free-text answer might read as a grant of scope. That concern does not arise for this item.                                                                                                                           |
| F6  | **The item lands in the approvals lane.** `planAskItem` sets kind `human_approval`. `partitionLanes` in `use-action-center-lanes.ts` puts it in `approvals`. `counts.actionable` adds approvals, inputs, connections and Coach proposals (`use-action-center.ts`). The Workbench's **Needs attention** shows connections, approvals and inputs (`WorkbenchNeedsAttention.tsx`, citing Plan 228 §3.1).                                                                                |
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

**The ceiling.** The section holds at most 500 tokens by `estimateStringTokens` (`packages/schemas/src/runtime/tokenEstimate.ts`). A test renders five lines with 120-character titles and the longest item ids, and fails above 500. P2 records the measured number of one live space here. The 120-character cut is a prompt budget, measured, and not a write validation.

**Not consumed.** These lines are not `attention_items` rows. A turn does not consume them, and they show until the item resolves.

**Staleness.** A gate or a consent does not bump the attention generation. The cache's 60-second lifetime bounds how long its count can lag (F11).

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

**Lazy sections.** On open, only **Needs attention** and recent conversations mount. Skills, Applets, Agents, Integrations and Coach mount on expand. Their headers show without reading. Recent conversations reads workflow names from the workflows list today (`Workbench.tsx`). Under lazy sections it shows the slug until Skills has loaded the names.

**Recommended: (c) with lazy sections.** The operator who keeps it open gets it open. The operator who closes it is not overruled on the next landing. A phone keeps the chat first, because there the Workbench is a mode (`space-chat.tsx`). The bell's `?workbench=1` still opens it.

**The measure, so the operator decides on numbers.** P3 measures first, on the live stack, and records it here.

| Mount                 | Reads at mount today (F14)                 | With lazy sections                                                                                   |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Dock open             | at least 15 new, 4 shared, 2 subscriptions | 5 new (directives, cascade, workflow runs, invitations, one presence read), 3 shared, 1 subscription |
| Each section expanded | —                                          | its own reads from the table in F14                                                                  |

P3 also moves the two raw `fetch` reads onto `useApiQuery`, so a second open reads the cache (`CLAUDE.md`, _Client server-state_).

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
- `@aflow/server-runtime`: `planAskSource.ts` (the listing, the resolve lookup, the title from the table).
- `@aflow/schemas`: the label table, `PLAN_OPEN_ASKS_LIMIT` and `PLAN_OPEN_DECISIONS_LIMIT` in `operations/plan/schemas.ts`.
- `@aflow/web-product`: `app-shell.tsx` (the Plan count), `plan-board.ts` and the plan components (labels), `WorkbenchNeedsAttention.tsx` (**Pending**), `Workbench.tsx` (lazy sections), `space-chat.tsx` (the remembered dock state, the landing), `cybernetic-provider.tsx` and `entity-chat-inspector.tsx` (the two reads onto `useApiQuery`), `ChatHeader.tsx` (the shortcut).
- `@aflow/platform-artifacts`: `helpCenter/articles/concepts.ts` (the Plan entry's labels) and `approvals.ts` (**Needs attention**, the Workbench's default, the landing).
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

**Open:** the phase exit on the live stack.

**P2 — The Helmsman knows what waits (D2).** It holds the counts, the section and the ceiling test, and records the measured tokens in D2. _Exit:_ asked "is anything waiting on me?", a Helmsman names the count and points at the plan link without a tool call.

**P3 — The Workbench's default (D3), the measurement first.** It records the measured reads of both columns of D3's table first. It then builds the lazy sections, the remembered state and the two reads onto the cache. _Exit:_ the operator reads the numbers and keeps or changes the recommendation. The dock then opens as decided.

**P4 — Where the chat lands (D4).** It holds the resume rule, the window constant and the shortcut. It builds the read or the hook extension that D4 names. _Exit:_ on the live stack, the operator moves from the Plan page to Chat and back, and lands in the conversation they left.
