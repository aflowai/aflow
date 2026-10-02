# Plan 320 — Agents use a browser

**Status:** 🔨 P0 measured (§8); P1 merged (#47) and on the dev stack — a real-Chrome pass ran against the driver in an installed checkout (open, act by reference, stale reference, read text and network, navigate, list, close; eight routes to a local server through a signed-in profile — seven address spellings including the machine's LAN address, and a public name resolving to loopback — all refused with no request reaching the server). Outline retention is still not built (§9 F9).

**Supersedes for the local edition:** the phase order of archive plans 274 (browser lane) and 310 (browser actions and computer use). Their hosted container backend, deterministic `browser.verify.run` product and native desktop control stay where they are; this plan is what the local edition builds first, and it defines the operation contract a hosted backend would later serve.

## 1. Problem

An agent on this platform cannot open a web page in a browser. Three consequences, each observed in the code rather than assumed:

- **Helmsman and Runner reach the web only as text over HTTP.** `search.web.search`, `search.web.fetch` and `search.web.download` (`packages/schemas/src/operations/search.ts`) are the whole surface. A page that renders in JavaScript, sits behind a sign-in, or has to be clicked through is out of reach, and no operation in the registry is a browser operation.
- **A coding harness never sees what it built.** `host.harness.run` takes `bindingId, harness, task, inputs, outputSchema, resultRetries, base, continueFrom, maxTurns, model, timeoutMs` — no tools, no MCP servers. The harness runs `--bare` with an isolated config directory and a denied home, so the operator's own browser tooling is not inherited, and the lane passes no MCP configuration of its own. A commission that changes a web UI is reviewed as a diff and nothing else.
- **The one local mechanism that could carry a browser cannot hold one.** `host.mcp.call` runs a machine-declared MCP server, but a connection lives for one operation (`apps/aflow-executor-host/src/localMcpClient.ts`): the server is spawned, asked one thing and killed. A browser server would lose its page between two calls. It is also wired to Helmsman only, never into a harness.

Two further gaps sit underneath any fix:

- **A tool result cannot carry an image to the model.** `AiContentPartSchema` is `text | json | ref`, and `aiMessageToChatMessage` keeps only text and JSON, so a screenshot reaches a model as nothing. `@aflow/ai-client` already has an image content part; the agent-turn path does not use it.
- **Chrome does not start inside the host lane's sandbox.** Under `@anthropic-ai/sandbox-runtime` with the lane's policy shape it aborts creating its process singleton, and it still aborts with the user temp directory writable, unix sockets allowed and its own sandbox off (§8.1). So "let the harness run its own browser inside its sandbox" is not available, and neither is confining the agent's browser the way a command is confined.

### What the products this competes with do

xAI's Grok Bot and OpenAI's dots are the same product shape: a named, persistent agent with **its own computer and browser**, signed in to the operator's accounts, working on a schedule while the operator is away, and returning for approval before consequential actions.

|                        | Grok Bot                                                                                            | dots                                                                                       | What it means here                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Where the browser runs | A cloud VM per user; every Bot shares its files, browser sessions and logins                        | A hosted computer and browser per dot; optional separate access to the operator's laptop   | The local edition already has the computer: the operator's machine, reached by the paired host executor |
| Sign-in                | The operator signs in on the agent's machine; secrets go through a masked flow the model never sees | Apps connected by the operator; password changes always stay with the person               | A profile the agent owns, signed in by the operator, with credential entry kept out of the model        |
| Reaching an app        | Connector first, MCP second, browser last — the vendor's own recommendation                         | 4,000+ connected apps first, browser otherwise                                             | The browser is the fallback for what no API or MCP binding covers, not a way around one                 |
| Autonomy               | Approval rules for sending, publishing, deleting, purchasing                                        | Built-in rules, operator Custom Rules (allow / block / ask), read-only while self-directed | An operator-chosen posture, enforced on something the platform can actually observe                     |
| Watching               | A screen per Bot                                                                                    | "Open the dot's computer" at any time                                                      | The browser is a real window on the operator's own desk                                                 |
| Learning a task        | Demonstrate it once; a draft skill results                                                          | —                                                                                          | A browser run that succeeded is material for a skill                                                    |
| Stated weakness        | No isolation between Bots; action audit promised, not shipped; prompt injection "unsolved"          | Closed runtime, no model choice; unproven over weeks                                       | Audit and model choice are things this platform already has                                             |

### How coding agents drive a browser today

Three mechanisms are in use, and they are not interchangeable:

- **A browser MCP server** — Playwright MCP or Chrome DevTools for agents. The page is observed as an accessibility snapshot whose elements carry references the model acts on; screenshots are selective. It launches its own Chrome with a persistent profile, an isolated one, or attaches to a running browser over CDP. It works headless and unattended. Both projects now also ship a CLI-plus-skill form, because tool schemas and whole-page snapshots are expensive in a coding agent's context.
- **A vendor extension in the operator's own Chrome** — Claude in Chrome, the Codex Chrome extension. It carries the operator's real sign-ins, and that is its value. It also needs a visible Chrome, an interactive account login (Claude Code keeps it off under an API key), and a person nearby: it pauses on a sign-in page, and its service worker drops on a long idle session.
- **Screen-level computer use** — screenshots and synthetic input. The slowest of the three; the only one that reaches native applications.

The second cannot serve an unattended harness run and the third is a different capability. The first is the mechanism this plan builds on.

## 2. Decisions

**D1 — The agent has its own browser on the operator's machine.** The host executor owns a Chrome process per **browser profile**: a persistent user-data directory under the host directory (`~/.aflow/browsers/<id>`, owner-only), signed in by the operator, kept across restarts. It is never the operator's daily profile. _Rejected:_ attaching to the operator's own Chrome through an extension — it borrows every account the operator has rather than the ones they chose to give, needs a visible window, and Chrome refuses remote debugging on its default profile. _Rejected:_ a container browser as the first backend (274) — it has no display for the operator to sign in on and no route to a dev server on the operator's loopback, which are the two things the local edition needs most. The container remains the hosted backend.

**D2 — One browser, two consumers, one policy point.** Platform agents and coding harnesses reach the same executor-owned browser through the same code: the executor drives Chrome, and both the operation handlers and the harness-facing MCP endpoint call that one driver. Posture, origin rules, hand-off, audit and artifact capture are therefore written once. _Rejected:_ the harness launching a browser MCP server inside its own sandbox — a second browser with no shared sign-in and no policy point, on a path where Chrome is measured not to start. _Rejected:_ the harness's native browser integration — it needs the account login, extension and visible window the lane's isolation exists to remove.

**D3 — Browser actions are operations, one step each.** A new step type `browser`, group `page`, with a small typed vocabulary (§3.2). Helmsman and Runner call them as tools in their own turn, the way a coding agent calls its browser tools. A stateful resource across steps is not new here: a compute session is keyed by run, a harness session is continued by handle, a host process is addressed by handle. _Rejected:_ 274's black-box browser harness with its own inner model loop — it was chosen because per-action steps "would pin a live browser across stateless dispatches", which the three precedents above already do; and it puts a second agent loop, a model broker and separate cost accounting between the agent and the page. _Rejected:_ exposing Playwright MCP through `host.mcp.call` with a kept-alive connection — the tools arrive untyped (`arguments: unknown`, `content: unknown`), so nothing can be gated, receipted or validated per action, and the catalog cannot teach their use.

Per-action steps also remove 274's frame-manifest problem: payload identity is per step execution, so one screenshot per step never collides with another.

**D4 — The step type is `browser`, and the local backend lives in the host executor.** A skill written against `browser.page.*` runs unchanged when a hosted backend exists. The host executor registers a second step handler for it, as the AI executor does for `search`. _Rejected:_ `host.browser.*` — it would name the machine in the contract and fork every skill by edition. Operations take a `profileId`, never a `bindingId`: a profile is not a folder.

**D5 — A profile is declared on the machine, like a harness.** `HostPolicy` gains `browsers` — optional on read, so a policy file written before this plan loads unchanged — edited only from the machine (`aflow browser …`) and relayed in the host inventory. Each profile names the spaces that may use it, its posture (D7) and its origin rules. The workspace addresses a profile by id and cannot introduce one, move its directory or change its posture. Pairing and `yarn start` declare a `default` profile when a supported Chrome is found, open to every space the machine serves, so a paired local edition has a working browser without a setup step. A further profile can be pinned to one space when the operator wants its sign-ins kept apart. _Rejected:_ one profile per space by default — a single operator would sign in to the same accounts once per space, which is the friction this plan exists to remove; separation is there for the operator who asks for it.

**D6 — Pages belong to runs; sign-ins belong to the profile.** One Chrome process serves a profile; each run owns the pages it opened and can address no others. A chat session keeps one run id across turns, so Helmsman's pages persist through a conversation; a workflow run keeps its pages across its tasks. Pages are held in memory, like process handles and harness sessions and for the same reason. A page closes when its run closes it or when nothing has touched it for the profile's idle limit; the executor is not told when a run ends, so the idle limit is what bounds an abandoned page. An executor restart loses pages and keeps sign-ins; an operation on a lost page fails with `page_gone` and the URL it was last at. A harness run that asks for a browser gets an **ephemeral** profile by default — a throwaway directory, no sign-ins — which is what verifying a dev server needs; it reaches a signed-in profile only when the profile's own policy admits harness use.

**D7 — Autonomy is a posture on the profile, enforced by origin.** The operator chooses, per profile, one of three postures, with per-origin rules that override it:

- `autonomous` — navigation, reading and interaction all run without asking. **The default for a local-edition profile.**
- `ask-to-act` — reading and navigation run; every interaction pauses for the operator.
- `read-only` — interaction is refused.

An origin rule is `{ origin pattern, effect: allow | ask | deny }`. The gate is the origin of the page being acted on, which the executor knows exactly, and never a judgement about whether a click is "consequential". _Rejected:_ approving by semantic class (send, purchase, delete), as both products describe — nothing on the platform can decide that class from a click, so the agent would be assigning its own risk tier. _Rejected:_ gating on intercepted non-GET requests — a modern page issues them continuously, so it is a prompt per click on some sites and silence on a form posted by GET; request capture is kept as audit evidence instead. _Rejected:_ 274's opt-in default OFF behind Full Access — correct for a hosted multi-tenant browser, and exactly the friction the local edition is meant not to have. What the operator consented to is which accounts they signed the agent's profile into; the posture and the origin rules are how they narrow it.

An `ask` pauses inside the executor's step with a durable resume contract, on the same executor-step pause path the write approval uses. Its grant is minted only at the authenticated operator boundary (`pausedStepSource.resolve`), keyed by run and request hash — the hash covering profile, page origin, element reference and name, action and the value's digest — and an agent-driven or scheduled resume is refused. The approval payload becomes a discriminated union — the existing API-shaped variant and a browser variant carrying origin, page title, the element's role and accessible name, a summary of the value being entered and a screenshot reference. It reuses the Action Center card and the grant-minting path; there is no second inbox.

**D8 — Credentials are entered by the operator, in the window.** An agent never types a password, a one-time code or a CAPTCHA answer. `browser.page.handoff` pauses the step, shows the profile's window on the operator's desk with the page that needs them, raises one Action Center item, and resumes when the operator says done. This is the capability 274 ruled out — it had torn the browser down by then — and the local edition has it for free, because the browser is on the operator's machine. Chrome cannot change between headless and windowed while running, so a hand-off restarts the profile's browser windowed at the same URL and returns it afterwards; sign-in survives the restart because it is on disk, and other runs' pages are reported `page_gone`. A profile may instead run windowed permanently (`window: visible`), which is also the live view.

**D9 — The page is read as an outline; the rest is asked for.** A whole-page accessibility snapshot with element references measures 12,000–154,000 tokens on five ordinary pages, median 18,000 (§8.3) — one page would take most of an agent turn's context and ten actions would exhaust it. The same pages reduced to their interactive elements and headings measure 1,000–14,000, median 2,200. So every navigation and interaction returns that **outline** — each interactive element and heading with its reference, in document order — plus a receipt of what changed (URL, title, whether the outline differs). `browser.page.snapshot` returns the full subtree under one reference, `browser.page.read` returns page text, and `browser.page.screenshot` returns an image as a payload reference. An outline over the result bound is cut at the bound and ends with a census of what was withheld, by role and by landmark, so the agent can ask for the region it needs. The bound is a named default (32,000 characters) the profile can raise. The agent turn keeps the newest outline per page in context and reduces older ones to their receipt.

**D10 — A tool result can carry an image.** `AiContentPartSchema` gains an image part resolved from a payload reference, and the agent-turn conversion passes it to `@aflow/ai-client`'s existing image content part. Whether a model accepts images in a tool result is catalog data and is measured per model; for a model that does not, the conversion substitutes the reference's summary. Anthropic takes the images as image blocks inside the tool result; OpenAI, xAI, OpenRouter, Fireworks and Google take the tool result as text naming the image, followed by a user message carrying the images, each labelled with the tool call it came from.

**D11 — The harness receives the browser as an MCP server the executor answers.** `host.harness.run` gains `browser: { profile: 'ephemeral' | <profileId> }`. The harness is handed, through a profile-declared argument template (`mcpArgs`, beside `sessionArgs` and `modelArgs`), a stdio MCP server whose tools are the `browser.page.*` vocabulary derived from the same Zod schemas. That server is a relay with no browser of its own: it runs inside the harness's sandbox and passes each call to the executor over a pair of named pipes in the run's scratch directory, and the executor's driver performs it. A harness profile without `mcpArgs` refuses a run that asks for a browser, naming the missing field. Each harness browser call appears in the run's activity feed like any other tool line, and the action log is stored as a payload beside `activity` and `patch`.

Claude Code under the lane's flags loads a server handed to it this way (§8.2). _Rejected:_ a loopback HTTP endpoint on the executor — the sandbox reaches loopback only with `allowLocalBinding`, which opens every local port to the harness, the stack's Redis and Postgres among them (§8.2). _Rejected:_ a unix socket — the lane forbids the option by name. Named pipes are files in a directory the run may already write, so the boundary is not widened at all.

**D12 — A signed-in profile cannot reach this machine's own services, and the refusal is made at the connection.** The local edition's web application has no browser login: it presents the instance secret for whoever reaches its port, so any page loaded from it is the owner's Action Center, and an agent that could load it could approve its own requests. Confined workloads are kept from it by the sandbox, which refuses loopback (§8.2); Chrome runs outside the sandbox (D15), so it needs its own refusal. Every profile that persists sign-ins sends all its traffic through an egress proxy the executor runs for it, and the proxy refuses any destination that resolves to a loopback, unspecified or link-local address, or to one of this machine's own interface addresses, on any port. The check is on the resolved address at connect time, so it holds for a redirect, a page that navigates itself after load, a subresource, a WebSocket, and a public name that resolves to loopback. The same proxy is where an origin `deny` rule is enforced (D7). _Rejected:_ comparing the page's URL against a list of the appliance's ports — the port is configurable, loopback has many spellings, a name can resolve to it, and a check made once after load is passed by a script that navigates later. _Rejected:_ a header marking the agent's browser for the appliance to refuse — it would announce the automation to every site visited. An ephemeral profile is not proxied away from loopback, which is what lets a harness verify a dev server and this product's own UI: it carries no sign-ins, and the harness that drives it is the one P3 wires.

**D13 — An action is never replayed.** Interaction operations are non-idempotent. A redelivered action whose outcome is unknown returns `uncertain_outcome` with a fresh snapshot of the page as it now stands, and the agent reconciles from what it can see. A stale element reference is a failure naming the reference and carrying the current snapshot. An interaction that changed nothing says so in its receipt, and one that could not find its target is a failure, so the loop guards that count failures see both.

**D14 — The browser is preferred last.** The operations' `whenToUse` and `pitfalls` state the order both products recommend: a bound API or MCP tool first, `search.web.fetch` for a public page that reads as text, the browser otherwise. No prompt paragraph carries this.

**D15 — Chrome runs as the operator, outside the lane's sandbox, started by the executor.** It cannot start inside it (§8.1), so it runs unconfined with its own sandbox on, pointed at the profile's directory and nothing else. The executor spawns it through the lane's own supervised unconfined spawn, with a named minimal environment — no job-supplied variable, and none of the tokens the git transport environment carries — so it is in the process table that withdrawal, shutdown and the next boot's journal already cover; `playwright-core` then attaches to it over CDP rather than launching it. _Rejected:_ letting the library launch Chrome — the process would sit outside every registry the lane keeps, which is the failure `localMcpClient.ts` records for the MCP SDK's own transport. The CDP endpoint listens on loopback at a port Chrome picks; a sandboxed workload cannot reach loopback (§8.2), and a same-user process outside the sandbox could already read the profile directory. What bounds the browser is therefore not the operating system: it is the profile's directory, the posture, the origin rules and Chrome's own sandbox, and the profile's disclosure says so.

**D16 — Giving the agent access is one sitting, and nothing is asked twice.** §3.6 is the contract: a browser exists at pairing; the operator signs in to whatever the agent should reach in one window, at any time, without a run waiting; the agent is told as data which sites hold a session; a lapsed session costs one Action Center item and no failed run.

## 3. Design

### 3.1 Pieces

```
Helmsman / Runner ──► browser.page.* step ──► jobs:browser ──┐
                                                             ▼
                                          host executor: BrowserHandler
                                                             │
coding harness ──► MCP tools (per-run endpoint) ──► browser driver ──► Chrome (profile)
                                                             │
                              posture + origin rules · hand-off · audit · payloads
```

The **browser driver** is one module in `apps/aflow-executor-host`: it starts and stops a profile's Chrome (D15), owns the page table keyed by run, applies posture and origin rules, takes outlines, snapshots and screenshots, and writes the action record. It drives the operator's installed Chrome through `playwright-core`; the plan bundles no browser.

### 3.2 Operations

Step type `browser`, group `page`, capability group `browser.page`.

| Operation                 | Access | What it does                                                                                |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `browser.page.open`       | write  | Open a page at a URL in the run's profile; returns `pageId`, snapshot, receipt              |
| `browser.page.navigate`   | write  | Go to a URL, back, forward or reload                                                        |
| `browser.page.snapshot`   | read   | The current accessibility snapshot, optionally scoped to one element                        |
| `browser.page.read`       | read   | Page text, console messages or network requests, each bounded and filterable                |
| `browser.page.screenshot` | read   | An image of the page or one element, as a payload reference                                 |
| `browser.page.act`        | write  | One interaction — click, type, select, press, hover, upload, drag — on an element reference |
| `browser.page.handoff`    | write  | Pause for the operator to sign in or pass a challenge in the window                         |
| `browser.page.list`       | read   | The run's open pages                                                                        |
| `browser.page.close`      | write  | Close a page                                                                                |

Beside them, `browser.profile.list` (group `profile`, read) returns the profiles the space may use, each with its posture and the sites that hold a session (§3.6).

Uploads take a path inside a connected folder the run may read; downloads land in a per-run scratch directory and are returned as payload references. Script evaluation in the page is available to the harness-facing endpoint on an ephemeral profile only, where console-level debugging is the point; it is not a platform-agent operation.

Loading a page runs its scripts with the operator's sessions, so opening and navigating are writes: not idempotent, never retried, and outside what a read-only capability profile may do. The `read` operations observe a page that is already open. What bounds either is the profile, not the access mode: a space reaches only the profiles open to it.

### 3.3 Reach and readiness

- **Edition.** `EditionDescriptor` carries `browserLane`, present exactly when the host lane is. `isStepTypeComposed` reads it for `browser`, so a hosted build offers nothing it cannot run. Whether the paired machine has a usable Chrome is not known to the descriptor; a machine without one answers the first operation with where it looked and what counts.
- **Helmsman.** `browser.page.open` joins the local pinned set and the rest are promoted together as the `browser` bundle, so the every-turn cost is one operation.
- **Runner.** A task declares the operations in its capabilities, as with any other; compose-skill can author them.
- **Capability profiles.** Tenant migrations append `browser.page` and `browser.profile` to the system profiles — read and write for Full Access, Standard and Personal Safe. Personal Safe is what a space on the local edition holds, and what bounds a browser operation is the profile on the machine — which spaces may use it and what its posture lets an action do — not a second opinion in the capability profile. Read Only receives nothing: every observation needs a page, and opening one is a write.
- **Readiness.** The host inventory reports each profile's id, posture, whether Chrome is running, and the sign-in state the operator last confirmed. The web product shows it on the page where the machine's folders and harnesses already are, gated on the local edition.

### 3.4 Unattended work

The host executor already runs as a login service. A scheduled or resident run that needs the browser starts the profile's Chrome headless on demand. Three things keep that from failing silently:

- A sign-in that has lapsed surfaces as an operator task through `browser.page.handoff` — one Action Center item saying which site and why — and the run waits on it rather than failing or retrying.
- A profile carries `unattended`, default true. Until a job carries whether a person started its run, `unattended: false` is refused when the policy file is parsed, because nothing could keep that promise. Enforcement follows: then, when false, a run with no operator-initiated trigger is refused before it opens a page.
- Chrome stops after the idle limit and the profile's directory is the only thing that persists. The idle check is a background task registered in `packages/schemas/src/background/registry.ts` and run on `createBackgroundTaskRunner`; its work is the set of running profiles on this executor, so its idle cost does not grow with spaces or runs.

### 3.5 What is recorded

Every action — from a step or from a harness — produces one record: run, profile, page, origin, URL with query values redacted, action, element role and name, outcome. For platform agents the record is the step; for a harness it is a line in the stored action log. Typed text is recorded by length and field name, not by value. The disclosure shown when a profile is created says what a signed-in agent browser is: it acts with the accounts signed into it, page content is untrusted input to the model, and no rule here makes prompt injection impossible.

### 3.6 Setup and access

What the operator does, in full:

1. **Nothing, to get a browser.** Pairing declares the `default` profile. The machine page in the web product shows it beside the folders and harnesses, with its posture and whether Chrome was found. A machine with no supported Chrome says which browsers count and where it looked.
2. **One sitting, to give it accounts.** `aflow browser sign-in` on the machine, or **Sign in to sites** on the machine page, opens the profile's window. The operator signs in to whatever the agent should reach — as many sites as they like — and closes the window. No run is waiting and nothing is asked per site. This is an operator action dispatched to the host executor, not an agent operation.
3. **Nothing, to tell the agent what it can reach.** `browser.profile.list` (read) returns each profile the space may use with its posture and the sites that hold a session — cookie-bearing origins by name, never a value — and when each was last used successfully. The agent's context carries the same list as data, so it knows a task is reachable before it tries and asks for a sign-in before it starts work rather than halfway through.
4. **One item, when a session lapses.** `browser.page.handoff` raises a single Action Center item naming the site and the task that needs it. The run waits. When the operator has finished in the window the executor sees the page leave the sign-in origin and resumes the run; a **Done** on the item does the same. A second run that needs the same site joins the item already open rather than raising another.
5. **A command, to narrow it.** `aflow browser posture` and `aflow browser rule` change posture and origin rules, on the machine only, as the push posture is changed.

Three things keep this from needing a person later:

- **Driving Chrome over CDP needs no operating-system grant.** No Accessibility or Screen Recording permission is involved, unlike screen-level computer use, so nothing is prompted the first time or after an update.
- **In-browser prompts are answered by policy at launch**: notifications and geolocation denied, downloads sent to the run's scratch without a dialog, the default-browser and restore-session prompts off.
- **A saved password is the operator's to offer.** If the operator saves a site's password in the agent profile's own Chrome, Chrome fills the sign-in form and the agent presses the button; the value is never in an outline, a snapshot or a screenshot, because password fields are masked at capture. Whether Chrome fills in a headless profile is measured in P2 before this is described as working.

_Rejected:_ importing sign-ins from the operator's own Chrome profile. It would hand over every account at once, which is the decision D1 keeps with the operator, and the cookies are encrypted to a key the daily profile owns.

## 4. What it affects

- `packages/schemas` — `browser` in the step-type enum; `operations/browser.ts` and its registration; the image content part; the approval payload union; `browserLane` and composed-operation gating; the `host.harness.run` input and output; a capability bundle.
- `apps/aflow-executor-host` — the driver, the step handler, the per-run MCP endpoint, `browsers` in the machine policy, `aflow browser` CLI, harness `mcpArgs`, inventory fields. `playwright-core` as a dependency.
- `apps/aflow-executor-ai` — image parts in tool results; snapshot retention in the agent-turn context.
- `apps/aflow-orchestrator` — the browser approval variant on the existing pause and resolve path.
- `packages/platform-artifacts` — Helmsman's local pinned set.
- `packages/database` — the capability migration.
- `packages/redis` — host inventory fields.
- `packages/web-product` — the profile list and posture display, the hand-off and approval cards, screenshots in the run view.

No stored data changes shape. The approval payload schema changes for every producer and consumer in one pass.

## 5. Phases

**P0 — Measure the three unknowns.** ✅ Done; the answers and the commands that produced them are §8. They settled D9 (outline, not whole-page snapshot), D11 (named pipes, not loopback) and D15 (Chrome outside the sandbox).

**P1 — Platform agents browse.** One pull request, built in two commissions on one branch.

- _P1a — the driver and `browser.page.open`._ The `browser` step type and its job stream, `browsers` in the machine policy with the `default` profile declared at pairing, the driver (supervised Chrome, CDP attach, page table by run, outline), the step handler in the host executor, `browserLane` and composed-operation gating, the capability migration, and `page_gone`. ✅ Built.
- _P1b — the rest of the vocabulary._ `navigate / snapshot / read / act / list / close`, `browser.profile.list`, posture `autonomous` and `read-only`, origin `allow` and `deny`, the egress proxy of D12, D13, outline retention in the agent turn, Helmsman's pinned operation, the idle task. ✅ Built, except outline retention (§9 F9): the seven operations; every signed-in profile behind its own egress proxy, which resolves each destination itself and refuses loopback, unspecified, link-local and this machine's own addresses on any port and the hosts a `deny` or `ask` rule names, with Chrome given `--proxy-bypass-list=<-loopback>`; postures `read-only` and `ask-to-act` and rules `ask` refusing an action with "not available yet" until P4; a redelivered act or navigate returning `uncertain_outcome`; console and network kept per page in bounded buffers with query values redacted; `idleMinutes` on the profile and the `host.browser_idle` task; `browser.page.open` pinned for the local Helmsman with the rest promotable as the `browser` bundle; `browser.page.open` a write, and Read Only granted nothing.

_Exit:_ on a paired local edition with no setup beyond pairing, Helmsman completes a task on a JavaScript-rendered public site that `search.web.fetch` cannot read, and a Runner task does the same from a skill. Killing the executor mid-task yields `page_gone`, not a hang.

**P2 — Signed-in work and seeing.** The operator sign-in sitting (§3.6), `browser.page.handoff` with its shared item and its resume on leaving the sign-in origin, the windowed restart, `browser.page.screenshot`, image parts in tool results, sign-in state in the inventory, the profile surface in the web product.

_Exit:_ the operator signs in once through a hand-off; a later run, started by a schedule with nobody present, reads from that account. A model that accepts images describes a screenshot correctly; one that does not receives the summary.

**P3 — The harness gets the browser.** `host.harness.run`'s `browser` input, the relay server and its pipe pair, `mcpArgs` on the Claude Code profile, the ephemeral profile, the action log payload, script evaluation on ephemeral profiles.

_Exit:_ a commission that changes a page in this repository's own web UI opens it on the dev server, finds a deliberately planted visual defect that the diff alone does not show, and reports it with a screenshot.

**P4 — Asking.** Posture `ask-to-act`, origin `ask`, the browser approval variant, its Action Center card.

_Exit:_ on an `ask` origin, an interaction pauses with a preview the operator can judge; approval performs that interaction and no other; denial reaches the agent as a non-retryable permission error with the operator's reason; a scheduled resume cannot approve.

**P5 — A run becomes a skill.** A completed browser task is offered to compose-skill as the material for a draft skill, proposed through the existing ratification path. Demonstration by the operator in the window, recorded and drafted the same way, follows only if the first form proves useful.

_Exit:_ a task done once by Helmsman is re-run as a ratified skill by a schedule.

Deferred, not planned here: a hosted backend for the same operations (274's container), 274's deterministic assertion-script product, native desktop control (310 P4), and a live screencast in the run view.

## 6. How it is proven

- **The dedicated profile is the boundary.** A run addressed to a profile declared for another space is refused; a run cannot name a user-data directory.
- **Pages are per run.** Run B, given run A's `pageId`, is refused.
- **Posture is enforced where the page is, not where the agent says.** A page that redirects from an `allow` origin to a `deny` origin is stopped at the redirect; an `act` on an `ask` origin pauses even when the agent's stated intent names a different site.
- **No self-approval.** Through a signed-in profile, the appliance's web port is unreachable when asked for by loopback name, by `[::ffff:127.0.0.1]`, by the machine's LAN address, on a non-default port, through a redirect, by a script that navigates after load, and through a public name resolving to loopback; the test fails if any of them returns the page.
- **Credentials stay out of the model.** After a hand-off, no step input, output, payload, activity line or model message contains the value typed; a planted password is searched for across all of them.
- **No replay.** With a fault injected after an interaction is sent and before its result is written, redelivery returns `uncertain_outcome` and the fixture site records exactly one submission.
- **No unbounded loop.** An interaction against a stale reference is a failure; five identical ones trip the existing repeated-decision pause.
- **The harness path shares the policy.** The same `deny` origin is refused through the MCP endpoint and through the operation, by one test parameterised over both.
- **The relay widens nothing.** The compiled sandbox policy of a harness run with a browser is byte-identical to one without, apart from the scratch directory it already had.
- **The agent's browser is where the lane can reach it.** Withdrawing the machine's pairing or stopping the executor leaves no Chrome process for the profile; the test fails on a surviving one.
- **Injection is measured, not claimed.** A fixture suite of pages carrying instruction-shaped content runs against each posture and reports the attack success rate beside the task completion rate; the numbers are published with the feature rather than a statement that it is safe.
- **Guards.** A contract test fails if a `browser.page` operation with an interaction verb is registered idempotent, and another if a non-local edition composes the lane without a backend.

## 7. Open questions

- Whether Codex belongs in the known harness profiles. It is absent today, and D11's `mcpArgs` is written so that adding it is data rather than code; the argument shape it needs is unmeasured.
- How the resident agent of archive plan 299 accounts for browser work in its attention and spend budgets. This plan gives it the operations and the operator task for a lapsed sign-in; the budgeting is 299's.

## 8. P0 measurements

Measured on macOS (Darwin 25.3), Chrome stable, `@anthropic-ai/sandbox-runtime` 0.0.77, Claude Code 2.1.287, `playwright-core` 1.63. Each probe ran the lane's launcher (`node <sandbox-runtime>/dist/cli.js -s <settings> -- <argv>`) with the policy shape `compileSandboxPolicy` emits — home denied for reading, one scratch directory readable and writable — and `HOME` and `TMPDIR` inside that scratch, as the lane sets them.

### 8.1 Chrome inside the lane's sandbox

Command: `Google Chrome --headless=new --user-data-dir=<scratch>/profile --no-first-run --disable-gpu --dump-dom https://example.com`, with `example.com` as the one allowed domain.

| Policy                                                              | Result                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| As the lane compiles it                                             | exit 21 — "Failed to create socket directory", no process singleton |
| + `allowLocalBinding`                                               | exit 21, the same                                                   |
| + `allowAllUnixSockets`                                             | exit 21, the same                                                   |
| + the user temp directory (`getconf DARWIN_USER_TEMP_DIR`) writable | exit 21 — `bind()` on the singleton socket: operation not permitted |
| + temp directory + `allowAllUnixSockets`                            | exit 1 — "Check failed: Operation not permitted"                    |
| + temp directory + unix sockets + `allowLocalBinding`               | exit 1, the same                                                    |
| + temp directory + unix sockets + Chrome's `--no-sandbox`           | exit 1, the same                                                    |
| + temp directory + unix sockets + `enableWeakerNestedSandbox`       | exit 1, the same                                                    |
| Unconfined, own sandbox on, dedicated profile directory (control)   | the page's DOM                                                      |

Chrome keeps its singleton socket in the Darwin user temp directory whatever `TMPDIR` says, which is also where every harness worktree lives, so even the first widening would hand the browser the other runs' checkouts. Past that it fails on something the sandbox refuses that none of the available options grants. Two of the options tried are ones the lane forbids by name. **Answer: Chrome is not confined by the lane (D15).**

### 8.2 The harness's route to the executor

A server listening on `127.0.0.1` outside the sandbox, `curl` inside it:

| Policy                                               | Result           |
| ---------------------------------------------------- | ---------------- |
| As the lane compiles it, through the sandbox's proxy | refused (exit 7) |
| As the lane compiles it, `--noproxy '*'`             | refused (exit 7) |
| `allowedDomains: ['127.0.0.1']` or `['localhost']`   | refused (exit 7) |
| `allowLocalBinding: true`                            | 200              |

`allowLocalBinding` is not scoped to a port. With it, a harness reaches everything the machine listens on.

A pair of named pipes made with `mkfifo` in the scratch directory, a process outside the sandbox reading one and answering on the other, `sh -c 'echo hello > req.fifo; cat res.fifo'` inside it under the unwidened policy: the reply `echo:hello` arrives. **Answer: the relay speaks to the executor over named pipes in scratch (D11).**

`claude --permission-mode bypassPermissions --bare --output-format stream-json --verbose --mcp-config <file> --strict-mcp-config -p …`, with a stdio server declared in that file: the init event reports the server `connected` and lists its tool, and the model calls it and reads the result. **Answer: Claude Code under the lane's flags takes an MCP server by argument.**

### 8.3 What a page costs to read

`playwright-core` against the installed Chrome, viewport 1280×800, tokens estimated at four characters each:

| Page                    | Whole page, with references | Whole page, plain | Interactive elements and headings | Visible text |
| ----------------------- | --------------------------- | ----------------- | --------------------------------- | ------------ |
| Wikipedia article       | ~33,700                     | ~18,700           | ~3,800                            | ~5,100       |
| Hacker News front page  | ~11,900                     | ~10,000           | ~2,200                            | ~1,000       |
| GitHub repository page  | ~18,100                     | ~11,800           | ~2,200                            | ~2,700       |
| MDN reference page      | ~153,800                    | ~72,800           | ~13,600                           | ~14,000      |
| react.dev tutorial page | ~11,700                     | ~6,400            | ~1,000                            | ~3,300       |

The outline column is the plain snapshot filtered to interactive roles and headings; with references it will be somewhat larger, and P1b records the real figure. **Answer: the default observation is the outline, bounded, with the region and the text asked for separately (D9).**

## 9. Findings

Gaps met while driving this plan through the loop, numbered in this plan's own series. Loop gaps already logged are in Plan 315 §6 and are not repeated here.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                              | State |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| F1  | **A session opened in this repository has no `aflow-local` MCP server.** The registration lives in the operator's per-project client configuration for the old checkout path, and this repository carries no `.mcp.json`. The driving session reached the server by speaking MCP over HTTP by hand.                                                                                                                  | open  |
| F2  | **A commission cannot add a dependency.** Its checkout mirrors the connected folder's `node_modules` and has no registry egress, so a new package can be neither installed nor resolved. `playwright-core` was declared and locked by hand on the branch before the commission, the agent was told its one unresolved import was expected, and the typecheck that covers it ran afterwards in an installed checkout. | open  |
| F3  | **`yarn test:file` does not run in a commission's checkout.** Corepack needs the network to provide the pinned Yarn, and the test runner does not resolve `@aflow/*` there. The agent ran Vitest directly through a temporary source-condition config. The protocol's brief names a check the agent cannot run as written.                                                                                           | open  |
| F4  | **A review over `origin/main..sha` reads main's newer work as reverted** when the branch forked before main moved; the reviewer noticed and reviewed from the merge base. Merging main into the branch before the review removes it; that merge was made by hand here. Plan 315 F66 is the same gap seen from the push side.                                                                                         | open  |
| F5  | **Helmsman's first read of a harness result guesses a field that is not there** (`/data`), fails, and recovers from the refusal's field list. One wasted step per commission.                                                                                                                                                                                                                                        | open  |
| F6  | **A stale-reference failure carries only the start of the current outline.** `toAgentToolError` bounds an error's details to `AGENT_ERROR_DETAILS_MAX_CHARS` (2,048), so the outline D13 puts in the failure reaches the model cut to about 2,000 characters, against an outline bound of 32,000. The agent can take a snapshot to see the rest.                                                                     | open  |
| F7  | **A commission's sandbox cannot run the egress proxy's tests or the policy-watch tests.** Listening on `127.0.0.1` or `::1` is refused (EPERM) and `fs.watch` fails (EMFILE). A per-workspace `tsc -p` also needs every referenced workspace built first, and the orchestrator imports `@aflow/authz` without a project reference to it.                                                                             | open  |
| F8  | **`browser.profile.list` names cookie domains, not registrable sites.** The host executor has no public-suffix list, so a site is the cookie's own domain with its leading dot dropped (`mail.example.com` and `example.com` can both appear). `tldts` is in the tree, but only as a transitive dependency, and a commission cannot add one (F2).                                                                    | open  |
| F9  | **The agent turn has no seam for superseding an older tool result.** History clearing (`ConversationStateStore.clearUnderPressure`) runs only above 55% context pressure, never touches the three newest turns, and replaces a whole exchange with its own note, so D9's "the newest outline per page, older ones reduced to their receipt" is not built.                                                            | open  |
| F10 | **The context-budget guard does not see the local Helmsman surface.** `scripts/context-budget/scan.ts` prices the authored agent definition, not `composeHelmsmanSurface`'s local composition, so pinning `browser.page.open` locally (+259 tokens, 25 → 26 tools, measured through `buildToolSurface`) passes unmeasured.                                                                                           | open  |
| F11 | **§3.3 grants `browser.page` only, but `browser.profile.list` is in the `browser.profile` group.** Migration 215 grants Full Access and Standard both groups; without the second, every space would be refused the profile list.                                                                                                                                                                                     | fixed |
| F12 | **A secret-scan hit on a test fixture strands the branch.** `?token=abc123` in a test URL matched `secret-assignment`; the scan's remedy is to commission the change again on a fresh branch, which repeats the whole commission for a one-word change. The fixture was changed and the unpushed commit amended by hand.                                                                                             | open  |
| F13 | **The scan task fails its own projection when it finds something.** `host.commit.scan` reported `PROJECTION_FAILED` on `unflaggedRange` and `receipt` beside the finding, so the finding arrives through an error path.                                                                                                                                                                                              | open  |
| F14 | **A test that needs a listener cannot run in a commission, and the defect it guards shipped.** The proxy's plain-http forward connected to localhost:80; the test that catches it could not open a socket in the sandbox (F7) and was reported unrun. It was caught by running the suite in an installed checkout.                                                                                                   | open  |
| F15 | **Each review pass finds defects in code an earlier pass had already read.** The refusal-attribution leak was in the range the second review read and called `comment`; the third review, over the same code plus a fix-up, raised it as major. A publication is therefore a loop of unknown length, each turn a full commission.                                                                                    | open  |
| F16 | **CI failed on a timing-sensitive test in a workspace the change does not touch.** `sandboxPidsLimit.test.ts` waited 500 event-loop turns for a spawn that follows real filesystem work; a loaded runner did not get there. Other pull requests the same week failed on other timing assertions. The wait was changed to a deadline in this pull request.                                                            | fixed |
| F17 | **The first live call was refused by the capability profile.** Every space on the local edition holds Personal Safe, and migration 215 granted Full Access and Standard, following the general rule; the host lane's own migrations had already met this. No check in the loop exercises an operation against the profile a real space holds.                                                                        | fixed |
| F18 | **`unattended` is not enforced.** Enforcing it needs the fact of what started a run carried to the executor, which reaches past the job envelope; until then `unattended: false` is refused when the policy is read.                                                                                                                                                                                                 | open  |
| F19 | **Two streams took the same migration number.** A commission takes the next number from its base when it starts; another stream's pull request merged the same number while it ran, and the collision showed only as a conflict on GitHub after the push.                                                                                                                                                            | open  |
