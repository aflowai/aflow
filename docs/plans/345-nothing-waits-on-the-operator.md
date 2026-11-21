# Plan 345 — Nothing waits on the operator

**Status:** A, B, C and D built in one change. The exit on the live stack is open: Trading Joe takes the Plan 343 update with no click, and the bootstrap PR below merges.

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

- `@aflow/schemas`: `models/spaceAutonomy.ts` (the setting, its meanings, `effectiveSpaceWritePolicy`), the `space_autonomy` task binding, `HostMergePostureSchema`'s description, the `store.listing.install` output union, `store.listing.update`, `StoreFollowedUpdateSchema`, and the space context's `autonomy` and `store` sections.
- `@aflow/database`: migration 239, `spaces.autonomy_policy` (JSONB, NULL takes every default).
- `@aflow/cybernetic-runtime`: `readSpaceAutonomyPolicy`, `readSpaceOwnerUserId`, `followStoreCatalog` and its binding's static schema.
- `@aflow/platform-artifacts`: the shepherd's rules, merge task and abandon claim, the push gate, the Helmsman's operation list, bind-capability's install task and the help articles `this-computer.ts`, `skills.ts` and `approvals.ts`. The listings `local-shepherd` (revision 6) and `coding-with-github` (version 2) move.
- `aflow-orchestrator`: the Store inline handlers, the `space_autonomy` resolver, the follow-catalog hook before a run starts and before a Helmsman turn, and the space context's two sections.
- `aflow-executor-api`: the write gate reads the write policy with the autonomy composed in.
- `@aflow/server-runtime`: `GET` and `PUT /v1/spaces/:spaceId/autonomy`.

**Risks**

- A space-wide update replaces a skill a schedule or campaign runs. Mitigation: the update is applied, and `reconcile` names each skill for the Helmsman.
- An update fails on a lock or a transient error. Mitigation: the space tries it again on its next use, and lists it as `failed` meanwhile.
- A space whose installs are customized gets no update. Mitigation: it is listed as `customized`, and the Helmsman chooses `replace_customized` or `keep`.

**Not done on purpose**

- No background task walks tenants for updates (Plan 180). The space follows the catalog on its next use: a workflow run starting, or a Helmsman turn.
- No Settings screen for the setting. The REST pair sets it, and the write-policy page still shows medium's default as gated.
- The store_install StagedChange stays. A space under `ratify` still proposes.

## A — merge on any verdict that is not `request_changes`

Under `when-green`, a green head whose publication review returned `approve` or `comment` merges by squash pinned to that head. The `comment` findings are on the pull request and brief the next node. `request_changes`, or no verdict, holds the head. The `overrideCheck: operator` with `pushDecision: ask` branch merges as before. A person's GitHub review requesting changes still holds the merge, because a person is speaking. Under `ratify` a `comment` merge is the operator's, as before.

The `does_not_merge` hand-over now holds for a `comment` head too. That rule is at the ten comparisons one rule may hold, so it does not read the autonomy: under `ratify` a conflicting `comment` head is also handed to the Helmsman.

**Bootstrap.** This plan's own PR may return a `comment` verdict, and the rule it replaces still holds until it merges. One click on it ends the clicks.

## B — the Store without a click

1. `store.listing.install` runs `executeStoreInstall`, the path the Store page takes, under `full`. Its output is `status: installed` with the setup checklist. A credential in it is the operator's, and the Helmsman names it to them.
2. `store.listing.update` runs `executeStoreUpdate`, the path `POST /v1/spaces/:id/store/update` takes. Its output names the skills to reconcile. The Helmsman learns of an update from `store.listing.get` and from the space context's `store.updatesAvailable`.
3. `storeUpdates: follow-catalog | manual`, default `follow-catalog`. A space following the catalog compares the catalog it last followed, one Redis read, before each run start and Helmsman turn. Behind it, the space updates each install through `executeStoreUpdate` under its owner's id, records it, and lists it under `store.followed` with what to reconcile. An update that ends a campaign or invalidates a schedule is applied all the same.

## C — the audit

Kinds seen in this tenant: `trigger_armed`, `ratification`, `human_approval`.

| Ask                                                           | Where                          | Disposition under `full` (2026-11-21)                                   |
| ------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Merge on a `comment` verdict                                  | Local PR Shepherd rules        | Merges (A).                                                             |
| Merge write approval, medium tier                             | API executor gate              | Not gated unless the write policy gates medium (D).                     |
| Budget spent, "take over the pull request" item               | Local PR Shepherd abandon      | Handed to the Helmsman as `budget_spent`, and no item is raised.        |
| Push over a blocker or a major                                | Publish Local Changes gate     | Branch stays local for a fix round the Helmsman commissions.            |
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

## D — the rule as data

`spaces.autonomy_policy` holds `{ autonomy?: 'full' | 'ratify', storeUpdates?: 'follow-catalog' | 'manual' }`. NULL, and any field left out, takes `full` and `follow-catalog` each time it is read, so Full Circle and Trading Joe are `full` with no row written. The shepherd, the push gate and the abandon claim read it through the `space_autonomy` binding. The Store handlers and the write gate read the column. The Helmsman reads it in the space context's `autonomy` section, whose guidance is `SPACE_AUTONOMY_MEANING` and `SPACE_STORE_UPDATES_MEANING`. A space chooses to be asked with `PUT /v1/spaces/:spaceId/autonomy { "autonomyPolicy": { "autonomy": "ratify" } }`.
