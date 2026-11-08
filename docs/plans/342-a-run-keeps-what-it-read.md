# Plan 342 — A run keeps what it read

**Status:** built. The tiers below are what `apps/aflow-executor-ai` runs.

**Builds on:** Plan 196's retention plan, which defined the tiers, and Plan 189, which defined clear-to-ref notes. Both predate the published archive, which starts at Plan 315. This document restates Plan 196's §4 as it now stands and keeps its section numbers, so the `§4.x` references in `exchangeClearing.ts`, `retentionPolicy.ts`, `conversationStateStore.ts`, `compaction.ts` and `agentTurn.ts` land here.

**Leaves alone:** the working budget and its trigger points, the protection classes, the note format, resurrection detection and the summarizer model.

## Decision card

**What changes**

- Today: a long run turns its own older results into stubs every turn once history holds 200 atoms, and compaction then summarises the stubs.
- After: pressure clearing takes only large results of finished runs outside the recency floor. The run and every small result leave history through compaction, unless the prompt would not fit the model.

**Why**

- In one long conversation, history held exactly 200 atoms for four turns in a row. The forced pass cleared exchanges at every one of them.
- 619 exchanges were cleared over the conversation, and 54 of them were read again after clearing.
- The fifth compaction took 200 atoms to 7, but most of those atoms were already stubs. The summary could not keep facts the stubs no longer held.
- An 800-byte result could be replaced by a stub nearly its size, because the net-savings bar was twice the note's own size.

**What it affects**

- `apps/aflow-executor-ai`: the retention policy, both clearing paths, compaction range selection, the summarizer prompt and the turn's retention ladder.
- `@aflow/schemas`: the default summary sections, the conversation state's compaction block, and the `inputOrigin` on a message atom and its history ref.
- Every agent conversation, the Helmsman's included.

**Risks**

- A single run may outgrow the hard budget. Its own recent results then become stubs, and the agent may read them again. Mitigation: compaction runs first, and only the hard-budget pass may take them.
- The hard budget may still bind once every unpinned exchange is cleared. Mitigation: the turn logs `agent_turn_structural_bound_unrelieved`, and the next turn compacts again.
- Compaction costs a summarizer call where clearing cost none. Mitigation: it fires at the same pressure bar as before, and at the structural cap.
- A result just under the size threshold stays verbatim longer. Mitigation: compaction takes it with its turn once it is older than the floor.

**Open questions**

- Is flash-lite good enough for the new template? Recommended: keep it until a compaction of a real run shows a lost fact.

**Not done on purpose**

- `MAX_ATOMS_STRUCTURAL` stays 200. It bounds state size and assembly cost, and reaching it now triggers compaction instead of clearing.
- The summarizer model does not change. No measured failure of flash-lite has been shown.
- Notes written before this change stay as they are.

**Done when**

- No turn clears an exchange because of the atom count.
- No exchange created since the latest direct request is cleared, except by the hard-budget pass. A run wakeup or a room message moves neither the run nor its pin.
- Every compacted read path reaches the agent through the restore list or the summary.
- No result under the size threshold becomes a stub, except by the hard-budget pass.
- A prompt still over the hard budget after compaction is cleared oldest first, the recency floor and the current run included. The current turn's pinned atoms stay.
- A run of tool calls compacts to a summary that keeps what was read, what was decided and what is left pending.

## 1. The problem

An operator who gave the Helmsman a long task watched it forget what it had just read. It read a file, acted on it, and a few steps later read the same file again. In one long conversation it read 54 results a second time. Each repeat cost a step, and the operator paid for the same tokens twice.

The agent lost a result while it was still working on the operator's request. Once a conversation grew long, every step replaced the oldest results with short notes, results of the request in hand included. A note names the call and where its result is stored. It does not say what the result held.

When the conversation was condensed into a summary, the summary was written from those notes. The facts the agent had read, what it had decided and what it had left open were gone. An operator who then asked what the agent had found got an answer the agent could no longer support. Section 4 restates the retention tiers behind this, in the code's terms.

## 2. Decisions

**D1 — one recency floor, and one path that may breach it.** `RECENT_TURNS_FLOOR` is 8, in `retentionPolicy.ts`. Tier-2 clearing and compaction read it as `keepRecentTurns`. The hard-budget pass (§4.7) is the only path that may clear inside it. Rejected: a second, shorter floor for a forced pass. Two floors let a forced pass take what the agent was still using.

**D2 — pressure clearing never takes the current run.** The current run starts at the latest direct request (§4.10). An exchange whose first atom sits after it is never a Tier-2 candidate. Compaction relieves the run instead. Rejected: clearing the run's large results after compaction at any pressure. Compaction already takes them with their turns, and their read paths survive as active refs.

**D2b — a report never starts a run.** A run wakeup or a room message is a `user_input` atom stamped with its `inputOrigin`. A `user_input` atom without one is a direct request, and only a direct request moves the current run's start and its pin. Rejected: reading the origin from the source id's prefix. The history refs retention reads carry no source id, and a prefix match ties retention to how two writers spell their ids.

**D2a — two forced passes with two candidate sets.** The structural-cap pass honours the floor and the current run. Its remedy is compaction of the older range, and it clears nothing. The hard-budget pass runs after pressure clearing and compaction, when the prompt is still over the hard budget. It may clear any exchange without a pinned atom, oldest first, the floor and the current run included. Rejected: one candidate set for both. A single run whose last 8 turns exceed the hard budget would then shrink by nothing, and the provider would refuse the request.

**D3 — only large results clear to a ref.** `LARGE_RESULT_MIN_TOKENS` is 2,000 tokens, about 7 KB. Every result of a cleared exchange must reach it. `MIN_CLEAR_NET_SAVINGS_TOKENS` is 1,500, the absolute floor under the old twice-the-note rule. Rejected: a per-exchange total. It would stub a small result that shares an exchange with a large one.

**D4 — the cap triggers compaction.** `MAX_ATOMS_STRUCTURAL` stays a fixed state-size bound. Reaching it triggers compaction, and `forceClearExcess`, the hard-budget pass, takes only a token excess. Rejected: a budget-derived atom bound. Atoms vary from a few tokens to thousands, so an atom count says nothing a token budget does not already say.

**D5 — compaction selects atoms, not turns.** An exchange with any atom outside the range leaves it whole. The rest of its turn stays in. Rejected: selecting whole turns. A turn holds one call and the result of the call before it, so every turn of a tool chain shares an exchange with the next. A range that drops each turn holding a straddling exchange then drops the whole chain, and a run of tool calls never compacts.

**D6 — the summary is a session summary.** The default sections are Objective, What Was Read, What Was Decided, What Was Done, Left Pending and Mistakes & Lessons Learned. The transcript is labelled by turn and names each result's tool, status and re-read path. Rejected: a larger summarizer model. Nothing measured shows flash-lite losing facts from a raw transcript.

**D7 — each read path has one owner.** The restore lists the newest 40 active refs, and the summary carries every other path. `splitActiveRefOwners` makes that split for both the restore and the summarizer prompt, so they never disagree. Rejected: telling the summarizer to leave out every active ref. The restore lists only 40, so an older path then reached the agent nowhere.

## 3. What it affects

`history.maxAtomsStructural` keeps its default. `compaction.lastCompactedTurn` leaves the conversation state schema, and compaction no longer writes it. Nothing read it: a compacted atom has left history and cannot be selected again. A stored state that still carries the field parses, because the schema strips unknown keys.

A message atom and its history ref gain an optional `inputOrigin`, `run_wakeup` or `room_message`. A state stored before it reads every `user_input` atom as a direct request, as retention read them until now.

## 4. The retention tiers

### §4.1 Tier-0 pins

Pinned atoms are never cleared or compacted. They are the opening `user_input` atoms, the latest direct request (§4.10), the latest `compaction_restore` and every atom of the current turn. `computePinnedAtomIds` derives the set at evaluation time.

### §4.2 Low pressure

Below `clearHighWater` (0.55 of the working budget) nothing is cleared. Verbatim, cache-stable history wins.

### §4.3 Tier-2 clearing and the savings ledger

Above `clearHighWater`, `clearUnderPressure` clears greedily until estimated pressure reaches `clearLowWater` (0.4). Candidates are ranked by protection class, then by net savings, then oldest first. A candidate must save more than `minClearNetSavings`: twice its note, and never less than `MIN_CLEAR_NET_SAVINGS_TOKENS`.

A candidate must hold all of these:

- It carries a tool result and has not been cleared before.
- None of its atoms is pinned.
- Every turn it spans is older than `RECENT_TURNS_FLOOR`.
- It was created before the current run started, when there is a current run (§4.10).
- Every one of its results measures at least `LARGE_RESULT_MIN_TOKENS` as sent (§4.4).

### §4.4 Clear-to-ref notes and the size threshold

A cleared exchange becomes one in-position note of at most `noteMaxTokens` (200). The note names each call, its arguments and its status, and the read pointer to the stored result where a read op is on the surface. Tier-2 never replaces a result under `LARGE_RESULT_MIN_TOKENS` by a note. Such a result leaves history through compaction, with its turn, or through the hard-budget pass (§4.7).

### §4.4a Idempotency classes

The protection class comes from the catalog's `idempotency` for the envelope's `operationId`. Idempotent results clear first, then unknown, then non-idempotent, then failed. Resurrected exchanges clear last.

### §4.5 Note placement

A note is a user-role atom placed at the cleared assistant turn's slot.

### §4.6 Resurrection

A new call matching a cleared call's arguments, or a read of a cleared output's path, marks its exchange resurrected. The counters are logged with every clearing pass.

### §4.7 Tier-4 structural bound

After Tier-2, the turn runs compaction when any of these holds. The log names the first that holds, in this order:

- `hard_budget`: pressure after clearing exceeds the hard budget.
- `pressure`: pressure after clearing exceeds `compactHighWater` (0.7 of the working budget).
- `structural_cap`: history holds more atoms than `MAX_ATOMS_STRUCTURAL` (200).

The working budget never exceeds the hard budget, so `hard_budget` is tested first. Tested after `pressure`, it could never be named.

The structural-cap pass is compaction alone, and it clears nothing. Its compaction honours the recency floor. It never clears the current run, but its compaction may take the current run's atoms older than the floor (§4.8). A cap compaction cannot relieve stays logged until a later compaction relieves it.

The hard-budget pass runs only if pressure still exceeds the hard budget after compaction. `forceClearExcess` takes its own candidate set, `hardBudgetClearableExchanges`: every uncleared exchange with a tool result and no pinned atom. The recency floor, the current run and the size threshold do not bind it, so the current turn's pinned atoms are all that stay. It clears oldest first until the estimated saving covers the excess, and any clear that saves tokens counts. It is the only path that clears inside the floor. A failed forced write fails the step, retryable. If the cap or the hard budget still binds, the turn logs `agent_turn_structural_bound_unrelieved`. No turn clears an exchange because of the atom count.

### §4.8 Tier-3 compaction

Compaction selects every unpinned atom older than `RECENT_TURNS_FLOOR`, the current run's included. An exchange with any atom outside that set leaves the range whole. It needs `minCompactableTurns` (3) content turns. The range's atoms are archived and replaced by one restore atom, placed in the last compacted atom's slot.

The restore holds verified state and the summary. Verified state is the objective, the latest sub-goal, written variables and active refs. Active refs include each compacted result's read path and each swept note's pointer. The restore lists the newest 40 refs, and the summary carries the rest (D7). The summarizer prompt names the restore's 40 as paths the summary leaves out. It names every other path as one the summary must copy verbatim. A merge leaves out a path its existing summary already holds, so that list holds only paths that have just left the restore. The summarizer is `compactionSummaryModel` (flash-lite). Its transcript is labelled by turn, and it shows each result's tool, status, re-read path and summary. It shows each decision's text and calls, and marks notes as stubs.

### §4.9 Honest degrade

When no read op is on the turn's tool surface, notes and restores omit the read promise. Clearing then protects each exchange one class harder.

### §4.10 The current run

The current run is everything after the latest direct request: a `user_input` atom without an `inputOrigin`. A run wakeup or a room message arrives while a request is in flight. It never moves the start or the pin, so the request's own turns stay out of Tier-2 and the request stays out of compaction. A history without a direct request has no current run, so `currentRunStartIndex` returns -1 and Tier-2 excludes nothing on this account. No exchange of the current run is a Tier-2 candidate. Pressure inside the run is relieved by compaction of its turns older than the floor. Only the hard-budget pass (§4.7) may clear an exchange of the current run.

## 5. Phases

One phase, built. Its exit is the Done-when list above, each item held by a test.

## 6. How it is proven

`currentRunRetention.test.ts` holds the cases that fail if the change is wrong:

- The recency floor holds on the pressure path. The hard-budget pass clears inside it, oldest first.
- Pressure clearing takes no exchange created since the latest `user_input`. The hard-budget pass takes them, and keeps the current turn's pinned atoms.
- A history without any `user_input` has no current run. Pressure clearing still takes its exchanges older than the floor.
- Above the compaction bar, the turn compacts the current run from raw results and creates no stub.
- Over the hard budget, the turn compacts first, names the trigger `hard_budget`, and then clears inside the floor and the current run.
- An 800-byte result is never stubbed by pressure clearing, and a large one still clears to a note with its read pointer.
- An over-cap history at low pressure is compacted, and no exchange is cleared. With a current run, the floor's exchanges stay verbatim and the hard-budget pass never runs.
- The summarizer prompt asks for what was read, decided and left pending, and its transcript carries those facts.
- A run of tool calls compacted by the turn sends the next request a restore with that summary and every compacted read path, with no stub.
- An unbroken chain of tool calls compacts up to the floor, and keeps the straddling exchange whole.
- A run wakeup and a room message mid-request leave the current run starting at the request. Pressure clearing takes none of its turns, and compaction keeps the request.
- Every compacted read path has one owner, the restore list or the summary. A merge hands over only the paths that have left the restore list.

`retentionSafetyBound.test.ts` holds the pins under maximal hard-budget pressure, the archive trace and the fail-closed forced write. `retentionPressure.test.ts` and `compactionAlignment.test.ts` hold the class order and the compaction alignment.
