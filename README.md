# Aflow

**Your AI agents — and your coding agents — as workflows you can see, schedule and
approve, on your own machine.**

Aflow runs agents that call your APIs, run code in sandboxes, keep memory, and
pause for your approval. It can also hand work to the coding agent you already
use — Claude Code or OpenCode, with Codex next — as one step among the rest. Every
model decision and every tool call is a step you can inspect.

This repository is the **local edition**: one owner, on infrastructure you control.
No account, no licence server, and nothing phones home.

> **Status:** active development. Interfaces and schemas change without deprecation
> shims.

---

## Quick start

You need **Docker**. Nothing else.

Download `aflow-appliance-<version>.tgz` from the
[latest release](https://github.com/aflowai/aflow/releases/latest), then:

```bash
mkdir aflow && tar -xzf aflow-appliance-*.tgz -C aflow && cd aflow
docker compose up -d
open http://127.0.0.1:3001
```

That pulls the published image, about 4 GB, and builds nothing. The bundle's own
README carries upgrade, rollback and backup.

To build the image from source instead:

```bash
git clone https://github.com/aflowai/aflow.git && cd aflow
docker compose -f docker-compose.local.yml up -d --build
```

There is no login — reaching the web app on loopback identifies you as the owner.
First run walks you through connecting a model provider; the key is stored
encrypted per workspace, not in a file.

|                    |                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **Supported**      | macOS with Docker Desktop. Linux is expected to work, not yet qualified                        |
| **Disk**           | ~4 GB for the published image; ~20 GB to build it from source                                  |
| **Lifecycle**      | From a clone: `yarn local:up` · `local:down` · `local:logs` · `local:backup` · `local:restore` |
| **Check it works** | `./scripts/appliance-smoke.sh` — needs only Docker                                             |

[`docs/dev/local-appliance.md`](docs/dev/local-appliance.md) is the operator guide:
secrets, backup and restore, upgrades, and sandboxed code execution.

---

## Coding agents, as steps

Connect a folder, and Aflow can give work in it to the coding harness installed on
your machine — signed in as you, with your toolchain around it.

- **Ask in chat.** An Aflow agent hands the task to the harness and reads back the
  result.
- **Or make it a step in a skill.** The harness becomes one node in a workflow,
  alongside your APIs, sandboxed code, memory and approvals — run on demand, on a
  schedule, or when something happens.

What Aflow adds to the harness on its own:

- **A result you can use.** The task declares the shape of what it needs; the
  answer is validated, and a run that ends without one fails and can be retried.
- **Nothing lands without you.** The harness works in a checkout of its own, so
  your uncommitted work is untouched. Changes arrive on a branch, you approve
  before anything is pushed, and a connector opens the pull request.
- **A record of the run.** Every step, with its cost, is there to inspect.

> Every morning: read new GitHub issues → Claude Code drafts a fix on a branch →
> tests run in the sandbox → you approve → the pull request opens.

Setting up a harness is in the operator guide under
[Putting a coding agent to work](docs/dev/local-appliance.md#putting-a-coding-agent-to-work).

---

## What it does

- **Agents that delegate.** Agents choose their tools, hand work to sub-agents,
  and pick up where they left off — on OpenAI, Anthropic, Google or OpenRouter,
  with the cost of every step.
- **Skills that stay valid.** A skill is a procedure an agent has learned, with
  declared inputs and evals. It is checked again every time it runs, so a rule
  tightened today flags every skill it breaks.
- **Your tools, behind one surface.** Around two dozen connectors ship ready;
  anything else comes in by OpenAPI import. Credentials stay in per-workspace
  bindings, never inside a workflow.
- **Memory that is also a filesystem.** Documents with folders, search and
  backlinks — the same store an agent's code reads and writes.
- **Sandboxed code.** Python, Node, Deno or Bash in network-isolated containers.
- **You stay in the loop.** Steps ask for input or approval as cards in the app. A
  risky API write waits until you approve the exact request that will be sent.
- **Interfaces agents build.** Generated views and stateful applets, validated
  before they render.
- **Scheduled and triggered.** Cron schedules, webhooks, and runs that start when
  another finishes.

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
