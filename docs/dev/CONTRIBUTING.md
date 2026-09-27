# Contributing to Aflow

Guidelines for humans and AI agents working in this codebase.

## Before You Start

1. **Read the Cursor rules** in `.cursor/rules/` — they provide essential context for every task.
2. **Read [`docs/plans/README.md`](../plans/README.md)** — larger changes start with a plan there.
3. **Understand the architecture**: Redis-first hot path, schema-first types, payload discipline.

## Development Workflow (for AI agents and humans)

The `/check` Claude Code skill runs the quality gate: it auto-fixes formatting and lint, then runs build, typecheck and tests.

**The order is always**:

1. Make your code changes
2. Run `yarn format` — **always format before staging/committing** (CI enforces `yarn format:check`)
3. `/check` — confirms build + typecheck + test all pass
4. Update the docs the change affects — the plan it implements, `CLAUDE.md`, skills and rules
5. Commit on a branch, push, and open a pull request against `main`

**Never push directly to `main`.** All changes go through a PR. CI runs automatically on every PR.

### Branch naming convention

```
<type>/<short-description>
```

| Type        | When           | Example                         |
| ----------- | -------------- | ------------------------------- |
| `feat/`     | New feature    | `feat/grpc-executor-streaming`  |
| `fix/`      | Bug fix        | `fix/sse-reconnection-race`     |
| `docs/`     | Docs only      | `docs/update-plan-19-notes`     |
| `refactor/` | Restructure    | `refactor/extract-run-watchdog` |
| `chore/`    | Tooling/config | `chore/topological-build-order` |
| `test/`     | Tests only     | `test/agent-flow-integration`   |

Rules: `kebab-case`, 3-5 words, no ticket numbers (unless referencing a GitHub issue).

## Commit Message Standards

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>
```

**Types**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `style`

**Scopes** (use the app or package name): `orchestrator`, `executor-ai`, `executor-memory`, `executor-api`, `executor-user`, `server`, `web`, `schemas`, `database`, `redis`, `ai-client`, `payload-store`, `executor-runtime`, `input-resolution`, `observability`, `mcp`, `scripts`, `docs`

Examples:

```
feat(orchestrator): add agent decision handling for invoke_steps
fix(web): resolve SSE reconnection race in use-run-events hook
docs(plans): mark plan 19 as completed, add implementation notes
chore(schemas): rebuild output after adding AgentTurnDecision schema
```

## Code Standards

### TypeScript Strictness

The codebase uses strict TypeScript with these enforced rules:

| Rule                                 | Impact                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `exactOptionalPropertyTypes`         | Cannot assign `undefined` to `foo?: string` — omit the property instead |
| `noPropertyAccessFromIndexSignature` | Must use `config['key']` not `config.key` for index signatures          |
| `noUncheckedIndexedAccess`           | Array/object indexed access returns `T \| undefined`                    |
| `strict: true`                       | All strict checks enabled                                               |

### Import Conventions

- Use `.js` extensions in imports: `from "../runtime/aiHistory.js"` (NodeNext resolution)
- Use `import type { Foo }` for type-only imports
- Cross-package imports use the package name: `from "@aflow/schemas"`

### Error Handling

```typescript
// Always catch with typed errors
try {
  await doSomething();
} catch (err) {
  log.error('Failed to do something', {
    error: err instanceof Error ? err.message : String(err),
  });
  throw err; // Re-throw or handle explicitly
}
```

Never swallow errors silently. At minimum, log them.

### Naming

- `camelCase` for variables, functions, parameters
- `PascalCase` for types, interfaces, classes, Zod schemas (e.g., `AgentTurnInputSchema`)
- `UPPER_SNAKE_CASE` for constants
- Schema naming: `<Thing>Schema` with `type <Thing> = z.infer<typeof <Thing>Schema>`

### Large-file guardrails (Plan 153)

Production TypeScript/TSX modules should stay reviewable. The repo enforces a **baseline-aware** budget:

| Policy                     | Threshold                                                                  |
| -------------------------- | -------------------------------------------------------------------------- |
| Target                     | 300–500 LOC for ordinary modules                                           |
| Soft warning (scan output) | production files ≥ 800 LOC                                                 |
| Hard gate (new files)      | production files > 1500 LOC unless allowlisted                             |
| Existing over-budget files | may not grow more than **+50 lines** vs `scripts/large-file-baseline.json` |

**Split rules** (behavior-preserving refactors only):

1. Split by domain, lifecycle, operation, or event family — never by arbitrary line ranges.
2. Keep public imports stable; use a thin `index.ts` facade when needed.
3. Do not duplicate schema field lists; derive from Zod at runtime.
4. One module family per PR unless a shared boundary is required.

Commands:

```bash
yarn large-files:scan      # report warnings and top offenders
yarn large-files:check     # CI gate (also runs in yarn typecheck)
yarn large-files:baseline  # refresh baseline after an intentional batch split
```

Allowlist entries live in `scripts/large-file-allowlist.json` and require `path`, `reason`, and `owner`. Omit `maxLines` to exempt a new over-budget file from the 900 LOC hard gate; set `maxLines` only when you need an explicit ceiling. See `docs/plans/aflow/153-large-file-modularization-and-guardrails.md` for the full modularization roadmap.

## Schema-First Development

All types flow from Zod schemas in `@aflow/schemas`:

1. **Define the Zod schema** in `packages/schemas/src/`
2. **Derive the TypeScript type** with `z.infer<typeof Schema>`
3. **Register operations** in `packages/schemas/src/catalog/registry.ts`
4. **Build**: `yarn workspace @aflow/schemas build`
5. Other packages import the compiled output

### Derive, don't mirror schemas

Never maintain a hand-written list that must stay in sync with a Zod schema — derive it at runtime. See `deriveStringFields()` in `packages/redis/src/hotState.ts` for the pattern. Manual lists silently drift and cause bugs that no typecheck catches.

Any serialize/deserialize boundary should have a **schema-driven round-trip test**: serialize a valid object, deserialize it, and assert the Zod schema still parses it. This catches type-mangling bugs (e.g., a JSON string field silently parsed into an object) that typechecks cannot detect.

### Adding a New Operation

See `.cursor/rules/schemas-and-operations.mdc` for the step-by-step guide.

### Field Visibility in UI

Use `internalFields` on `OperationMeta` to hide orchestrator-managed fields:

```typescript
"ai.agent_turn": {
  name: "Agent Turn",
  semanticDescription: "...",
  internalFields: {
    input: ["availableTools", "historyRef", "lastToolResults", "turnNumber"],
  },
},
```

## Docker image and new workspaces

The root **`Dockerfile`** uses an explicit **`COPY …/package.json`** list for every Yarn workspace **before** **`yarn install --immutable`** (builder stage) and again in the **production** stage (from the builder image). When you add **`apps/<name>`** or **`packages/<name>`** with a `package.json`, add the matching **`COPY`** lines in **both** stages, next to the other workspace entries. If you omit this, image builds fail with Yarn **YN0028** (lockfile would have been modified) because the install-time workspace graph does not match `yarn.lock`.

**Enforcement:** `packages/lib/src/__tests__/dockerWorkspaceManifests.test.ts` compares the repo’s workspace directories to those `COPY` lines. It runs with **`yarn test`** (no Docker required).

**ESLint:** There is no practical ESLint rule for this—ESLint does not parse Dockerfiles, and duplicating the workspace list in JS for a custom rule would be another source of drift. The Vitest contract test is the appropriate check.

## Platform-owned agents and skills (Plan 106)

Platform **definitions** (system capability agents, cybernetic ensemble agents, built-in workflows/skill bundles used identically in every tenant) are authored in `packages/platform-artifacts` and loaded through registry-aware resolvers in `@aflow/database`, the orchestrator, and `packages/cybernetic-runtime`. Reserved IDs are enforced at publish/API boundaries.

- **Do not** add new `release.mjs` or deploy-phase steps that upsert the same platform flows into every tenant schema. Release stays for migrations and tenant-owned or catalog data — not for reconciling global platform definitions.
- **Do** extend or fix platform behavior by changing `platform-artifacts` and the shared resolver helpers, then run the normal quality gates (`/check`).

Local dev may still use `yarn db:seed` / `yarn db:seed:cybernetic` to insert **rows** and bootstrap spaces; runtime resolution of platform agents still prefers the code registry. If something works only when rows exist in `agent_definitions`, that is a bug relative to Plan 106 — fix the resolver path, do not re-add production sweeps.

## URL state and web routes (Plan 160)

The web app treats the URL as the canonical source of truth for "which space is this page in" — there's no client-side activeSpace pointer that pages should read instead. A few rules that come out of that:

- **Space-scoped routes live under `/s/[space]/...`** (`apps/web-local/src/app/(dashboard)/s/[space]/`). Tenant-scoped surfaces (`/account`, `/settings/*` — the tenant settings, not space settings — `/spaces`, `/spaces/archived`) stay top-level. Legacy paths (`/chat`, `/agents/...`, `/memory`, `/integrations`, `/sessions`, `/spaces/settings`) are thin redirects that consult the `preferredSpaceSlug` cookie and forward to the canonical `/s/<slug>/...` URL — they preserve query strings.
- **Use `useSpaceFromRoute()` on pages under `/s/[space]/...`.** It reads `useParams().space` and looks the slug up in the spaces list. The legacy `useSpace()` is still wired (via `RouteSpaceBridge`) for backward compatibility, but route-derived is one effect ahead of bridge-derived during navigation.
- **Build links with `spaceRoute(slug, '/agents/foo')`** (`packages/web-product/src/ui/lib/space-routes.ts`). For space switches, `equivalentRouteInSpace(currentPath, newSlug)` truncates deep resource paths so `/s/A/agents/foo/edit` lands on `/s/B/agents` instead of a 404. For "where did this thing go" UX, render `<NotInThisSpace resourceKind="agent" resourceSlug={…} currentSpaceSlug={…} />` on a 404 — it consumes `/v1/spaces/where-is`.
- **Agent route segments use the slug**, not the UUID. `Flow.slug` is the canonical URL identifier; `Flow.agentId` (UUID) is for runtime references (`?agentId=` query params, DB references). The agent detail page accepts either, but links should prefer `slug ?? agentId`.
- **Query keys for space-scoped reads MUST nest under `['space', spaceId, ...]`** (Plan 161 §4.4). Pass `spaceId: routeSpace.id` to `useApiQuery` so `X-Space-ID` matches the URL, and gate with `enabled: !!routeSpace?.id` so requests don't fire before the slug resolves. The agent detail page is the reference (`apps/web-local/src/app/(dashboard)/s/[space]/agents/[agentId]/page.tsx`).
- **Slugs are validated at write time.** `POST /v1/spaces` and `POST /v1/agents` use `validateSpaceSlug` / `validateAgentSlug` from `@aflow/schemas` — typed `SLUG_INVALID` / `SLUG_RESERVED` errors. Rename emits a `space_slug_history` / `agent_slug_history` row inside the UPDATE transaction so retired slugs can't be reused; `PATCH` returns `409 SLUG_TAKEN` on collision.
- **Helmsman emits links via `SpaceContext.navigation.routes`** templates and the pre-built `route` field on `catalog.agent.list` items — never invent paths. Same-origin markdown links route through `next/link` automatically (`packages/web-product/src/ui/components/markdown-renderer.tsx`).

The plan doc is `docs/plans/aflow/completed/160-url-state-and-agent-driven-navigation.md`. Cache-key sweep playbook (still useful as a pattern reference for new hooks): `docs/plans/aflow/160-handoff-cache-key-sweep.md`.

## Orchestrator Changes

All app services (server, orchestrator, executors) now use `tsx watch` and auto-restart on file changes. However, **changes to compiled packages** (`packages/*`) still require `yarn build` — the watcher only observes direct source files, not compiled `dist/` outputs.

If you suspect a stale process, check for duplicates:

```bash
ps aux | grep orchestrator | grep -v grep
```

## CI checks — what blocks a merge

See `docs/dev/CI.md` for full details. In brief:

| Check                          | Blocks merge?         |
| ------------------------------ | --------------------- |
| Typecheck (`yarn typecheck`)   | **Yes**               |
| Format (`yarn format --check`) | **Yes**               |
| Build (`yarn build`)           | **Yes**               |
| Tests (`yarn test`)            | **Yes**               |
| Schema determinism             | **Yes**               |
| Lint (`yarn lint`)             | **Yes — errors only** |

**Lint warnings are non-blocking, but lint errors still block CI.** There is a backlog of pre-existing ESLint warnings, so the CI lint job allows warnings to remain visible without failing the PR. Fix lint issues in new code you write; don't add to the backlog.

## Lint and Build Hygiene

Keep `yarn build` and `yarn typecheck` passing. Lint warnings are non-blocking, but keep new code clean:

- **Fix lint issues in new code**: Prefer fixing over disabling rules. Remove unused imports/vars.
- **Template literals**: Use `String(n)` for numbers to satisfy `restrict-template-expressions`.
- **Object stringification**: Avoid `String(obj)` when `obj` can be an object; use explicit fields or `JSON.stringify`.
- **Unused vars**: Prefix intentionally unused vars with `_` (e.g. `_setShowPanel`).

## Testing

### Unit Tests

```bash
yarn test                                           # Complete proof: every workspace
yarn test:changed                                    # Affected tests since main + local changes
yarn test:changed origin/main                        # Use a different comparison ref
yarn test:workspace @aflow/schemas                 # One workspace
yarn test:file packages/schemas/src/example.test.ts # One or more explicit files
yarn test:profile                                    # Full run with slow-import diagnostics
```

Use Node 22 (`nvm use` reads `.nvmrc`). The root runner is the supported path: it gives all
projects one bounded worker pool, applies one project configuration, and prevents full runs in
sibling Git worktrees from competing for the same machine. Override its conservative
worker budget only for a measured run with `PHOENIX_TEST_WORKERS=<n>`.

`test:changed`, `test:workspace`, and `test:file` are feedback lanes. CI and preflight still run
the complete `yarn test` proof.

**Multi-worktree rule:** if `yarn test` reports that another run owns the lock, leave it queued or
keep working with a focused feedback command. Do not bypass the wait with raw Vitest, package test
scripts, or workspace-level parallelism; those recreate the resource contention the runner removes.

### Integration Tests

Requires a running stack (`yarn start`):

```bash
./scripts/test-flows.sh all            # All flow tests
./scripts/test-flows.sh agent          # Agent flow only
```

### Cybernetic dev seed

For end-to-end work on Plan 102h (cybernetic entities), seed a fully
bootstrapped space in one command:

```bash
yarn db:seed:cybernetic --template ml-optimization
```

Runs `seedCyberneticAgents()` (optional local rows in `agent_definitions`) plus
`bootstrapCyberneticEntity()` for space wiring — the same bootstrap entrypoint
as production, but **not** the same as the old deploy sweep: `scripts/release.mjs`
no longer calls `seedCapabilityFlows` / `seedCyberneticAgents` (platform
**definitions** come from `packages/platform-artifacts` at runtime). The script
hard-refuses on `NODE_ENV=production` or prod-looking `DATABASE_URL` hosts. See
`scripts/README.md` for flag reference.

### After Any Schema Change

```bash
yarn workspace @aflow/schemas build  # Rebuild compiled output
yarn typecheck                         # Verify no type errors
```

## Common Mistakes

1. **Forgetting to build schemas** after editing `packages/schemas/src/` — other packages see stale types
2. **Using `kind: "output"` for non-output payloads** — use the appropriate `PayloadKind` ("history", "state", "input", etc.) to avoid overwriting step output
3. **Not rebuilding packages** — all services auto-restart, but compiled packages need `yarn build`
4. **Duplicate orchestrator processes** — kill old ones before starting new
5. **macOS `head -n -1`** — not supported; use `sed '$d'` in shell scripts
6. **Forgetting `.js` in imports** — NodeNext requires explicit extensions
7. **Leaving unused imports** — causes lint warnings; remove or use them. Prefix intentionally unused vars with `_`
8. **UI work** — screens and components go in `packages/web-product/`; `apps/web-local/` holds only the routes that compose them
9. **Skipping the workflow** — always run `/check`, update docs, then commit
10. **Using `git add -A` or `git add .`** — stage files intentionally to avoid accidentally including `.env` or stale build artifacts
11. **Pushing directly to `main`** — always use a branch + PR; CI only runs on PRs
12. **"Works locally, fails CI" on build** — usually means `dist/` is missing in CI. The `--topological` flag in `yarn build` fixes ordering, but if you changed `packages/schemas/src/`, always run `yarn workspace @aflow/schemas build` locally first to verify
13. **Editing a compiled package without rebuilding** — packages like `executor-runtime`, `redis`, `schemas`, `payload-store`, `ai-client`, `database`, and `input-resolution` export from `dist/` (via `package.json` `exports`). Apps that import them (executors, orchestrator, server) resolve to the compiled JS, **not** the TypeScript source. After editing any of these packages, run `yarn build` before restarting services — otherwise the running code is stale. Symptoms: new code "doesn't run", events don't appear, no errors logged
14. **Maintaining manual lists that mirror Zod schemas** — never keep a hand-written `Set` or array of field names that must match a Zod schema. Derive it from the schema (e.g., `deriveStringFields()` in `hotState.ts`). Manual lists silently drift when someone adds a schema field but forgets the list
15. **MCP `registerTool` inputSchema** — in `apps/aflow-mcp/src/tools/*.ts`, always use `inputSchema: SomeSchema.shape as any`, never the full schema. MCP SDK 1.27+ Zod v3/v4 compat triggers deep type recursion → TS2589 + OOM. Runtime validation is unchanged (`.parse()` in handler). Do not "clean up" by removing the cast.
16. **Committing lint errors** — the pre-commit hook (`lint-staged`) blocks committing files with lint errors. Fix them or use `git commit --no-verify` (strongly discouraged — only for genuine emergencies). The rule: every file you commit must pass lint. You are not responsible for pre-existing debt in files you don't touch, but never make a file worse.

## Keeping Documentation in Sync

Documentation is NOT optional. Every change that affects behavior, schemas, or architecture
**must** update the relevant docs before the task is considered complete.

### What lives where

| Location                       | Content                                                                              | When to update                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/platform-artifacts/` | Code-backed definitions for platform agents, workflows, and skill bundles (Plan 106) | When you change a built-in system agent, workflow, or platform skill  |
| `docs/plans/<NNN>-*.md`        | Feature plans with schemas, behavior, acceptance criteria                            | When you change the behavior described in that plan                   |
| `.cursor/rules/*.mdc`          | Agent-facing context (architecture, patterns, gotchas)                               | When you add a new pattern, discover a gotcha, or change architecture |
| `scripts/README.md`            | Test and DB script usage                                                             | When you add/change test flows, seed data, or scripts                 |
| `README.md`                    | Project overview, quick start, repo structure                                        | When you add new packages/apps or change the dev workflow             |
| `docs/dev/CONTRIBUTING.md`     | Code standards and common mistakes                                                   | When you discover a new pattern or pitfall                            |

### After implementing a feature

1. **Update the plan** — mark status, add implementation notes for what was built vs. what was planned
2. **Update Cursor rules** if you introduced a new pattern or gotcha that future agents need to know
3. **Update `scripts/README.md`** if you added test flows or seed data

### After fixing a bug or gotcha

Add it to:

1. **`docs/dev/CONTRIBUTING.md`** → "Common Mistakes" section
2. **The relevant `.cursor/rules/*.mdc`** file so agents get warned proactively

### After adding a new operation

1. Update the plan it belongs to, if it's part of one
2. Add a test flow in `scripts/test-flows/` and document in `scripts/README.md`
3. Add a seed flow in `scripts/seed-flows.ts` for UI testing

### Rule of thumb

If you had to figure something out the hard way, write it down so the next agent doesn't have to.
