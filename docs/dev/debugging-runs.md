# Debugging Runs — Quickstart for Agents & Developers

Plan 25 standardizes a **golden debugging path** for flows and agents.

**If you only read one doc to test/debug a flow run, read this one.**

## What to Pass to a Coding Agent

Give the agent the minimum set of inputs below so it can start runs, watch events, and inspect state:

- **API base URL**: usually `http://localhost:3000`
- **Tenant header**: `X-Tenant-ID` (default dev tenant: `a0000000-0000-0000-0000-000000000001`)
- **How to start the run** (pick one):
  - **Saved flow**: `flowId` and optional `version`
  - **Inline flow**: a `flowConfig` JSON object (or a file path like `scripts/test-flows/agent-simple.json`)
- **Input**: the JSON you want as run input (often `{ "prompt": "..." }` or `{ "message": "..." }`)
- **What you’re trying to verify**: e.g. “agent calls tool X”, “step Y pauses and resume works”, “no loop”, “output matches schema”

### Copy/paste agent prompt template

```text
You are a coding agent testing Phoenix flows locally.

Use this API base URL: http://localhost:3000
Use tenant header: X-Tenant-ID: a0000000-0000-0000-0000-000000000001

Start a run using ONE of:
- Saved flow: flowId=<...> version=<...optional>
- Inline flow config file: scripts/test-flows/<...>.json

Input JSON: <paste JSON here>

Test plan:
1) Start the run.
2) Tail events until terminal/PAUSED.
3) If PAUSED, resume with stepExecutionId.
4) Fetch /v1/runs/:runId/debug (eventsLimit=200) and summarize: status, last events, agent snapshot refs, key runtime vars.
5) Hydrate any relevant refs via /v1/payloads?ref=...
6) Export a debug bundle to .debug/runs/<runId>/ and report what’s inside.

Report:
- runId, traceId
- terminal status (or why it’s still running)
- key events timeline
- links/commands I can run next
```

## Prerequisites

- Infrastructure: `yarn infra:up` (Postgres 5433, Redis 6379)
- Backend: `yarn dev:core` (server, orchestrator, executors)
- Dev auth: When `AUTH0_DOMAIN` is unset, server enables auth bypass. Use `X-Tenant-ID` header.

## Quick Commands

### 1. Start a run (saved flow)

```bash
curl -X POST "http://localhost:3000/v1/runs" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "flowId": "flow-1771337114680",
    "version": "17",
    "mode": "chat",
    "input": { "prompt": "can you list all memories?" }
  }'
```

### 2. Start a run (inline flow config)

Note on inputs:

- Most bundled test flows in `scripts/test-flows/*.json` use `input.message` (their agent step config is typically `prompt: "${input.message}"`).
- Some examples in this doc use `input.prompt`. `ai.agent_turn` will fall back to `input.prompt` for **turn 0** if the flow config prompt is missing/miswired.

```bash
curl -X POST "http://localhost:3000/v1/runs" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "flowConfig": {
      "name": "repro-agent-loop",
      "startStepId": "start",
      "steps": [
        { "stepId": "start", "type": "platform", "operation": "platform.get_schema" },
        { "stepId": "ai-1", "type": "ai", "operation": "ai.agent_turn" }
      ]
    },
    "mode": "chat",
    "input": { "prompt": "hello" }
  }'
```

### 3. List runs

```bash
curl "http://localhost:3000/v1/runs?limit=10" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001"
```

### 4. Get run details

```bash
curl "http://localhost:3000/v1/runs/<runId>" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001"
```

### 5. Tail events (polling)

```bash
curl "http://localhost:3000/v1/runs/<runId>/events?after=0&limit=200" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001"
```

### 6. Get run debug view (Plan 25)

Single JSON with run, recent events, agent turn snapshots, refs. No large payloads embedded.

```bash
curl "http://localhost:3000/v1/runs/<runId>/debug?eventsLimit=200" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001"
```

### 7. Get run hot state (Redis)

Sanitized Redis state — "what does the engine think right now?"

```bash
curl "http://localhost:3000/v1/runs/<runId>/state" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001"
```

### 8. Fetch a payload ref

```bash
curl "http://localhost:3000/v1/payloads?ref=<payloadRef>" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001"
```

(URL-encode `payloadRef` if it contains special chars.)

### 9. Resume a paused run

```bash
curl -X POST "http://localhost:3000/v1/runs/<runId>/resume" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: a0000000-0000-0000-0000-000000000001" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "stepExecutionId": "<stepExecutionId>",
    "input": { "message": "yes, continue" }
  }'
```

---

## Node Scripts (Plan 25)

These scripts use Node only (no Python) and work with `X-Tenant-ID`:

### run-flow.ts — Start a flow run

```bash
# Saved flow
npx tsx scripts/run-flow.ts --flow-id flow-123 --version 1

# Inline flow from file
npx tsx scripts/run-flow.ts --flow-config scripts/test-flows/agent-simple.json --input '{"message":"hi"}'

# Wait until terminal or PAUSED
npx tsx scripts/run-flow.ts --flow-id flow-123 --wait
```

Fast smoke test (completes quickly):

```bash
npx tsx scripts/run-flow.ts --flow-config scripts/test-flows/platform-get-schema.json --wait
```

### tail-run-events.ts — Poll and pretty-print events

```bash
npx tsx scripts/tail-run-events.ts <runId>
npx tsx scripts/tail-run-events.ts <runId> --hydrate    # Fetch outputRef payloads
npx tsx scripts/tail-run-events.ts <runId> --follow    # Keep polling
```

### export-run-debug-bundle.ts — Export for offline analysis

Creates `.debug/runs/<runId>/bundle.json` and `payloads/*.json` for all refs.

```bash
npx tsx scripts/export-run-debug-bundle.ts <runId>
npx tsx scripts/export-run-debug-bundle.ts <runId> --out .debug/runs
```

---

## Where to Look First (Common Issues)

| Symptom           | Check                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Run stays QUEUED  | Orchestrator running? Redis `aflow:control` being consumed? `yarn orchestrator:dev`         |
| No StepScheduled  | Executor heartbeat (Plan 03/06), engine health                                              |
| Corrupt hot state | `GET /v1/runs/:runId/state` shows `isCorrupt: true`. Admin: quarantine-clear                |
| Agent loops       | Turn snapshots in `/debug` — `agent.<stepId>.turnSnapshots`; hydrate refs to see model view |
| Stuck PAUSED      | `requiredInput.stepExecutionId` — resume with that ID                                       |

---

## Golden Path for Coding Agents

1. **Start**: `POST /v1/runs` with `flowId` or `flowConfig` + `input`
2. **Watch**: Poll `GET /v1/runs/:runId/events?after=<cursor>&limit=200`, keep `nextCursor`
3. **Hydrate**: `GET /v1/payloads?ref=<ref>` for `outputRef`, `errorRef`, `turnSnapshotRef`
4. **Debug**: `GET /v1/runs/:runId/debug` for one-shot view with agent snapshots
5. **Resume**: When `requiredInput` present, `POST /v1/runs/:runId/resume` with `stepExecutionId` + `input`

Response `next` hint: `{ "kind": "watch_events", "eventsUrl": "..." }` or `{ "kind": "provide_input", "requiredInput": {...} }`.
