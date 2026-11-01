# Plan 339 — The loop moves on events

**Status:** decisions settled, phases built and merged, live exits open. This document is P0, approved and merged as PR #268. P1, the push-time merge, is built and merged as PR #274, and the refusal codes it starts from remain to be read. P2, the wait primitive and the pull request event source, is built and merged as PR #277, and its live exit is open. P3, the shepherd on events with the schedule as the fallback, is built and merged as PR #285 (merge 610b911b), and its live exit is open. P4, D6's approval gate, is built and merged as PR #276, and its live exit is open.

**Builds on:** Plan 331 (the resident, its wake on a run's end and its pending mark, D8's rule on the folder), Plan 321 (the Local PR Shepherd, its rules, its turn and its hand-over), Plan 315 (the local loop, D15's merge round, the push's own scan), Plan 180 (background work is declared and candidate-driven), Plan 337 (the decision card), Plan 333 (D2's writing rules).

**Leaves alone:** the shepherd's rules and what each decision does, the folder's push approval and when it asks the operator, the secret scan's rules and the range it reads from the measured base (D3 changes what the push sends and which checks' receipt it accepts), the merge round as Plan 315 D15 built it, the resident's board order, Plan 331 D8.

## Decision card

**What changes**

- Today: the loop moves on a clock. A schedule fires the shepherd every five minutes, and a person relays every other signal by hand.
- After: the loop moves on events. A Helmsman, a Runner or a skill waits on the event it needs, and the event wakes it.

**Why**

- 440 shepherd runs have fired since midnight, against 77 publications and 61 commissions.
- Two runs fire every five minutes whether or not a pull request is open.
- With four pull requests open, a green one waited up to twenty minutes for its turn.
- Two publications of one branch were approved and then failed at the push, after `main` moved in the twenty-five minutes between the scan and the push. The refusal's exact cause is uncertain (§2), and P1 reads it before it builds. Each failure cost a merge round of about thirty minutes.
- A person relayed every signal the loop needed: a run ending, a pull request going green, merging or conflicting, a node changing status, a gate resolving.

**What it affects**

- `apps/aflow-executor-host`: the push merges a cleanly mergeable `origin/<base>` before git pushes (`scanReceipt.ts`, `checkReceipt.ts`, `baseMerge.ts`).
- `@aflow/platform-artifacts`: Local Publish's push task and its failure text, the shepherd's schedule text and its start on an event.
- `@aflow/schemas`: the event kinds, the waiter's shape, a background task in `background/registry.ts`.
- `@aflow/cybernetic-runtime`: the wait primitive, built on the run waiters that exist (`ledger/waiters.ts`).
- `apps/aflow-orchestrator`: the pull request event source and the fallback sweep's due check.
- `docs/dev/driving-work-through-the-loop.md` and `docs/architecture/background-work.md`.
- The operator, who stops relaying signals between conversations.

**Risks**

- A merge made at push time puts a commit on the branch that the folder's checks did not run on. Mitigation: git makes it only where it has no conflict, CI runs on the pull request, and the shepherd merges only on green.
- A missed event leaves a waiter asleep. Mitigation: every wait has a window, and the fallback sweep still fires.
- The pull request source spends GitHub's rate limit. Mitigation: it asks only about the loop's open pull requests, and it asks conditionally.
- Two waiters act on one pull request. Mitigation: the shepherd's branch lease stays, so the second acts on nothing.
- The two failed publications may have met a refusal D3 does not remove (§2). Mitigation: P1 reads their refusal codes before it builds anything.

**Open questions**

- Which package owns the wait primitive? Recommended: the runtime exposes the wait, and the schemas package declares the event kinds.
- What emits the folder's head moved event? Recommended: a background poll under Plan 180, candidate-driven like the pull request source.
- What wakes a waiter whose event fired before it started waiting? Recommended: the primitive records the event and wakes the waiter at once.
- Do the folder's checks run again on the merge the push makes? Recommended: no. The checks' receipt covers the branch's commit, and CI runs on the merge.

**Not done on purpose**

- No webhook. The machine sits on a private network and takes no inbound calls.
- The shepherd's rules do not change. Only what starts a pass changes.
- The fallback schedule is not deleted.
- No event replaces the operator's approval of a push, or a merge card the space asks for.
- The resident's heartbeat cadence (Plan 331 D1) does not change here.

**Done when**

- The operator approves or amends §3 from this card and the decisions under it.

## 1. Problem

The loop moves on a clock, and where no clock reaches, it moves on a person.

The figures are from the operator's space on 2026-10-31, counted from midnight:

- 440 Local PR Shepherd runs fired, against 77 Local Publish runs and 61 commissions. That is close to six shepherd runs for every publication.
- Two runs fire every five minutes whether or not a pull request is open. A stretch with nothing open still spends them.
- With four pull requests open, a green one waited up to twenty minutes for its turn. A pass tends one pull request, and the next pass tends the next one.
- Two publications of one branch were approved to publish and then failed at the push. `main` moved during the twenty-five minutes between the scan and the push. Each failure cost a merge round of about thirty minutes.
- Every signal the loop needed was relayed by hand. A run ending, a pull request going green, merging or conflicting, a node changing status and a gate resolving each reached the next conversation because a person carried it there.

The clock is the only way the loop knows to wait. A cadence asked of a model is a poller, and a poller spends a run on every tick whether or not anything happened.

## 2. What the code shows today

The facts come from reading the code at `cdcd00be`.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **The shepherd fires on a five-minute cron.** `SHEPHERD_SCHEDULE_CRON_DEFAULT` is `*/5 * * * *` (`packages/schemas/src/operations/pullRequestShepherd.ts`). A firing starts the Local PR Shepherd agent, which starts a pass (`packages/platform-artifacts/src/skillCatalog/localPrShepherd.ts`).                                                                                                                                                                                                                                    |
| F2  | **A pass aimed at no pull request tends one, in turn.** `localPrShepherdTurn.ts` records the pull request the last such pass tended in `shepherd/<owner>/<repo>/turn.json`, and the next pass tends the one after it. With four open and a five-minute cadence, a pull request waits up to four passes. A pass aimed at one pull request takes no turn.                                                                                                                                                                              |
| F3  | **Nothing ahead of a shepherd firing asks whether a loop pull request is open.** The schedule evaluator runs a due check ahead of the model only for a resident schedule (`isPlanResidentSchedule`, `orchestrator.resident_due_check`). A shepherd firing starts its agent whatever is open.                                                                                                                                                                                                                                         |
| F4  | **A pass hands a case it cannot act on to a Helmsman through a one-firing schedule** (`localPrShepherdHandOver.ts`). That is the one path today on which a pull request's state reaches a Helmsman without a person.                                                                                                                                                                                                                                                                                                                 |
| F5  | **The push reads `origin/<base>` again, just before git runs.** `rangeToPush` in `apps/aflow-executor-host/src/scanReceipt.ts` measures the base. Where it moved and the commit still merges into it, the push scans the new range and pushes the commit unchanged, without the base in it. Where `merge-tree` reports a conflict, the push refuses with `base_conflicts` and names the merge round as the remedy.                                                                                                                   |
| F6  | **The checks' receipt binds one commit.** `checkReceipt.ts` refuses a push whose checks did not pass on exactly the commit pushed, against the measured base or one under it. A merge commit made at push time would carry no receipt of its own.                                                                                                                                                                                                                                                                                    |
| F7  | **Two space-level events exist.** `entity.run.updated` (`packages/cybernetic-runtime/src/runEvents.ts`) fires on every run status transition. `entity.plan.updated` (`packages/cybernetic-runtime/src/entityEvents.ts`) fires after a plan node write commits. Both go to the space's entity event stream (`packages/redis/src/entityEvents.ts`), kept to about 10,000 entries for seven days, with a publish for live subscribers in the same transaction. No event exists for a pull request, a gate resolving or a folder's head. |
| F8  | **A conversation can already wait on one run.** `workflow.run.start` with `wait: 'none'` registers the conversation in `workflow_run_waiters` (`addWaiter`, `packages/cybernetic-runtime/src/ledger/waiters.ts`), and the run's pauses and end reach it as events. `emitCatchupToNewWaiter` (`workflowRunProgress.ts`) gives a late waiter the run's state as it stands. This is the one wait the platform has, and its only subject is a run.                                                                                       |
| F9  | **A resident wake follows a run's end only for a run a wake started.** `workflowCrud/run/start.ts` writes `wakeSessionId` into the run's metadata only where a scheduled wake started it for a node. `wakeResidentOnRunEnd` (`apps/aflow-orchestrator/src/services/cybernetic/harness/planLinks.ts`) wakes the resident for that run and for no other. A run a conversation started is that conversation's to answer.                                                                                                                |
| F10 | **Background work is declared and candidate-driven.** Every stateful background task is registered in `packages/schemas/src/background/registry.ts`, and its idle cost may not grow with tenants or stored keys (Plan 180, `docs/architecture/background-work.md`). `host.browser_requests` is a precedent for a poll that reads nothing while it has no candidate.                                                                                                                                                                  |

F5 bears on the fourth figure of §1. The code pushes over a base that moved and still merges cleanly. It refuses where `merge-tree` reports a conflict, where the base was rewound, or where a receipt is missing. The two failed publications may therefore have met one of those refusals rather than a clean moved base. P1 reads their refusal codes before it builds anything (§5).

## 3. Decisions

### D1 — One wait primitive

A Helmsman, a Runner or a skill waits on a declared event, and the event wakes it. The waiter names what it waits on, never a cadence.

The event kinds are at least these:

- `run.ended`: a run reached a terminal status. Its subject is the run.
- `plan.node.status_changed`: a plan node's status changed. Its subject is the node.
- `pull_request.changed`: a pull request's checks went green, it merged, it became conflicting, or a review requested changes. Its subject is the pull request, and the event names which of the four happened.
- `gate.resolved`: an Action Center item was resolved. Its subject is the item.
- `folder.head_moved`: a connected folder's head moved. Its subject is the folder's binding.

A wait names the kind, the subject and a window. It ends when a matching event arrives or the window closes, whichever comes first. The waiter learns which of the two ended it. The run waiters of F8 become one case of this primitive, with `run.ended` as their kind, rather than a second mechanism beside it. The two entity events of F7 feed it, and the new kinds join the same stream.

A woken waiter acts on the event by its own rules. The wait delivers the event and decides nothing.

_Rejected:_ more schedules with shorter windows. A cadence asked of a model is a poller, not a wait. It spends a run on every tick, and a shorter window spends more of them.

### D2 — A pull request event source on the machine

A registered background task polls only the pull requests the loop has open, and emits `pull_request.changed`. It is candidate-driven under Plan 180. The publication that opens a pull request arms it as a candidate. The merge or the close of that pull request clears it. When no loop pull request is open, the task runs nothing.

Each poll is a conditional request. The task keeps the `ETag` of each answer and sends it back as `If-None-Match`. GitHub's documentation says a `304 Not Modified` answer to an authorised conditional request does not count against the primary rate limit. A poll that finds nothing new should therefore spend nothing against it. The proposed cadence is 60 seconds, and P2 measures it before it is settled.

The task is registered in `registry.ts` with its owner, invariant, trigger, budgets and recovery, as every background task is. Its idle cost is zero requests. Its working cost grows with the loop's open pull requests, not with spaces or stored keys.

_Rejected:_ a webhook. The machine sits on a private network and takes no inbound calls.

### D3 — The publication's push takes a cleanly mergeable base itself

At push time, where `origin/<base>` has moved and git merges it into the commit without conflict, the push merges it and pushes the merge. Only a true conflict becomes a merge round. The push makes the merge as Plan 315 D15 makes a commission's merge: `--no-ff`, under the operator's commit identity, with the same pins, so it is a function of its two parents.

The merge adds no line that is in neither parent. The push already scans the range from the measured base (F5), so after the merge that range holds the branch's commits and the merge commit. The checks' receipt (F6) is for the branch's commit. The push accepts it for a merge whose first parent is that commit and whose second parent is the measured base, and records that it did. CI then runs on the merge, and the shepherd merges only on green. The fourth open question asks whether the folder's checks should run on the merge instead.

_Rejected:_ a re-scan and a re-approval before the push. They repeat the round the merge removes, and each repeat leaves the base time to move again.

### D4 — The shepherd becomes what the owner of a pull request does on its event

The pull request event goes to the pull request's owner. The owner is the Helmsman conversation that started the publication that opened it. Where that conversation has ended, or none started it, the owner is the resident. On the event, the owner runs a shepherd pass aimed at that pull request, which takes no turn (F2). The shepherd's rules decide as they do today:

- Checks green and the head merges: merge it.
- Conflicting: commission the merge round.
- Merged: close the plan step, and move the folder where the folder's merge is not the operator's.
- Changes requested or a red check: the fix the rules choose today.

A folder whose merge is the operator's stays theirs, as the shepherd's rules and Plan 331 D8 already hold.

A pull request has one owner, and one record names it: the pull request's watch. Its events go to the conversation that record names, and nothing else decides who owns them. After a hand-over, the record moves with it or the hand-over defers to the record, never both. While the recorded owner can act, the hand-over defers to it and starts no conversation. An owner can act while it has neither ended nor failed. Where it cannot act, the hand-over starts a conversation, and the record moves to that conversation when it publishes the branch. From then on, that conversation hears the pull request's events. A publication never takes the record from an owner that can act, so two conversations never own one pull request.

The schedule stays as a fallback sweep for pull requests no conversation owns, such as those of a space with no resident. It fires rarely, at a proposed hourly cadence. A due check ahead of the model reads the loop's open pull requests, as the resident's due check reads the board (F3). With no loop pull request open, the firing is recorded as skipped and starts nothing.

_Rejected:_ keeping the round-robin schedule as the primary. It is the 440 runs the problem records.

### D5 — A waiter with a shorter window overrides the schedule

A Helmsman that expects a signal soon waits on it rather than on the next tick. While a waiter holds a pull request with a window shorter than the sweep's, the sweep passes that pull request over. When the window closes with no event, the waiter is woken and told so, and it reads the pull request itself.

_Rejected:_ raising the schedule's frequency. It spends runs whether or not a signal comes.

### D6 — Approval is a decision gate, not the default

A person relayed every node change because work waited on approval by default. Three rules make approval a gate the operator meets only at a decision.

**Rule 1 — a node's first status is data.** `PLAN_NODE_FIRST_STATUS_RULE` in `@aflow/schemas` (`cybernetic/plan.ts`) holds the rule the planning skill (Plan 329) writes by. The Helmsman and the resident read it through `plan.node.create`'s `work` field and the card's `waitsOn`, not through prose in a prompt.

- Active, for approved work in the queue: a phase of a plan the operator approved or wrote (`approved_phase`), a defect fix such as CI red, a regression or a loop defect (`defect_fix`), or a follow-up for findings a review carried (`findings_follow_up`).
- Blocked, only for a decision that is the operator's: a design decision (`design_decision`), a new plan's design document (`design_document`), a change to a decision in a plan document (`decision_change`), anything that touches policy, egress, write authority or confinement (`authority`), or a question the card marks as the operator's (`operator_question`).

A blocked kind needs the card's `waitsOn`, and the schema refuses one without it. A node whose card names `waitsOn` starts blocked, its note opening with `Waiting on you:` and the decision. The carrier a done-close writes for open findings (Plan 331 D6) reads the same rule and starts active. Where a resident wake wrote the close, the carrier stays blocked and proposed, so a resident wake never creates active work.

**Rule 2 — the card carries the reason a node waits.** `waitsOn` names the reason and the decision it asks. The rail offers **Approve** only on a blocked step whose card names it, and shows the decision above it. A node whose card names no waiting reason never shows Approve. A live check keeps **Approve** whatever its card holds, because its open write is no resume: it closes the check done as the operator’s read of the folder’s head. Any other blocked step that names none, such as a stop, offers **Resume**, the same open write with no decision asked. Every label is the same control, so Resume keeps the instructions field and **Revise** beside it. A lane row of the overview offers no Approve, because it carries no card.

**Rule 3 — a finished root asks for nothing.** A root whose steps have all closed reads `finished` and offers Close plan, whatever status it was created with. It stands in no Needs you column or lane. The Action Center lists no item for it, and no resident wake asks about it.

This amends Plan 322 D2, which names a node's first status, and Plan 331 D5, which names a proposal's blocked status and a root's waiting state.

_Rejected:_ the default-blocked rail of today. Every blocked step showed Approve, whatever it waited on, and a blocked root read as waiting after its work had finished. The operator approved work they had already approved, and the loop stopped at each such step until a person came. An approval that asks no decision is a relay, which is what this plan removes.

_Not done on purpose:_ a resident wake still creates only blocked work, and a defect fix it finds is a proposal. Whether it may start one active is a change to write authority, so the rule itself makes it the operator's decision. A proposal written without `waitsOn` stays blocked and offers Resume rather than Approve, and keeps Revise. The Action Center item's own **Approve** label is left as it stands.

## 4. What it affects

- `apps/aflow-executor-host`: `scanReceipt.ts` merges a cleanly mergeable base in `rangeToPush` rather than pushing the commit unchanged. `checkReceipt.ts` accepts the branch commit's receipt for that merge. `baseMerge.ts` makes the merge with D15's pins (D3).
- `@aflow/platform-artifacts`: Local Publish's push goal and failure text name the merge (D3). The shepherd's schedule text names the fallback sweep and its cadence (D4). The Helmsman's `usage` text names the wait (D1).
- `@aflow/schemas`: the event kinds and the waiter's shape (D1), the pull request source's registration (D2), the sweep's cadence default (D4).
- `@aflow/cybernetic-runtime`: the wait primitive, which generalises `workflow_run_waiters` and its catch-up (D1), and the owner's wake on a pull request event (D4).
- `apps/aflow-orchestrator`: the pull request event source (D2), and the sweep's due check in the schedule evaluator (D4).
- `@aflow/redis`: the new kinds on the entity event stream (D1).
- Stored data: the waiter's record gains a kind and a subject beside the run. The pull request source keeps a candidate set and an `ETag` for each candidate. Their lifetimes are stated where they are built.
- `docs/dev/driving-work-through-the-loop.md`: what the loop waits on, and what the operator no longer relays.
- `docs/architecture/background-work.md`: generated again from the registry.
- D6: `@aflow/schemas` (the first-status rule, the card's `waitsOn`, `planStepsAllClosed` and the root's waiting rule), `@aflow/cybernetic-runtime` (`createPlanNode`, the carrier, the board's state and the Action Center's waiting list), and `@aflow/web-product` (the rail's Approve and Resume, the overview's rows).

## 5. Phases

Each phase lands on its own.

**P0 — This document and its index row.** _Exit:_ the operator approves it, or amends it and then approves it.

**P1 — The push-time merge (D3).** P1 is the smallest phase and the most valuable. It starts by reading the refusal codes of the two failed publications (§2, below F10). Where both were `base_conflicts` over a true conflict, D3 does not remove them, and the plan says so before P1 is built. _Exit:_ a publication whose base moves without conflict between its scan and its push pushes a merge that holds the base, and no merge round runs. A base that conflicts still refuses with `base_conflicts`.

_P1 as built:_ `mergeBaseIntoCommit` (`baseMerge.ts`) writes the merge's tree with `merge-tree` under D15's pins and commits it with the branch's commit as first parent and the measured base as second. `rangeToPush` scans the range to the merge, and the push sends the merge in place of the commit. `checkReceipt.ts` accepts the commit's receipt for that merge only. The push's output records `baseMerge` and, where the folder declares checks, `checkedMerge`. The refusal codes of the two failed publications were not readable from the commissioned checkout, which reaches no run record. They remain to be read before this phase is taken as removing them.

**P2 — The wait primitive and the pull request event source (D1, D2).** _Exit:_ a Helmsman waiting on a loop pull request's checks is woken within one poll cadence of their going green. With no loop pull request open, the source makes no GitHub request in an hour. Over a day with the loop running, the source's `304` answers spend none of the primary rate limit, read from `x-ratelimit-used`.

_P2 as built:_ `workflow.wait` declares a wait for the conversation that calls it, by a kind, a subject and a window. The Helmsman holds it pinned, and its `usage` names the wait in place of a schedule. `appendEntityEvent` records each wait event in the transaction that appends it (`packages/redis/src/waits.ts`). A wait counts from its declaration, because one subject fires many times. A wait that names `since` catches up: an event recorded since then ends it at once, in its own declaration. Its usage tells the model to pass `since`, because each event fires once, on a change, and one fired before the declaration is otherwise missed. `orchestrator.wait_delivery` posts each ended wait to its conversation's room and wakes a conversation that rests at its prompt. A window that closes with no event wakes its waiter the same way and says the window closed. A subject keeps its recent events, so a waiter is told every change that fired before its wait was claimed. An event arms its subject for delivery only where a waiter holds it. A claimed wait stays in a delivery set under a lease until its delivery settles it, so a process that dies mid-delivery leaves it for a later cycle. A conversation mid-turn when its outcome lands is woken for it when that turn settles. A cold conversation is restored from its snapshot only where no hash has come back first. `entity.run.updated` feeds `run.ended`. A plan write that changes a node's status now carries both statuses and feeds `plan.node.status_changed`. The Action Center's resolve emits `gate.resolved`. `orchestrator.pull_request_events` polls the pull requests Local Publish has opened. A publication's end arms its pull request, and the pull request's merge or close clears it. Each read sends back the ETag of the answer before it, with the token of the space's GitHub binding. Where the check runs are none or more than one page, green is read from the head's combined commit status. A change whose event did not land is saved with the poll's reads and sent again at the next poll, and the changes that landed are not. A poll that fails leaves the watch's lifetime as it stands, so a watch whose polls keep failing lapses after fourteen days. Its tests run an hour of cycles with no loop pull request open and count no GitHub request. Three things are not built. `folder.head_moved` is withdrawn, its wait kind, its entity event and its emitter with it, until the second open question decides what emits it: a wait on a kind nothing emits could end only when its window closed. A skill's task cannot wait, because `workflow.wait` is not on the task-safe inline list. The run waiters of F8 stay beside the primitive rather than inside it. The 60-second cadence and the `x-ratelimit-used` reading are not measured, and the live exit is open.

**P3 — The shepherd on events, with the schedule as fallback (D4, D5).** _Exit:_ over one working day with the loop running, no shepherd firing starts a run while no loop pull request is open. Shepherd runs stay within the pull request events plus the sweep's firings. No person relays a pull request's state to a conversation.

_P3 as built:_ the publication's arm records the pull request's owner, the live Helmsman conversation that started it, and the folder it pushed from. A later publication of the branch names its conversation the owner only where none is recorded, or where the recorded owner has ended or failed. The owner and the folder live in a holder record apart from what the polls save. Arms and disowns change it in one script each, and a saved poll only renews it. The arm declares the owner's wait on `pull_request.changed`, flagged as the owner's, with a 24-hour window. Its delivery tells the owner to run a shepherd pass aimed at the pull request with `bindingId` and `pullNumber`. Once the pull request has merged, the owner closes the plan step and moves the folder where the merge is not the operator's. Each delivery declares the next wait from just past the last event it told. An event in between ends it at once, and its registration queues it in the delivery set under the same lease and retry. A window that closes on the owner's wait posts nothing and declares the next one from the window's close, so an event recorded before the renewal still reaches the owner. An owner that has ended, or whose conversation is gone, is forgotten. Its liveness is read before any wait it holds, so an ended owner with an open wait is forgotten too. A wait kept for an earlier owner is dropped, and one already ended tells that conversation nothing. `SHEPHERD_SCHEDULE_CRON_DEFAULT` is hourly. `orchestrator.shepherd_sweep_due_check` reads the space's open loop pull requests before a firing of the Local PR Shepherd agent. A pull request is attended where the recorded owner has neither ended nor failed and holds its wait, or where another waiter's window closes before the next sweep (D5). A due check that fails lets the firing start. A firing with no unattended pull request starts nothing and spends none of the firing cap. It counts the skip under the schedule's `metadata.sweep`, apart from the resident's `metadata.overlap`. Only a cron firing is checked, so a one-shot schedule of the agent always fires. Each saved poll renews the space's index of open loop pull requests with its watch, so the due check sees every watch the source keeps. An owner the arm cannot read is recorded as none, so the pull request is still armed and the sweep tends it. The four lines of the node's card are settled, each with a test. A hand-over reads the record through `workflow.run.list` with `startedByActingOwnerOf`, which lists the publications of the branch the recorded owner started while it has neither ended nor failed. It defers while one exists or the read fails. No claim is taken, and a pass after the owner has ended or failed hands the case over. A failed owner thus holds the branch for nobody, in the sweep and in the hand-over alike. A pass publishes only where a remedy moved the head, and a second pass over the same red head acts on nothing. Every coding agent a pass starts is a `host.harness.run`, which the machine's cap of two counts. The hand-over brief carries no kept session, and tells the Helmsman to start every commission fresh and never to publish a red, unmoved head as it stands. `WORKFLOW_TASKS_MAX` rises to 72 for the owner's read and its judgement. Four things are not built. The resident does not take over an ended owner's pull requests: the sweep tends them. A sweep that starts tends the loop's pull requests in turn, attended ones among them, because the schedule cannot aim its pass. A red check fires no event, so the sweep or a pass aimed at the pull request finds it. The day's count of shepherd runs and the time from green to the merge request are not measured, and the live exit is open.

**P4 — Approval as a decision gate (D6).** _Exit:_ on the operator's space, a day of the loop's work in which no step that asks no decision waits on the operator, and no finished plan asks for approval.

_P4 as built:_ the three rules of D6, each with its test. `planFirstStatus.test.ts` starts each approved kind of work active and each decision blocked, and refuses a decision whose card names none. `plan-board.test.ts` and `space-plan.test.ts` show Approve only with the decision the card names. `planTrees.test.ts` and `planStream.test.ts` read a root whose steps have all closed as `finished`, with no Action Center item and no ask. The Action Center learns which roots have finished from one overview read, made only where a blocked root is listed, never from a walk for each item. `planStream.test.ts` keeps the carrier of a resident wake’s done-close blocked. The live exit is open.

## 6. How it is proven

- **P1:** a fixture repository whose `origin/main` gains a commit that does not conflict, between the publication's scan and its push. The push succeeds, and the pushed head's second parent is the measured base. This fails today, because the push sends the commit without the base.
- **P1:** a second fixture whose new commit conflicts makes the push refuse with `base_conflicts`. That case fails if the merge swallows a conflict.
- **P1:** the merge's tree equals the tree `merge-tree` writes for the same parents. That case fails if the push's merge differs from the one D15 makes.
- **P2:** a waiter registered after its event fired is woken at once. That case fails where the primitive serves only live subscribers.
- **P2:** a waiter whose window closes with no event is woken and told that the window closed. That case fails where a lost event leaves a waiter asleep.
- **P2:** the source's request count over an hour with no loop pull request open is zero. That case fails where the task scans rather than reads its candidates.
- **P3:** the count that opens §1, taken again on a day of comparable work. The plan is wrong if shepherd runs do not fall below two for every publication.
- **P3:** with four loop pull requests open, the time from one going green to its merge request is within one poll cadence plus the pass. The plan is wrong if it stays near twenty minutes.
