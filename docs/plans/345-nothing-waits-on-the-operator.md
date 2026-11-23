# Plan 345 — Nothing waits on the operator

**Status:** A, B, C and D built in one change. Three exits on the live stack are open, and the Proof section names the same three. D's exit is first: Full Circle and Trading Joe answer `full` after a raise on a message the operator sent. A's exit depends on it: the bootstrap PR merges, and the next green `comment` pull request of Full Circle merges with no Action Center item. B's exit depends on it too: Trading Joe's first run after the Plan 343 merge starts on the new bundle version with no click. Both read `full`, so neither can pass before D's.

**Builds on:** Plan 321 (D6, the shepherd's merge), Plan 253 (the write approval), Plan 315 D22 (the push gate), Plan 330 (Store readiness), Plan 333 (D2's writing rules).

**Leaves alone:** the secret scan and its asks, a folder's push approval `always`, the operator's own word at a push approval, a person's GitHub review requesting changes, the high-tier write gate, the eval plane (operator-owned by CLAUDE.md), the hosted coding lane's skills.

## The rule

The operator's standing rule, 2026-11-21 19:15Z, verbatim: "absolute autonomy please.. nothing waits on me." Their one remaining act is supplying secrets through Settings → Credentials. The rule is data: the space setting `autonomy` (D). No prompt carries it.

## Decision card

**What changes**

- Today: a `comment` review verdict sends a green pull request's merge to the operator. A Store install waits on ratification, and only the operator applies an update. Every merge waits on a medium-tier write approval.
- After: under `autonomy: full` a `comment` verdict merges. `store.listing.install` installs, `store.listing.update` updates, and a space following the catalog takes each update itself. A medium-tier write is not gated unless the write policy gates it.

**Why**

- PR #348 (comment verdict, CI green) sits on the operator today, and #344 did before it.
- Trading Joe needed two Store clicks today, and Plan 343 needs another before Monday 2026-11-23 08:30 ET.

**What it affects**

- `@aflow/schemas`: `models/spaceAutonomy.ts` (the setting, its meanings, the spent directive's record and its two conversation record types, the autonomy's clock and `nextSpaceAutonomyPolicy`, `effectiveSpaceWritePolicy`), `space.autonomy.update`'s `directiveQuote`, `space.autonomy.update` and its `space.autonomy` capability group, the `space_autonomy` task binding, `HostMergePostureSchema`'s description, the `store.listing.install` output union, `store.listing.update`, `StoreFollowedUpdateSchema`, and the space context's `autonomy` and `store` sections. `workflow.run.decide` takes 16 comparisons a rule, up from 10.
- `@aflow/database`: migration 239, `spaces.autonomy_policy` (JSONB, NULL takes every default), and no posture written for any space. Migration 240 grants `space.autonomy` write to the Full Access and Standard profiles.
- `@aflow/cybernetic-runtime`: `readSpaceAutonomyPolicy`, `readSpaceOwnerUserId`, `writeSpaceAutonomyPolicy`, `updateSpaceAutonomySettingRow`, `readSpaceAutonomyDirectiveRecords`, `selectSpaceAutonomyDirective`, `directiveAsk`, `readSpaceRole`, `isSpaceAdmin` and `canWriteSpace`, `followStoreCatalog` and its binding's static schema.
- `@aflow/platform-artifacts`: the shepherd's rules, merge task and abandon claim, the push gate, the Helmsman's operation list, bind-capability's install task and the help articles `this-computer.ts`, `skills.ts` and `approvals.ts`. The skills `publish-local-changes` (version 57) and `local-pr-shepherd` (version 23) move, so the listings `local-publish` (60), `local-shepherd` (29, revision 6) and `coding-loop` (117) move. `coding-with-github` moves to version 2.
- `aflow-orchestrator`: the Store inline handlers, the `space.autonomy.update` handler, the `space_autonomy` resolver, the follow-catalog hook before a run starts and before a Helmsman turn, and the space context's two sections.
- `aflow-executor-api`: the write gate reads the write policy with the autonomy composed in. It reads the two apart, so a schema without `autonomy_policy` keeps its stored write policy and takes only the autonomy's default.
- `@aflow/server-runtime`: `GET` and `PUT /v1/spaces/:spaceId/autonomy`. The `PUT` body takes `autonomy` and `storeUpdates` only, and the write keeps the stored directive.
- `@aflow/web-product`: the Write Policy page reads the autonomy through `useApiQuery`.

**Risks**

- A space-wide update replaces a skill a schedule or campaign runs. Mitigation: the update is applied, and `reconcile` names each skill for the Helmsman.
- An update fails on a transient error. Mitigation: the space tries it again after a wait that starts at one minute and doubles up to six hours. It lists a failure that repeats as `failed` once (B5).
- An update finds another use of the space applying it, `STORE_MUTATION_IN_PROGRESS`. Mitigation: that is not a failure. It is not listed and writes no retry record, since the other use records it (B5).
- A space whose installs are customized gets no update. Mitigation: it is listed as `customized`, and the Helmsman chooses `replace_customized` or `keep`.

**Open questions**

**Not done on purpose**

- No background task walks tenants for updates (Plan 180). The space follows the catalog on its next use: a workflow run starting, or a Helmsman turn.
- No Settings control for the setting. The Helmsman sets it with `space.autonomy.update`, and the REST pair sets it too. The Write Policy page reads it and shows each tier's default as the autonomy composes it.
- The store_install StagedChange stays. A space under `ratify` still proposes.

**Done when**

- Full Circle and Trading Joe answer `full` after a raise on a message the operator sent (D).
- The bootstrap PR merges, and the next green `comment` pull request of Full Circle merges with no Action Center item (A).
- Trading Joe's first run after the Plan 343 merge starts on the new bundle version with no click (B).

## A — merge on any verdict that is not `request_changes`

Under `when-green`, a green head whose publication review returned `approve` or `comment` merges by squash pinned to that head. The `comment` findings are on the pull request and brief the next node. `request_changes`, or no verdict, holds the head. The `overrideCheck: operator` with `pushDecision: ask` branch merges as before. A person's GitHub review requesting changes still holds the merge, because a person is speaking. Under `ratify` a `comment` merge is the operator's, as before. An `approve` merge's reason names the autonomy that applies. Under `full` the merge waits on no approval unless the write policy gates medium writes. Under `ratify` it waits on the operator's approval at the medium-tier write gate, unless the write policy lets medium writes through.

The `does_not_merge` hand-over now holds for a `comment` head where the autonomy is `full`, and goes to the Helmsman there. Under `ratify` a conflicting `comment` head falls through to the rule that leaves its merge to the operator, as before. The rule reads the autonomy as an eleventh comparison, so `workflow.run.decide` now takes 16 comparisons a rule. The cap of 10 guarded no storage limit.

_Rejected:_ merging on any verdict but `request_changes`, a review with no verdict included. A review that could not judge the head has cleared nothing, so the merge would rest on CI alone.

_Rejected:_ asking the Helmsman to decide each `comment` merge. The findings already brief the next node, and a model call per merge adds cost and a failure path for no new judgement.

_Exit:_ in the shepherd's decision table (`localPrShepherd.test.ts`), a green `comment` head decides `merge` under `full` and `leave` under `ratify`. A conflicting `comment` head is handed to the Helmsman under `full` and left to the operator under `ratify`. A `request_changes` head decides `leave` under both. On the live stack: the bootstrap PR merges, and the next green `comment` pull request of Full Circle merges with no Action Center item.

**Bootstrap.** This plan's own PR may return a `comment` verdict, and the rule it replaces still holds until it merges. One click on it ends the clicks.

## B — the Store without a click

1. `store.listing.install` runs `executeStoreInstall`, the path the Store page takes, under `full`. Its output is `status: installed` with the setup checklist. A credential in it is the operator's, and the Helmsman names it to them. The Store's routes ask for space `write`, so the op does too. It runs as the session's user, and a user below `write`, a viewer or a non-member, is refused with `STORE_LISTING_NEEDS_SPACE_WRITE`.

   _Rejected:_ keeping Action Center ratification, with an auto-approve under `full`. It lost because it keeps a dead step in the flow and in the record the operator sees.

2. `store.listing.update` runs `executeStoreUpdate`, the path `POST /v1/spaces/:id/store/update` takes. Its output names the skills to reconcile. The Helmsman learns of an update from `store.listing.get` and from the space context's `store.updatesAvailable`. It asks for space `write` as the install does, and refuses a user below it with `STORE_LISTING_NEEDS_SPACE_WRITE`.

   _Rejected:_ a bespoke update path for the op that duplicates the route's logic. It lost because two paths drift, and the op would then update differently from the Store page.

3. `storeUpdates: follow-catalog | manual`, default `follow-catalog`. A space following the catalog compares the catalog it last followed, one Redis read, before each workflow run start and Helmsman turn. Another agent's turn does not follow the catalog. Behind it, the space updates each install through `executeStoreUpdate` under its owner's id, records it, and lists it under `store.followed` with what to reconcile. An update that ends a campaign or invalidates a schedule is applied all the same.

   _Rejected:_ `manual` as the default. It lost because it recreates the click this plan removes.

   _Rejected:_ skipping an update that ends a campaign or invalidates a schedule, and asking the operator. It lost because it waits on the operator. The update is applied, and `reconcile` names each skill for the Helmsman.

   The alternatives rejected for when the space follows the catalog, a tenant walk and the Helmsman's call alone, follow this list.

4. Under `ratify`, `store.listing.update` is refused and follow-catalog applies nothing. The operator applies an update from the Store page, as before this plan. A space keeping its updates manual, or under `ratify`, writes a hold marker in place of the catalog it followed, so each later use pays the one Redis read and no Postgres read. `PUT /v1/spaces/:spaceId/autonomy` clears the marker, and it expires after an hour. Switched to follow the catalog, the space takes the pending updates on its next use.

   _Rejected:_ applying the update and asking the operator after. It lost because it discards the space's customizations before the operator can speak.

5. A failed update is tried again after a wait that starts at one minute and doubles with each failure, up to six hours. A failure that repeats is listed for the Helmsman once and moves the space context's generation once. An update another use of the space is applying, `STORE_MUTATION_IN_PROGRESS`, is not a failure. It is not listed, moves no generation and writes no retry record, since that other use records it.

   _Rejected:_ failing fast on every retry, with no wait. It lost because each use of the space would try the update again. The failure would fill the `followed` list and rebuild the space context on each turn.

_Rejected:_ a background task that walks every tenant's spaces when the catalog moves. Plan 180 forbids a tenant walk, and its idle cost would grow with spaces that never run.

_Rejected:_ applying an update only when the Helmsman calls `store.listing.update`. Trading Joe's schedule runs at 08:30 with no Helmsman turn before it, so the update would wait on a conversation.

_Rejected:_ replacing customized installs on follow. That discards the space's own changes unasked. The Helmsman is told and decides instead.

_Exit:_ `storeListing.test.ts` installs and updates under `full` and refuses the update under `ratify`. It installs and updates for a user who may write the space, and refuses both for a user below `write`. `spaceRole.test.ts` gives `write` to an editor, an admin and the owner, and refuses it to a viewer and a non-member. `storeFollowCatalog.test.ts` applies, backs off, lists a repeated failure once, and takes a pending update after a switch from `manual`. On the live stack: Trading Joe's first run after the Plan 343 merge starts on the new bundle version with no click.

## C — the audit

Kinds seen in this tenant: `trigger_armed`, `ratification`, `human_approval`.

| Ask                                                           | Where                          | Disposition under `full` (2026-11-21)                                   |
| ------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Merge on a `comment` verdict                                  | Local PR Shepherd rules        | Merges (A).                                                             |
| Merge write approval, medium tier                             | API executor gate              | Not gated unless the write policy gates medium (D).                     |
| Budget spent, "take over the pull request" item               | Local PR Shepherd abandon      | Handed to the Helmsman as `budget_spent`, and no item is raised.        |
| Push over a blocker or a major                                | Publish Local Changes gate     | Branch stays local, and the run records `fixRound` for the Helmsman.    |
| Push where the review found nothing and did not approve       | Publish Local Changes gate     | Branch stays local, and the Helmsman decides.                           |
| Push where the review gave no result twice, or did not finish | Publish Local Changes gate     | Branch stays local, and the Helmsman publishes again.                   |
| Push over an uncleared scan                                   | Publish Local Changes gate     | Kept: a secret.                                                         |
| Push from a folder whose push approval is `always`            | Publish Local Changes gate     | Kept: the folder asks for it.                                           |
| Push on the operator's own word                               | Publish Local Changes gate     | Kept: the operator is speaking.                                         |
| Store install ratification                                    | `store.listing.install`        | Installs (B1).                                                          |
| Store update click                                            | Store page                     | `store.listing.update` and follow-catalog (B2, B3).                     |
| Commission Change, Local Code Review                          | their skills                   | No ask found.                                                           |
| Daily Trading Cycle approved set                              | `dailyTradingCycleApproved.ts` | A document a review run writes, not an item. Plan 343 holds the bundle. |
| `trigger_armed` notices                                       | Action Center                  | A notice, which waits on no one.                                        |

Product rules changed, 2026-11-21: "the merge is the operator's" on a `comment` verdict, "installation requires operator ratification", "updates are operator actions in the Store", and "the shepherd leaves the pull request to a person" are now the Helmsman's or the skill's decisions under `full`.

_Rejected:_ removing the asks over an uncleared scan, an `always` folder and the operator's own word. The first guards a secret. The other two are the operator's own choice to be asked.

_Rejected:_ turning the shepherd's spent budget into a silent stop. A pull request nobody tends stays red, so the case goes to the Helmsman, which acts with the skills it has.

_Exit:_ eleven rows of the table above are decided by test under `full`. The `comment` merge row is decided by the decision table in `localPrShepherd.test.ts`. The medium-tier write row is decided by `spaceLoader.test.ts` (D). The spent budget row is decided by the abandon tests in `localPrShepherd.test.ts`. The six push rows are decided by the push gate tests in `publishLocalChanges.test.ts`. The two Store rows are decided by the Store tests of B. Under `ratify`, each of those tests decides as before this plan, and a spent budget raises the Action Center item and hands nothing to the Helmsman. Three rows hold no ask, so no test can decide them, and the audit's record decides them. Those rows are Commission Change and Local Code Review, the Daily Trading Cycle approved set, and the `trigger_armed` notices. Each records where the audit looked and what it found there.

## D — the rule as data

`spaces.autonomy_policy` holds `{ autonomy?: 'full' | 'ratify', storeUpdates?: 'follow-catalog' | 'manual', directive?: { sessionId, eventId, eventType, authorUserId, postedAt, words, spentAt }, raisedAt?, loweredAt? }`. NULL, and any field left out, takes `ratify` and `follow-catalog` each time it is read, so a space that never chose keeps asking as before. Migration 239 adds the column and writes no posture for any space. Full Circle and Trading Joe take `full` once this lands. In each space the Helmsman calls `space.autonomy.update { "autonomy": "full", "directiveQuote": … }` on the operator's word, which writes that space alone. That is the Helmsman's act, not a migration's. The op writes through the route's path: the row, the space context generation and the Store hold marker. It writes only the space the conversation runs in, and only where the session's user is an admin of that space. A field it names replaces the stored value, and a field it leaves out keeps it. The shepherd, the push gate and the abandon claim read it through the `space_autonomy` binding. The Store handlers and the write gate read the column. The Helmsman reads it in the space context's `autonomy` section, whose guidance is `SPACE_AUTONOMY_MEANING` and `SPACE_STORE_UPDATES_MEANING`. A space chooses to be asked with `space.autonomy.update { "autonomy": "ratify" }`, or with `PUT /v1/spaces/:spaceId/autonomy { "autonomyPolicy": { "autonomy": "ratify" } }`.

**The authority to raise.** An admin session does not separate the operator's word from the agent's own choice. A raise from `ratify` to `full` removes the medium-tier write gate, Store ratification and the push-gate asks at once. So the raise rests on the operator's word, and the platform must attest that the operator wrote it. Text any session can write attests nothing: a plan document or a plan link is the Helmsman's own write.

The attested artifact is an operator message in the space's conversation record. That record is the `event_log` of the space's sessions. The API stamps the author of two of its event types from the authenticated request, and no agent session writes either with an author:

- A `SessionResumed` event that carries `userMessage` and `actorUserId`: the message that resumed a conversation.
- A `RoomMessage` event with `wakeHelmsman` set: a message posted into a room for the Helmsman, `actorUserId` its author.

_Rejected:_ a plan document or a plan link as the operator's word. It lost because the Helmsman writes both itself, so either attests the agent's own choice.

The Helmsman passes the operator's whole message as `directiveQuote`, verbatim. The op reads the space's 200 newest message events and takes the newest whose whole content equals the quote. Both are trimmed, their whitespace collapsed and their case set aside first. The match is equality of the whole message, never a substring. So a word such as "yes", or a fragment of a longer message, cannot stand for the operator's ask.

**An imperative ask.** The message must be an imperative addressed to the agent, with full autonomy as its object. `directiveAsk` runs five steps in order, and the first that fails refuses the message:

1. **It names the raise.** It holds `autonomy` and one of `full`, `absolute`, `complete` and `total`, each as a whole word. Otherwise `SPACE_AUTONOMY_DIRECTIVE_NAMES_NO_RAISE`.
2. **It negates nothing.** It holds no negating word. A negating word is one of `no`, `not`, `never`, `nor`, `neither`, `none`, `without`, `cannot`, `stop`, `cancel`, `revoke`, `refuse`, `deny`, `disable`, `remove`, `revert`, `undo`, `lower`, `drop`, `off` and `ratify`. Any word ending in `n't` negates too, and so do the common contractions written without the apostrophe, such as `dont` and `wont`. The words are whole words, so `nothing` and `know` do not negate. Otherwise `SPACE_AUTONOMY_DIRECTIVE_REFUSES_RAISE`.
3. **It asks no question.** It holds no question mark and no `whether`. No clause opens with an interrogative such as `what` or `how`, or with an auxiliary such as `should`, `can` or `do`. Otherwise `SPACE_AUTONOMY_DIRECTIVE_QUESTION`.
4. **It sets no condition.** It holds none of `if`, `unless`, `when`, `whenever`, `once`, `until`, `till`, `after`, `provided`, `providing`, `assuming`, `suppose`, `supposing` and `otherwise`. Otherwise `SPACE_AUTONOMY_DIRECTIVE_CONDITIONAL`.
5. **It directs the raise.** A clause names the raise and opens with a verb such as `set`, `give`, `grant` or `switch`, after a courtesy such as `please` or `ok`. Or a clause is the raise alone with `please`, such as "the full autonomy, please". Punctuation ends a clause. Otherwise `SPACE_AUTONOMY_DIRECTIVE_AMBIGUOUS`.

So "set full autonomy" asks, and so does the operator's "absolute autonomy please.. nothing waits on me". "What does full autonomy mean?" and "Should I give you full autonomy?" are questions. "If CI passes, set full autonomy" is a condition. "Please do not set full autonomy" refuses, and "Full autonomy, not ratify" is refused as well, because the rule reads words and not intent. It errs toward refusing on purpose. A refused ask costs the operator one more message, and a granted question lifts every gate at once.

_Rejected:_ the negating-words rule alone, which asked only that the message name the raise and hold no negating word. It lost because questions and conditionals pass it. "Should I give you full autonomy?" and "If CI passes, set full autonomy" negate nothing, yet neither directs the raise.

It raises only where that message is one of the two attested types, it was posted after the space's last lowering, its author is an admin of the space, and no earlier raise spent it. Every other quote is refused, and the refusal names it:

- `SPACE_AUTONOMY_DIRECTIVE_NAMES_NO_RAISE`: the quote does not name the raise, as "yes" does not. No message can then qualify, whoever sent it.
- `SPACE_AUTONOMY_DIRECTIVE_REFUSES_RAISE`: the quote holds a negating word, as "please do not set full autonomy" does. No message can then qualify, whoever sent it.
- `SPACE_AUTONOMY_DIRECTIVE_QUESTION`: the quote asks a question, as "Should I give you full autonomy?" does. No message can then qualify, whoever sent it.
- `SPACE_AUTONOMY_DIRECTIVE_CONDITIONAL`: the quote sets a condition, as "If CI passes, set full autonomy" does. No message can then qualify, whoever sent it.
- `SPACE_AUTONOMY_DIRECTIVE_AMBIGUOUS`: the quote names the raise but directs nothing, as "full autonomy is what we discussed" does. No message can then qualify, whoever sent it.
- `SPACE_AUTONOMY_DIRECTIVE_PARTIAL_QUOTE`: no message equals the quote, but one holds it as a part of a longer message. The refusal names that message.
- `SPACE_AUTONOMY_DIRECTIVE_AGENT_AUTHORED`: a `SessionResumed` with no author stamped, as an agent session or a schedule resumes a conversation. The opening message of a session an agent session started is refused too.
- `SPACE_AUTONOMY_DIRECTIVE_UNATTESTED`: no message equals the quote or holds it, or the record does not attest a person. That covers a conversation's opening message, which carries whoever started it. It covers a room line not sent to the Helmsman, such as a join or an applet action, and the platform's wait notices.
- `SPACE_AUTONOMY_DIRECTIVE_NOT_OPERATOR`: the author is not an admin of the space.
- `SPACE_AUTONOMY_DIRECTIVE_BEFORE_LOWERING`: the message was posted at or before the space's last lowering, whatever its spend state. The refusal names the message and both times.
- `SPACE_AUTONOMY_DIRECTIVE_SPENT`: an earlier raise spent this message, or the message is recorded before the one it spent. A lowering's time refuses such a message first, so this code answers only a stored directive with no lowering timed.

_Rejected:_ the alternatives already recorded for the parts of this rule. The negating-words rule lost to the ask rule above. A standing directive lost to one directive, one raise, below. A `directive` field lost to the REST refusal, below. A substring match and the admin check alone lost at the end of D.

A raise with no quote is refused with `SPACE_AUTONOMY_RAISE_NEEDS_DIRECTIVE`. Each refusal writes nothing. A raise that passes records what it verified as `directive`: the conversation, the event, its type, its author, when it was recorded, its words and when the raise spent it.

**The autonomy's clock.** Every write that changes the autonomy records its time, the op's and the REST pair's alike (`nextSpaceAutonomyPolicy`). A raise records `raisedAt` and a lowering records `loweredAt`. A write that leaves the autonomy as it was keeps both. A raise needs a message posted after the last lowering. A space never lowered has never been full, so its floor is its creation, and every message of its record qualifies. A message from before the last lowering is refused with `SPACE_AUTONOMY_DIRECTIVE_BEFORE_LOWERING`, whether a raise spent it or not. So a message the operator sent while the space was full cannot raise it again after a lowering. That holds for a space the REST pair raised too, which stores no directive.

**One directive, one raise.** The stored `directive` is the message the last raise spent. A lowering keeps it, and so does a change of `storeUpdates`. A raise, a lowering and a raise take two messages from the operator, and the second is posted after the lowering. Lowering `full` to `ratify` stays an admin session's act and needs no directive. A change of `storeUpdates` alone stays one too.

_Rejected:_ a raise that needs only a message posted after the last spent directive. It lost because a message sent between a raise and a later lowering then raises the space back with no new word from the operator. A space the REST pair raised stores no directive, so any old attested ask would raise it after a lowering.

_Rejected:_ a standing directive, one message that authorises every later raise. It lost because it re-authorises a raise after a lowering. The operator who lowered a space to be asked again would find the agent able to raise it back on their old word.

**The REST pair.** It is the operator's own act. `PUT /v1/spaces/:spaceId/autonomy` takes `autonomy` and `storeUpdates` only. A body naming `directive`, `raisedAt` or `loweredAt` is refused with a 400. The write keeps the stored directive and times a change of autonomy as the op does. So only the op's verified path writes `directive`, and a client cannot clear the spent record or the lowering's time.

_Rejected:_ accepting a `directive` field on the REST pair. It lost because a client can store a made-up directive. A body naming a later `postedAt`, or no spent record at all, would reopen a raise the record never attested.

For Full Circle and Trading Joe, the operator sends the Helmsman of each space a message asking for full autonomy. The Helmsman quotes it and calls the op. An API key the operator holds speaks as them, as Plan 331 treats it. This plan leaves that alone.

Under `ratify` the guidance is `SPACE_AUTONOMY_MEANING.ratify` alone, since the Store update setting applies nothing there. The Write Policy page reads the setting and shows each tier's default as `effectiveSpaceWritePolicy` composes it. The merge is a medium-tier write, so the stored write policy composes first and the autonomy sets only the default. `HostMergePostureSchema` and the machine page's merge line say so, and the line names a medium-tier override where one is stored. The machine page shows no merge line until it has read the autonomy and the write policy. A failed read shows an error, as on the Write Policy page. Both pages read the autonomy through `useApiQuery` under the key `['space', spaceId, 'autonomy']`.

_Rejected:_ the autonomy overriding the stored write policy. It lost because an explicit policy the operator set must not be silently reversed. A space whose write policy gates medium writes keeps that gate under `full`.

_Rejected:_ writing `full` in the migration for spaces named Full Circle and Trading Joe in one tenant. It lost because every local-edition install shares the fixed tenant `00000000-0000-4000-8000-0000000ed1c0`. Any local install with a space of either name would stop asking for medium writes, comment merges and Store installs, unasked.

_Rejected:_ a global default of `full`, read for every space whose `autonomy_policy` is NULL. It lost because it changes the safety defaults of spaces that never chose: every space in every tenant and edition would stop asking for a medium-tier write.

_Rejected:_ one setting per surface, such as a merge flag, a Store flag and a push flag. Three flags drift apart, and a space choosing to be asked would need all three set.

_Rejected:_ rule prose in the Helmsman's prompt. Prompts drift across model versions, and CLAUDE.md puts a rule in the schema before the prompt.

_Rejected:_ matching the quote as a substring of any attested message. Three letters of any message an admin sent would raise the space, and so would the words "set full autonomy" taken out of a message that refuses it.

_Rejected:_ the admin check alone for a raise to `full`. The Helmsman's session runs as the space's admin, so the check passes on the agent's own choice as well as on the operator's word.

_Rejected:_ leaving the setting to the REST pair alone. An agent holds no session token, so a person would issue the call, and every live exit would wait on them.

_Rejected:_ storing the setting in `spaces.directives`. Directives steer the orchestrator and the model, and their writes go through the directives editor's snapshot check. A policy column follows the write policy's route and cache rule.

_Exit:_ `spaceAutonomy.test.ts` resolves the defaults to `ratify` and composes the write policy under both values. `spaceLoader.test.ts` lets a medium write through under `full` and pauses it under `ratify` and under no stored setting. It keeps a stored write policy that gates low writes where the schema has no `autonomy_policy`. `migration239.test.ts` adds the column and writes no autonomy row in the local-edition tenant or any other. `spaceAutonomyUpdate.test.ts` raises the setting on a `SessionResumed` and on a `RoomMessage` the operator sent, and records the message and its author as spent. It raises on the whole of a message that asks for full autonomy, on "set full autonomy" and on "absolute autonomy please.. nothing waits on me". It refuses a raise on a part of a longer message, on a whole message that refuses full autonomy, as "please do not set full autonomy" does, and on a whole message that does not name it, such as "yes". It refuses "What does full autonomy mean?" and "Should I give you full autonomy?" as questions, "If CI passes, set full autonomy" as a condition, and a message that directs nothing. `spaceAutonomyDirectiveAsk.test.ts` holds each of the five steps of `directiveAsk` to its finding. It refuses a raise on words an agent session wrote, on a record whose authorship cannot be attested, on an author who is not an admin, and with no quote. A raise and a lowering record their times. After a lowering, a raise on the message the first raise spent is refused as `SPACE_AUTONOMY_DIRECTIVE_BEFORE_LOWERING`. A raise, a message, a lowering and a raise on that message refuse the raise with that code. A lowering, a message and a raise on that message pass. A space the REST pair raised and lowered refuses a message from before the lowering. A space never raised raises on an old message. It lowers the setting without a directive and keeps the spent record. It keeps a field left out, and refuses a session whose user is not an admin. `computePolicyGuardRoute.test.ts` refuses a `PUT` body that names `directive`, keeps the stored directive on a `PUT`, and times the route's raise and lowering. `spaceAutonomy.test.ts` accepts the directive's shape in the stored setting and refuses it in the REST setting, and records the time of each change of autonomy. `migration240.test.ts` grants the op's group. On the live stack: Full Circle and Trading Joe answer `full` after a raise on a message the operator sent. `GET /v1/spaces/:spaceId/autonomy` then answers `{ "autonomyPolicy": { "autonomy": "full", "directive": { …, "authorUserId": … } } }` for each.

## Proof

The plan is proven in two parts.

- **In the checkout.** The tests each exit names pass, and `scripts/verify-commit.mjs` passes on the branch, once plainly and once under the `ts-source` condition. The type check, the linter, the formatter, the large-file check and the context-budget check pass.
- **On the live stack.** The three open live exits close the plan, each recorded here with its date.
  - D: Full Circle and Trading Joe answer `full` after a raise on a message the operator sent.
  - A: the bootstrap PR merges, and the next green `comment` pull request of Full Circle merges with no Action Center item.
  - B: Trading Joe's first run after the Plan 343 merge starts on the new bundle version with no click.

A failure of any one reopens its phase. A `ratify` space that is not asked as before reopens D.
