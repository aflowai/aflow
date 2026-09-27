# Aflow

**An agentic execution platform you run yourself.** Aflow runs agents that do real
work — they call your APIs, execute code in sandboxes, drive a coding harness on
your own machine, keep durable memory, and pause for your approval. Every model
decision and every tool call is a first-class execution step you can inspect, so a
run is never a black box.

This repository is the **local edition**: one owner, one tenant, on infrastructure
you control. No account, no licence server, and nothing phones home.

> **Status:** active development. Interfaces and schemas change without deprecation
> shims.

---

## Quick start

You need **Docker**. Nothing else.

```bash
git clone https://github.com/aflowai/aflow.git && cd aflow
docker compose -f docker-compose.local.yml up -d --build
open http://127.0.0.1:3001
```

There is no login — reaching the web app on loopback identifies you as the owner.
First run walks you through connecting a model provider; the key is stored
encrypted per workspace, not in a file.

|                    |                                                                                  |
| ------------------ | -------------------------------------------------------------------------------- |
| **Supported**      | macOS with Docker Desktop. Linux is expected to work, not yet qualified          |
| **Disk**           | ~20 GB for the first build                                                       |
| **Lifecycle**      | `yarn local:up` · `local:down` · `local:logs` · `local:backup` · `local:restore` |
| **Check it works** | `./scripts/appliance-smoke.sh` — needs only Docker                               |

[`docs/dev/local-appliance.md`](docs/dev/local-appliance.md) is the operator guide:
secrets, backup and restore, upgrades, and sandboxed code execution.

---

## What it does

- **Agents that delegate.** An agent turn is a decision step — the model picks a
  tool, the orchestrator schedules it as a real step, and the result loops back.
  Agents hand off to sub-agents and resume child sessions. One client covers
  OpenAI, Anthropic, Google and OpenRouter with native tool calling, prompt
  caching, reasoning continuity across tool calls, and per-step cost accounting.
- **Work on your own machine.** Connect a folder and the agent can commission a
  coding harness — Claude Code or OpenCode — to work in it, either on demand or as
  a step inside a skill. The task declares the shape of the result it needs, so
  what comes back is validated rather than scraped from a transcript, and a run
  that ends without one is a failure the agent can retry. Patches land on a branch
  for you to approve; your git pushes, and a connector opens the pull request.
- **Skills that stay valid.** A skill is a procedure an agent has learned — a task
  graph with declared inputs, typed channels between tasks, and evals. Validity is
  recomputed whenever a skill is read or run, so tightening a rule retroactively
  surfaces every skill that breaks it instead of letting it execute.
- **Integrations behind one surface.** Discover, promote, bind, call. Around two
  dozen connectors ship curated; anything else arrives by OpenAPI import.
  Credentials live in space-scoped bindings — never inline in a workflow — with
  OAuth 2.1 + PKCE and per-binding egress allowlists.
- **Memory that is also a filesystem.** A document store with directories, hybrid
  keyword-and-vector retrieval, `[[wikilinks]]` that derive a backlink index, and
  queryable frontmatter. The same store mounts as the sandbox filesystem, so what
  an agent writes from code it reads back as memory.
- **Sandboxed compute.** Python, Node, Deno or Bash in ephemeral,
  network-isolated containers, with warm sessions and an ML image.
- **You stay in the loop.** Steps pause for input, approval, or a direct question
  and surface as typed cards with schema-driven forms. Every pause carries a resume
  contract, so it always reaches whoever is waiting. Write risk is curated per API
  endpoint, and a gated call parks _after_ its body is resolved — you approve the
  exact bytes that will be sent.
- **Generative UI and applets.** Agents produce design-system-bound React
  components, validated and CSP-compiled before render. Stateful applets are
  durable work objects with declared actions, where every write passes through one
  gateway that bounds the patch.
- **Scheduled and triggered.** Cron and interval schedules, inbound webhooks,
  completion triggers, cancellation, and per-run cost summaries.

Roughly 180 operations across 20+ step types. Browse them under **Catalog** in the
app, or run `yarn catalog:export`.

---

## How it works

A Fastify API writes to Redis streams; an orchestrator is the single writer of
durable run state; stateless executors claim jobs per step type and write results
back. Redis holds live state, Postgres is the durable record, and large payloads go
to a payload store by reference rather than through agent context.

Zod schemas in `@aflow/schemas` are the single source of truth — types, JSON
Schema and OpenAPI are derived from them, so an operation cannot drift from its
contract. [`docs/architecture/`](docs/architecture/) has the diagrams.

## What crosses the network

**Leaves the machine** — only calls you configure: model providers, and the
integrations and MCP servers you connect. No telemetry, crash reporting,
analytics or update checks.

**Comes in** — when an interactive artifact uses them, your browser loads
open-source libraries (React, charting, maps and similar) from public
CDNs (jsDelivr, esm.sh); catalog provider logos load from an image host. Those
hosts see a request for a library or image, never your data. Such artifacts need
a network connection to render.

---

## Development

```bash
yarn install
yarn start
```

`yarn start` does the rest: creates `.env`, brings up Postgres and Redis, builds
once, applies migrations, provisions the instance, and starts the stack in watch
mode on the same ports as the appliance. It checks what it needs first and names
anything it cannot fix.

Afterwards `yarn start` is still the command — the build and the datastores are
skipped when they are already there.

**Which one to run.** The appliance above is what ships: the built image, no
toolchain, closest to what another person will run. The development stack is the
same edition from source with watch mode, so an edit is live immediately. They
keep **separate data** — the appliance has its own Postgres inside its Compose
project, the development stack uses `aflow-postgres` on 5433 — so work in one is
not visible in the other.

Before opening a pull request:
`yarn format && yarn typecheck && yarn test:changed && yarn lint`.

[`docs/dev/CONTRIBUTING.md`](docs/dev/CONTRIBUTING.md) covers standards and the
gotchas that catch most first contributions.

## Documentation

| Document                                                                                 | What it covers                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`docs/dev/local-appliance.md`](docs/dev/local-appliance.md)                             | Running, backing up and upgrading Aflow Local       |
| [`docs/dev/CONTRIBUTING.md`](docs/dev/CONTRIBUTING.md)                                   | Code standards, workflow, common mistakes           |
| [`docs/dev/integrations-and-capabilities.md`](docs/dev/integrations-and-capabilities.md) | Discovering, binding and calling integrations       |
| [`docs/dev/debugging-runs.md`](docs/dev/debugging-runs.md)                               | Tracing a run through Redis, streams and the DB     |
| [`docs/architecture/`](docs/architecture/)                                               | Flow execution, system diagrams, background work    |
| [`docs/plans/README.md`](docs/plans/README.md)                                           | How to propose a change large enough to need a plan |
| [`CLAUDE.md`](CLAUDE.md)                                                                 | Working context for AI coding agents                |

---

## Licence

**AGPL-3.0-or-later** — full text in [LICENSE](LICENSE), copyright and
attributions in [NOTICE](NOTICE). Running Aflow, privately or inside your
organisation, asks nothing of you. Modifying it and letting other people use it
over a network means offering those users your source.

A **commercial licence** is available for organisations that cannot accept those
terms — support@aflow.ai. The name and logo are trademarks the software licence
does not cover; [TRADEMARK.md](TRADEMARK.md) permits most ordinary uses.

[Contributing](CONTRIBUTING.md) · [Conduct](CODE_OF_CONDUCT.md) ·
[Security](SECURITY.md)
