# Plan 324 — Helmsman finds capabilities without carrying them

**Status:** Implemented. Placement, shared resolution, lean defaults, indexed skill discovery and the shared settings editor are built. Automated validation is recorded below; live-provider behavior comparisons remain a rollout measurement.

## Problem and evidence

Helmsman already has pinned operations, discoverable operations, and operator placement overrides. The composer exposes them alongside bound connections. The next improvement is to make the choices correspond to useful tasks, keep discovery reliable as the playbook grows, and show what the assembled agent actually carries.

The source audit identified these mismatches in the original implementation:

- `capabilityBundles.ts` assigns a default tier to a bundle, but `applyBundlePlacements` preserves each operation's authored position unless an explicit override exists. A row can therefore say Always on while only one of its six tools is pinned. The UI deletes overrides equal to the bundle default, so the control cannot consistently express pinning every member of such a default-loaded bundle.
- `helmsmanSurface.ts` changes the local edition's defaults: it pins host reads, a coding harness, browser opening and model status, and unpins campaign reads and visualization. The bundles catalog route and placement write guard instead read the raw platform definition. They do not compose the edition's surface or account for a space's custom discovery ceiling.
- The catalog route estimates schemas directly from Zod. Runtime `buildCoreToolSpec` also removes internal inputs and collapses selected fields. For example, the same serialized-schema estimate for Memory read is 1,482 tokens through the panel recipe versus 1,019 through the runtime recipe. Provider serialization and meta tools introduce further differences.
- Discoverable operations already get compact awareness through `buildCompactAwareness`, but it groups by step type. Its broad descriptions advertise actions beyond some actual scopes: `agent` says agent CRUD and delegation even when Helmsman only has schedules. Several newer types receive only a generic fallback.
- Skills have a separate awareness surface. `SpaceContext.skills` can include descriptions, progress and complete first-task input contracts for up to 25 entries. Platform skills are placed first. Space-local collection stops adding runnable entries at 25 before `composeSkillsSection` calculates `total` and `truncated`, so that section can report no overflow even when more skills exist. Source scans are bounded at 200 documents. This is not a scalable search index or a complete skill count.
- Overflow guidance says to promote `workflow.manage.list` to enumerate all skills, but that operation defaults to 20 results, caps at 50, has no text query or cursor, and reports the returned length as `total`. It also loads run statistics for each returned workflow.
- Memory bundles use access-qualified ownership (`memory.store:write`), while promoted-tool revocation matches the plain capability group. A local probe that promotes `memory.store.put`, then applies `memory_write: off`, leaves that promotion present. New promotion is removed from the allowed operation list, but existing promoted writes survive this revocation helper.
- Space Settings has a different `HelmsmanDiscoveryEditor` for the discovery ceiling. It does not mount the composer's placement editor. The composer already writes space directives, so these are two presentations of related persistent settings rather than a chat-only preference.

Relevant implementation:

- `packages/platform-artifacts/src/cyberneticAgents.ts`, `helmsmanSurface.ts`
- `packages/schemas/src/catalog/capabilityBundles.ts`, `coreToolSpec.ts`, `compactFormat.ts`
- `apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/agentTurn.ts`, `capabilityShedding.ts`, `spaceContext.ts`
- `apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/workflowCrud/read.ts`
- `packages/server-runtime/src/routes/catalog.ts`, `spaceCrudRoutes.ts`
- `packages/web-product/src/ui/components/cybernetic/AgentToolSettings.tsx`, `CapabilityBundleEditor.tsx`, `HelmsmanDiscoveryEditor.tsx`

## Measured baseline

These are estimates from the checked-out catalog, using `composeHelmsmanSurface`, then `buildCoreToolSpec`, then the existing `estimateStringTokens` heuristic over a consistent `{name, description, input_schema}` envelope. They compare operation schema sizes; they are not provider token counts or whole-prompt measurements. They exclude meta/graph tools, integrations, skill awareness, system instructions, history and tool results. Hosted means the enterprise composition with the code lane; local means community-local with host and browser lanes present and the code lane absent.

| Surface                                          | Default pinned operations | Estimated schema tokens |
| ------------------------------------------------ | ------------------------: | ----------------------: |
| Hosted                                           |                        29 |                   9,180 |
| Local                                            |                        31 |                  11,372 |
| Hosted after deferring memory writes and visuals |                        23 |                   7,142 |
| Local after deferring memory writes and visuals  |                        26 |                   9,867 |

This first default change saves approximately 22% hosted and 13% local of the estimated pinned operation schemas. It preserves `workflow.manage.get`; moving that read to another UI group saves no tokens and is desirable for usability. These figures precede adding skill search or compacting schemas.

| Bundle                         | Operations reachable locally | Estimated tokens if all pinned | Main reason for size                                                                  |
| ------------------------------ | ---------------------------: | -----------------------------: | ------------------------------------------------------------------------------------- |
| Media                          |                            4 |                          4,571 | Repeated structured asset/reference unions; animation alone is 1,972                  |
| Integrations                   |                           17 |                          3,535 | Definition editing, bindings and webhooks bundled together                            |
| Run skills                     |                           10 |                          3,211 | Execution and campaigns combined; start alone is 1,140                                |
| Simulations                    |                            7 |                          3,137 | Full simulation definition in upsert; upsert alone is 1,630                           |
| Code                           |                            1 |                          2,820 | Locally this is sandbox execution, with workspace, session and resource configuration |
| Browser                        |                           10 |                          2,658 | Multiple page lifecycle, observation and interaction operations                       |
| MCP servers                    |                           12 |                          2,565 | Server registration, bindings, authentication and tool inventory                      |
| Visuals                        |                            6 |                          2,362 | Rendering and artifact generation/inspection combined                                 |
| Files on this computer         |                            4 |                          2,210 | Patch includes optional commit configuration, approximately 898 tokens                |
| Coding agents on this computer |                            1 |                          2,028 | Harness lifecycle options, browser configuration, branch/base/merge configuration     |

Bundle size is the cost of explicitly pinning all its reachable operations. It is not the amount loaded on promotion: `catalog.tool.promote` takes individual tool IDs. Splitting a bundle primarily improves operator choices; it does not automatically make current promotion cheaper.

## Decisions

### D1 — Keep a small steering surface and defer occasional work

Default Always on:

- Chat and Action Center access; capability search, listing and promotion remain locked infrastructure.
- Memory reads, including the guaranteed run-output reread floor.
- Plan operations; planning is part of steering, and this five-operation group is about 1,151 estimated tokens.
- Skill inspection (`workflow.manage.get`) and run start/resume/cancel/detail.
- Web search and fetch, about 619 tokens together.
- Proposal inspection (`proposal.get`), about 133 tokens. Rename its UI home rather than remove a cheap steering tool.

Default On demand:

- Memory writes, including remember/forget; defer all four currently pinned writes, saving about 1,357 tokens. Required automatic platform bookkeeping must retain its own authority and must not rely on a Helmsman tool being pinned.
- Visuals, including artifact rendering. The local edition already defers visualization; its remaining render costs only about 148 tokens, so local savings here are modest.
- Skill authoring and learning edits. Preserve the inspect read in a separate skill-inspection group.
- Campaign management in every edition. Local already defers its reads; hosted should follow it once separated from run controls.
- All existing occasional setup, media, evaluation, scheduling and execution groups.

Keep the local edition's host reads, harness entry point, browser opening and model status in the first change. They encode an existing local operating-model decision. The harness is a major cost (about 2,028 tokens), so compact it and measure actual use; reconsider pinning it in spaces that rarely commission coding work. Do not add another large always-on group speculatively. The critical addition is a small installed-skill search operation (D4).

Rejected: switching only a bundle's `tier`. Runtime defaults are authored operation lists, so both the runtime surface and registry defaults must change together. Existing explicit operator choices remain explicit; unset choices inherit the new defaults.

### D2 — Make placement truthful, with useful subgroups and optional per-operation choices

Always on must mean that every operation in the selected leaf group is pinned. On demand means it is discoverable and may be promoted. Off means it cannot be selected or promoted by this agent, and any existing promotion is removed. A parent whose children differ displays Mixed as a derived state, not as another persisted placement.

Introduce catalog-owned operation selectors where access-mode group selectors are too coarse. Every reachable operation has exactly one placement owner, derived from registry metadata. Keep capability profiles and operation authorization on their existing enforcement keys; a UI subgroup must not require inventing a new executor capability or renaming an operation.

Recommended boundaries:

| Current grouping           | Proposed leaf groups                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Run skills + Author skills | Inspect skills; Run controls; Campaigns; Edit skills               |
| Integrations               | Connection inventory; HTTP definitions; HTTP bindings; Webhooks    |
| MCP servers                | Server setup; MCP bindings; Tool inventory                         |
| Visuals                    | Render visuals; Build/inspect artifacts                            |
| Media                      | Images; Video/animation                                            |
| Code                       | Sandbox; Repository inspection; Managed coding lane where composed |
| Learning                   | Proposals; Learning review/changes, including `workflow.learn`     |

Keep groups collapsed beneath recognizable parents to avoid replacing 20 rows with 60 rows. Let advanced users choose individual pinned operations, reusing the connection editor's existing pattern. Retain current distinctions between local files, commands, MCP and harnesses: their use cases and binding authority differ. Do not split tiny coherent groups solely to lower a displayed number.

During implementation, replace superseded stored group keys deliberately rather than adding compatibility aliases or parallel policy systems. Recompute and preserve each explicit choice's effective operation set when a group splits; do not silently reset Off or widen reach.

### D3 — Reduce large schemas at their source

Use the shared `buildCoreToolSpec` path everywhere. Extend the existing `agentCollapsedFields` mechanism only for optional structures that remain discoverable through a detailed schema read and still validate against the full Zod schema at dispatch.

First candidates:

- Harness: optional `browser` and `mergeFrom` structures, about 700 tokens combined before replacing them with concise descriptions.
- Run start: optional `simulationRunInput`, about 366 tokens.
- File patch: optional `commit` structure, about 898 tokens.
- Media: repeated asset references account for most of several declarations. Investigate a compact reference form derived from the canonical schema. Required variant semantics must remain available before invocation.
- Sandbox: workspace/session/limits account for roughly 1,329 tokens. Retain common and safety-critical inputs; defer uncommon configuration detail.

Do not replace every schema with an untyped object or a generic universal execute operation. That sacrifices the platform's main validation and model-guidance advantages. Do not move long field descriptions into another always-on prompt. Savings are accepted only with representative calls that remain valid and understandable.

### D4 — Give skills the same placement choices, with skill-specific loading

Persist skill placement per agent within the space directives, keyed by stable skill identity and including platform skills. Default new installed skills to On demand. A skill's validity, approval, binding readiness, dependencies and schedules remain separate properties.

| Placement | Helmsman awareness and selection                             | Explicit operator invocation |
| --------- | ------------------------------------------------------------ | ---------------------------- |
| Always on | Compact entry always present; agent may select it            | Available when runnable      |
| On demand | Found through installed-skill search; agent may select it    | Available when runnable      |
| Off       | Excluded from autonomous discovery and new autonomous starts | Available when runnable      |

For skills, Always on pins a concise activation entry, not the entire workflow, task graph or every input contract. Load a selected skill's run/campaign input contract when needed, then use the existing `workflow.run.start`. Adding 100 skills must not add 100 function declarations. Skills execute in their Runner context; loading them must not load their tools into Helmsman's own context.

Add a small always-on `catalog.skill.search` operation for installed/platform skills. Return ranked summaries with stable IDs, activation hints, readiness, a next cursor when applicable, and a suggested inspection/start action. Reuse existing search infrastructure where practical; preserve a distinct result shape from tool promotion. A skill does not need `catalog.tool.promote` just to run.

Use `workflow.manage.get` for existing detail initially, with a compact invocation view that omits histories unless requested. It currently returns the whole workflow and defaults to ledger detail, so preflight must not blindly replace one oversized context block with another oversized tool result.

Enforce Off at search, inspection used for selection, and autonomous run start, not just in the injected index. A known slug or a memory document must not bypass it. Explicit invocation authority comes from an authenticated, structured operator selection at the request boundary; never accept an agent-authored `direct: true` bypass flag. Preserve the chosen skill reference through the dispatch path.

An Off skill may still execute as a declared dependency of another authorized skill or through an existing schedule, subject to ordinary validity and permission checks. Such execution is not autonomous Helmsman selection. Stopping a running skill, disabling its schedule, and making a skill unavailable to every caller are separate controls. Existing active runs must remain visible and controllable after a placement change.

The distinction matters for `compose-skill`: switching the Author skills tool group Off today does not prevent Helmsman from starting the authoring skill through `workflow.run.start`. Skill placement closes that semantic gap without changing skill execution authority globally.

Rejected: storing visibility in skill approval/dormancy, duplicating skills per agent, or disabling installed skills globally to save one agent's context.

### D5 — Bound discovery by tokens and retrieve from the complete authorized set

Generate on-demand awareness from the same resolved surface as search and execution: edition composition, authored authority, custom discovery ceiling, placements, capability profile and applicable policies. Describe the actual available bundles and their use cases, not every possible action associated with a step type. Include counts and how to search; omit every Off entry.

For skills, use search from the outset, regardless of library size. Keep explicitly pinned summaries plus a compact category/count rollup for the rest. Initial design targets are approximately 1,000 tokens for on-demand awareness and 1,500 tokens for pinned skill summaries, to be calibrated against emitted context and representative model runs. These are measured prompt budgets, not skill-count or prose-length limits. If pinning exceeds the budget, explain the excess at save time and let the operator move entries to On demand; do not silently hide pinned entries.

Search the complete authorized library server-side with bounded result pages and a token-aware response budget, normally a handful of matches. Return honest matched/returned counts and continuation information. Do not summarize the first 25 or 200 records and treat that sample as the catalog. Replace bounded prefix scans with a paginated/queryable metadata projection; invalidate it on skill creation, revision, readiness and placement changes. Keep authoritative validity/readiness checks at use time.

Full invocation contracts are retrieved only for selected skills. Keep schema summaries stable and small; active progress belongs in the existing attention/run context. A large library should grow server-side search work and storage, not the every-turn prompt linearly.

On-demand tools have a small awareness cost before promotion, and promotion/result/history costs afterward. Replace “Costs nothing until used” with wording that explicitly refers to unloaded tool schemas.

### D6 — Share the editor and resolution logic across composer and settings

Extract a controlled `AgentCapabilitiesEditor` from `AgentToolSettings` containing operations, connections, skills, totals and detailed rows. Pass the agent/space identity, resolved catalog, draft placements and change callbacks. Keep the popover and page as presentation shells.

Composer uses the shared content with its compact layout. Space Settings → Agent uses the same content with expanded detail. Put the raw discovery-ceiling editor under Advanced; it controls authority, whereas placement controls how already-authorized capability reaches this agent. Explain scope as “Helmsman in this space” and show whether a change applies next turn or next session.

Use a common resolver/estimator for runtime assembly, the catalog response, save validation and both UIs. It must include edition composition and custom ceilings. The space-dependent query cache key must include the space and role. Show inherited defaults and an explicit Reset to default action, so an explicit Always on choice is distinguishable from following a default.

Use the shared query/mutation hooks and one persistence path. Avoid replacing the entire directives document from two independently loaded editors; patch the relevant section or use optimistic concurrency so changing tools cannot overwrite a simultaneous model/rule edit.

### D7 — Explain overlapping capabilities without conflating them

- Rename Learning to Proposals for its small pinned steering read; place actual learning changes together. Helmsman does not acquire the Coach's full tool surface.
- Label Integrations as HTTP setup and MCP servers as MCP setup. Bound-tool execution remains Connections; local MCP remains tied to host bindings.
- Split Images from Video/animation; distinguish generating media from rendering an existing visual or building an artifact. Applets remain durable interactive instances.
- Keep Agents, Delegation, Guardrails and Direct HTTP outside the default Helmsman ceiling. They are registry bundles, but not all belong in this role's normal settings. Offer only what the resolved role can reach; do not grant new authority by exposing a toggle.
- Treat Store as acquiring new skills/services and skill search as finding skills already installed. Search results can suggest Store when no installed skill matches, without silently installing anything.

## Budget, observability and evaluation

Keep the existing independent caps of 50 pinned and 20 discovered tools until evidence justifies changing them. They are separate tiers, not a single 50-tool active maximum. Add a combined schema-token budget because a 2,820-token sandbox and a 99-token status operation are not interchangeable units.

Show a settings estimate and a live session view separately: pinned schemas, promoted schemas, discovery awareness, skill awareness/contracts and recent results/history. The inspector's recorded `ToolSurface` is the authority for emitted tools. Label heuristic figures as estimates; token size is not monetary cost without model pricing and cache accounting.

Promotion currently retains the 20 most recently used discovered tools and warns when eviction is likely. Preserve that behavior initially, but report the exact admitted/evicted set and costs. Consider explicit release or token-aware eviction only after measuring churn; do not flush tools every turn and force repeated search/promotion or cache misses.

Measure discovery success, wrong-tool/skill selection, extra model turns, schema-validation failures, promotion churn, tokens, latency and task completion. Compare the lean defaults with the current defaults on representative steering, skill creation, memory, visual and local coding tasks. Saving schema tokens while adding repeated failed searches is not a successful optimization.

This design follows the progressive-disclosure pattern described in primary references: [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) and [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills). Those support the pattern; Aflow's thresholds and model behavior must be measured locally.

## Phases and proof

1. **Truthful placement and revocation.** Share effective-surface resolution and estimation; fix access-qualified promoted-tool revocation; expose inherited versus explicit placement. Exit: a promoted memory write disappears after Memory write is switched Off, reads remain available, hand-written placement directives enforce the same rules as the UI, and local UI/save/runtime counts agree under custom ceilings.
2. **Lean defaults and task-based groups.** Defer memory writes and visuals, preserve skill inspection, split campaign/authoring responsibilities, and compact selected optional schemas. Exit: both editions assemble the intended defaults; subgroup selection does not alter the authority union; unsupported lanes never appear; representative harness, simulation and media inputs still validate.
3. **One editor in both locations.** Extract controlled content and use it in composer and Space Settings. Exit: both views show the same effective placement/cost, reset semantics match, over-budget saves explain the cause, and concurrent edits do not discard unrelated directives.
4. **Skill placement and complete search.** Add schema, persistence, metadata queries and search operation; wire all autonomous selection/start paths; make explicit invocation use trusted operator provenance. Exit: skill 101 and skill 1,001 are searchable with bounded context, totals are honest, Off blocks autonomous starts with a known slug, explicit invocation works, and active runs/schedules/dependencies behave as specified.
5. **Observed budgets and behavioral comparison.** Extend the context-budget scanner and inspector across both editions and representative skill-library sizes. Exit: documented token budgets are enforced consistently, retrieved contracts stay bounded, and representative tasks retain completion quality without disproportionate extra turns.

## Implementation and validation

- Placement uses exact operation IDs for exclusions and persistent promotion revocation. `resolveToolPlacement` is shared by the runtime and editor; a group set Off dominates an old individual override. The editor can deliberately reopen one member while leaving its siblings Off.
- The catalog preview accepts the draft discovery ceiling, so unsaved edits and reset-to-default are priced correctly. Create and update endpoints share the same tool-count, schema-token and pinned-skill-budget validation. Settings updates use a JSONB compare-and-swap condition and return a conflict instead of overwriting a stale snapshot.
- Migration 222 maintains the space-scoped `skill_discovery` metadata table through the memory-document write transaction, backfills existing documents, grants `catalog.skill:read` to system profiles, and copies existing explicit choices into the split groups. There are no compatibility aliases or tenant/background scans on the execution path.
- `catalog.skill.search` returns bounded, ranked, paginated summaries, including current readiness for agent searches. Cursors bind to the query hash. An oversized first description is explicitly omitted rather than breaking the response budget. A malformed workflow is reported as unavailable without losing the rest of its search page. A selected skill's compact invocation view returns its input/campaign contracts and current validity/readiness; the full workflow and history remain available explicitly.
- `SpaceContext.skills.pinned` replaces the capped active-skill inventory. Only explicit Always on summaries enter it. Counts come from the complete metadata query. If a later revision makes a pinned description exceed its budget, the context reports omitted pinned summaries and directs search; it preserves the rest of the space context. Cached contexts are validated against the current schema before reuse.
- Composer and Space Settings render `AgentCapabilitiesEditor`, including operation, connection and skill placement. The raw operation ceiling remains under Advanced. The inspector records schema-budget pressure, and the model gets bounded feedback when promoted tools could not be loaded. The new schema-token limit applies only to Helmsman; Coach retains its larger authored surface, covered by a regression test.
- The shared editor separates tool groups, skills and connections into views, then groups each inventory by resolved placement. Tool groups with different per-operation placements appear under Custom. Search matches group labels and operation IDs and opens matching results. Group rows expand directly into tools without an intermediate taxonomy tree; names, metadata and placement controls share a consistent layout. Required groups use disabled Always on controls with a reason. Skill placement counts describe the current results page when paginated.
- The current comparable operation-schema estimates are 22 pinned operations / 6,862 tokens hosted and 27 / 9,527 locally. These include skill search and the optional schema compaction. Provider/meta-function overhead remains separate. Local harness reads and its entry point retain their authored default positions, so some inherited group defaults are Mixed; explicit Always on pins every member.

Validation performed:

- Full `yarn build`, including the production Next.js application.
- Root project-reference TypeScript check and the separate web-product UI TypeScript check.
- Targeted schema, runtime, server-route, UI interaction and skill-discovery regressions.
- Real Postgres tests in a newly created, isolated tenant schema with 1,005 skills: search beyond both previous caps, accurate counts/pagination, space isolation, transactional updates/deletion, preserved split settings, and concurrent settings conflict protection. The fixture also applies the upstream memory-embedding migration 221 before skill-discovery migration 222 and checks both recorded versions. The fixture drops only its own generated schema.
- Context-budget baseline/check extended to both editions and 100/1,000-skill awareness, plus the large-file guard.

The production stack was not restarted and no provider-funded agent A/B comparison was run. Those comparisons should track extra discovery turns and task completion alongside the schema savings; the automated evidence here proves contracts, placement and bounded retrieval rather than model behavior quality.
