# System Agents, Platform Skills & The Skill-Shop

How platform-bundled capability ships to every tenant, how the registry overlay works, and how a tenant imports community/platform-curated skills via the skill-shop.

## The platform-artifact registry (Plan 106)

Source: `packages/platform-artifacts/`. Plan doc: `docs/plans/aflow/completed/102-cybernetic-agent/106-platform-artifact-registry-and-space-overlays.md`.

Before Plan 106, system agents and skills were **seeded into every tenant's database** at deploy time via `release.mjs`. This was wasteful (per-tenant copies of identical artifacts), risked drift across tenants, and made hot-fixing painful (a deploy required reconciliation across all tenants).

Plan 106 replaced that with a **runtime registry overlay**:

- Platform-owned skills, system agents, and directives live as TypeScript modules in `@aflow/platform-artifacts`.
- Loaders in `@aflow/database` (e.g., `getWorkflow()`, `getSkillManifest()`, `getCapabilityFlow()`) check the registry **first**, then fall back to space-local storage for operator-owned artifacts.
- Reserved keys (registered via `reservedKeys.ts`) cannot be shadowed by space-local writes — attempts to write to them are rejected.
- The `release.mjs` deploy phase **no longer seeds platform skills/agents per tenant** — the registry is the source of truth at runtime.

### What's in the registry

| File                                                  | Contents                                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/platform-artifacts/src/cyberneticAgents.ts` | The four system agents: Helmsman, Runner, Coach, Driver. ~948 lines of full agent definitions with system prompts, tool catalogs, state variables. Built around lines 933–938 as `CYBERNETIC_AGENTS`. |
| `packages/platform-artifacts/src/skillBundles.ts`     | Platform-bundled skills: `compose-skill` (~lines 100–600) and `bind-capability` (~lines 593–800). Each includes the full `SkillManifest`, `WorkflowDefinition`, and `CyberneticEvalSuite`.            |
| `packages/platform-artifacts/src/capabilityAgents.ts` | Classic capability agents (orchestrator, agent-builder, api-configurator, media-creator, mcp-runner, ml-prediction-agent). Used in non-cybernetic spaces.                                             |
| `packages/platform-artifacts/src/skillCatalog.ts`     | The skill-shop catalog: `SKILL_CATALOG` array of `SkillCatalogEntry` items.                                                                                                                           |
| `packages/platform-artifacts/src/reservedKeys.ts`     | Slugs that cannot be shadowed by space-local writes.                                                                                                                                                  |
| `packages/platform-artifacts/src/registry.ts`         | Operation registrations the platform provides.                                                                                                                                                        |

### How a developer modifies a system skill

1. Edit `packages/platform-artifacts/src/skillBundles.ts` (or `cyberneticAgents.ts` for agents).
2. Run `yarn typecheck` — the bundle is type-checked end-to-end.
3. Test via the `aflow-local` MCP server (served by `yarn start`) — see the `test-mcp` skill.
4. Commit & deploy. **No per-tenant migration needed.** Every tenant picks up the new bundle on the next request that resolves the slug.

### Space overlay rules (Phase 1)

- **Additive only.** A tenant can add space-local skills at slugs that don't conflict with the registry.
- **Reserved-key block.** Writes to platform slugs (`compose-skill`, `bind-capability`, etc.) are rejected.
- **No fork/clone yet.** Plan 106 Phase 2 sketches an explicit fork operation; not implemented. If a tenant needs a custom variant, the workaround is to author a new skill with a different slug.

## System agents

The four-agent ensemble lives in `cyberneticAgents.ts` as `CapabilityFlowDefinition` objects — same shape as classic capability flows. Each defines:

- A system prompt embedded at the top of the file (`PROMPT_HELMSMAN`, `PROMPT_RUNNER`, `PROMPT_COACH`, `PROMPT_DRIVER`).
- The flow's state variables, steps (mostly `ai.agent.turn` orchestrators), and tool catalog scoping.
- The role's specific operation surface (e.g., the Helmsman exposes `proposal.list`, `proposal.ratify`, `run-procedure`, `run-coach`; the Coach has memory-write authority the Helmsman lacks).

To modify a system agent: edit the file, redeploy. Same overlay rules — no per-tenant variants.

> **You don't add a fifth system agent to add capability.** Capability is added by authoring a skill (via `compose-skill`) or binding an external API/MCP server (via `bind-capability`). The four-agent ensemble is constitutional.

## The skill-shop / skill catalog (Plan 108)

Plan docs: `docs/plans/aflow/108-skill-catalog-and-store.md` (catalog model), `docs/plans/aflow/244-store-one-catalog-production.md` (the unified Store surface).

The skill-shop is the distribution mechanism for skills users want to import rather than author from scratch. Two surfaces:

| Surface | Path                                                                                          | Purpose                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **UI**  | `/s/[space]/store?kind=skill` (`apps/web-local/src/app/(dashboard)/s/[space]/store/page.tsx`) | Browse the unified Store, view listing details, install.                                                          |
| **API** | `POST /v1/spaces/:spaceId/store/install-preview`                                              | Dry run. Body: `{ catalogId }` — returns planned artifacts, conflicts, missing setup, and the `catalogVersion`.   |
|         | `POST /v1/spaces/:spaceId/store/install`                                                      | Body: `{ catalogId, expectedVersion, idempotencyKey }` — `expectedVersion` echoes the preview's `catalogVersion`. |

### Catalog data model

Source: `packages/schemas/src/cybernetic/skillCatalog.ts` (`SkillCatalogEntry`).

Catalog entries are code-backed in `packages/platform-artifacts/src/skillCatalog.ts`. Today there are four entries (small — Plan 108 is shipped at Phase 2 but the catalog is still maturing):

- `ml-experiment-runner`
- `intake-triage`
- `approval-routing`
- `_test-api-dependent` (hidden test fixture)

Each entry carries:

- A portable `SkillComposeBundle` (workflow + manifest + evals + activation).
- `capabilityHints` — APIs/MCP servers the skill expects to be bound. The install flow checks these against the destination space and prompts to run `bind-capability` if anything's missing.
- Versioning fields (`catalogVersion`).

### Install flow

1. Operator browses `/s/[space]/store?kind=skill` and picks a listing.
2. Hit `install-preview` to see what will land and what's missing — note the returned `catalogVersion`.
3. If capability hints are unbound, run `bind-capability` first (the UI prompts).
4. Hit `install` with `{ catalogId, expectedVersion, idempotencyKey }` — the bundle materializes under `/skills/{slug}/...` with `origin: 'cloned'`, `sourceCatalogId`, `sourceVersion`, and `installedAt` populated.
5. Post-install, the skill is **a fully editable, operator-owned copy** — Coach can refine it, Helmsman can activate it, no link to the catalog version.

> **Maturity caveat.** The skill-shop is shipped infrastructure but the catalog is small. As it matures it's expected to become a primary path for new capability — most users will install rather than compose. Treat the shop as the **first thing to check** when a user asks for a new capability: if a curated skill already exists, importing is faster, safer, and more reproducible than authoring from scratch.

### What's _not_ yet in the shop

- Marketplace mechanics (ratings, contributions from operators, paid skills).
- Auto-update on catalog version bumps (cloned skills are deliberately decoupled from upstream).
- Catalog management UI for platform engineers (entries are edited in code).

## Modifying system skills vs. operator skills — a quick guide

| Scenario                                            | Where to make the change                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fix a bug in `compose-skill` task logic             | Edit `packages/platform-artifacts/src/skillBundles.ts` → redeploy.                                                          |
| Adjust the Helmsman's system prompt                 | Edit `packages/platform-artifacts/src/cyberneticAgents.ts` (`PROMPT_HELMSMAN`) → redeploy.                                  |
| Add a new platform skill all tenants get            | Add a new bundle to `skillBundles.ts`, register in `reservedKeys.ts` → redeploy.                                            |
| Distribute an opt-in skill (operator chooses)       | Add a `SkillCatalogEntry` to `packages/platform-artifacts/src/skillCatalog.ts` → redeploy.                                  |
| Fix a misbehaving operator-owned skill in one space | Helmsman activates `compose-skill` again to author a replacement, or Coach proposes a `workflow_refinement` `StagedChange`. |
| Roll out a refinement to many spaces at once        | Not supported automatically — each space owns its skills after import. Re-author and re-distribute via catalog if needed.   |

## Pointers to plans for deeper context

| Topic                                           | Plan                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The cybernetic vision and ontology              | `docs/plans/aflow/completed/102-cybernetic-agent/00-vision.md`, `00-ontology.md`                       |
| Naming and registers                            | `docs/plans/aflow/completed/102-cybernetic-agent/00-naming.md`, `104a-unified-naming-migration.md`     |
| Typed `StepRole` and the cohesion model         | `102-cybernetic-agent/104b-skill-cohesion-and-typed-step-roles.md`                                     |
| Graph contract runtime                          | `123-graph-contract-runtime.md`                                                                        |
| Cross-task typed channels                       | `completed/129-cross-task-typed-channels.md`                                                           |
| compose-skill robustness / handoffs             | `117-compose-skill-robustness.md`, `102-cybernetic-agent/104f-compose-skill-meta-skill.md`             |
| External capability binding                     | `102-cybernetic-agent/104g-external-capability-binding.md`                                             |
| Platform-artifact registry & overlays           | `102-cybernetic-agent/106-platform-artifact-registry-and-space-overlays.md`                            |
| Skill catalog & store                           | `108-skill-catalog-and-store.md`                                                                       |
| SpaceContext skill surfacing                    | `completed/124-spacecontext-skill-surfacing.md`                                                        |
| Workflow run pause / resume / failure isolation | `completed/130-workflow-run-pause-resume-failure-isolation.md`, `completed/131-delegation-liveness.md` |
| Adaptive cybernetic loop                        | `102-cybernetic-agent/105-adaptive-cybernetic-loop.md`                                                 |
| Advanced guardrails / grader completion         | `102-cybernetic-agent/107-advanced-guardrails-and-grader-completion.md`                                |
