# Plan 326 — Codex runs on this computer

**Status:** 🔨 P0 measured (§6). P1 built; its exit met under both postures through the real handler and sandbox (§6 M8, M9). P2 built, its live exit not yet run. P4 built. P3 not started.

## 1. Problem

The host lane runs one coding agent well: Claude Code, on the operator's own subscription, inside the sandbox the lane compiles. An operator whose subscription is ChatGPT's has no coding agent at all, and an operator with both cannot compare them or choose per task. Codex CLI is the other reference harness the lane is already held to — the `confined` posture is defined as Codex CLI's `workspace-write` (Plan 315 D19) — and Plan 320 records its absence from the known profiles as an open question.

The profile schema (`apps/aflow-executor-host/src/harnessProfiles.ts`) was written so a harness is data, and most of Codex fits it. Five things do not:

- **The conversation id is minted here.** `HarnessSession.conversationId` is "minted here, so it need not be parsed back out" (`harnessSessions.ts`), passed through `sessionArgs`/`resumeArgs`. Codex takes no id. It reports its own, as the first event of the run, and resumes by it.
- **One event format is read.** `HarnessOutputFormatSchema` is `claude-stream-json | text`. Codex's `--json` stream is a different shape; read as `text`, a step shows raw JSON and its answer is the whole stream.
- **The MCP configuration is a Claude Code file.** `harnessBrowser.ts` writes `{"mcpServers": …}` and `mcpArgs` hands over its path. Codex takes no configuration file argument.
- **The rules file is `CLAUDE.md`.** `harnessHandlers.ts` names it in the brief because a bare Claude Code does not discover it. Codex discovers `AGENTS.md` and never reads `CLAUDE.md`, so in a repository with only `CLAUDE.md` its rules never reach the agent.
- **The credential is a value in an environment variable.** A ChatGPT sign-in is a file, `~/.codex/auth.json`, holding a refresh token Codex rotates. Copying it into a run is not the same as passing a token: a run that refreshes its copy spends the operator's refresh token.

And two behaviours of the lane assume one harness:

- **A run that names no harness is refused on a machine offering two** (`selectHarness`). Review Local Changes never names one, and Commission names one only when asked, so adding Codex alongside Claude Code would refuse every review.
- **A turn budget a harness cannot take is refused** (`buildTurnsArgs`). Codex has no turn flag, so Review's `brief` depth — which always sends `maxTurns` — would be refused on Codex.

## 2. Decisions

**D1 — Codex is a known profile, measured.** `harnessDiscovery.ts` gains `codex`, found on PATH like every other, with arguments measured against Codex CLI 0.163 (§6):

| Field          | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `args`         | `exec --json --dangerously-bypass-approvals-and-sandbox` plus the feature disables of D7 |
| `promptArgs`   | `{prompt}`                                                                               |
| `output`       | `codex-jsonl`                                                                            |
| `resumeArgs`   | `resume {session}` — after `args`, which `exec` accepts before its subcommand            |
| `sessionArgs`  | none — Codex reports the id (D2)                                                         |
| `modelArgs`    | `-m {model}`                                                                             |
| `turnsArgs`    | none (D5)                                                                                |
| `mcpArgs`      | `-c {mcpServers}` with `mcpFormat: codex-toml` (D3)                                      |
| `configDirEnv` | `CODEX_HOME`                                                                             |
| `configSeed`   | `.codex/auth.json` (D4)                                                                  |
| `env`          | `CODEX_CA_CERTIFICATE=/etc/ssl/cert.pem` on macOS (D9)                                   |

`--dangerously-bypass-approvals-and-sandbox` is what `bypassPermissions` is for Claude Code: Codex's own Seatbelt sandbox cannot nest inside the lane's, and the lane's sandbox is the boundary (Plan 315 D19). Codex documents the flag as intended for externally sandboxed environments, which this is. Rejected: `--sandbox workspace-write` — a second Seatbelt profile inside the first, which macOS refuses, and on Linux a second policy that would disagree with the posture the operator chose.

**D2 — A harness may report its conversation id.** The id is minted here when the profile declares `sessionArgs`, and read from the event stream otherwise. The event reader exposes `conversationId()`; the handler records it on the session after the turn. A run that ends before reporting one cannot be continued, and its result says so rather than reporting a `sessionRef` that resumes nothing. A retry with no reported id starts the brief again in the same checkout, as a non-resumable harness already does. Rejected: parse the id from Codex's session files under `CODEX_HOME` — a second source that can disagree with the stream, read from a directory whose layout is Codex's business.

**D3 — The MCP configuration has a format, chosen by the profile.** `HarnessProfileSchema.mcpFormat: 'claude-json' | 'codex-toml'`, default `claude-json`. For `claude-json` the executor writes the file it writes today and fills `{mcpConfig}` with its path. For `codex-toml` it fills `{mcpServers}` with one `-c` value, `mcp_servers.<name>={command="…",args=[…]}`, every string TOML-escaped. One placeholder per format; a profile carrying the other is malformed. Measured (§6 M3): Codex connects to a stdio server declared this way and the model calls its tool. Rejected: write `config.toml` into the run's `CODEX_HOME` — the browser is per turn while the configuration directory is per session, so a stale turn's relay would linger in it.

**D4 — The operator's sign-in is seeded into the run, and a refresh is written back.** `HarnessProfileSchema.configSeed: string[]`, paths under home. Before the harness starts, the executor — outside the sandbox, as the operator — copies each into the run's configuration directory, mode 0600. After the run, for each seeded file whose copy changed, it writes the copy back over the original **only if the original is byte-identical to what was seeded**, by temporary file and rename in the original's directory. If the operator's own Codex refreshed meanwhile, the original is newer and is kept. Home stays denied: the harness reads its sign-in from its own directory, and nothing is carved out of the standing denial.

Two runs seeded from one refresh token must not both refresh it. The access token lives ten days and Codex refreshes after eight (§6 M5), so a copy refreshes only when the original is already old. The executor holds a per-file lock from seeding to write-back for any run whose seed is older than the refresh threshold, and a run seeded from a fresh token holds none. Rejected: a write grant on `~/.codex/auth.json` — Codex is free to save by rename, which a single-file grant refuses, and the grant would put the operator's live credential inside the boundary. Rejected: an API key as the primary path — it bills per token, where the operator already pays for a subscription; it remains available through `credential` (`CODEX_API_KEY`) as for any profile.

**D5 — A budget the harness cannot take is not applied, and the result says so.** `buildTurnsArgs` no longer refuses: a run naming `maxTurns` on a harness without `turnsArgs` runs without it, and the result carries `budget: { maxTurns, applied: false }` with an activity status line naming it. The run is bounded by `timeoutMs`, which every run already has. This reverses the refusal: a refused review is friction an operator cannot answer from the review, while an unapplied budget leaves a bound in place and is visible. `model` keeps its refusal — a comparison run on the wrong model answers a different question, and no other bound stands in for it. The commission and review descriptions that promise refusal change with it.

**D6 — A machine has a default harness, and falls back when it cannot run.** The host policy gains `defaultHarness`, set with `aflow harness default <id>`, written on first adoption of a harness when none is set. `selectHarness`:

1. `harness` named → that profile, or the refusal listing the offered ids. A named harness never silently becomes another.
2. Otherwise the default, when it is configured and its executable resolves.
3. Otherwise the first configured harness whose executable resolves, in policy order.
4. None → the existing refusal.

Steps 2–3 report `harness.selectedBy: 'named' | 'default' | 'fallback'` on the result, and a fallback carries why the default was passed over. Rejected: refuse when ambiguous, as today — it turns installing a second harness into a broken review skill. Rejected: let skills name a harness — the machine knows what is installed, a skill does not.

**D7 — Codex runs bare.** A fresh `CODEX_HOME` already drops the operator's `config.toml`, plugins, hooks and `notify`. Codex still fetches remote plugins, ChatGPT app connectors and its own skills into a fresh home (§6 M4). The profile disables the features that reach beyond the run — apps, plugins, computer use, browser use, memories, hooks — by `--disable`, each named feature measured to exist in `codex features list` at the measured version. This is Claude Code's `--bare`: fewer hosts reached and no execution surface the run did not ask for.

**D8 — Every rules file the checkout holds is named.** `repositoryRulesFiles` looks for `CLAUDE.md` and `AGENTS.md` at each place it looks today. A harness that discovers one of them reads it twice; one that discovers neither reads both. Rejected: a per-profile rules file — a repository's rules are a fact about the folder, and a harness that would have missed them is the failure this sentence exists to prevent.

**D9 — A profile carries the variables its harness needs, under a job's rules.** `HarnessProfileSchema.env`, validated by `assertSafeEnv` at parse and again at spawn: nothing steering the launcher, its proxy, its trust roots or the loader (`PATH`, `*_PROXY`, `SSL_CERT_*`, `NODE_*`, `DYLD_*`, `LD_*`). On macOS Codex verifies TLS through `com.apple.trustd.agent`, which the boundary never grants — `enableWeakerNetworkIsolation` is a forbidden option because the daemon is an egress path of its own — so every request fails just after the proxy accepts its CONNECT (§6 M7). Given `CODEX_CA_CERTIFICATE`, Codex verifies against that bundle and never asks the daemon. Rejected: granting the daemon to Codex runs — it voids the egress contract under `confined`, the posture that most needs it. Known limit: `/etc/ssl/cert.pem` holds the system roots, not roots an operator added to their Keychain; behind an inspecting proxy the operator points the variable at their own bundle with the same field.

**D10 — A harness run reads the machine's tool paths, as a command does.** `toolPaths` reached `host.process.exec` and the folder checks but not `host.harness.run`, so a harness installed under home — Codex bundled with its app, any CLI installed by npm under a version manager — could not start (§6 M6), and the tools its agent runs were withheld the same way. Harness runs now pass `policy.toolPaths`, read-only, and `aflow harness add` names the `aflow harness tools <dir>` to run when the harness it adds is installed under home.

**D11 — A lent sign-in is scrubbed like a credential.** The harness can read its copy, so it can print it or copy it into the checkout. Every string of twenty characters or more in a seeded JSON file (the whole of any other) joins the run's secrets, which are removed from every live delta, the captured output, the patch and every failure message, as a fetched `credential` already is. A token refreshed mid-run is not in that list; the refresh is rare (D4) and the patch, the one artifact that leaves the machine, is still scrubbed of what was lent.

**D12 — A space prefers a coding agent; the machine still decides.** `spaces.preferred_harness` (migration 225), a nullable harness id, read and replaced through the space policy routes (`/spaces/:id/preferred-harness`) like the write, code and compute policies, and refused in a deployment without a host lane. It is not written into the run's input: a harness named there is one the caller requires, and the machine refuses rather than swaps it (D6). The orchestrator reads the column when it dispatches a `host.harness.run` — on both the session path (`scheduleStep`) and the workflow-task path (`dispatchClaimedOperationTask`) — and stamps it on the job as `preferredHarness`, as it stamps `callerModel`; the read tolerates a schema not yet migrated and leaves the machine deciding. The machine's order becomes: named, else the space's preference, else its own default, each only where installed, else the first configured harness installed; `selectedBy: 'preferred'` and `passedOver` say what happened. Rejected: a field in `directives` — directives govern the agents, and a runtime policy belongs beside the other space policies as a column. Rejected: letting the space set the machine's default — the policy file is the half the appliance cannot write.

The machine publishes, every inventory refresh, whether each configured harness's executable resolves (`installed`) and its own default. `GET /spaces/:id/host-bindings` returns, for each running machine holding one of the space's folders, its harnesses with `installed` and its default. This Computer shows them and the preference as one card: a select of every harness those machines offer, each marked installed, installed on some machines, or not installed, with "Each machine's default" as the empty choice. The space's context gives Helmsman the same facts as data — each harness with `installed`, and `preferredHarness` — so it can leave `harness` out, or name one to require it, without prose telling it to. Review Local Changes takes `harness` as an optional run input, as Commission does.

## 3. Codex events as activity

`codex-jsonl` maps onto `HarnessActivityLine` (`harnessEvents.ts`):

| Event                                        | Line                                                          |
| -------------------------------------------- | ------------------------------------------------------------- |
| `thread.started`                             | records the conversation id; status `Harness started`         |
| `item.completed` `agent_message`             | `thought`; the last one is the answer                         |
| `item.started` `command_execution`           | `tool` `shell`, text the command                              |
| `item.completed` `command_execution`         | `tool_result`, ok when `exit_code === 0`, `command: true`     |
| `item.*` `file_change`                       | `tool` with `changes` per path                                |
| `item.started` / `completed` `mcp_tool_call` | `tool` `server.tool` / `tool_result`, ok when `error` is null |
| `item.*` `todo_list`                         | `intent`, the first item not completed                        |
| `item.*` `web_search`                        | `tool` `web_search`, text the query                           |
| `turn.completed`                             | status `Finished · N tokens`                                  |
| `turn.failed`, `error`                       | status naming the error                                       |

An unknown event or item type is ignored, as in the Claude reader.

## 4. What it affects

- `apps/aflow-executor-host`: `harnessProfiles.ts` (schema fields `mcpFormat`, `configSeed`, `env`; turn budget), `configSeed.ts` (lend, write back, serialize, scrub list), `credentialFetch.ts` (several secrets), `harnessDiscovery.ts` (`codex`), `harnessEvents.ts` (reader), `harnessSessions.ts` (reported id), `handlers/harnessHandlers.ts` (selection, seeding, write-back, budget report, rules files), `browser/harnessBrowser.ts` (TOML form), `harness-cli.ts` (`default`), `bindings.ts` (`defaultHarness`).
- `packages/schemas/src/operations/host.ts`: `HostHarnessRunOutput` gains `harness.selectedBy` and `budget`; `harness` and `maxTurns` descriptions.
- `packages/platform-artifacts`: Commission and Review descriptions of `harness` and `maxTurns`; Review gains a `harness` run input.
- `apps/aflow-orchestrator`: `hostHarnessPreference.ts`, read at both dispatch paths and into the space context.
- `packages/schemas`: `StepJobMessage.preferredHarness`; `SpaceContextHostFoldersSection` harnesses gain `installed`, and the section `preferredHarness`. `packages/executor-runtime`: `ExecutorContext.preferredHarness`. `packages/redis`: the host inventory's harnesses gain `installed`, and the inventory `defaultHarness`.
- `packages/server-runtime`: `/spaces/:id/preferred-harness`; `host-bindings` returns `machines`. `packages/web-product`: `HostCodingAgent` on This Computer.
- Stored data: the host policy file gains three optional fields; `spaces.preferred_harness` (migration 225).

## 5. Phases

**P0 — Measure.** Done (§6). Exit: every profile value in D1 has a measurement behind it.

**P1 — Codex runs a commission.** D1, D2, D4, D5, D6, D7, D8, and the reader of §3. Exit: on a machine with both harnesses and Claude Code the default, a commission naming `codex` returns a patch, a `sessionRef` that continues the same Codex thread with a second turn, and an activity feed of commands and file changes; a Review Local Changes with no harness runs on the default; with the default's executable removed, it runs on Codex and says `fallback`; `brief` depth runs on Codex with `budget.applied: false`. The operator's `~/.codex/auth.json` is unchanged by a run seeded from a fresh token.

**P2 — Codex uses the browser.** D3. Exit: a commission on Codex with `browser` calls the lane's browser tools.

**P4 — A space prefers a coding agent.** D12. Exit: on the dev stack with both harnesses configured on the machine and Claude Code its default, choosing Codex on This Computer makes a commission and a review that name no harness run on Codex, reporting `selectedBy: 'preferred'`; with Codex's executable removed they run on Claude Code reporting `default` and why; Helmsman's space context lists both with `installed` and the preference.

**P3 — Write-back proven.** A run seeded from a token past the refresh threshold refreshes, and the original then holds the refreshed token; the operator's own `codex` still works afterwards; two such runs started together serialize.

## 6. Measurements

Codex CLI 0.163.0-alpha.10.2, macOS, ChatGPT sign-in copied into a scratch `CODEX_HOME`, no lane sandbox.

- **M1 — Headless run.** `codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>` exits 0, runs shell commands, writes files in the working directory. Events: `thread.started {thread_id}`, `turn.started`, `item.started`/`item.completed` with `item.type` `agent_message {text}`, `command_execution {command, aggregated_output, exit_code, status}`, `turn.completed {usage}`. With standard input open it prints `Reading additional input from stdin...`; the lane closes standard input for harness runs.
- **M2 — Resume.** `codex exec --json --dangerously-bypass-approvals-and-sandbox resume <thread_id> <prompt>` exits 0, emits JSON, reports the same `thread_id`, and answers from the earlier turn.
- **M3 — MCP.** `-c 'mcp_servers.probe={command="<node>",args=["<server>"]}'` connects a stdio server; the stream shows `mcp_tool_call {server, tool, arguments, result, error, status}` and the model answers with the tool's result.
- **M4 — Writes.** Everything Codex wrote went under `CODEX_HOME` (sessions, sqlite state, caches, `tmp/arg0-macos`, a trust entry in `config.toml`, and fetched remote plugins, app-connector tool lists and system skills) or the working directory. Nothing under the system temp root. The seeded `auth.json` was not rewritten.
- **M5 — Token lifetime.** The access token is issued for ten days; `last_refresh` was two days old and no run refreshed it.

- **M6 — Under home.** The bundled CLI is a shell script exec'ing `CodexCLI.app` beside it under `~/.codex`. Under the lane's sandbox it exits 126, `Operation not permitted`, until its directory is in `toolPaths` and harness runs receive them (D10).
- **M7 — Trust daemon.** Inside the sandbox, with the proxy variables set, Codex connects to the proxy for every request and every request fails about 60 ms later with `error sending request`; no TLS handshake is logged and the proxy records no refusal. `--enable respect_system_proxy` and a plain proxy username change nothing (the proxy checks only the token). `CODEX_CA_CERTIFICATE=/etc/ssl/cert.pem` makes the run complete (D9).
- **M8 — P1 end to end, `open`.** Through `host.harness.run` and the lane's sandbox, on a throwaway repository, with the default set to a Claude Code that is not installed: the run falls back to Codex and says why; Codex reads `AGENTS.md`, follows it, writes a file, and the patch applies clean; the feed shows its commands and results live; a `continueFrom` turn resumes the thread Codex reported and answers from the first turn; `maxTurns` runs with `budget.applied: false`; `~/.codex/auth.json` is byte-identical afterwards.

- **M9 — P1 end to end, `confined`.** The same three runs, with the profile allowed `chatgpt.com` and `api.openai.com`, complete as under `open`. The one host refused is `ab.chatgpt.com`, on every run; each run reaches its result regardless and reports the refusal as a note. It is left refused: under `confined` fewer hosts reached is the point, and nothing the runs produced needed it. Whether `api.openai.com` is needed under a ChatGPT sign-in is not measured, since it was allowed.

Still to measure: the feature names of D7 against the tool list a run reports.

## 7. Follow-ups outside this plan

- A harness run that exits without starting (126, 127) returns `SUCCEEDED` with an empty answer, for every harness. It should fail naming the start failure (`explainFailedStart` already writes the sentence).
- The `confined` launcher shares its standard streams with the workload, and so carries the risk the `open` launcher carried. The adapter's CLI spawns the command with its standard streams inherited (`sandboxedStdio`), so the workload holds the same open file descriptions as the CLI. Once the CLI's Node process touches `process.stdout` or `process.stderr` after the spawn, Node puts the shared description into `O_NONBLOCK`, and Codex panics on the EAGAIN of its next print (exit 101), as it did under `open`. The `open` launcher no longer shares them (Plan 315, `runWorkload` in `openSandboxLauncher.mjs`): the workload's standard output and error are pipes the launcher pumps into its own, and standard input stays inherited. Today the CLI writes nothing to standard output after the spawn, and writes to standard error only once the command has ended or failed. That is why M9 completed, and it is the only reason: nothing in the adapter keeps it so. `confined` needs the same separation, either in the adapter or in a launcher the lane owns around it.
