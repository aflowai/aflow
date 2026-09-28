# Plan 315 — The local edition's first run: a person and a Helmsman who can both see the machine

**Status:** 🌱 design · **Depends on:** the local operating model (delivered through publication; the archive's 313) · **Companion:** the design pass in §5 P2, which decides layout questions this plan records but does not settle

## 0. How this plan is built

From one walkthrough of the local edition as a new user, in a fresh workspace, on the development stack: create a workspace, ask the first question, find This Computer, the Store, Skills, Integrations, Settings, the Workbench, then open a long conversation. Each finding is recorded with the surface it was seen on and the shape of its fix; the phases group the fixes by the surface they change, smallest first. Layout questions the walkthrough raised but cannot answer are recorded for one design pass rather than settled piecemeal.

## 1. Problem

A person installs the appliance, opens a workspace and is met by a hosted product: a rail that names nothing until it is expanded, an empty chat that suggests skills and integrations, a "workspace ready" step that names agents, a Store led by trading and Kaggle, an Integrations page offering repository designations for a lane that is absent here, a connect flow that assumes a source checkout, and credentials buried in a settings tab although most of the product is blocked without them. Nothing says what this computer is, whether it is paired, which coding agent it has, or which folders it reaches. Helmsman is in the same position: it answers the first question well but cannot point at the surface to use, and its own Workbench shows it nothing about the machine.

Memory has the same shape of problem underneath: embeddings need a provider, and today they either ride a platform credential or fail quietly, which leaves memory unsearchable without a word to the operator.

The loop delivered by the local operating model works. Reaching it from a first run takes knowledge the product does not give.

## 2. Decisions

**D1 — The machine is a first-class object on every operator surface, and the same object Helmsman reads.** This Computer, the Workbench and the first-run checklist all render the host inventory the space context already carries (`hostname`, `runtimes`, `harnesses {id, label}`, `observedAt`) and the folders with their posture (`mode`, `allowsExecution`, `branchPrefix`). One reader, three places. When a surface and Helmsman disagree about the machine, that is a bug in the reader, not two facts.

**D2 — First-run guidance is state, not prose, and it lives in the Workbench.** The checklist is derived: credentials present, paired, a folder connected, the local skills installed, GitHub connected, embeddings configured. Each line links to the surface that changes it and disappears when done. The Workbench holds the guidance and the controls; the empty chat only points at the Workbench. Helmsman gets the same state as data in its space context; its prompt gains no sentence.

**D3 — Hosted-only affordances are withheld where their lane is absent, by the derivation the Store already uses.** The Repos tab and the code-repository option in Integrations, hosted-only settings tabs, and any listing whose operations name an uncomposed lane are absent on the local edition, not shown and refused. One rule (`isOperationComposed` / `uncomposedListingReason`) decides.

**D4 — Words.** Operator-facing copy says _coding agent_, never _harness_; _Store_, never _Shop_; _Helmsman_ or _the assistant_, never _cybernetic agent_. Internal identifiers keep their names.

**D5 — The appliance's connect command is the appliance's.** The paired daemon ships a CLI; This Computer prints `aflow connect <code>` on the appliance and the `yarn workspace` form only on a development stack, decided by the same descriptor that decides the edition.

**D6 — A fresh chat says nothing about its connection.** The connection notice speaks only for a session that once was live. The transport's own phase is what a notice reads, not a session subscription that does not yet exist.

**D7 — The coding agent may not touch refs it did not make.** A commission's worktree shares refs with the operator's repository; the executor snapshots refs before the run and refuses a result that changed any ref other than the worktree's own detached HEAD. Local Publish, in turn, takes a branch that already exists and appends to it, so "on the same branch" is a request the skill can honour rather than one the agent works around.

**D8 — Credentials are a rail entry, not a settings tab.** Most of the product is blocked until a model provider key exists, and more will be. Credentials get their own entry in the rail, linked from the model picker beside the composer; the picker keeps the model and reasoning choice and gains a line that says which providers are usable and which need a key. The remaining settings tabs stay where they are: each is optional and situational, and the pass in P2 reviews them for what is dead.

**D9 — The rail expands on hover and pins on click.** Hovering slides the expanded rail over the content, so names appear without a click and nothing moves; clicking pins it open and pushes the content, as today. Names are always in the accessibility tree, expanded or not.

**D10 — The Workbench is open by default on a desktop, and it is cheap to keep open.** Its sections read the same queries the chat already holds; nothing in it polls, and a section that is empty renders one line. Whether it opens by default is a width rule, not a preference.

**D11 — What needs the operator has its own place.** Approvals, questions, gates and proposals gather in one panel that is collapsed when empty and opens when something arrives; the chat inlines the same item where it occurred, as now. One source, two views.

**D12 — Embeddings use the operator's credentials, and their state is visible.** Memory's embedding provider and model are chosen by the operator per space among the providers whose key is present, with a default that follows the chat provider when it offers embeddings. No embedding is ever attempted against a platform credential on the local edition, and none fails silently: a memory written without embeddings is marked as such, memory search says when it is lexical only, and the checklist carries the line. Switching the embedding provider or model re-indexes, and the switch says so and shows progress; a space keeps searching lexically while it re-indexes.

## 3. Measurement

- Time from opening a fresh workspace to the first commission that runs, for a person who has never seen the product, counted in surfaces visited and questions asked. Walkthrough baseline: seven surfaces, two dead ends (Integrations → Repos; This Computer → a command for a checkout that does not exist).
- Zero occurrences of _harness_, _Shop_, _cybernetic_ in operator-facing copy on the local edition (a copy test over the product package).
- Helmsman's first answer in a fresh local workspace names This Computer and the Store as links (a golden-transcript case).
- Memory search in a space with no embedding provider says it is lexical; a space that switches provider reports its re-index and searches throughout.
- Heap and mount time of one chat tab holding a forty-message conversation with eight agent cards, on a production build (dev-mode reading: 644 MB, not yet meaningful), with the Workbench open.

## 4. Affected packages and contracts

`packages/web-product` (rail, chat empty state, This Computer, Workbench, Store, Integrations, Settings, credentials entry, model picker, operator panel, connection notice, semantic copy), `packages/schemas` (space context: first-run state on the machine block; edition descriptor read by the UI; memory embedding configuration and state), `packages/platform-artifacts` (Store shelf for the local edition; listing copy), `packages/cybernetic-runtime` (Helmsman operating-model section names surfaces as links, from data), `apps/aflow-executor-host` (ref snapshot guard; the appliance CLI's connect verb), `apps/aflow-executor-memory` and `apps/aflow-executor-ai` (embedding provider from space configuration, credential resolution, indexed-or-not marking, re-index), `apps/aflow-orchestrator` (space context carries first-run state), Local Publish skill (existing-branch commit mode).

## 5. Phases

### P0 — Copy and withholding (one PR, no new surface)

Names in the rail's accessibility tree and the hover-slide (D9, F1); _Store_ everywhere (F4); _coding agent_ and _Helmsman_ in every operator-facing string (F9, F10, F11); Repos tab, code-repository option and hosted-only settings tabs withheld where their lane or edition is absent (F12, F13); the connection notice silent on a fresh chat (F2); the realtime origin in `connect-src` (F5).

### P1 — The machine and the credentials on the surfaces (D1, D8)

A machine card on This Computer: hostname, paired state, executor last seen, the coding agent's label, with pair and unpair (F8). A _This computer_ section in the Workbench: folders with mode, commands and publish prefix, the agent (F14). The connect command per edition (F7, D5). Credentials as a rail entry, linked from the model picker, with the picker saying which providers are usable (D8). One reader in the product package for the machine block; the same block Helmsman reads.

### P2 — The design pass (D2, D10, D11, and the questions below)

One pass over the shell so the rail, the Workbench, the operator panel and the chat's empty state are used as one system rather than four. It decides, with a prototype each: whether there is a home across spaces and agents, with a space's chat as that space's landing; whether the Workbench opens by default at desktop width and what it costs; what the empty chat shows when the Workbench carries the guidance (F3, F6, F15); where the operator panel sits and how it opens when something arrives; which settings tabs are dead or hosted-only. Recorded inputs: the walkthrough findings, the Full Circle round's cards and pauses, and the checklist lines from D2. Exit: a written layout with the questions answered, and P3's tickets cut from it.

### P3 — First run as state (D2, D12)

The checklist derived from the space: credentials, paired, folder, local skills, GitHub, embeddings. Shown in the Workbench and after _Create workspace_ in place of "ready to run agents" (F6), pointed at from the empty chat (F3), and given to Helmsman as data in the machine block so its first answer links the surfaces (F9). The Store's local shelf first (F10). The last conversation offered on opening a space's chat (F15). Embeddings per D12: provider and model chosen from present credentials, the lexical-only state visible, re-index on switch with progress.

### P4 — The coding agent's boundary and the branch it may extend (D7)

Ref snapshot before a commission, refusal of a result that moved any other ref. Local Publish appends to an existing branch when `branch` names one, with the commit's base required to be that branch's head; the skill's description says a fix lands on the branch it reviews.

**Delivered**: a commission takes `base` — a branch, tag or commit — and starts its checkout there, reporting it as `baseSha`; `host.file.patch` takes `commit.baseSha` and appends one commit to an existing branch only when that base is the branch's head, refusing a stale base, a branch that moved and a branch some checkout has open, never merging; the coding agent's git is stopped from creating, deleting or moving a local branch or tag by a `reference-transaction` hook the executor owns, set through git's environment config and requiring git 2.28 or later, below which a commission is refused; changes to local branches and tags during a run are reported on the result as `refChanges`, the operator's own included, and no run is refused for them; Local Publish takes the commission's `baseSha` and binds it to `commit.baseSha`, reads the repository through the space's GitHub binding before its approval so a credential that cannot see it fails the run before anything is pushed, and shows the commit — sha, branch, message and files changed — on that approval; a commission's `base` of the form `<remote>/<ref>` naming one of the folder's remotes is fetched before it is read.

### P5 — Measure, then trim (F17)

Production-build heap and mount time for a long conversation with the Workbench open; if the reducer's retained feeds are the cost, completed feeds fold to counts and a stored reference, the card reading the store on open (the path the run page already uses).

## 6. Findings the phases answer

| #   | Surface      | Finding                                                                                                                             | Phase                                |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| F1  | rail         | Collapsed rail names nothing; expanding takes a click and pushes content; no accessible names when collapsed                        | P0 (D9)                              |
| F2  | chat         | Every fresh chat shows "Reconnecting…" although the socket is live; the notice reads a session subscription that does not exist yet | P0 (D6)                              |
| F3  | chat         | Empty-state copy is the hosted product's; nothing about this computer                                                               | P2, P3                               |
| F4  | rail         | "Shop" in the rail, "Store" everywhere else                                                                                         | P0                                   |
| F5  | web          | Report-only CSP `connect-src 'self'` omits the realtime origin                                                                      | P0                                   |
| F6  | onboarding   | "Workspace ready — ready to run agents" is the only post-create step                                                                | P3                                   |
| F7  | computer     | The connect command assumes a source checkout                                                                                       | P1 (D5)                              |
| F8  | computer     | No machine state: paired, executor, coding agent, last seen                                                                         | P1                                   |
| F9  | chat         | Helmsman's first answer links nothing, says "coding harness", asks for push credentials the local push does not use                 | P0 copy, P3 data                     |
| F10 | store        | No local-first shelf; listing copy says "harness"                                                                                   | P0 copy, P3 shelf                    |
| F11 | skills       | "Describe one to the cybernetic agent"                                                                                              | P0                                   |
| F12 | integrations | Repos tab and code-repository option for an absent lane                                                                             | P0 (D3)                              |
| F13 | settings     | Hosted-only tabs shown; credentials buried; tabs unreviewed                                                                         | P0 gating, P1 credentials, P2 review |
| F14 | workbench    | Nothing about this computer                                                                                                         | P1                                   |
| F15 | chat         | Opening a space's chat always starts empty                                                                                          | P2, P3                               |
| F16 | chat         | The first answer ran a memory query before a how-do-I-start question                                                                | P3 (state, not a query)              |
| F17 | perf         | 644 MB heap for one chat tab in dev                                                                                                 | P5                                   |
| F18 | memory       | Embeddings ride a platform credential or fail silently; no per-space provider or model; a switch has no re-index                    | P3 (D12)                             |
| F19 | operator     | Approvals and questions have no place of their own beside the chat                                                                  | P2 (D11)                             |

## 7. Migration and breaking changes

None for the shell. Memory: an existing space's embedding configuration is derived from what it used, and a space whose embeddings rode a platform credential is marked unindexed on the local edition until the operator chooses a provider; its memories stay readable and lexically searchable.

## 8. Test plan

A copy test over the product package for the withheld words on local surfaces; edition-gating tests for Repos, code-repository and the hosted-only tabs; a connection-notice test for the fresh-chat case; the machine-card reader tested against a space context with and without a machine; a ref-snapshot test with a planted `git branch -D` inside a commission; a Local Publish test for the existing-branch case; a golden transcript for the first question in a fresh local workspace; memory tests for write-without-provider marking, lexical-only search reporting, and a provider switch re-indexing while search stays available.

## 9. Open questions

- A home across spaces and agents, or straight to a space's chat: decided in P2 with a prototype, not here.
- Whether the appliance CLI is the executor binary itself (`aflow-host connect`) or a thin `aflow` command that fronts it; pairing already writes `~/.aflow`, so the name is the only decision.
- Whether resuming the last conversation on open is the default for every local workspace or only a personal one.
- Whether an embedding model is chosen per provider (each provider offering its own list) or once per space with the provider implied; D12 assumes per space with the provider's models offered, and re-index cost is the argument for keeping the choice rare.
