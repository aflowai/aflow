# Aflow — agent project context

## What is this?

Aflow is an **agentic execution platform** — a schema-first, Redis-hot engine for building and running agents where AI agents orchestrate tool steps with full observability.

**Development status**: Active development, no external users depending on API stability. **Never add backward-compatibility shims, deprecation wrappers, or migration bridges.** All data is experimental — prefer clean cuts over gradual migrations. When a schema, API, or pattern changes, change it everywhere in one pass.

## Architecture (must-know)

```
User / Web UI ──► API server (Fastify: REST + SSE + WebSocket)
                        │
                        ▼
               Redis Stream (control)
                        │
                        ▼
                  Orchestrator ──► Redis Streams (jobs:ai, jobs:api, …)
                        ▲                     │
                        │                     ▼
               Redis Stream (results) ◄── Executors (AI / API / User / Memory / Compute / …)
                        │
                        ▼
      Redis session_events stream → SSE → Web UI
```

### Key architectural decisions

- **Redis-first hot path**: All active session/step state lives in Redis. Postgres is eventual-consistency via TerminalFlushWorker.
- **Schema-first**: Zod schemas in `@aflow/schemas` are the single source of truth. Types, JSON Schema, and OpenAPI derived from Zod.
- **Payload discipline**: Large data in PayloadStore (GCS/Redis/memory), referenced by `PayloadRef`. NEVER inline large payloads in Redis streams or hot state.
- **Single-writer orchestrator**: `FlowExecutionService` is the ONLY writer of durable session/step state. Executors are stateless.
- **Tools are steps**: Every tool call becomes a first-class `StepExecution` with parent/child linkage.
- **Multi-tenant**: Schema-per-tenant in Postgres. `tenantId` explicit in every message and operation.

## Repository structure

```
apps/
  server/                  # API server entrypoint — composition root, startup, signals (port 3000)
  web-local/               # Next.js web app for this edition, port 3001
  aflow-orchestrator/      # FlowExecutionService + ResultConsumer + ControlConsumer
  aflow-executor-ai/       # AI ops: generate, generateJson, generateStream, agent_turn, embed, image.*
  aflow-executor-api/      # HTTP API call executor
  aflow-executor-user/     # User input/approval executor (always produces PAUSED)
  aflow-executor-memory/   # Memory read/write/query/vector_search executor
  aflow-executor-ui/       # UI artifact executor (generate, validate, publish, render)
  aflow-executor-compute/  # Sandboxed code execution executor (Docker containers)
  aflow-executor-mcp/      # MCP tool executor
  aflow-executor-host/     # Paired host executor — coding harnesses and commands on the operator's machine
  aflow-executor-mock/     # Dev-only mock executor for contract testing
  aflow-mcp/               # MCP server (Streamable HTTP transport)
packages/
  server-runtime/          # The Fastify API itself — factory, routes, plugins, services, composition contracts (REST + SSE + WebSocket)
  web-product/             # The web product's pages and components, shared by every web application
  schemas/                 # Zod schemas, operation registry, catalog export
  database/                # Drizzle ORM, migrations, tenant schema management
  redis/                   # Redis Streams helpers, hot state, timers, heartbeats
  payload-store/           # PayloadStore abstraction (inline refs, Redis, GCS backends)
  ai-client/               # Multi-provider AI client (OpenAI, Anthropic, Google, OpenRouter)
  executor-runtime/        # Base ExecutorRuntime class, StepHandler interface, concurrency limiter
  input-resolution/        # Input resolution, schema validation, expression evaluation
  observability/           # OpenTelemetry tracing, structured logging
  design-system/           # Design tokens, primitives, semantic UI components
  lib/                     # Shared utilities
  platform-artifacts/      # Code-backed platform agent/skill/workflow registry (Plan 106)
  applet-runtime/          # Stateful-applet gateway: applyAppletCommand, patch bounding/templates, conformance gate (Plan 264)
  run-view/                # Pure run-view reducer + types (folded on both client and server for the chat snapshot+tail mount path — Plan 146)
docs/plans/                # Plans for larger changes — see docs/plans/README.md
scripts/                   # Dev tools, test flows, seed data, integration tests
```

## Hard rules

- **NEVER run `git checkout -- .` or `git checkout -- <file>` or `git restore .`** — discards uncommitted work irreversibly. Use `git stash` or ask the user.
- **NEVER run `git reset --hard`** — same reason.
- **NEVER run `git clean -f`** — destroys untracked files permanently.
- **NEVER suggest `yarn infra:reset`** — wipes all local Postgres and Redis data. Use `yarn db:migrate` for schema changes. Only the user should decide to reset infrastructure.

## Critical patterns to follow

### TypeScript strictness

- `exactOptionalPropertyTypes`: Cannot assign `undefined` to `foo?: string` — omit the property instead
- `noUncheckedIndexedAccess`: Array/object indexed access returns `T | undefined`
- `noPropertyAccessFromIndexSignature`: Must use `config['key']` not `config.key` for index signatures
- No `any` — use `unknown` and narrow with type guards
- **Module resolution follows the runtime, not the repository.** Code Node executes as ES modules — engines, workers, CLIs, and any package consumed directly by Node — resolves with `NodeNext` and **must** spell relative imports with `.js`, because Node's loader does not try `./helper.ts` for `./helper` and the program fails on a file that exists. Shared utilities consumed by both Node and the web keep the same rule. **Next-consumed UI is different**: a bundler resolves extensionless specifiers, and Next's own subpaths (`next/link`, `next/navigation`) do not resolve under `NodeNext` at all — which is why `packages/web-product` compiles `src/ui` under a second config with `moduleResolution: "Bundler"` while its Node-facing entries keep the first. Strictness is identical in both; only resolution differs, because only resolution differs at runtime. Keep `.js` on relative imports there too as a convention, but it prevents no failure and is not a reason to withhold a component from the shared product

### Schema-first workflow

When changing types or adding operations:

1. Define Zod schema in `packages/schemas/src/`
2. Derive TypeScript type: `type Foo = z.infer<typeof FooSchema>`
3. Register in catalog: `packages/schemas/src/catalog/registry.ts`
4. **Update capability profiles** if the operation introduces a new `stepType.group` capability group:
   - Add a tenant migration in `packages/database/src/tenant.ts` that appends the new `capabilityGroupId` to the system profiles' `allowed_capabilities`
   - Full Access + Standard: `:read` and `:write`; Read Only: `:read` only
   - Operations with `group: null` derive capability as just `stepType` (e.g., `workflow`)
   - **If you skip this step**, agents get "Operation X not covered by any allowed capability" errors at runtime
5. Run `yarn typecheck` to verify

### Package resolution

**The scope is `@aflow/*`, and the word "phoenix" survives on purpose in six places
that are not packages** (Plan 157 W2): the `PHOENIX_*` environment keys, the
`__PHOENIX_DONE__` sandbox sentinel, the `phoenix:*` applet postMessage channels,
the prebuilt `phoenix-python-ml` image, the hosted deployment's GCP resource
names (`phoenix-core`, `phoenix-worker`), and the
`@phoenix.local` synthetic identities. None of them is a stale rename — three cross
an artifact boundary and one is baked into applet HTML already stored, which is why
W3 owns them rather than W2. A stale package import needs no guard: the old scope
resolves to nothing, so typecheck and the build fail on it.

All `packages/*` have conditional exports with a `ts-source` condition. Dev scripts set `NODE_OPTIONS='--conditions=ts-source'` so tsx resolves `@aflow/*` imports directly to `.ts` source — **no rebuild needed during development**. Production builds use `import`/`require` conditions (compiled `dist/`). Type checking uses TypeScript project references (`tsc -b`, incremental).

### Other key patterns

- **Prompts are a last resort, not a tool surface.** Phoenix relies on Zod schemas, structured inputs/outputs, op-registry metadata (`semanticDescription`, `usage.whenToUse`, `usage.pitfalls`), and tool-result envelopes to drive agent behavior. When you find yourself adding prose to a system prompt to teach the agent a rule, first ask: can the schema carry it (remove an option entirely, change a default, make a field required, tighten a regex with a teaching error)? Can the tool's output field description carry it (the agent reads outputs on the next turn)? Can the op-registry `pitfalls` / `whenToUse` carry it durably? Prompts drift across model versions, are easy for the LLM to deprioritize, and are the hardest surface to test. Removing the `placement` field from `human.action_center.focus` (Plan 166 §HITL) is the worked example: a prompt paragraph telling Helmsman "use `placement: 'chat_inline'`" lost to the schema default; deleting the option from the schema fixed it permanently with zero prompt language.
- **A tool that cannot fail has no ceiling, and a refusal the model misreads is worse than none.** Every loop guard in the agent runtime counts _failures_ — `MAX_CONSECUTIVE_TOOL_FAILURES` (5, resets only when the message's first 500 chars change), `MAX_TOTAL_TOOL_FAILURES` (12, never resets), and the repeated-decision detector that pauses after five identical calls. A tool that returns SUCCEEDED on a no-op is therefore **unbounded**: one Runner re-sent the same empty draft 130 times over twenty minutes, every call succeeding, and nothing counted it. Make a no-op a _failure_ so the accounting that already exists can see it. The decision detector reads the decision rather than the result — right for this — but it hashes the whole argument object, so any argument required to DIFFER per call (a replay key like `mutationId`) makes every repeat look novel; exclude those from the signature. And a receipt is feedback only if it says what changed: an empty `{cases: [], rationale: ''}` reporting `itemCount: 2` (a count of KEYS) read as progress, where a census — `{ cases[0], rationale=empty }` — is what let the model recover unaided. **When the platform refuses a call, say which call.** A refused call never runs, so it never enters the transcript; "your previous tool call was rejected" points at the last call the model _can_ see, which succeeded — one model answered that by re-sending four already-applied cases. Name the refused call as the one just attempted, say every result above still stands, and distinguish the remedies: a wrong _type_ should be resent correctly, a _missing_ argument populated, and a response **truncated mid-argument** (reasoning is paid from the same output budget as the answer) made _smaller_ — resending it truncates in the same place.
- **A length cap is a storage ceiling, not a style guide — and a tight one is a bug.** Add a `max()` only where something genuinely breaks without it (a storage limit, a provider limit, a prompt budget that is actually measured), and then set it generously. A cap sized to what the author imagined the field would hold is the failure mode: the model writes the useful paragraph, validation refuses it, and — where the surface retries, like a `submit_output` validatorRef — the run **loops** rather than degrading. Never narrow a producer to match a consumer's tight cap; raise the consumer. `eval.case.propose`'s rationale was narrowed 2000 → 1000 to match a StagedChange proposal, which turned an operator-facing explanation of what a suite covers and what it would miss into a truncation error and then an infinite retry; the fix was 8000 everywhere in the chain. A field holding model-authored prose for a person to read wants room in the thousands, not the hundreds.
- **Derive, don't mirror schemas**: Never maintain hand-written field lists matching a Zod schema. Derive at runtime. See `deriveStringFields()` in `packages/redis/src/hotState.ts`.
- **Model capabilities are catalog data, and they are measured, not researched.** What a model accepts — which reasoning efforts, which params — belongs in `packages/ai-client/src/catalogModels.ts` where the client, the catalog API, and the operator UI all read it, never as string-matching inside a provider adapter. `ModelReasoningProfile.supported` is the authority: the client clamps every request to it once in `buildAdapterRequest` (the single choke point), so an effort a model cannot take degrades to its nearest rung instead of 400-ing mid-run, and the picker offers only rungs that model accepts. **Write these sets from `yarn models:verify-reasoning`, which probes the live APIs — not from vendor docs.** Docs describe the recommended envelope, not the accepted one, and were wrong on three of four models when these sets were first written. Both failure directions bite, and only one is loud: a rung the provider rejects fails runs visibly, while a rung wrongly withheld caps quality forever with no error anywhere. Pricing follows the same rule — `ModelPricing.scheduled` carries an announced rate change with the instant it takes effect, so an introductory price that lapses does not quietly under-report spend from the morning it does. **Which models a space may assign to a cybernetic role is a tenant choice**, not a platform one: `tenants.agent_model_allowlist` (NULL = follow the platform recommendation, which is not the same as allowing nothing), `effectiveAgentModelRefs` is the one resolver every gate reads, and refs are compared as catalog ids because the same model arrives as `luna` from an admin and `gpt-6-luna` from the picker. **A model id is never reclaimed once it can have been stored.** An alias names a tier (`glm-pro`) and an id names one version of it, so every surface that persists an operator's choice writes the alias where there is one (`aliases[0]`, pinned to `RECOMMENDED_AGENT_MODELS[].alias` by a contract test), and a model leaving the lineup is recorded in `retiredModels` — id → successor, resolved by `getModel` — rather than deleted. Deleting the entry cannot reach the space directives, task overrides and step configs already holding that id: each becomes a dangling ref that resolves to nothing, routes on a spelling guess, and surfaces as that vendor's 400 on the next run, while every readiness surface still reports green. A model withdrawn with no successor stays absent on purpose, so its refs fail as the unknown models they are.
- **Comments: only non-obvious WHYs.** Default to zero comments — well-named identifiers carry the WHAT. Add one only when the WHY is invisible from the code itself: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. Never narrate the change being made — no dates, no incident/dogfood references, no "fixed X" / "added for Y" provenance tags; that context belongs in the commit message and the plan doc, and it rots in code. Plan references (`Plan 158 §4.9 — …`) are reserved for load-bearing invariants whose full rationale lives in the plan — not as decoration on ordinary lines.
- **Edition gating is two decisions, and the registry only makes one.** The surface registry decides whether a ROUTE exists in a build (`tier: 'core' | 'enterprise'`, `packages/server-runtime/src/compose/coreSurfaces.ts`). It decides nothing about the UI. A nav entry, a page or a card is visible in every edition unless something gates it, so a feature that only works in one edition needs an explicit check — and the reverse holds too: hosted-only surfaces must not appear locally. **The failure is silent and looks fine in review**: the page renders, and every action on it is refused by an API that was right to refuse. `This Computer` shipped that way and appeared in the hosted edition, where no machine can be paired. **Do not gate on the surface name.** A route registered `core` exists in BOTH editions and declines at runtime on a missing credential, so `useHasSurface('host-bindings')` is permanently true and answers a different question. Gate on the edition (`useEdition().id === 'enterprise'`, or `isLocalEdition` server-side), and say in a comment which edition the feature belongs to and why — the API's own refusal message is usually the sentence you want. Anything genuinely platform-level (schedules, triggers, agent-turn policy) stays ungated on purpose; the test is whether the feature can _work_ in the other edition, not where it was written. The registry decides which routes a build carries; the ownership manifest (`packages/schemas/src/edition/ownership.ts`) decides which files each distribution carries, and its guards fail on a surviving file that imports one the core does not ship. Which stack to develop each kind of change in is the table under **Which stack for which change**.
- **DRY across apps**: Never duplicate business logic between apps. Common functions belong in `packages/`. If fixing a bug requires changing two files with the same logic, extract to a shared package.
- **Format before committing**: Always run `yarn format` before staging. CI enforces `format:check`.
- **Branded types**: `TenantId`, `RunId`, `StepExecutionId`, `FlowId`, `PayloadRef`, `TraceId`, `IdempotencyKey` — always cast via `as`, never widen to `string`.
- **Payload discipline**: Large data → `PayloadStore.store()` → `PayloadRef`. Small (<64KB) → `inline:<base64>`. Distinct `PayloadKind` values. Never overwrite a step's output payload with a different kind.
- **Operation IDs**: `{stepType}.{group}.{verb}` — always use `buildOperationId()`, never hand-write.
- **Agent pattern**: `ai.agent.turn` is a decision step → orchestrator schedules tool steps → results loop back to next agent turn.
- **Platform-owned definitions (Plan 106)**: System agents, platform workflows, and bundled cybernetic skills that are identical for every tenant live in `packages/platform-artifacts` and are resolved at runtime (registry first, then space-local data). No deploy-time phase re-seeds them across tenants. When changing a platform flow or prompt, edit the registry and shared DB/orchestrator resolvers — do not add a new deploy-time tenant sweep.
- **Dev auto-restart**: Every TypeScript service runs under `scripts/watch-service.mjs` with the `ts-source` condition, which restarts it on a change to its sources, as `tsx watch` did, and also when it crashes, by the appliance launcher's rule (`scripts/serviceRestart.mjs`: a non-zero exit starts again after a 2–30 s backoff; a clean exit or a kill does not) — `tsx watch` restarted on a change only, so a crashed orchestrator stayed dead behind a live watcher (Plan 315 F116). The dev runner applies the same rule to any service process that exits. A change kills a service five seconds after its SIGTERM, except the host executor: a restart drains it (Plan 315 D17), so it runs with `--drain`, which sends it SIGUSR2 and starts it again once it has exited. SIGTERM and SIGINT still end everything it runs at once, because every supervisor that sends them kills after a short grace. Package source changes are picked up immediately — except in a Next application, whose bundler resolves the `import` condition and therefore reads `dist`. The dev profiles that serve a web app run `@aflow/web-product` in watch alongside it for that reason; an edit to the product package outside those profiles needs `yarn workspace @aflow/web-product build` before the web app sees it, and the failure without one is a missing export naming a symbol the source plainly has.
- **Client server-state (Plan 161)**: All HTTP reads/writes route through `useApiQuery` / `useApiMutation` (`packages/web-product/src/ui/hooks/useApiQuery.ts`) — never call `fetch` directly from feature code. SSE channels go through refcounted module-level brokers (`session-events-broker.ts`, `action-center-broker.ts`); broker callbacks `setQueryData` the shared cache so React reads stay declarative. Query keys: tenant-scoped `['users','me'] | ['spaces'] | ['tenant'] | ['integrations','credentials'] | ['catalog', ...]`; space-scoped `['space', spaceId, 'agents'|...] | ['space', spaceId, 'integrations','definitions'|'bindings'] | ['session', sessionId, ...]` — the `['space', spaceId]` prefix is the §4.4 space-switch invalidation handle, so anything per-space MUST nest under it. Server rate-limits are segmented by user + method class (`packages/server-runtime/src/lib/rateLimitPolicy.ts`); see `docs/dev/rate-limits.md` for the policy table.
- **Skill contract validity (Plan 190)**: A structured skill earns its complexity over an open-text `skill.md` by being **machine-validatable** — so validity is a standing, **recompute-at-read** property, not a stamp. `f(skill, rules)` is recomputed at the read/use sites (`workflow.run.start`, `workflow.manage.get`); the persisted `SkillProjection.contractValidity` is an **advisory cache only**, never consulted for enforcement. **The executed artifact is always the materialized (derived) one** — any path that resolves a workflow for execution must materialize it first (`resolveWorkflowForRun`); the founding incident was validating one form and executing another. The detector (`validateWorkflowGraph` + `deriveOpBoundProducerShapes`) is importable **only** through the shared `packages/cybernetic-runtime/src/skillValidity` functions — `materializeAndValidateSkillConfig` (write), `ensureCurrentSkillValidity` (read), `materializeSkillTasks` (derive-only, execution hot path) — and a guard test (`detectorConsolidation.contract.test.ts`) fails if anything else imports them. **Contract validity** (space-independent: graph/op-input/eval-linkage/ref coherence) and **capability/activation readiness** (space-dependent: bindings/credentials) are distinct axes composed into `canRun`/`canShow`/`needsSetup` — never merge them. To change how skills are _structured_, encode a schema or graph-validation rule (machine-checked, retroactive via recompute-at-read, surfaced as a structured `SkillDiagnostic`) — prompt prose is the last resort; _behavioural_ correctness is the separate verification plane (Plan 188/183), not a graph rule. Spec: `docs/plans/aflow/completed/190-skill-validity-standing-property.md`.
- **Write-action safety is per-endpoint, not a global switch (Plan 253)**: every API endpoint carries a curated `writeRiskTier` (`read`/`low`/`medium`/`high`) on `ApiEndpointSchema`; `effectiveWriteRiskTier()` defaults an untiered write to `low` (safe-by-direction) and a guard test fails if any non-GET catalog endpoint omits an explicit tier. The tier lives in the **orchestrator/executor plane and is never exposed to agents**. The API executor gates a resolved write **after the body is fully resolved** (so the preview + `requestHash` cover the exact bytes) via `enforceWriteApprovalGate` — a gated (medium/high, composed with the per-space override by `requiresWriteApproval`) call with no matching approval parks as a `write_approval` PAUSE reusing the OAuth-consent rails, surfaced as an Action Center approve/deny card. **The approval grant is minted ONLY at the authenticated resolve boundary** (`pausedStepSource.resolve`), keyed by `(tenant, run, requestHash)` — NOT the step execution id (a re-dispatch mints a fresh one) — so no scheduled `{}` resume or agent-driven resume can approve. Deny fails the step with a non-retryable `permission` tool error (classification is load-bearing: `toAgentToolError` maps it to `retry:false`) carrying the operator's reason. The approval payload is a union discriminated by `target` — `api`, and `browser` for an action in the agent's browser on a profile that asks (Plan 320 D7) — and the browser variant shares this grant path, its pause, card and denial, except that its grant is spent by the one action it lets through. Direct-URL calls carry no endpoint and are pre-authorized by their binding. The operator override is `spaces.write_policy` (migration 140), composed at call time. Body-schema validation (`validateBody.ts`) is a separate always-on axis.
- **Sandbox bind-mount host-path invariant (Plan 188 §4.K)**: every host dir the compute executor bind-mounts into a sandbox (`/workspace`, `/tmp/input`, `/tmp/output`) must resolve to the **same path for the host Docker daemon** — the executor reaches the daemon over the mounted socket, so the daemon owns how the `-v` source resolves. Wherever the executor runs in a container of its own and spawns sandboxes through the host's daemon, a path under the container's own `/tmp` doesn't exist on the host, so Docker silently bind-mounts an empty dir and `/workspace/` is empty despite a populated manifest (the "hydrated but empty" bug — invisible locally because dev shares one FS). All sandbox scratch goes through `sandboxHostBaseDir()`/`sandboxScratchDir()` (`apps/aflow-executor-compute/src/handlers/sandboxHostDir.ts`), rooted at `PHOENIX_SANDBOX_HOST_DIR` (mounted at an identical host path wherever the executor is containerised; falls back to `os.tmpdir()` in dev). **The general worker mounts no Docker socket** (Plan 263 SEC-08): socket access is host root whichever user holds it, so the sandbox runs in a service carrying no model key, no mail credential and no credential-wrapping key. Never construct sandbox scratch with raw `tmpdir()` — a guard test (`sandboxScratchConsolidation.test.ts`) and a boot self-test (`sandboxSelfTest.ts`, hard-fails in strict mode) enforce this.
- **Run access grant storage (Plan 28 §P3)**: the `RunAccessGrant` lives in exactly one place — the `grantJson` field of the session hot-state hash — and its lifetime is `expiresAt`, **never a Redis key TTL**. A key TTL turns a _renewable_ grant into a _missing_ one, and those are not interchangeable: an aged-out grant recompiles from its own metadata, a missing one has nothing to recompile from. **Grant enforcement never pauses a run** — `GrantEnforcementResult` carries no way to ask for one, so the option cannot return without changing that contract. A pause raised in `scheduleStep` happens **before any step state exists**: it emits no resume contract, no client can resume it, `retryRun` refuses anything not `FAILED`, and an autonomous Runner strands the parent waiting on it. Refusals deny the step instead — a tool call becomes a non-retryable `permission` error the agent answers with `signal_blocked`; an agent turn fails the run. Because `atomicCreateSession` and `setSessionState` both DEL the hash before writing it, a writer that _creates_ session state must embed `grantJson` in that same literal — `setRunAccessGrant` is only valid against a hash that already exists (resume, retry, step scheduling). A guard test (`grantStorageConsolidation.test.ts`) fails if any module both creates session hot state and separately stores a grant.
- **Background work is declared and candidate-driven (Plan 180)**: production background discovery must be event- or candidate-driven. A task may not find its work by scanning the Redis keyspace (`KEYS`, whole-keyspace `SCAN`), reading a whole dirty set, or enumerating tenant schemas, and its **idle cost may not grow with logical shards, tenants, stored keys, or connected subscribers** — only with live process count. Every stateful background task is registered in `packages/schemas/src/background/registry.ts` with its owner, invariant, criticality, trigger, scope, budgets, feature gate, disable policy, recovery story, and the source files that implement it; `docs/architecture/background-work.md` is generated from it (`yarn background-work:docs`) and compared byte-for-byte. A contract test (`backgroundWork.test.ts`) scans every production source file and fails on a `setInterval`/`KEYS`/`SCAN`/full-set-read/tenant-walk hit that belongs to neither a registered task nor a named, bounded exception. New and migrated tasks use `createBackgroundTaskRunner` (`@aflow/lib`), never a raw `setInterval`, so cycles cannot overlap and every task gets jitter, budgets, abort, and error backoff; the pre-existing loops registered in the catalog are being moved onto it a domain at a time, and several of them genuinely can stack today. Arming a candidate marker **extends an existing transaction/Lua/pipeline; it never adds a hot-path round trip**. Disabling a task whose `disablePolicy` is not `safe` requires both `BACKGROUND_TASK_OVERRIDES` and `BACKGROUND_TASK_BREAK_GLASS` to name it; a refused override logs at error level and raises `aflow.background_task.disabled`.
- **One eval substrate, and the subject never sees the ruler (Plan 269)**: there is exactly one evaluation plane — the cybernetic one; never resurrect a parallel eval stack. `workflow_runs.evaluation_json` is the typed `RunEvaluationEnvelope` with **ONE writer** (`writeRunEvaluationEnvelope`, idempotent on `(runId, suiteContentHash)`) — every terminal run records a decision (`ran | no_suite | operator_cancelled | no_scorable_criteria | eval_batch | error`), deterministic evaluation is unconditional, and `judgeSamplingRate` is the only cost lever (sampled-out = `not_selected`, never silent). The eval plane is **operator-owned** (dataset CRUD/labels/baseline pins are REST, server-stamped principal; Helmsman holds exactly the registered `eval.*` ops — guard test `helmsmanEvalPlanePreset.test.ts`) and **structurally excluded from every Runner surface including the promotable grant tier** (`isEvalPlaneOperation` is fail-closed string-prefix; every run-time Runner exclusion asks `isRunnerExcludedOperation`, which also holds the Helmsman's `plan.*` (Plan 322 D3), so a plane added there is excluded from every channel at once; `validateSkillEvalPlaneSeparation` rejects skill references at validation). Eval batches are **frozen replays** (`trigger: 'eval'` + `workflow_runs.evalBatchId`) excluded from every production seam — runs listings, learnings, Coach counts, baselines all filter `eval_batch_id IS NULL`. Scorecard (validation-partition) labels are minted **only** by the batch's uniform random slice (`buildLabelValuesFromQueueItem` stamps partition from the queue item — no submit path can promote itself); every other stream is exemplar. Judges are **advisory until measured** — no judge verdict counts toward a regression finding. Spec: `docs/plans/aflow/269-skill-evals-and-golden-dataset.md`.

## Quick reference commands

```bash
# Running it
yarn start                 # First run and every run: .env, Postgres + Redis, build, migrate, all services
yarn dev:local             # What `yarn start` runs once its checks pass
yarn dev:core              # Server + orchestrator + mock executor (no web)
yarn dev:mcp               # MCP server alone (port 3100); `yarn start` already serves it
yarn mcp:setup             # Give the MCP server its API key and session token (mcp.local.json); idempotent
yarn redis:password        # Put this checkout and Redis on the machine's password (~/.aflow/stack.env)
yarn infra:up              # Postgres (port 5433) + Redis (port 6379, the machine's password) only
yarn infra:tools           # Same, with pgAdmin (8080) + Redis Commander (8081), Redis password as login

# Build and test
yarn build                 # Build all packages
yarn typecheck             # Type-check everything
yarn test                  # Run all unit tests
yarn test:changed          # Tests affected since main + local changes
yarn test:workspace @aflow/schemas  # One workspace through the shared config
yarn test:file path/to/example.test.ts # One or more explicit test files

# Quality / pre-PR
yarn preflight             # Format, build, typecheck, test, lint — full check
yarn preflight:no-test     # Same but skip tests (when infra is not running)
/check                     # Claude Code skill: auto-fix format/lint, then build + typecheck + test

# Database
yarn db:migrate            # Run all migrations

# Model catalog
yarn models:verify-reasoning   # Probe every model's reasoning ladder against the
                               # live provider APIs; exits non-zero on drift.
                               # Spends real tokens — run after adding a model or
                               # bumping a version, not on every change.
```

**Test policy for every coding agent/worktree:** iterate with `yarn test:file`,
`yarn test:workspace`, or `yarn test:changed`. Run the complete `yarn test` only for proof or
preflight; it intentionally waits behind any full run from a sibling worktree. Never bypass that
wait with a second broad Vitest process or workspace-level parallel test command. Never run
`yarn test` or `yarn preflight` against a database a running stack uses — some suites drop and
recreate schemas.

### Which stack for which change

| The change is…                                                 | Run it in                             | Build? |
| -------------------------------------------------------------- | ------------------------------------- | ------ |
| Anything in the platform — orchestrator, executors, routes, UI | `yarn start` (**default**)            | no     |
| The appliance itself — packaging, image boot, compose, volumes | `yarn local:dev:up` + `local:dev:web` | yes    |

**Most work is the first row.** Every service runs under `tsx watch`, so an edit is live
immediately. Only reach for the second row when the **artifact** is the subject — an
orchestrator fix tested through the appliance pays a container rebuild per iteration for
nothing.

**One stack at a time.** Two stacks on one Redis join the _same_ consumer groups and
load-balance each other's work, so a run started against one executes on whichever claimed
the message. Both also bind ports 3000/3001, so the second one's server and web cannot
start. The dev stack and the appliance use separate
datastores and do not share data.

**The host lane ships outside the image, and `yarn start` starts it anyway.** In the
appliance it is a paired daemon running as the operator's own user (`service install`),
because reaching their real folders and toolchains is the point of it. The dev stack starts
the same executor from the checkout it is launched in, as the operator's user, whenever the
machine is paired (`~/.aflow/host.env`) and no other host executor is running; it reaches
the stack through the `REDIS_URL` in that file. A leftover launch agent from an older
checkout is the one thing that defeats it: the stack then yields to the running daemon and
its old code. `service uninstall` once, and the stack owns the lane.

Nothing here proves the shipped image boots. That is release testing against a real
appliance, and nothing faster substitutes for it.

The root **`Dockerfile`** carries every workspace through two stages, and adding one under **`apps/*`** or **`packages/*`** means editing **three** lists (see existing entries):

1. **`COPY …/package.json`** in the **builder** stage, before `yarn install --immutable` — skip it and image builds fail with **YN0028** (lockfile would have been modified).
2. The same **`COPY --from=builder …/package.json`** in the **production** stage, so Yarn can resolve workspaces.
3. **`COPY --from=builder /app/<ws>/dist <ws>/dist`** in the **production** stage (a Next application ships `.next` instead). `.dockerignore` excludes build output, so this line is the _only_ thing that puts the compiled package in the image — skip it and the image builds green, then the container dies at startup on `ERR_MODULE_NOT_FOUND` the moment anything imports the package.

**`@aflow/lib`** includes a Vitest contract test (`dockerWorkspaceManifests.test.ts`) that fails if any of those lists drifts from the repo.

**Never push directly to `main`.** Every change goes through a branch and a pull request.

### Driving a change through the loop

A change can be built by the platform itself — Helmsman commissions the coding agent on
the connected checkout, Local Code Review reads the range, Local Publish commits, scans,
pushes and opens the pull request. Every session that works this way follows
`docs/dev/driving-work-through-the-loop.md`: one dev stack, one Helmsman conversation per
stream of work, a merge into `live` only when no Helmsman turn is in flight (the host
executor drains its harness runs), and the checks the
review does not run done by hand before the operator merges.

## Key files to read first

| File                                                        | Purpose                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CONTRIBUTING.md`                                           | How a change gets in: plans, licensing, pull requests                                      |
| `docs/dev/CONTRIBUTING.md`                                  | Code standards, common mistakes, documentation requirements                                |
| `docs/dev/integrations-and-capabilities.md`                 | Unified integration surface (APIs + MCP) — discover, promote, bind, call                   |
| `packages/schemas/src/runtime/streamMessages.ts`            | Stream message contracts                                                                   |
| `packages/schemas/src/runtime/agentTarget.ts`               | Tagged agent target — platform-role / custom-agent / inline-agent (Plan 160 §1.1)          |
| `packages/redis/src/hotState.ts`                            | SessionHotState, StepHotState, SessionEvent schemas                                        |
| `apps/aflow-orchestrator/src/services/SessionOrchestrator/` | Core orchestrator logic                                                                    |
| `packages/executor-runtime/src/executor.ts`                 | ExecutorRuntime base class                                                                 |
| `packages/web-product/src/ui/components/providers.tsx`      | `useSpaceFromRoute()`, `RouteSpaceBridge`, the route-derived space hook (Plan 160 Phase 2) |

## Local MCP server

The Aflow MCP server (`apps/aflow-mcp/`), **`aflow-local`**, is how a coding agent drives the local stack (`localhost:3000`): run operations, start and watch sessions, inspect them, browse the catalog.

**Set up.** `yarn start` serves it on `127.0.0.1:3100` (`MCP_HOST` names another interface, refused at startup while the auth file is configured — the Host check stops browsers, not another client on the network, which the session token would reach in the clear; unset one of them. An MCP server already holding the port is used instead of a second). It answers only to `localhost` and `127.0.0.1` on that port (`ALLOWED_HOSTS` replaces the list) and refuses any request carrying a browser `Origin` while the auth file is configured, so a web page cannot reach the owner's key through a name rebound to loopback; a `421` or `403` from it says which check refused. It is the owner, through an API key of its own in `mcp.local.json`, which `AFLOW_MCP_LOCAL_AUTH_JSON` in `.env` names, and it gives that key only to a session presenting the file's `sessionToken` as `Authorization: Bearer <token>`: a session presenting nothing, or another token, is refused with a `401` that says how to set it up. `yarn mcp:setup` mints the key and the token and writes both, and prints the line that sets `AFLOW_MCP_LOCAL_TOKEN` from the file without printing the token; `yarn start` runs it once the stack is healthy when the file is missing or sets no session token, and run by hand it replaces the key only when the API no longer accepts it. When `auth_status` reports a method other than `api_key`, check that `.env` names the file (read when the MCP server starts — restart it after adding the line), that the file parses (exactly the fields of `apps/aflow-mcp/mcp.local.json.example`; a refused file is a `local_auth_json_invalid` line in the server's log), and that the key is still listed under Settings → API Keys.

**Connect.** `.mcp.json` registers `aflow-local` at `http://localhost:3100` for Claude Code in this checkout and every worktree of it, sending `Bearer ${AFLOW_MCP_LOCAL_TOKEN}` and holding no credential itself: start Claude Code from a shell where that line has run (`yarn mcp:setup`, run in a terminal, offers to add it to the shell's profile; `--write-profile` adds it unasked, from a terminal or not, and without either nothing is written). A coding agent setting this up runs `yarn mcp:setup --write-profile`, then tells its operator the two things only they can do: start the client from a new shell, and approve the project's server. A session already running does not gain the server — the client loads MCP servers when it starts — so restart it from a shell that has the token. The client offers the project's server once; approve it. `claude mcp list` should report `aflow-local` connected: not naming it at all means it was not approved (`claude mcp reset-project-choices` offers it again), naming it as failed means the token is missing or wrong. A port moved off 3100 (`MCP_PORT`, then `PORT`) needs `aflow-local` registered again at the new port with `claude mcp add` in local scope, which overrides the project file. After the MCP server restarts, start a new session to pick up changed tool schemas.

**Drive.** Follow `docs/dev/driving-work-through-the-loop.md`. Tools (prefixed `mcp__aflow-local__`): `auth_status`, `space_list`, `catalog`, `run_operation`, `start_session`, `watch_session`, `watch_run`, `inspect_session`, `retry_session`, `fetch_payload` (lazy/auto payload mode only). MCP sessions are in-memory (lost on restart). Every space-scoped tool takes an explicit `space_id` (discover via `space_list`). When `start_session`/`run_operation` time out waiting, the response carries a `continuation` (tool + args) — call it verbatim (`watch_session`/`watch_run`) instead of polling. `inspect_session` is bounded: status, target, the newest ten steps without the `agent.control.run_step` wrappers, the agent's latest reply or the question it is paused on, a `census` of every step left out with the parameter that returns it (`last_n_steps`, `cursor`, `status`, `operation`, `include_control_steps`), and for a `FAILED` session a `failure` — the failing step and its stored error, provider's words included — which `watch_session` carries too; `retry_session` then runs it again, as the web UI's Retry does.

## Documentation practices

After every change that affects behavior, schemas, or architecture:

1. Update the plan in `docs/plans/` that covers it, if one does
2. Update this CLAUDE.md if you added new packages, apps, or changed architecture
3. Update `.claude/skills/` and `.cursor/rules/` if your change affects a pattern they cover

## Environment setup

`yarn start` creates `.env` from `.env.example` on first run. Postgres listens on port
**5433** (not the default 5432), Redis on 6379. Model provider keys are added in the web UI.

**Every service requires a credential** (Plan 315 D20). Every checkout shares one Redis, so its
password is the machine's, in `~/.aflow/stack.env` (written by the first `yarn start` or `yarn dev:local`); every
script that runs tsx on a file of the repository runs under `scripts/with-stack-env.mjs`
(`with-stack-env.test.mjs` names the entry points that cannot, and why), which reads `.env`
under what the caller set, as `dotenv` did, and lays the password into a `REDIS_URL` naming this
machine (`scripts/stackEnv.mjs`), so `.env` carries none. Redis Commander and pgAdmin log in with
it, on `127.0.0.1` — pgAdmin with the password as it was when its volume was created, until that
volume is removed. The Redis integration suites resolve the URL as the services do
(`scripts/stackRedis.mjs`) and connect only to this machine's Redis: they skip where no Redis
answers or the URL names another host, and fail where one refuses its credential. `yarn start`
prints each service's credential state and stops on a Redis without the machine's password or a
`REDIS_URL` for it carrying its own; a `REDIS_URL` naming another host is the checkout's own
Redis, checked with the credential it carries and never rewritten. **Then run
`yarn redis:password` once** — it adopts the machine's password and restarts Redis with it; the
data stays.

@CLAUDE.hosted.md
