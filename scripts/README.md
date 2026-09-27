# Scripts

Development and testing utilities for the Phoenix platform.

## Testing

### Unit-test runner

`scripts/test-runner.mjs` is the root Vitest entrypoint. Use `yarn test:file`,
`yarn test:workspace`, or `yarn test:changed` while iterating, and reserve `yarn test` for the
complete proof. Full runs share a lock across sibling Git worktrees; a waiting run must not be
bypassed with another broad Vitest or workspace-level parallel command.

### Integration Tests (API-based)

```bash
./scripts/test-flows.sh all               # Run all tests
./scripts/test-flows.sh agent             # Agent flow (ai.agent_turn loop)
./scripts/test-flows.sh chat-history      # Chat with history (ai.generate + historyPolicy)
./scripts/test-flows.sh user              # User input (pause/resume)
./scripts/test-flows.sh memory            # Memory tests (put-get + full-cycle)
./scripts/test-flows.sh memory-concurrent # 5 parallel memory runs (keyed concurrency + DB pool)
```

Tests use **inline `flowConfig`** (POST /v1/runs with flowConfig body) — no database required.
Each test starts a run, polls for completion, and checks the final status.

### Test Flow Definitions

JSON files in `scripts/test-flows/`:

| File                       | Description                                               |
| -------------------------- | --------------------------------------------------------- |
| `agent-research.json`      | Agent that calls an API tool step and completes           |
| `agent-simple.json`        | Minimal agent flow                                        |
| `ai-chat.json`             | Simple AI text generation                                 |
| `api-call.json`            | API HTTP call                                             |
| `chat-with-history.json`   | AI generate with history policy enabled                   |
| `memory-put-get.json`      | Memory v2: put a document, then get it back               |
| `memory-full-cycle.json`   | Memory v2: put → list → grep → get (transaction + search) |
| `multi-step-api-ai.json`   | Multi-step: API call then AI summarize                    |
| `platform-get-schema.json` | Platform: get operation schema                            |
| `user-input.json`          | User input step (pause/resume)                            |

### Adding a New Test

1. Create a flow file under `scripts/test-flows/` — `my-test.json`, say:

```json
{
  "flowConfig": {
    "name": "my-test",
    "startStepId": "step1",
    "steps": [
      {
        "stepId": "step1",
        "type": "ai",
        "operation": "ai.generate",
        "config": { "model": "gpt-4o-mini", "temperature": 0.5 }
      }
    ]
  },
  "input": { "message": "Hello" }
}
```

2. Add to `scripts/test-flows.sh`:

```bash
test_my_test() {
  run_flow_test "My test description" scripts/test-flows/my-test.json
}
```

3. Register in the `case` switch and `all` profile.

## Database & Seeding

### Seed a Cybernetic Space (Plan 102h)

```bash
yarn db:seed:cybernetic                                     # defaults: first tenant, "Cybernetic Lab", ml-optimization
yarn db:seed:cybernetic --template pe-intake-pricing        # pick a different directive template
yarn db:seed:cybernetic --tenant t_dev --space-name "Q2O"   # target a specific tenant + custom name
yarn db:seed:cybernetic --help                              # usage
```

End-to-end dev seed for Plan 102h. Runs the **bootstrap** code path the HTTP
`PATCH /v1/spaces/:id` handler uses, but **not** the old Heroku release sweep
for platform agents (Plan 106: `release.mjs` no longer calls
`seedCyberneticAgents` / `seedCapabilityFlows`; runtime reads platform
definitions from `packages/platform-artifacts`).

1. `seedCyberneticAgents()` — optional local insert of `agent_definitions` rows
   for the ensemble (useful for dev; **not** run on every production deploy
   anymore).
2. Creates a space row in that tenant's schema.
3. Writes directives from the chosen template and calls
   `bootstrapCyberneticEntity()` — the same function `PATCH /v1/spaces/:id`
   calls — which wires the space, self-model, default agent, and emits
   `entity.space.bootstrapped` into the per-space entity event stream
   (cybernetic workflow/manifest seeding into memory was removed; those resolve
   from the platform registry at runtime).

**Templates**: `blank`, `ml-optimization`, `pe-intake-pricing`, `q2o-approval`
(see `packages/schemas/src/cybernetic/directiveTemplates.ts`).

**Safety rails**: refuses to run when `NODE_ENV=production` or when
`DATABASE_URL` matches any production host pattern (`*.aflow.ai`,
`*.cloudsql.*`, `*.rds.amazonaws.com`, `*.supabase.co`, GCP private IPs).
Local-dev only.

Pair with the web app — after the script prints the space id, open
`http://localhost:3001/chat?spaceId=<id>` (Executive auto-mounts via Phase 3
default-agent wiring) or `/console/<id>` for the Console view, or
`/console/<id>/agents` to inspect the three-agent ensemble.

### Seed Sample Flows

```bash
yarn db:seed                          # Via root script
npx tsx scripts/seed-flows.ts         # Direct execution
```

Seeds capability flow rows with `seedCapabilityFlows()` (direct SQL, local
dev). **Production `release.mjs` no longer runs this** (Plan 106 — platform
definitions are code-backed; see `packages/platform-artifacts`). What remains is
plumbing rather than agents an operator picks:

- **mcp-runner** — System plumbing for single-operation execution via MCP
- **workflow-agent** — Workflow lifecycle sub-agent (defining, running, evaluating)

The pre-cybernetic specialists — orchestrator, agent-builder, api-configurator,
media-creator — are gone. Helmsman is the operator's entry point and holds what
they held; they had accumulated no sessions at all, while still occupying the
agents list as things you could apparently pick.

System prompts are stored as versioned `.md` files in `seeds/prompts/` and injected at seed time.

### Plan 106 — cleanup of legacy seeded rows (operator maintenance)

To soft-delete pre-registry copies of platform agents, workflow docs, manifests,
or eval suite docs that were created with `created_by` / `created_by_actor` of
`system` (does **not** delete operator-authored overrides):

```bash
npx tsx scripts/106-cleanup-seeded-artifacts.ts            # dry-run
npx tsx scripts/106-cleanup-seeded-artifacts.ts --execute
```

Read the script header and get approval before using against shared
environments.

### Database Management

```bash
yarn infra:up         # Start Postgres (5433) + Redis (6379)
yarn infra:down       # Stop infrastructure
yarn infra:reset      # Wipe data and reinitialize (runs init-db.sql)
yarn infra:tools      # Start with pgAdmin (8080) + Redis Commander (8081)
```

Database is initialized by `scripts/init-db.sql` on container creation.
Default dev tenant: `a0000000-0000-0000-0000-000000000001`.

### Schema Changes

1. Edit `packages/database/src/schema/tenant.ts` or `public.ts`
2. Run `yarn db:push` to apply changes
3. For production: generate migrations with `yarn db:generate`

## Debugging Runs (Plan 25)

| Script                               | Purpose                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `scripts/run-flow.ts`                | Start a flow run (saved or inline), `--wait`, `--parallel N`     |
| `scripts/tail-run-events.ts`         | Poll run events; `--hydrate`, `--follow`, `--timing`             |
| `scripts/export-run-debug-bundle.ts` | Export `.debug/runs/<runId>/` bundle for offline analysis        |
| `scripts/perf-check.ts`              | Performance regression checker (p50/p95/p99, threshold gate)     |
| `scripts/large-files/cli.ts`         | Plan 153 large-file scan, baseline-aware check, baseline refresh |

### `run-flow.ts` — Parallel mode

Launch N identical runs simultaneously and get a summary:

```bash
npx tsx scripts/run-flow.ts \
  --flow-config scripts/test-flows/memory-put-get.json \
  --parallel 5 --wait
```

### `tail-run-events.ts` — Timing mode

Show per-step queue wait, execution time, and a summary:

```bash
npx tsx scripts/tail-run-events.ts <runId> --timing
```

### `perf-check.ts` — Performance regression gate

Run a flow N times, compute percentiles, fail if p95 > threshold:

```bash
npx tsx scripts/perf-check.ts \
  --flow-config scripts/test-flows/memory-put-get.json \
  --runs 10 --max-p95 500
```

Options: `--concurrency N` for parallel batches, `--max-p95 <ms>` as a CI gate.

### `large-files/cli.ts` — File-size guardrails (Plan 153)

Baseline-aware production TS/TSX budgets (600 LOC warn, 900 LOC hard gate for new files):

```bash
yarn large-files:scan
yarn large-files:check      # runs in yarn typecheck / CI
yarn large-files:baseline   # refresh scripts/large-file-baseline.json after splits
```

See `docs/plans/aflow/153-large-file-modularization-and-guardrails.md` and `docs/dev/CONTRIBUTING.md`.

See `docs/dev/debugging-runs.md` for curl snippets and golden path.

## Other Scripts

| Script                                | Purpose                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/dev.mjs`                     | Dev runner — orchestrates all services with prefixed logs                            |
| `scripts/test-runner.mjs`             | Bounded root Vitest runner, focused feedback lanes, and cross-worktree full-run lock |
| `scripts/export-operation-catalog.ts` | Export operation catalog as JSON                                                     |
| `scripts/test-e2e-flow.ts`            | E2E test: create flow → trigger run → monitor                                        |
| `scripts/test-ai-step.sh`             | Test real AI step execution via API                                                  |
| `scripts/test-inline-flow.sh`         | Test inline flowConfig API                                                           |
| `scripts/init-db.sql`                 | Database initialization (runs on Docker container start)                             |
