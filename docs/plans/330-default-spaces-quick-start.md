# Plan 330 — Default spaces: a quick start installs with the product

**Status:** 🌱 design. Nothing built. **Builds on:** Plan 106 (platform artifacts resolve from the registry), Plan 315 node `5f573124` (the coding loop as one Store entry, ready or not at install), Plan 321 (the shepherd and its schedule), Plan 322 (plans as platform records, and their board), Plan 325 (the product's help articles), Plan 326 D12 (a space prefers a coding agent), Plan 320 P6 (a connected folder's preview). **Leaves alone:** Plan 227 (hosted onboarding).

## 1. Problem

A new install has one space, and it is empty. The local edition's bootstrap claims the space the tenant schema seeds, names it "Personal" (`FIRST_WORKSPACE`, `packages/server-runtime/src/bootstrap/localEdition.ts`), turns compute off in it and writes nothing else. The Store lists single pieces. Its entries are bundles, connectors and applets (`CatalogEntrySchema`, `packages/schemas/src/store/catalogEntry.ts`). Nothing in it describes a space.

Everything the Full Circle space does today was put together by hand over weeks: commission, review, publish, shepherd, the plans board, and Helmsman driving work through the loop. A new user cannot reproduce it:

- **The loop is four Store entries, and none of them is the whole.** Local Commission, Local Code Review, Local Publish and Local PR Shepherd (`packages/platform-artifacts/src/skillBundleCatalog.ts`) install one at a time. None of them brings the Helmsman directives that drive the loop, the plans board's place in the work, or the schedule that makes the shepherd run.
- **What makes Full Circle work lives in the space's own records.** The directives were written by hand. The github binding was made by hand. The folder's branch prefix and merge posture were set with `aflow connect` flags. The shepherd schedule came from a Helmsman tool call and has been recreated each time it ran out. The protocol, `docs/dev/driving-work-through-the-loop.md`, is something the operator read and the Helmsman was told. None of it ships.
- **The setup is spread over five places, and the product names the missing pieces one at a time.** Those places are This Computer, the `aflow connect` flags, the credentials page, the space policy routes and a Helmsman tool call. A bundle install's post-install manifest (`generatePostInstallManifest`, `packages/cybernetic-runtime/src/stagedChange/bundleInstallManifest.ts`, rendered by `SetupChecklist`) covers credentials, MCP bindings, pairing a machine, designating the repository, provider keys, switched-off lanes and capability profiles, each as a task that appears while it is unmet. The shepherd bundle's own description asks the Helmsman to create the schedule, and to create it again once it expires. Nothing tells an operator that their space is ready to take a change on their repository, or what stands in the way.

So a new operator cannot get to the first space they could get value from, coding on their own repository, unless someone who built Full Circle walks them through it. The product should ship ready-made spaces as quick starts. The first is coding on the user's own GitHub repository.

## 2. Decisions

**D1 — A default space is a Store entry of kind `space`.** `CatalogEntrySchema` gains a `space` member. Its payload is a template naming:

- the Store bundles it installs, by catalog id;
- the agents, directives and api_definitions it writes beyond those bundles;
- the help it carries;
- the readiness list the space needs before it works (D4).

`StoreInstallKindSchema` gains `space`. The install row records the template version the space was made from. Installing creates a new space and applies the template to it. "Start from a quick start" in the space switcher and the first-run offer use that one path. The offer appears while the operator has only the bootstrap's space and it holds nothing, and it shows each template beside the empty space; choosing one leaves Personal as it was.

Each bundle the template names goes through the bundle install path, with its own install rows and claims. The space's Store page therefore shows those bundles as installed and updatable, as it shows any other. The directives and agents the template writes become the space's own data once written. An operator edits them as they edit anything in the space, and a later version of the template does not overwrite them.

A template is never applied to an existing space, because it writes directives and replacing a space's directives is not a quick start.

_Rejected:_ a seed migration. It writes into every tenant at deploy time, and the data then drifts from the code that described it. _Rejected:_ a tenant sweep (Plan 106: platform artifacts resolve from the registry). _Rejected:_ the bootstrap writing a coding space on first boot. It would ask for a repository nobody has connected, and the hosted edition has no bootstrap of its kind.

**D2 — Templates are code in `packages/platform-artifacts`.** They sit beside the bundle catalog. The Store catalog lists them, and `storeCatalogHashes.json` hashes them like every other entry. They ship with the repository and the image, and there is nothing to seed. Every install's Store lists them. The hosted edition lists them too and installs them through the same path. An edition difference is a readiness item's to report (D4), not a second copy of the template.

**D3 — The first template is "Coding with GitHub".** It brings:

- **The coding-loop bundle** (Plan 315 node `5f573124`): the four loop skills, the shepherd agent and the github api_definition as one entry. The template names that one entry, not the four bundles it replaces.
- **The plans board:** the Helmsman directives that keep each stream of work on a plan node, so the board fills as work is commissioned. The board and its `plan.node` grants already exist in every space (Plan 322, migration 218), so the template grants nothing new.
- **The Helmsman directives and help for driving work through the loop.** The help is a Plan 325 article derived from `docs/dev/driving-work-through-the-loop.md`, not copied from it. It keeps the protocol: one conversation per stream, commission, review, publish, the shepherd, `hands-off`. It drops what belongs to developing this repository: the dev stack, `live`, `yarn verify`, and this stack's ports and credentials.
- **The shepherd schedule, created on the operator's word.** The readiness item offers the schedule, and the operator's answer creates it. It carries the input its renewal needs: the shepherd agent it targets, the cron (`SHEPHERD_SCHEDULE_CRON_DEFAULT` unless the operator names another), and the operator's choice of firings. Recreating an expired schedule is then a single action on the same input, not a new conversation.

**D4 — Readiness is computed from live state, never a static list, and one function serves three surfaces.** The template walks the operator to their own repository. Each item has:

- a state: `done`, `needs_setup` or `broken`;
- the exact page or command that changes it;
- whether it is required or optional.

The checklist is green when every required item is `done`. The items for Coding with GitHub, each with where its state is read:

1. **Pair this machine.** The machine reading of `pair_machine`. Read from the space's host binding and the executor's presence in the host inventory. A paired machine whose executor is gone is `broken`. Changed at This Computer → Get a code.
2. **Connect the folder of the repository, with a branch prefix and a merge posture.** The folder reading of `pair_machine`, because connecting the folder is part of the host lane's grant. Read from the binding's folder, push policy, `branchPrefix` and `mergePosture`. A folder that does not allow pushes is `needs_setup`. The item shows the prefix and posture in force, and the command that changes them: `aflow connect <folder> --branch-prefix <p> --merge-posture <never|when-green>`. It also reports when the shepherd agent was written before this folder was connected, because that agent's folders are fixed when it is written (§7 F4).
3. **Bind a GitHub credential to the github connector, with the scopes publish and shepherd need.** Read from the binding, and from GitHub's own answer for that credential. A credential GitHub refuses is `broken`. One that lacks a scope is `needs_setup`, and names the missing scope. Changed on the credentials page.
4. **Choose the coding harness.** Read from the space's preferred harness (`/spaces/:id/preferred-harness`, Plan 326 D12) and the host inventory's `harnesses[].installed`. No choice is `needs_setup`. A choice that is not installed on the machine is `broken`. The options are Claude Code and Codex, as installed on the machine.
5. **Arm the shepherd schedule.** Read from the schedule's status and the firings it has left. Absent is `needs_setup`. Expired is `broken`, with the one action that recreates it from its stored input (D3).
6. **Declare the folder's preview** (Plan 320 P6), where the repository has a web app. Optional. Read from the binding's `preview`, and it names `aflow folder preview`. It is listed only once Plan 320 P6(a) has built the declaration (§7 F3).

An item the edition cannot meet reports `broken`, with the edition's own refusal sentence. Pairing in the hosted edition is the example. The listing shows such an item before install as well as after.

The readiness function is the derived post-install manifest grown, not a sibling of it. `generatePostInstallManifest` takes the template's items as well. An item whose question a task kind already answers extends that kind rather than adding one beside it:

- Items 1 and 2 are `pair_machine`. The host lane's grant is a paired machine and a connected folder, and today `pair_machine` is one row listed while that grant is unmet. It becomes two stateful readings of the same grant. The machine reading covers pairing, and it is `broken` when the paired machine's executor is gone. The folder reading covers the connected folder's push policy, `branchPrefix` and `mergePosture`, and the shepherd agent's report.
- `designate_repo` stays what it is: the cloud designation of a `code_repo`. The template's skills run on the host lane and never require `code_repo`, so `designate_repo` never appears for Coding with GitHub. Its meaning for the cloud `coding-pr-loop` bundle does not change.

Items 3 to 6 have no kind today and are new ones. Three surfaces read the function:

- the bundle install (node `5f573124` criterion 2);
- the Store page;
- the space's help surface.

`SetupChecklist` renders it on all three. _Rejected:_ a second checklist for templates. Two functions that answer "what is missing" end up disagreeing, and the one an operator happens to read is the wrong one.

**D5 — A template is tested.** A contract test installs each template into a fresh space in-process and asserts that:

- every bundle it names was installed through the bundle path, with its install rows;
- every agent, directive and api_definition it writes is present;
- its readiness list has the expected items in the expected states for a fresh space.

A guard checks every template statically:

- each bundle id it names resolves in the bundle catalog;
- each page an item names is a route that exists, and each command is one the host CLI accepts, as the help articles' anchors are checked.

The live exit installs Coding with GitHub into a fresh space on this stack and takes its checklist to green on a scratch repository. It then runs one commission → review → publish → shepherd merge there.

**D6 — Nothing in a template names this machine, this repository or this operator.** Folders, credentials, harnesses and ports are the operator's declarations, and the template only asks for them. Its directives refer to "the space's connected folder" and "the space's github binding", and resolve them when a run starts. A guard test reads every template's content and fails on:

- an absolute path;
- a port number;
- an `owner/repo` pair;
- a binding, credential or schedule id;
- a host name other than the api_definition's own.

_Rejected:_ exporting Full Circle's directives as the template. They name `aflowai/aflow`, this stack's ports and the `live` branch.

## 3. What it affects

- `packages/schemas` — the `space` member of `CatalogEntrySchema` and its template payload. `space` in `CatalogEntryKindSchema` (`store/listingCore.ts`), a separate enum that the entry's `kind` and every schema reading a listing's kind take from: the Store search filter (`StoreListingSearchInputSchema`), the `store_install` staged change's listing snapshot (`cybernetic/stagedChange.ts`) and the registry lookup's catalog candidate. `space` in `StoreInstallKindSchema`. In `PostInstallTaskSchema`, the state and the page or command on the variants readiness reads; `pair_machine` grown into the machine and folder readings of items 1 and 2; new variants for items 3 to 6. `designate_repo` is unchanged. Every variant pins `required: z.literal(true)` today, and the required ones keep it. The optional preview item is a variant of its own pinning `required: z.literal(false)`, so no kind can be both. The existing test that rejects `designate_repo` with `required: false` therefore stands, and a test beside it rejects the preview variant with `required: true`.
- `packages/platform-artifacts` — the template catalog beside `skillBundleCatalog.ts`; the Coding with GitHub template; its help article under `helpCenter/articles/`; the Store catalog listing and its hashes.
- `packages/cybernetic-runtime` — `generatePostInstallManifest` takes template items, with their readers over host inventory, bindings, credentials, the preferred harness and schedules.
- `packages/server-runtime` — the Store listing route's `kind` query, which reads `CatalogEntryKindSchema`; the Store install route for `space`, which creates the space, applies bundles and writes artifacts in one install; the first-run offer's read.
- `packages/web-product` — "Start from a quick start" in the space switcher; the first-run offer; `SetupChecklist` on the Store page and on the space's help surface.
- Stored data: one install row per space made from a template. No new table.

## 4. Phases

**P0 — This document and its index entry.**

- _Remaining._ Review and merge.

_Exit:_ the document is merged and `docs/plans/README.md` lists it.

**P1 — The `space` Store kind, the install path and the first-run offer.** The schema member and install kind; the install route; "Start from a quick start"; the first-run offer; a test template carrying one bundle and one directive; the D5 contract test and the D6 guard, run on that test template.

- _Remaining._ All of it.

_Exit:_ from a fresh install, the first-run offer shows the test template beside the empty space. Choosing it creates a new space. The space holds the bundle with its install rows and the directive, and Personal is unchanged. Applying the template to an existing space is refused. The contract test fails if the install skips the bundle path, and the guard fails on a template carrying a planted absolute path.

**P2 — Coding with GitHub and the readiness function with its three surfaces.** The template (D3); the six readiness items (D4) in `generatePostInstallManifest`, items 1 and 2 as the machine and folder readings of the grown `pair_machine`, and `designate_repo` left as the cloud repository designation; the `PostInstallTaskSchema` changes in §3, with the preview's own `required: false` variant; the three surfaces. Depends on node `5f573124`'s single coding-loop entry.

- _Remaining._ All of it. Before building item 3, measure how a credential's scopes are read for each kind of GitHub token the connector accepts, and record the result here.

_Exit:_ the contract test installs Coding with GitHub into a fresh space and finds the coding-loop entry, the directives, the help article and five listed items, all `needs_setup`. The preview item is not listed until Plan 320 P6(a) lands. Setting one item's live state changes that item, and the change is the same on all three surfaces.

**P3 — Live proof on a scratch repository.**

- _Remaining._ All of it.

_Exit:_ on this stack, a fresh space made from Coding with GitHub takes its checklist from all-`needs_setup` to green against a scratch repository, by following only what the checklist names. One change then goes commission → review → publish → shepherd merge there, with the shepherd's merge on the operator's approval. Stopping the executor turns item 1 `broken`, and the schedule expiring turns item 5 `broken`.

Deferred, not planned here: further templates (research, operations); hosted onboarding changes beyond listing the templates (Plan 227 stays).

## 5. How it is proven

- **One path.** A space made from a template holds exactly what the contract test asserts. Its bundles carry install rows from the bundle path, which a template that wrote skills directly would not have.
- **Live state, not a list.** Each readiness item is driven from `needs_setup` to `done` and to `broken` by changing the state it reads. A static list, or one cached at install, fails the second transition.
- **One function.** A state change is read on the bundle install, the Store page and the help surface, and a test compares the three. A surface with its own logic fails it.
- **Nothing local.** The D6 guard fails on a template with a planted path, port or `owner/repo`.

## 6. Open questions

- Whether a template version newer than the one a space was made from should be offered to that space as a set of changes, rather than offered not at all. This plan offers nothing (D1).

## 7. Findings

Facts met while writing this plan, numbered in its own series.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **The Store has no kind that can carry a space.** `CatalogEntrySchema` is `bundle \| connector \| applet`. `StoreInstallKindSchema` adds only `skill`, for a bundle's member skills.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F2  | **A readiness function derived from live state already exists.** `generatePostInstallManifest` rebuilds a bundle's post-install tasks from current state, and `SetupChecklist` renders them. From binding templates it emits `fill_credentials`, `fill_mcp_credentials` and `run_mcp_binding_test`. From the installed skills' unmet capabilities it emits `pair_machine`, `designate_repo`, `connect_provider`, `enable_space_policy` and `assign_capability_profile`. A task carries no state, since it is listed only while unmet, and every variant pins `required: z.literal(true)`. D4 extends it rather than adding a second one. |
| F3  | **The preview has no declaration to read.** Plan 320 P6 is designed, not built. `aflow folder preview` and the binding's `preview` do not exist yet, so D4's sixth item waits on P6(a).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F4  | **The shepherd agent's folders are fixed when it is written.** A folder connected after the agent is written is not added to it (the Local PR Shepherd bundle's description). A space made from a template connects its folder after install, so the bundle update that rewrites the agent has to follow the connection, and readiness item 2 reports when it has not.                                                                                                                                                                                                                                                                   |
| F5  | **The shepherd schedule expires and nothing renews it.** A cron schedule fires at most 50 times (`MAX_FIRINGS_CAP`). At `*/5 * * * *` that is about four hours. Readiness item 5 therefore has a `broken` state, and D3 stores the input that recreates the schedule.                                                                                                                                                                                                                                                                                                                                                                    |
| F6  | **The plans board needs no grant.** Migration 218 grants `plan.node` to the system profiles, and the board is in every space. The template's part in it is directives only.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F7  | **Coding with GitHub cannot reach green in the hosted edition today.** Its loop needs a paired machine, which the hosted edition does not offer. D2 lists the template there, and D4 reports the pairing item `broken` with the edition's refusal before install.                                                                                                                                                                                                                                                                                                                                                                        |
