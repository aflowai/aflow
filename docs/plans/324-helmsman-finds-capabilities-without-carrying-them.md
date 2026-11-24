# Plan 324 — Helmsman finds capabilities without carrying them

**Status:** In progress. Phases 1 to 4 are built and their exits hold. Phase 5 is open. Its budgets are enforced, but no provider-funded comparison has shown that representative tasks keep their completion quality. Phase 6 is appended below and built. It carries skill usage metadata into search and pinned summaries. It puts each core tool's first `whenToUse` in its declaration and makes the space's custom agents findable. It also refuses a promotion the next turn would leave unloaded, under a 24,000-token surface budget with an 8,000-token promoted margin. Phase 6's exit is not yet met, because its Postgres search proof needs `DATABASE_URL` and has not run.

## Problem and evidence

What is wrong today, in the operator's terms: a Helmsman promotes a tool and is told the promotion succeeded. On its next turn the platform refuses the call to that tool as an unknown tool. A desk conversation whose pinned tools sat near the schema budget could therefore not create its schedules. `agent.schedule.create` was refused on three turns that way, with no error the operator could act on. Phase 6 records the measurements.

When this plan opened, the operator met these problems. Each is followed by the source that caused it.

- A tool group said Always on while only one of its six tools loaded. The editor could not pin every member of such a group. `applyBundlePlacements` kept each operation's authored position, and the UI deleted overrides equal to the group default.
- Settings showed the hosted defaults in the local edition, and ignored a space's custom discovery ceiling. The bundles route and the placement write guard read the raw platform definition instead of `helmsmanSurface.ts`.
- Settings priced a tool differently from what a turn carried. Memory read showed 1,482 tokens in the panel and cost 1,019 at runtime. The panel estimated from Zod, while `buildCoreToolSpec` removes internal inputs and collapses fields.
- The Helmsman was told it could do things it could not. Its on-demand summary said agent CRUD and delegation when it held only schedules, because `buildCompactAwareness` described step types rather than the actual scope.
- The Helmsman could not see skills past the 25th, and the context reported no overflow. `SpaceContext.skills` stopped at 25 before it counted, and source scans stopped at 200 documents.
- The overflow advice to list skills with `workflow.manage.list` returned at most 50, with no query or cursor, and reported that page length as `total`.
- Switching Memory write Off left an already promoted memory write callable. Revocation matched the plain group while memory bundles used access-qualified keys (`memory.store:write`).
- Space Settings showed a different editor from the composer for the same stored directives. It mounted `HelmsmanDiscoveryEditor` for the ceiling and no placement editor.

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

Rejected: persisting Mixed as a fourth placement. A stored Mixed does not say which members are pinned, so the runtime and the editor could read it differently.

Rejected: a flat list of per-operation choices with no groups. About 60 rows would hide the task each group serves. Per-operation choice stays available as the advanced view.

Rejected: a new executor capability for each UI subgroup. It would change what an agent is authorized to do in order to change how settings display it.

### D3 — Reduce large schemas at their source

Use the shared `buildCoreToolSpec` path everywhere. Extend the existing `agentCollapsedFields` mechanism only for optional structures that remain discoverable through a detailed schema read and still validate against the full Zod schema at dispatch.

First candidates:

- Harness: optional `browser` and `mergeFrom` structures, about 700 tokens combined before replacing them with concise descriptions.
- Run start: optional `simulationRunInput`, about 366 tokens.
- File patch: optional `commit` structure, about 898 tokens.
- Media: repeated asset references account for most of several declarations. Investigate a compact reference form derived from the canonical schema. Required variant semantics must remain available before invocation.
- Sandbox: workspace/session/limits account for roughly 1,329 tokens. Retain common and safety-critical inputs; defer uncommon configuration detail.

Do not replace every schema with an untyped object or a generic universal execute operation. That sacrifices the platform's main validation and model-guidance advantages. Do not move long field descriptions into another always-on prompt. Savings are accepted only with representative calls that remain valid and understandable.

Rejected: an untyped object or one generic execute operation. It would lose dispatch validation and the field guidance the model reads before it calls.

Rejected: moving long field descriptions into the system prompt. The prompt is paid on every turn too, so it saves nothing and drifts across model versions.

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

Rejected: storing visibility in skill approval or dormancy. Those states bind every caller, so hiding a skill from one agent would also stop its schedules and dependents.

Rejected: duplicating skills per agent. The copies would drift apart in revision and validity.

Rejected: disabling installed skills globally to save one agent's context. It would remove the skill from operators and other agents who still run it.

### D5 — Bound discovery by tokens and retrieve from the complete authorized set

Generate on-demand awareness from the same resolved surface as search and execution: edition composition, authored authority, custom discovery ceiling, placements, capability profile and applicable policies. Describe the actual available bundles and their use cases, not every possible action associated with a step type. Include counts and how to search; omit every Off entry.

For skills, use search from the outset, regardless of library size. Keep explicitly pinned summaries plus a compact category/count rollup for the rest. Initial design targets are approximately 1,000 tokens for on-demand awareness and 1,500 tokens for pinned skill summaries, to be calibrated against emitted context and representative model runs. These are measured prompt budgets, not skill-count or prose-length limits. If pinning exceeds the budget, explain the excess at save time and let the operator move entries to On demand; do not silently hide pinned entries.

Search the complete authorized library server-side with bounded result pages and a token-aware response budget, normally a handful of matches. Return honest matched/returned counts and continuation information. Do not summarize the first 25 or 200 records and treat that sample as the catalog. Replace bounded prefix scans with a paginated/queryable metadata projection; invalidate it on skill creation, revision, readiness and placement changes. Keep authoritative validity/readiness checks at use time.

Full invocation contracts are retrieved only for selected skills. Keep schema summaries stable and small; active progress belongs in the existing attention/run context. A large library should grow server-side search work and storage, not the every-turn prompt linearly.

On-demand tools have a small awareness cost before promotion, and promotion/result/history costs afterward. Replace “Costs nothing until used” with wording that explicitly refers to unloaded tool schemas.

Rejected: raising the 25-skill cap of the injected inventory. Every-turn prompt cost would still grow with the library, and any cap still reports a sample as the catalog.

Rejected: enumerating skills through `workflow.manage.list`. It has no text query or cursor, and it loads run statistics for each workflow it returns.

### D6 — Share the editor and resolution logic across composer and settings

Extract a controlled `AgentCapabilitiesEditor` from `AgentToolSettings` containing operations, connections, skills, totals and detailed rows. Pass the agent/space identity, resolved catalog, draft placements and change callbacks. Keep the popover and page as presentation shells.

Composer uses the shared content with its compact layout. Space Settings → Agent uses the same content with expanded detail. Put the raw discovery-ceiling editor under Advanced; it controls authority, whereas placement controls how already-authorized capability reaches this agent. Explain scope as “Helmsman in this space” and show whether a change applies next turn or next session.

Use a common resolver/estimator for runtime assembly, the catalog response, save validation and both UIs. It must include edition composition and custom ceilings. The space-dependent query cache key must include the space and role. Show inherited defaults and an explicit Reset to default action, so an explicit Always on choice is distinguishable from following a default.

Use the shared query/mutation hooks and one persistence path. Avoid replacing the entire directives document from two independently loaded editors; patch the relevant section or use optimistic concurrency so changing tools cannot overwrite a simultaneous model/rule edit.

Rejected: keeping two editors, one in the composer and one in Space Settings. They priced and saved the same directives by different rules, so the two views disagreed.

Rejected: last-write-wins saves of the whole directives document. An edit in one view would discard a concurrent model or rule edit made in the other.

### D7 — Explain overlapping capabilities without conflating them

- Rename Learning to Proposals for its small pinned steering read; place actual learning changes together. Helmsman does not acquire the Coach's full tool surface.
- Label Integrations as HTTP setup and MCP servers as MCP setup. Bound-tool execution remains Connections; local MCP remains tied to host bindings.
- Split Images from Video/animation; distinguish generating media from rendering an existing visual or building an artifact. Applets remain durable interactive instances.
- Keep Agents, Delegation, Guardrails and Direct HTTP outside the default Helmsman ceiling. They are registry bundles, but not all belong in this role's normal settings. Offer only what the resolved role can reach; do not grant new authority by exposing a toggle.
- Treat Store as acquiring new skills/services and skill search as finding skills already installed. Search results can suggest Store when no installed skill matches, without silently installing anything.

Rejected: merging each overlapping pair into one row, such as Store with skill search or Learning with the Coach's surface. The two halves differ in authority or in what they act on, so one row would grant or hide the wrong one.

Rejected: offering every registry bundle to the Helmsman's settings. A toggle for a bundle outside the role's ceiling would grant authority the role was never given.

## What this plan leaves alone

- What an agent is authorized to do. Capability profiles, executor capabilities and operation authorization keep their enforcement keys.
- Operation IDs. No operation is renamed to fit a settings group.
- The caps of 50 pinned and 20 promoted tools.
- Coach and every other agent. Their surfaces carry no schema-token budget.
- Skill execution authority. Validity, approval, readiness, schedules and declared dependencies keep their own rules.
- Explicit operator invocation of a skill, which skill placement never blocks.
- Store installation. Skill search may suggest the Store, and it installs nothing.
- Provider token counts and pricing. Every figure here is the `estimateToolSchemaTokens` heuristic.
- Promotion's LRU eviction. A promotion can still displace an older promoted tool on a later turn, and `ToolAvailability` still reports it.
- Stored directives written before the group split. They are migrated once, with no compatibility aliases.

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
6. **What the Helmsman needs to choose reaches the conversation.** Carry skill usage metadata to search and pinned summaries, put each core tool's first `whenToUse` in its declaration, make custom agents findable, and refuse a promotion the next turn would leave unloaded. Exit: the proofs named in the Phase 6 exit below pass. A promotion `catalog.tool.promote` reports is on the next turn's surface, including a re-promotion. Isolated Postgres search finds `commission-change` first for “fix a bug in the repo”.

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

## Phase 6 — what the Helmsman needs to choose reaches the conversation

The shared cause of three plan nodes: what a Helmsman needs to pick the right skill, tool or agent existed at install time or in long Store text, and never reached the conversation. They landed together. The schema-budget admission followed, because a tool the Helmsman found and promoted still did not reach its next turn.

**Exit.** These pass: `loopSkillUsage.test.ts`, `coreToolSpec.test.ts`, `catalogSearch.test.ts`, `buildAvailableTools.test.ts`, `promoteMidConversation.test.ts` and `schemaBudget.test.ts`. `skillDiscovery.pg.test.ts` passes against an isolated Postgres. It needs `DATABASE_URL` and has not run here, so that part of the exit is unmet.

### Skill usage metadata reaches the runtime (d1df245a)

- A workflow carries a `usage` block beside `description` — `whenToUse`, `whenNotToUse`, `next` (each naming exactly one `skill` slug or `operation` id, with when it follows) and `pitfalls` (`SkillUsageSchema`, `packages/schemas/src/operations/workflow/definition.ts`). `WorkflowSchema`, `ComposedWorkflowSchema` (so a Store install writes it into `workflow.json`) and `workflow.manage.put` accept it.
- Migration 229 adds `skill_discovery.usage` (JSONB), projects an object `usage` from each `workflow.json` in the same trigger, and rebuilds the projection from every stored workflow. Skill search matches `whenToUse` (weight 4 per term, beside name 5, slug 3, description 1); `whenNotToUse` is not searched, so a skill is never found by what it is not for.
- `catalog.skill.search` results and `SpaceContext.skills.pinned` summaries carry `usage` as `whenToUse`, `whenNotToUse`, `next` and a `pitfallCount`; the pitfalls themselves arrive whole in `workflow.manage.get` (`view: invocation` and `full`), beside the input contracts they are about. Under the search response budget a first result sheds its description, then everything of its usage but `whenToUse`, before it sheds the usage at all (`usageOmitted`).
- The four loop skills' Store descriptions keep their lead paragraph; every operational paragraph, and the bundles' `helmsmanHints`, moved into their `usage` (the hints' duplicates of a paragraph were dropped), and their `activationHint`s were cut to one sentence. The four loop bundles carry no `helmsmanHints`. `next`: Commission Change → Publish Local Changes; Publish Local Changes → Local PR Shepherd (then Commission Change for a `fix_before_merge` round); Review Local Changes → Commission Change for a finding, and Publish Local Changes, whose `unless-unreviewed` publication runs the review itself (its `whenNotToUse` says so); Local PR Shepherd → `agent.schedule.create`. Skill versions: commission-change 11, review-local-changes 11, publish-local-changes 47, local-pr-shepherd 18; Store bundles: local-commission 11, local-code-review 11, local-publish 49, local-shepherd 22.
- Proof: `loopSkillUsage.test.ts` (usage present, survives the install shape, successors named, no hints left), `skillUsage.test.ts` (schema), `skillDiscovery.test.ts` (search and pinned rendering, budget shedding), `migration229.test.ts`, and the isolated-Postgres `skillDiscovery.pg.test.ts`, which installs every Store skill and finds `commission-change` first for “fix a bug in the repo” with its `whenToUse` and `next`. That suite skips without `DATABASE_URL` and was not run here; the same weights computed over the catalog score commission-change 18, publish-local-changes 14, the shepherd and review 10.

### Core tools show when to use them (d177cb3a)

- `buildCoreToolSpec` emits `semanticDescription`, then `Use when: <first whenToUse>` on one line (`compactToolDescription`). Only the first: the declarations are paid every turn and `host.harness.run` lists ten. First bullets on the pinned surface were tightened, and corrected where they misled (`workflow.run.start` led with “Beginning the next optimization iteration”). `host.harness.run`'s first `whenToUse` now says a change meant to land goes through the Commission Change skill.
- Measured with this plan's table method (`composeHelmsmanSurface` → `buildCoreToolSpec` → `estimateToolSchemaTokens`), against the same surface without the fold: local 27 operations 9,996 → 10,590 (+5.9%), hosted 22 operations 7,121 → 7,577 (+6.4%). The context-budget scan's local native row went 10,227 → 10,817 (+5.8%); the committed baseline was older (9,758), so it was refreshed. Coach's surface takes the same fold.
- Proof: `coreToolSpec.test.ts` holds that every operation declaring a `whenToUse` carries its first in the compact spec, and that `host.harness.run` points at Commission Change.

### The space's custom agents are findable (5d33836b)

- `catalog.tool.search` with `sources: ['agent']` (or none) searches the space's custom agents even for an agent whose `allowedAgents` is false, as the Helmsman's is: finding an agent's id to schedule or read it is not delegating to it. Such an agent sees no platform roles and gets no agent ids in `suggestedPromoteCall`; the result carries each agent's `target` (`{ kind: 'custom-agent', agentId }`, as `agent.schedule.create` takes it) and `slug`, and the promotion text says how to schedule and read it. Matching (`matchAgentCandidates`) ranks an exact handle or name first and keeps it above the tail pruning; the suggested promotion of a delegable agent now names its handle, which promotion takes, where it named an `agentId` the result never carried.
- `agent.manage.get` is in `HELMSMAN_DISCOVERY_PRESET`, so the Agents tool group is offered to the Helmsman with that one read; agent writes and `catalog.agent.*` stay out. Its usage example takes `agentSlug`.
- The shepherd's usage says the agent is found with `catalog.tool.search` `{ query: 'local-pr-shepherd', sources: ['agent'] }` or read with `agent.manage.get { agentSlug }`, and gives the schedule's cron and input, so a fresh conversation schedules it without asking for the id. That end-to-end behaviour was not exercised against a running stack or a model; `catalogSearch.test.ts` holds the matching and `buildAvailableTools.test.ts` the Agents group.

### A promotion that reports success loads next turn

- **The defect.** One budget of 16,000 schema tokens bounded both the pinned tier and the whole surface. A desk conversation sat at 15,915 to 15,963 tokens when its first promoted tool was reached. Each promotion persisted and reported success, and `buildAvailableTools` then left it unloaded with a log warning. The model saw success, then "unknown tool". `agent.schedule.create` was refused on three turns that way, and 16 promoted tools were dropped four times each.
- **Two ceilings.** `MAX_PINNED_SCHEMA_TOKENS` (16,000) bounds the pinned tier. Settings refuse a placement over it, and a turn whose pinned tier exceeds it still throws. `MAX_CAPABILITY_SCHEMA_TOKENS` bounds the whole surface and is now the pinned ceiling plus `PROMOTED_SCHEMA_TOKEN_MARGIN` (8,000), so 24,000. Only promoted tools can spend the margin, so a full pinned tier no longer leaves a promotion nowhere to land.
- **Measured.** The measurement uses `estimateToolSchemaTokens`, the estimate `buildAvailableTools` applies. The default local Helmsman surface (28 tools) costs 12,578 tokens, and the hosted one (23 tools) costs 8,919. The desk's 15,915 sits about 3,340 tokens above the local default. Its own placements may account for that, or promoted tools that loaded ahead of the first drop. The local edition offers 122 promotable operations. The median costs 225 tokens, `agent.schedule.create` 876, and the largest, `compute.sandbox.exec`, 2,923. The 16 largest sum to 19,207 and all 122 to 43,824. The log does not name the desk's 16 dropped tools, so the margin is sized from the distribution. It holds the largest operation and about 20 median ones (2,923 + 20 × 225 = 7,423). Twenty is `MAX_VIRTUAL_TOOLS`.
- **Prompt cost.** The margin is a ceiling and costs nothing until the model promotes into it. A turn that fills it carries 8,000 more schema tokens than the old ceiling allowed. That cost was chosen over compacting schemas, because the desk had no room for even the 876-token `agent.schedule.create`. Compacting the largest schemas (D3) remains the lever for the pinned tier.
- **Rejected.** Raising the single budget above 16,000 was rejected. Pinned settings could then fill the new room, and a promotion would again have nowhere to land. Dropping an over-budget promotion at assembly with a log warning was the old behaviour. The model read success, then "unknown tool", and the operator saw nothing. Evicting older promoted tools to make room at promotion time was rejected too. It would unload tools the model is using now, without telling it.
- **Promotion measures itself.** Each Helmsman turn stores its schema spend as `ai.agent._schemaBudget`: the pinned tokens, the pinned tool ids and the ceiling. `persistAgentTurnToolSurface` stores it beside the surface. `catalog.tool.promote` prices each admitted candidate with the spec the surface would carry. A promotion ranks first among promoted tools on the next turn, behind only the pinned tier and the earlier promotions of this turn. So it loads exactly when it fits beside that spend, which each admitted promotion raises. A candidate that does not fit is rejected with `schema_budget`, and the reason names its cost, the usage, the ceiling and the tokens it lacks. It also says whether promoting it again next turn lands it, or whether only the operator can free the room. A re-promotion now moves the tool to the front of the LRU order (`lastUsedAtTurn`), as the cap warning has always said it does.
- **Left alone.** What is authorized is unchanged, and so is the scope stored each turn. Promotion can still displace an older promoted tool on the next turn, and `ToolAvailability` still reports it. Coach and other agents carry no schema budget.
- **Proof.** `promoteMidConversation.test.ts` runs the real assembler, persistence and promote handler. With the pinned tier filled to within 100 tokens of its ceiling, as the desk's was, `agent.schedule.create` is promoted and lands on the next surface. With the margin filled by other promotions, it is rejected with the budget reason and stays off the next surface. Promoted again on a fresh turn, it lands. A tool promoted once, then displaced by newer promotions that fill the margin, is promoted again while still stored. That re-promotion stamps `lastUsedAtTurn` past every newer promotion, and the tool loads on the next turn. The case fails if a re-promotion keeps its old LRU position. `buildAvailableTools.test.ts` holds that a pinned overflow still throws and that a full pinned tier leaves the margin to promoted tools. `schemaBudget.test.ts` holds the admission order and the reason text.
