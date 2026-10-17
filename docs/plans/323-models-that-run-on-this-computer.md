# Plan 323 — Models that run on this computer

**Status:** 🔨 P0 met on one machine (§9). P1 merged, and its main exit met on the dev stack: Helmsman on Gemma 4 26B held a tool-using conversation through the web UI on the 24 GB machine, slowly, because the model spilled past the GPU working set (§9 G6). P3a built and tested: each model's window is sized from the machine it runs on, never below what the platform's agents need, and readiness says how it fits. P0, P1 and P3a together are the first complete slice.

**Supersedes for the local edition:** Tier 0 of archive plan 98 (open-weight inference). Plan 98 put a platform-managed `selfhosted` provider behind Ollama's OpenAI-compatible `/v1` endpoint. This plan uses Ollama's native API instead (D3) and makes the runtime the operator's own (D2). Plan 98's hosted tiers (Cloud Run GPU, GKE/vLLM) are untouched; the OpenAI-compatible adapter in P6 is the piece they would share.

## 1. Problem

An operator of the local edition cannot point an agent at a model running on their own machine. Every model call leaves the computer, and one without a cloud key cannot run Aflow at all. The pieces that exist are stubs:

- **`local` is a provider in name only.** It is in `AIProviderSchema` (`packages/ai-client/src/types.ts`), the usage enum and the UI labels (`modelGroups.ts`). `createAIClient` throws `Provider local is not yet supported` for it (`packages/ai-client/src/client.ts`), and the executor maps no credential to it.
- **Readiness reports it as ready.** `spaceLlmReadiness.ts` maps a `local` provider to `providerId = null` and skips it. A role assigned to a local model would show green and then fail on its first turn.
- **A credential must carry an `api_key`.** `getAIClientForContext` (`apps/aflow-executor-ai/src/handlers/ai/aiClient.ts`) refuses a credential without one and forwards nothing else, `baseUrl` included. `ProviderConfig.baseUrl` exists and six adapters honour it; nothing sets it.
- **Native tool calling is a hard-coded list of five providers** (`agentTurn.ts`: google, anthropic, openai, fireworks, xai). Any other model takes the `generateJson` fallback. That path is non-streaming, sends the whole decision schema, and allows one repair round. It is the path a weaker model is least likely to survive.
- **The catalog is static code**, and assigning a model to a role requires a live catalog chat entry (`agentModelPolicy.ts`). Nothing installed on a machine can appear in it.
- **Timeouts assume a datacenter.** A non-agent AI op has a flat 120 s. An agent turn dies after 300 s with no streamed byte (`AI_STREAM_IDLE_TIMEOUT_MS`). The AI executor runs 20 concurrent jobs with no per-provider limit. A 27B dense model on a laptop prefills a 60K-token prompt in minutes, emits nothing while it does, and serves one request at a time.
- **Embeddings are fixed at 1536/3072 dimensions** (`EMBEDDING_COLUMNS`, migrations 006 and 148), and memory embedding reads platform environment keys rather than the space's credentials (`aflow-executor-memory/src/embedder.ts`). Local embedding models emit 768, 1024 or 4096.
- **The appliance cannot reach the host.** `docker-compose.local.yml` declares no `extra_hosts`. On macOS, Docker cannot use the Apple GPU, so a model server has to run natively on the host, outside every container.

## 2. What is the same and what is not

Using one should look like using any other model. You choose it in the same picker, assign it to the same roles, and it runs the same operations, records the same usage, and passes the same readiness check. Three things differ, and pretending otherwise is what would make it fail:

1. **Capacity belongs to the machine, not the model.** The context window that fits, how many requests run at once, and whether the model loads at all depend on memory and GPU, and they change when the operator closes a browser. A cloud model's catalog entry describes the model. A local one also needs the machine's answer.
2. **Capability varies by model, runtime, quantisation and template, and it has to be measured.** "Supports tools" on a model card says little about whether a Q4 build under a given chat template survives a 40-turn agent loop. The catalog rule that capabilities are measured, not researched, binds harder here than anywhere.
3. **The model's lifecycle is the operator's.** It has to be downloaded (gigabytes), loaded (seconds to a minute), and kept warm. None of that happens with a cloud key.

## 3. Decisions

**D1 — Ollama is the runtime the local edition supports first. An OpenAI-compatible server is the second, for scale (P6).** Ollama installs in one step on macOS, Linux and Windows. It runs MLX on Apple Silicon, manages and pulls models over HTTP, supports native tool calling with streamed tool calls, schema-constrained output (`format`) and a `think` control, and has a library that tags the models this plan targets. _Rejected:_ llama-server as the first runtime. It needs the operator to pick GGUF files and chat templates by hand, and it has no pull or list. _Rejected:_ LM Studio first. It is a good desktop app, but its headless daemon and API are less settled. Both work through the P6 adapter.

**D2 — Aflow does not ship or supervise the runtime.** The operator installs Ollama, and its own app or service keeps it running. Aflow detects it, says how to install it when it is absent, and drives it over its API: list, pull, delete, load, unload. On a paired Mac, the UI may also offer a one-time install through the host lane (`brew install ollama`) after the operator approves it. This is a command run once, not supervision. _Rejected:_ bundling the runtime in the image. On macOS it would run without the GPU. _Rejected:_ the host executor supervising a model server. That is a second process supervisor beside launchd, systemd and the runtime's own, for something the runtime already does. The exception is the Linux appliance (D11).

**D3 — The Ollama adapter speaks the native `/api/chat` and `/api/embed`, not `/v1`.** Through `/v1` you cannot set the context length, cannot pass `tool_choice`, and get no `think` control. The context length is the decisive one (D5). The adapter implements `generateText`, `generateTextStream`, `generateJson` (`format` = the JSON schema) and `generateEmbedding`. It maps the catalog's reasoning ladder onto `think`, whose accepted values the runtime publishes per model in `/api/show` (`thinking.values`: `[false, true]` for Gemma 4 and Qwen3.5, `low | medium | high` for gpt-oss). It reads `thinking` from responses for the run view. It does not replay it: the runtime's chat templates drop `thinking` from history, so a replayed reasoning trace costs no tokens and reaches no model (§9 G1). It collects a streamed turn's `content` and `tool_calls` and sends them back together with the tool results, which is how the runtime expects a turn to be returned. **Structured output follows the runner.** The MLX runner refuses `format` outright, a JSON schema and `"json"` alike, with a 501 `structured output is unavailable`, while the llama.cpp runner honours both (§9 G1). So `generateJson` sends `format` first and, once a model's runner has refused it, carries the schema as a tool whose arguments are the response, as the Anthropic adapter does. The refusal is remembered per model by the adapter, learned from the runtime's own answer rather than written into the catalog, so a runner that gains structured output is used as soon as it does.

**D4 — A local runtime is a connection in the credential registry. Its provider id is `ollama`, and `local` is removed.** The credential is a URL, `base_url`, which defaults to `http://127.0.0.1:11434`. It has an optional token for a runtime behind a proxy and no required secret. Which secret a provider requires becomes registry data, not `api_key` hard-coded in the executor. Reusing the registry gives the connection the user → space → tenant resolution, the settings screens, the validation probe (`GET /api/version` plus `/api/tags`) and readiness, all unchanged. `base_url` origins are restricted with the existing `allowedOrigins` mechanism to loopback and `host.docker.internal`. A runtime on another machine is admitted only through `CREDENTIAL_EXTRA_BASE_URL_ORIGINS` (P6). _Rejected:_ an environment variable naming the runtime. It would bypass readiness and the UI, and it is exactly the "configured somewhere else" state that shows green and fails at run time.

**D5 — The context window a request gets is the machine's answer, sent on every request, and a prompt that might not fit is never sent.** Ollama's default context is sized by available memory and can be as small as 4K. What an over-long prompt does depends on the runner (§9 G1): the llama.cpp runner silently cuts it from the front to about half the window, dropping the system message, and the MLX runner does not enforce `num_ctx` at all and grows its cache with the prompt. The first loses the agent's instructions; the second spends memory the fit estimate did not count.

- **The window:** the connection carries `context_tokens`: chosen by the operator, offered from the fit estimate (D8), and never above the model's catalog `contextWindow`. The adapter sends it as `options.num_ctx` on every request. Prompt budgeting reads the effective window, `min(catalog, connection)`, rather than the catalog's.
- **The characters-over-four estimate cannot size a local prompt.** Measured against the runtime's own counts (§9 G1), English and German run at about 4.8 characters a token, code at 3.5–4.0, JSON at 2.8 and Chinese at 1.6. A tool result in JSON is undercounted by 40% and Chinese text by 2.5×. Eight tool schemas cost 570–890 tokens.
- **`prompt_eval_count` is exact.** On both runners it is the whole prompt's token count, cached prefix included: prefix caching shows in the time taken, never in the count. When the llama.cpp runner truncates, it reports the truncated count.
- **The sizing method** (P0's gate, met by the measurements in §9 G1; `packages/ai-client/src/providers/ollamaPromptSize.ts`):
  1. **Conservative size.** The prompt, tool schemas and tool calls are sized at the lowest measured ratio, 1.5 characters a token, so no script or format is undercounted. A prompt that fits at that size with its answer is sent as is.
  2. **Exact count when the estimate is not enough.** Any other prompt, and every prompt carrying an image, is counted exactly by a one-token evaluation before it is sent. The real request reuses the evaluated prefix from the runtime's cache, so the count costs a round trip and no second prefill: in §9 G1 a 6,422-token prompt counted this way was read back in 0.07 s. Images are always counted, because characters cannot size one: a 1280×800 image is 524 tokens on Gemma 4 and 1,002 on Qwen3.5, and a model that sizes images by resolution costs more for a larger one.
  3. **The answer gets what the window leaves.** A counted prompt is sent with `num_predict` set to the smaller of the requested `maxTokens` and what the window has left, so prompt and answer together never pass it.
  4. **Refusal.** A prompt that leaves less than `MIN_ANSWER_TOKENS` (4,096, the same reserve prompt budgeting holds back) fails before it is sent, as `context_length` with provider code `context_exceeded`, naming the size, the window and the remedy (D15). A count the runtime cut while counting is reported as _at least_ the prompt's lower bound.
  5. **Backstop.** A response whose `prompt_eval_count` is below the prompt's lower bound was truncated by the runtime. It fails with a message that says so, and its answer is discarded. The lower bound divides by the highest measured ratio, 5, and counts a run of one character (indentation, padding, a rule of dashes) once, since such a run can be one token however long it is.

  _Not built:_ a baseline carried from the previous response. With prefix caching the exact count is close to free, and a carried baseline would be a second source of truth for a number the runtime gives directly.

- **Streamed text is provisional:** what an agent turn streams is not the turn's result until the final chunk arrives and the response validates. A turn the backstop rejects fails, so nothing it streamed is committed as an answer. How the run view marks the text it already showed is P3's.

**D6 — Native tool calling is chosen by measured capability, not by a provider list.** `nativeFCProviders` is deleted. An agent turn uses native function calling when the catalog entry says `functionCalling: true`, and that flag is written for local entries by the conformance probe (D9). The same probe writes `structuredOutputs`, `forcedToolChoice` and the reasoning ladder. This also moves the three OpenRouter models, all declaring `functionCalling: true`, onto native tool calls; their route already accepts tool definitions in the streaming path, which `models:verify-reasoning` exercises. The `generateJson` fallback is reached only by a model without measured tool calling, and making it stream is P2's, with the first such model.

**D7 — A runtime has a concurrency limit, and waiting for it is not idleness.**

- **The limit belongs to the runtime, not to a credential or a process.** Two credentials can name the same Ollama, and model calls come from the AI executor, the API server (session titles, eval batches, post-run hooks) and the memory embedder.
  - **Runtime identity:** each local connection resolves to a `runtimeId`, the normalized base URL with every name for this machine's loopback (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`) folded into one.
  - **Admission:** a Redis-leased semaphore in `@aflow/redis` keyed by `runtimeId`, sized by `max_parallel` (default 1, the runtime's own default). Every caller goes through it.
  - **Leases:** each lease has an expiry that its holder heartbeats. A worker that dies frees its lease when the lease expires, with no sweep. A cancelled step leaves the queue and releases what it holds.
- **A step waits before it starts, by the rules of an operation slot.** The executor runtime gains an optional `StepHandler.admit`: the handler names what the step must hold from its own input, after the context is built and before the step is marked started. While it waits the step stays SCHEDULED, gives back its executor slot, and keeps its in-flight record alive; a cancel ends the wait; an executor that stops claiming gives the step back to its stream; and a step that waited is checked again for supersession and cancellation once admitted. Its timeout starts only after admission, so queued local work is never charged to the work and never holds up cloud work. The AI handler's `admit` takes the runtime lease when the step's model is served by Ollama, and asks nothing otherwise. _Rejected:_ `admitOperation` as it stands. Its limiter is keyed by operation id and is in-process, while the runtime a step needs is known only from its model and credential, and its capacity is shared across processes.
- **Callers outside a step** take the same lease through the client: `createByokAiClientFactory(db, admission)` wraps a client for an Ollama model so every request holds a lease while it runs. Session titles pass `wait: false` and decline when the runtime is busy, since the conversation is due again on the next cycle; post-run judging waits. The eval-batch engine, the UI and API executors' generation and the memory embedder are not yet admitted, and are P5's coverage list.
- **The idle clock:** every AI operation on a local model runs under an idle window of `AI_LOCAL_MODEL_IDLE_TIMEOUT_MS` (15 min) and the agent turn's ceiling, in place of the flat 120 s or the 300 s stream idle window. Prefill is a silent stretch on every local request, and at 250 tokens a second a 75K-token prompt outlasts the cloud window (§9 G5). _Rejected:_ a per-connection first-token timeout. The timeout is chosen before any credential is read, so a connection field would be a setting nothing reads.

**D8 — The window is sized from the machine, and fit is an estimate until the model is loaded.**

- **What a model costs** (§9 G6): its weights, plus a constant cost per context token for the KV cache — 16.18 GB and about 118 KB a token for Gemma 4 26B at the `q8_0` cache type. On the MLX runner the cache grows with the prompts the model has actually read, keeps more than one conversation's, and is freed only when the model unloads, so a loaded model's cost climbs to its whole window and stays there. Fit is therefore computed for the full window × `max_parallel`, never for the prompt in hand.
- **What the machine allows:** on Apple silicon, Metal's working set (`recommendedMaxWorkingSetSize`, 19.07 GB of 24 on the measured machine), less the runtime's own reserve. Past it the model does not fail: it spills, and prefill fell from about 240 to 130 tokens a second as swap grew. On a machine with discrete GPUs it is VRAM per device. The host executor reads the figure once through Metal, caches it, and publishes it in its inventory as `machine: { totalMemoryBytes, gpuWorkingSetBytes }`; no `sysctl` reports it and Ollama's API does not expose it.
- **The default window is the largest that fits, and never less than the agents need.** A connection that sets no `context_tokens` gets, per model, the largest window in 4,096-token steps whose footprint stays inside the GPU working set, capped by the model's catalog window, and never below 32K: Helmsman's first prompt is about 18K tokens of instructions and tool definitions before any conversation, so a smaller window refuses it outright, and slow is better than refused. A 64 GB machine gets Gemma 4 26B's full 256K; the 24 GB Mac fits only 16K, so it gets 32K and is told the model will spill. Without a footprint or a machine figure the window is 32K. An operator who sets `context_tokens` gets exactly that, fitting or not: fit informs, it never overrides a configured choice. A smaller Helmsman prompt for local models — fewer tools on the surface — is what would let a 24 GB machine run at full speed, and is outside this plan's phases until measured.
- **The answers:** _fits_, _tight_ (inside the GPU working set, but the model plus the memory the operating system, the stack and a browser take — about 8 GB measured — exceeds the machine's memory, so it will swap), _does not fit_ (even the smallest useful window spills), or _unknown_ (no footprint, no machine figure, or a build the footprint was not measured on).
- **Verified state:** once loaded, `/api/ps` reports the model's actual size as its cache grows; that replaces the estimate. A loaded size above the GPU working set is a diagnostic (D15) with two remedies: a smaller window, or unloading the model to free the conversations it is holding.
- **A trial load is an action:** reading diagnostics never loads a model.

**D9 — Local models are curated catalog entries, measured by a local conformance probe.**

- **The entries:** each is an ordinary `ModelDefinition` with `provider: 'ollama'`, a stable id, `providerModelId` set to the runtime tag, zero pricing and an alias per tier. The id and alias rules hold as for any model: an id is never reclaimed, and a model leaving the lineup goes to `retiredModels`.
- **The probe:** `yarn models:verify-local <tag>` runs against the operator's runtime in two tiers.
  - **Compatibility** sets the capability flags:
    - single and parallel tool calls against real operation schemas;
    - schema-constrained JSON against the agent decision schema;
    - streamed tool-call assembly;
    - the reasoning ladder, as `models:verify-reasoning` does;
    - memory at two context sizes.
  - **Usefulness** sets the role recommendations, repeated so variance shows:
    - representative tasks per role, each judged on whether the task succeeded;
    - recovery after a tool error;
    - a conversation long enough to be compacted;
    - total latency, model load and switch included.

    Looping is measured by the platform's own guards (the repeated-decision detector and the failure counters), not by a blanket rule that no call may repeat, because re-reading a file after changing it is legitimate.
- **What the probe is tied to:** a result holds for the build it measured. Each result records:
  - the model digest and quantisation (from `/api/tags` and `/api/show`);
  - the runtime version;
  - a fingerprint of the chat template and parameters;
  - the probe version.

  The curated entry carries that identity. When the runtime serves a different digest, template or runtime minor version, or the probe version moves on, diagnostics (D15) report the model as _unverified for this build_ with a remedy to re-run the probe. A stable Aflow model id never silently inherits a different build's flags. Unverified does not block assignment. It withdraws the recommendation and keeps the conservative path: no native tools until measured.

- **What it writes:** the capability flags, footprint and build identity that go into `catalogModels.ts`. It exits non-zero on drift.

Which local models are _recommended_ for which role follows from the usefulness tier. Whether a tenant _may_ assign one stays the tenant's choice (`agent_model_allowlist`). _Rejected:_ registering whatever is installed as a catalog entry at run time. `registerModel` mutates a process-wide singleton shared by every tenant, and an entry nobody measured would carry flags nobody checked. Discovered models are P6, as a tenant-scoped overlay with its own measurement.

**D10 — Setup and lifecycle are complete in the UI. Helmsman reads the runtime's state and asks before changing it.**

- **The UI needs no model.** Every setup and lifecycle action can be done from the UI with no working model behind it: connect, pull with progress, delete, warm, unload, and set context and parallelism. These are REST routes the server proxies to the space's connection. This is the floor, not a convenience. When the only model is local and it is not working yet, Helmsman cannot help, because Helmsman runs on that model.
- **Helmsman reads.** It holds one read operation, the runtime's status, which returns the diagnostics record (D15). It explains a problem in conversation from that record, not from knowledge of Ollama.
- **Helmsman acts only through approval.** The acting operations are pull, delete, switch the model a role uses, and change the context or `keep_alive`. Each one parks on the write-approval pause and its Action Center card, as a browser action does (plan 320 D7): a `local_model` target is added to the approval payload union, and the grant is minted only at the authenticated resolve boundary. None of them is ever pre-authorized. What each card shows:
  - for a pull: the download size and the model's fit;
  - for an unload or a switch: the live runs that use the model, the asking session's own run included, since an agent evicting the model it runs on ends its own turn;
  - for a context change: the memory it costs.

  A denial fails the step with a non-retryable `permission` error carrying the operator's reason.

- **No specialized agent.** The work is reading one record and proposing one of its remedies, and Helmsman with these operations does both. A separate system agent would be a second surface whose guidance could drift from the UI's.
- **Runner holds none of these operations.** They are Helmsman's alone, like the eval plane. A skill's run does not reconfigure the machine it runs on.
- **One GPU, several roles.** Helmsman, clerk, judge, titles and embeddings all compete for one runtime, and each model switch costs a load. The default for a local space is therefore a preset that assigns one chat model to every role (plus the embedding model). Mixing models per role is the operator's choice, and the models page shows its cost: total resident memory, and the load time per switch. On the measured machine a switch from a 9B to a 26B model took 49 s, and the MLX runner's first prompt after a load took 25–56 s whatever its length (§9 G5), so a switch in the middle of a run is a pause the operator can see. `keep_alive` comes from the connection, default 30 min.
- **Warming is the operator's, not a side effect.** Beside each role on a model on this computer, the operator sees whether it is loaded and how large, and has **Load now** (at the window its requests will use, so the first request does not reload it) and **Unload**. _Rejected:_ loading on assignment. Picking a model is not a request to take 16 GB of the machine at that moment, and on a small machine an unasked load is the starvation it would be meant to prevent.
- **Lifecycle actions are durable.**
  - **Pull:** one pull per runtime and tag, observed and not duplicated. A second request joins the first; the runtime already joins two pulls of one tag, reporting the same progress to both (§9 G3).
  - **Disk space:** a pull is refused before it starts when the host inventory's free disk cannot hold the download.
  - **Cancel and resume:** a pull is cancelled by closing its request, which installs nothing. The next pull of the tag resumes from what was already downloaded (§9 G3), and the UI says so.
  - **Stale approvals:** an approved action re-checks its impact when it executes. When the set of runs it would end, or the space it needs, has changed since the card was shown, it parks again with the new impact rather than acting on the old one.
- **Edition gating:** the provider, the routes, the operations and the "On this computer" surface exist only in the local edition. The UI gates on `useEdition().id === 'community-local'`, the server on the edition descriptor. A hosted tenant pointing a URL at loopback would be reaching the platform's own machine.

**D11 — Packaging follows the GPU.**

- **Dev stack:** executors run on the host and reach `127.0.0.1`.
- **macOS appliance:** the worker and API reach the host's Ollama at `host.docker.internal`, which compose maps explicitly (`extra_hosts: host.docker.internal:host-gateway`) so the same file holds on Linux.
- **Linux appliance:** the bridge cannot reach a host server bound to loopback, and binding Ollama to `0.0.0.0` publishes an unauthenticated model server to the network. So a compose profile `local-models` runs `ollama/ollama` with the NVIDIA runtime on the `backend` network. It publishes no port and keeps a named volume for weights. Its connection URL is `http://ollama:11434`, admitted by the registry only in that profile.
- **`yarn start`:** prints the runtime's state beside each service's credential state (absent / running vX / models installed), and changes nothing.

**D12 — A space can keep model inference on this machine, and the promise is exactly that.**

- **The promise:** the policy is `spaces.model_locality` (`any` | `local_only`), and its UI wording is _"model inference stays on this machine"_. It does not cover tools that reach the network by design (web search, API calls, MCP servers, the browser). Those are governed by their own policies, and the setting says so beside the toggle.
- **Coverage:** every model call the platform makes on a space's behalf follows that space's choice. That includes session titles, the clerk, the judge, eval batches and memory embedding. P0 lists every call site that resolves a model outside role resolution.
- **What counts as local:** a call is local only when both of these hold:
  - **The endpoint is this machine:** the connection's `runtimeId` (D7) is this machine's loopback or the appliance's `ollama` service. A runtime on the network (D14) is not local, even on the operator's own LAN.
  - **The model runs on the runtime:** Ollama can forward a request to its own cloud models. A model `/api/tags` lists with a `remote_host` is not local. `/api/show` carries no such marker (§9 G2), so the test reads the listing.
- **The runtime's cloud setting:** diagnostics report whether cloud features are disabled (`OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud` in `~/.ollama/server.json`), read from `GET /api/status` (`{ cloud: { disabled, source } }`, §9 G2). The remedy is the setting itself. The Linux appliance's `ollama` service sets it.
- **Discovered models (P6)** are classified by the same two tests.
- **Refusal:** under `local_only`, a non-local model is refused at resolution with a `permission` error naming the role and the model. It is not silently swapped.
- **Embeddings:** under `local_only` they need a local embedding model (D16).

**D16 — An embedding carries the identity of the model that made it, and search never mixes identities.**

- **The identity:** every stored vector carries an embedding identity: model id, build digest and dimensions. Two models that both emit 1536 dimensions produce vectors in unrelated spaces, so the dimension column is not the identity. Rows already record `embedding_model`, but `searchVector` (`memoryDocs.ts`) chooses only a column and filters on the column being non-null, never on the model.
- **Search:** a query is embedded with the identity active for its scope and matches only vectors of that identity.
- **Changing the model** creates a new identity and a rebuild. The rebuild is a registered, candidate-driven background task. Search keeps using the old identity until the rebuild has covered the scope, then switches, and the old vectors are dropped. A search never runs against a partially rebuilt index.
- **Jobs in flight:** a queued embedding job carries its identity and is discarded if the identity changed while it waited.
- **No silent truncation:** the adapter always sends `truncate: false` to `/api/embed` (the runtime defaults to `true`). An input over the window fails, and the chunker splits by the model's window.
- **Dimensions:** the first local embedding model is one whose native size is at least 1,536, served at 1,536 through `dimensions`, so P5 needs no new vector column. Qwen3-Embedding 4B (2,560 native) does this; EmbeddingGemma (768 native) refuses it (§9 G4). A model below 1,536 needs its own column and is left until one is wanted. Either way, the identity rule above holds.

**D13 — Usage is recorded as for any model, and cost shows "local", not "$0.000".**

- Tokens, latency, time to first token and tokens per second are recorded per call.
- The tokens-per-second figure is what tells an operator their model is partly on CPU.
- The usage provider is the runtime, so a mixed space can see how much ran where.

**D14 — Scale is more runtimes, not a bigger one (P6).**

- **The adapter:** an `openai-compatible` adapter on chat completions, built from the Fireworks adapter (the OpenAI adapter's Responses API is not what local servers serve). It reaches vLLM, SGLang, llama-server and LM Studio, and through vLLM a GPU box serving many requests at once.
- **Pools:** several connections to the same catalog model form a pool, chosen by least in-flight against each one's `max_parallel`.
- **A runtime on the network:** it needs an operator-admitted origin (`CREDENTIAL_EXTRA_BASE_URL_ORIGINS`) and a token, because an Ollama port has no authentication of its own. Its connection states that machine's GPU memory (`gpu_memory_gb`), so each model's window is sized for the machine it runs on; this machine's inventory is never applied to a runtime elsewhere, and without the figure its windows are the 32K default. Admission is keyed by its host, so a runtime on the network is one capacity however many connections name it.

**D15 — One diagnostics record says what is wrong and what fixes it, and every surface reads it.**

- **The record:** `LocalRuntimeDiagnostics`, a Zod schema in `@aflow/schemas`. It is computed per connection by one function, `diagnoseLocalRuntime`, in `@aflow/ai-client`, from:
  - the runtime's `/api/version`, `/api/tags` and `/api/ps`;
  - the connection's config;
  - the catalog footprint (D8);
  - the host inventory;
  - recent usage (D13).
- **What it carries:**
  - runtime state;
  - installed models and the one loaded, with its context and GPU/CPU split;
  - recent tokens per second;
  - `issues[]`. Each issue carries a stable `code`, a `severity`, a `cause` with the numbers in it (for example _61,204 tokens sent, 32,768-token window_), and a `remedy`. The remedy is an acting operation with its arguments already filled in (the smallest context that fits, the model that fits), or, where nothing in Aflow can fix the problem, an instruction for the operator (_start Ollama_, _close other apps_).
- **Who reads it:**
  - **Readiness** derives red and amber from `issues` rather than repeating the checks.
  - **The UI** shows each issue as a card whose button runs the remedy.
  - **Helmsman** gets the same record from the status operation and can propose the remedy as written.
  - **Run-time errors** on a local model (`context_exceeded`, a runtime that is not running, a model that is not installed) carry the same issue `code` and `remedy` in their tool error, so an agent whose call failed reads the fix on its next turn.

  _Rejected:_ separate checks per surface. Readiness, the models page and the agent would each describe the same fault in their own words, and drift apart.

- **Coverage:** an issue that cannot be stated with a cause and a remedy is not shipped as an issue. A vague warning teaches nothing, to a person or a model.

**D17 — A local model's silent stretches are said in the chat.** Before its first token, a request on a local model can be silent for minutes: the model loading (25–56 s on the measured machine, more for a larger one) and then reading the prompt, which Ollama streams nothing during. A spinner reading _Working…_ through that looks like a stalled chat.

- **What is known:** only the transitions. Whether a request will load the model is read from `/api/ps` before it is sent: the model is not loaded, or the llama.cpp runner holds it at another window, which reloads it. The MLX runner ignores the window and never reloads for one. Prefill progress is not reported by the runtime, so no percentage or time estimate is shown.
- **The adapter loads first.** A load otherwise happens inside the request's own prefill, where nothing tells the two apart. So when the request would load, the adapter loads the model explicitly, at the window the request uses, and then sends the request. That makes the end of the load observable at no extra cost, since the load would have happened anyway. A load that fails is left for the request to report in its own words.
- **The signal:** `AIRequestOptions.onRuntimePhase` reports `loading_model`, then `reading_prompt`. The Ollama adapter calls it; hosted adapters never do. The status read is made only for a caller that listens.
- **The channel:** the agent turn writes each phase as one line on the step's `status` live-delta channel (_Loading Gemma 4 26B (this computer) into memory…_, _Reading the conversation…_), and each phase slides the step's idle window. The chat's activity row shows the last line in place of _Working…_ until the first `thinking` or `text` delta replaces it with _Thinking…_ or _Writing…_. Nothing is written to the transcript. _Rejected:_ reusing the `activity` channel. Its lines fold into a harness feed, and the chat pins a harness card for any step with an unsettled feed.

**D18 — In the local edition, the catalog's models on this computer are assignable under the platform recommendation.** A tenant that names no allowlist follows the platform recommendation, which carries only hosted models, so a fresh local install with no cloud key had nothing it could assign. `allowedModelIds` takes the edition: in the local edition, a tenant following the recommendation may also assign every local catalog entry. Nothing is billed for them and the machine is the operator's own. A tenant that named its own set is held to it, as everywhere. They are assignable, not recommended: which local model is recommended for which role is still P2's usefulness tier.

## 4. The initial lineup

The figures below come from model cards and the Ollama library, read when this plan was written. None of them are measured: P0 replaces each of them with a number from the probe, and an entry ships only after its probe passes. "Fits" assumes Q4 weights and leaves room for the stack, the operating system and a browser.

| Entry (tier alias)                | Runtime tag                           | Shape                           | Weights  | Context (model) | Why it is in                                                          |
| --------------------------------- | ------------------------------------- | ------------------------------- | -------- | --------------- | --------------------------------------------------------------------- |
| Qwen3.8 27B                       | `qwen3.8:27b`                         | dense, hybrid attention, vision | ~18 GB   | 256K            | Strongest agentic and coding results in the size class; effort ladder |
| Qwen3.6 35B-A3B                   | `qwen3.6:35b`                         | MoE, 3B active, vision          | ~24 GB   | 256K            | Fast for its quality: 3B active; coding-tuned                         |
| Gemma 4 26B MoE                   | `gemma4:26b`                          | MoE, 3.8B active, vision        | ~17 GB   | 256K            | Native function calling; fastest of the capable tier                  |
| Gemma 4 31B                       | `gemma4:31b`                          | dense, vision                   | ~20 GB   | 256K            | Gemma's quality ceiling at desktop size                               |
| Muse Glimmer 30B                  | `muse-glimmer:30b`                    | dense, vision                   | ~18 GB   | 128K            | Meta's agent-tuned open model: tool use, long tasks, recovery         |
| gpt-oss 20B                       | `gpt-oss:20b`                         | MoE, MXFP4                      | ~14 GB   | 128K            | Smallest model with a usable tool-calling record; 16 GB machines      |
| Qwen3.5 9B                        | `qwen3.5:9b`                          | dense                           | ~7 GB    | 256K            | Clerk, judge and title roles; machines under 16 GB                    |
| gpt-oss 120B / Nemotron 3.5 Super | `gpt-oss:120b` / `nemotron-3.5-super` | MoE                             | 65–90 GB | 128K / 1M       | The 128 GB tier                                                       |
| Qwen3 Embedding / EmbeddingGemma  | `qwen3-embedding` / `embeddinggemma`  | embedding                       | small    | —               | Local memory (P5)                                                     |

Not in the lineup: **Muse Spark Open**, which needs hundreds of gigabytes of memory, and Muse Spark, which is served by API only.

## 5. Affected packages and contracts

- `packages/ai-client`:
  - `providers/ollama.ts` (new), and `providers/openaiCompatible.ts` in P6;
  - `AIProviderSchema`: `local` replaced by `ollama`, plus `openai-compatible` in P6;
  - `ModelDefinition.local`, with its footprint, measurement conditions and build identity;
  - local entries in `catalogModels.ts`;
  - `verifyCredential` for the new providers;
  - effective-context budgeting and the overflow-sizing method P0 chooses;
  - `truncate: false` on every embedding request;
  - `diagnoseLocalRuntime`.
- `packages/schemas`:
  - the credential registry entry `ollama`, with `base_url`, an optional token and the per-provider required secrets;
  - the connection config fields (`context_tokens`, `max_parallel`, `keep_alive`);
  - `HostInventory.machine`, including free disk;
  - `LocalRuntimeDiagnostics` and its issue codes;
  - the local-model status and acting operations, the `local_model` target in the approval payload union (`requestedInput.ts`, `sessionBlockedOn.ts` and `actionCenter.ts`, beside `browser`), a new capability group with its tenant migration for the system profiles, and the Helmsman preset entries (Runner excluded);
  - `spaces.model_locality`;
  - `AGENT_MODEL_PROVIDER_IDS`.
- `apps/aflow-executor-ai`:
  - required secrets read from the registry;
  - `baseUrl` and connection config forwarded to the adapter;
  - `nativeFCProviders` removed;
  - runtime admission through `admitOperation`;
  - provisional streamed text until the response validates;
  - local timeouts;
  - a streaming `generateJson` fallback.
- `packages/redis`: the leased semaphore keyed by `runtimeId`, and `runtimeAdmission` for callers outside a step.
- `packages/executor-runtime`: `StepHandler.admit`, waited on before a step starts.
- `packages/server-runtime`:
  - readiness for `ollama`, with no `providerId = null` special case;
  - model-lifecycle routes (local edition only);
  - catalog responses carrying fit;
  - `ByokAiClientFactory`, which gains the provider and goes through runtime admission.
- `apps/aflow-executor-host`: machine memory and free disk in the inventory.
- `apps/aflow-executor-memory`, `packages/database` (P5):
  - embedding through the space's credentials;
  - embedding identity on stored vectors, identity-filtered `searchVector`, and identity on queued jobs;
  - the rebuild task, registered in `packages/schemas/src/background/registry.ts`;
  - if G4 rules out 1536-dimension output, a migration adding the native-size columns with HNSW indexes, and `EMBEDDING_COLUMNS`.
- `packages/web-product`:
  - the models page's "On this computer" section;
  - the connection dialog;
  - the onboarding path;
  - cost shown as "local";
  - the locality policy in space settings.
- Packaging and scripts:
  - `docker-compose.local.yml`: `extra_hosts` and the `local-models` profile;
  - `scripts/start.mjs`: the runtime status line;
  - `yarn models:verify-local` and the P0 gate scripts.

## 6. Phases

The first complete slice is one model on one machine, P0 and P1. Every other lineup entry is qualified separately (P2) and blocks nothing.

### P0 — Feasibility gates (no product code)

Run on one machine, the 24 GB Apple Silicon one, with one model that fits it. Each gate is answered by a script committed beside the probe, so its answer can be reproduced:

- **G1, overflow (D5):** does the current runtime truncate or refuse a prompt over `num_ctx`, and what does it keep? How does prefix caching change `prompt_eval_count`? Which sizing method holds on multilingual text, tool-heavy turns, reasoning history and images, and with what margin?
- **G2, locality (D12):** can a client see whether a runtime's cloud features are disabled, and does it mark a model as remote?
- **G3, lifecycle (D10):** what happens to a pull that is interrupted, cancelled, or run twice at once, and what does a pull with no disk space left return?
- **G4, embeddings (D16):** does `dimensions` on `/api/embed` produce usable 1536-dimension vectors from a local model, and at what retrieval cost against its native size?
- **G5, the machine (D8, D10):**
  - memory at two context sizes and two `max_parallel` values;
  - the GPU wired-memory cap;
  - prefill and decode tokens per second;
  - model load and switch time.

**Inventory** every place a model is resolved outside role resolution.

_Exit:_

- every gate answered, and D5's sizing method chosen;
- the call-site inventory attached to this plan;
- a gate that fails changes the decision it serves before P1 starts.

### P1 — One local model runs an agent (D3–D7, D9 compatibility tier, D15 for these faults)

**Build:**

- the Ollama adapter;
- the `ollama` connection, set up through the existing credentials screens;
- one curated catalog entry, `gemma4:26b`, the model P0 measured on the 24 GB machine;
- `models:verify-local` with its compatibility tier and build identity;
- native tool calling decided by capability;
- the effective context window with overflow prevention;
- streamed text that stays provisional until the response validates;
- runtime admission (`runtimeId`, the leased semaphore, `StepHandler.admit`, cancellation, the client wrapper for titles and judging);
- the local idle window and idle-plus-ceiling timeouts for every AI operation on a local model;
- compaction's summary model and the clerk's `auto` choice resolved through the space's roles, so a space whose only provider is the local runtime can compact a long conversation and title a session (§9, call sites 2 and 11);
- readiness.

The dev stack only.

_Exit:_

- Helmsman on that model completes a tool-using conversation through the web UI, with the role assigned in the ordinary picker;
- three concurrent sessions on it run one at a time and finish with no timeout;
- a prompt near the window survives its prefill.

_Built and tested:_ everything in the list above, with unit tests for each proof below, and the adapter run against Ollama 0.40.5 on the 24 GB machine: plain text, two parallel native tool calls, streaming with thinking, JSON through the tool fallback after the MLX runner's 501, and a refusal before sending of a prompt the llama.cpp runner would have cut. `yarn models:verify-local` reports the `gemma4:26b` entry as matching its build. _Run on the dev stack_ (§9, P1 on the dev stack): Helmsman on Gemma 4 26B held a tool-using conversation through the web UI. _Not yet run:_ three concurrent sessions, and a prompt near the window.

_Proof:_

- **Overflow:** a prompt the sizing method cannot rule safe is refused before it is sent, as `context_exceeded`.
- **Tool calling:** native tool calling follows `capabilities.functionCalling`, not the provider.
- **Readiness:** a connection with no runtime listening is red in readiness, not green.
- **Admission:** two credentials naming one runtime share one admission. A step cancelled while queued leaves the queue. A worker killed while holding a lease frees it when the lease expires. A cloud call is not held up by a local queue.
- **Prefill:** a runtime that takes longer than the old 300 s idle window to send its first byte does not fail the turn.

### P2 — Qualifying the lineup (D9, one pull request per model)

Each lineup entry (§4) is qualified on its own: both probe tiers, the build identity, the fit footprint and the role recommendations. It lands as its own small catalog change and can run in parallel with every later phase. An entry that fails is recorded as not recommended, with its result, and blocks nothing.

_Exit for each entry:_ its usefulness results, repeated runs included, are in the entry, and its recommended roles follow from them.

### P3a — The window fits the machine (D8)

**Build:**

- the footprint in the catalog entry, `local.footprint: { weightsBytes, kvBytesPerToken }`, measured by `models:verify-local` from two prompt sizes and checked for drift — the per-token cost scales with the runtime's KV cache type, which its API does not report, so a changed cache type shows as drift rather than being recorded;
- `machine: { totalMemoryBytes, gpuWorkingSetBytes }` in the host inventory, the GPU figure read once through Metal and cached;
- `localModelFit` in `@aflow/ai-client`: the answer, the largest fitting window, and the bytes at the window in use;
- the default window: `context_tokens` left unset means the largest fitting window, per model, with 32K when the inputs are missing;
- the fit and the window in use on the connection's readiness, with what the runtime holds now: the model's loaded size beside the GPU working set, so a model spilling because it holds every conversation's cache says so;
- **Load now** and **Unload** beside the role, through operator-only routes refused outside the local edition;
- `gpu_memory_gb` on the connection for a runtime on another machine.

_Exit:_ on the 24 GB machine, a connection with no window set runs Gemma 4 26B at 32K and reports that it spills, naming the 16K it fits; the same connection on a machine with 64 GB or more reports _fits_ at the model's full window.

_Proof:_ a footprint and machine for which the full window does not fit yield a smaller window; a configured window is never replaced; a missing machine figure yields _unknown_ and 32K.

_Built and tested:_ all of the above. The probe measures Gemma 4 26B at 16.15 GB and 120,469 bytes a token, inside its entry's tolerances; the host's Metal probe reads 19.07 GB on the 24 GB machine and caches it; the fit there is 16K, below the agents' 32K, so the automatic window is 32K and readiness names the spill. Load and unload were run against Ollama on the 24 GB machine: the model loaded at a 32K window and unloading freed it at once. _Not yet run:_ the dev stack with this branch, where the host executor publishes the machine and readiness shows the note and the actions.

### P3 — The operator's surface (D8, D10, D13, D15)

**Build:**

- runtime detection;
- `diagnoseLocalRuntime`, with readiness derived from its issues;
- **On this computer**, listing installed and lineup models with estimated or verified fit, and each issue as a card whose button runs its remedy;
- the explicit trial load for an unpaired machine;
- pull with progress, cancel, delete, warm and unload, with the durability rules of D10: one pull per tag, a disk-space check, and the runtime's resume behaviour as P0 found it;
- the one-model-for-every-role preset as the default for a local space, and the cost of mixing models;
- an onboarding path for "use a model on this computer", for an operator with no cloud key;
- cost shown as local;
- the model loading and the prompt being read, said in the chat while a turn waits on them (D17);
- machine memory and free disk in the host inventory;
- edition gating;
- _optional:_ the approved one-time install on a paired Mac (D2).

_Exit:_ on a machine with Ollama and no models, an operator goes from first run to a working Helmsman conversation without a terminal.

_Proof:_

- the surface is absent in a hosted build (`apps/web` route and nav);
- a model loaded with a context too large to fit on the GPU raises an issue whose remedy, run from its card, leaves it entirely on the GPU;
- a second pull of a tag that is already downloading joins the first;
- a pull larger than the free disk is refused before it starts;
- reading diagnostics on an unpaired machine loads nothing.

_Built:_

- **The record:** `LocalRuntimeDiagnostics` (`@aflow/schemas`) and `diagnoseLocalRuntime` (`@aflow/ai-client`), pure over one observation of `/api/version`, `/api/tags` and `/api/ps`. Its issue codes are `runtime_unreachable`, `model_not_installed`, `window_does_not_fit`, `window_tight`, `model_spilling`, `model_partly_on_cpu`, `build_unverified` and `mixed_local_models`.
- **Remedies:** each is an action from `LocalModelActionSchema` (`pull`, `delete`, `warm`, `unload`, `set_context`, `use_for_every_role`) or an instruction.
- **Shared core:** the runtime, the diagnosis and the actions live in `@aflow/cybernetic-runtime` `localModels/`, so the server's routes and Helmsman's operations reach the same code.
- **Pulls:** a pull is one Redis record per runtime and tag. It is both the claim, which a second request joins, and the progress. Progress renews its lifetime, so a server that dies leaves nothing behind. A cancel is read on the same round trip, and a stopped or failed pull stays readable for ten minutes. The disk check reads the host inventory's `freeDiskBytes`, measured under `OLLAMA_MODELS` or `~/.ollama/models`, and holds 2 GiB of headroom.
- **Readiness:** derives `localFit` and `localIssues` from the record. An `error` issue counts against `ready`, and the banner points at This Computer rather than the model picker.
- **The page:** This Computer gains "Models on this computer":
  - the runtime and the machine;
  - each issue as a card whose button runs its remedy;
  - per model: download with progress and stop, load, unload, use for every role, and delete with a confirmation naming the roles it leaves without a model.
- **Edition gating:** the page renders none of it in the hosted edition, and the routes answer 404 there.
- **"Use for every role":** writes the space's directives through the space update the agent settings already use. It sets the default and clears every role override, and puts the Clerk on `space_default`.
- **Onboarding (D18):** offers the models on this computer beside the hosted ones. Choosing one puts every role on it, adds an Ollama connection unless one already resolves, and skips the key step.
- **Cost:** a run whose every model call ran here reads _Cost: local_, and so does each such step.

_Not built:_

- the trial load for an unpaired machine, beyond **Load now**, which loads at the request window and whose loaded size `/api/ps` then reports;
- recent tokens per second in the record;
- the approved one-time install.

The "use for every role" remedy is the operator's only, because a role's model is written through the space update, which no executor reaches. Helmsman proposes it as an instruction.

### P3b — Helmsman reads and asks (D10, D15)

**Build:**

- the status operation;
- the acting operations parked on the write-approval pause, with the `local_model` approval target and its card;
- the re-check of impact when an approved action executes;
- the capability group and its migration;
- the Helmsman preset;
- issue codes and remedies on local-model tool errors.

_Exit:_ in a live conversation, the operator asks Helmsman why responses are slow, and Helmsman names the cause from the record (for example, the model is partly on CPU at a context of 128K) and posts one card with the fitting context. Once the operator approves, the next status shows the model entirely on the GPU.

_Proof:_

- a Runner's grant cannot reach any of these operations;
- an acting call without approval does not run, and after a denial it fails with the operator's reason;
- a card for unloading the model the asking session runs on names that session among the runs it would end;
- an approved unload whose affected runs changed after approval parks again with the new impact.

_Built:_

- **Operations:** `model.runtime.status` (read) and `model.runtime.change` (write), in a `model` step type whose lane is composed only in the local edition (`isStepTypeComposed`). A hosted Helmsman's catalog does not carry them, in the same way it lacks `host.*` and `browser.*`.
- **Where they run:** inline in the orchestrator, reaching the runtime through the same `@aflow/cybernetic-runtime` `localModels` code as the operator's routes.
- **Capabilities:** the group is `model.runtime`, its bundle is `local_models` (on demand), and migration 220 grants it to the system profiles (read and write to every authoring profile, read to Read Only).
- **Helmsman's surface:** both operations are discoverable, and the status read is pinned on the local edition.
- **Runners and skills:** `isLocalModelOperation` is in `isRunnerExcludedOperation`, and a skill referencing one is invalid (`skill_references_local_model_op`).
- **The change's input** is `LocalRuntimeChangeSchema`: `pull`, `delete`, `warm`, `unload`, `set_context`. A role's model is not among them, because it is the space's setting written through the space update. Helmsman says so rather than proposing it.
- **The approval:** a third approval target, `local_model`, carried through the payload, `blockedOn`, the Action Center extension and card, and the chat's waiting notice.
- **The request** is built from a fresh diagnosis each time the step runs (`localRuntimeChangeRequest`). Its hash covers the change and whether the asking conversation's model is the one changed, so an approved change whose reach moved since its card was shown parks again.
- **What stays out of the hash** is on the card: the requests running on the runtime now (`countRuntimeRequests`, the admission leases held, on any model, since a lease does not record one), and the change's figures (download size against free disk, memory at the window, what an unload frees). They move by the second, and in the hash an approved change would rarely find the request it approved.
- **Who approves:** the card answers to a space admin (`resolverPolicy: ['admin']`), the role the operator's own routes for these changes require.

- **Spending the approval:** an approval lets one change through. It is spent with `spendWriteApprovalGrant`, now the one spend for every target. Its key family, `aflow:approval-spent:`, sits outside the grant family the host executor may only read, and the host's ACL may write it. The same request asked again names the spent decision (`decidedBefore`), and the orchestrator honours that for every target but the API one.
- **On the asking conversation:** a turn does not hold the runtime while its tool runs, so unloading the model Helmsman runs on ends no turn. Its card says the conversation's next turn loads the model again, and names any other requests the change ends.

_Not built:_ issue codes and remedies on local-model tool errors. A local model failing an agent's own turn fails that turn, not a tool call it could read, so this waits for an operation that calls a local model as a tool.

### P4 — The appliance (D11)

**Build:**

- `extra_hosts`;
- the `local-models` profile with NVIDIA and `OLLAMA_NO_CLOUD=1`;
- the `yarn start` status line;
- operator documentation.

_Exit:_ a Helmsman conversation on a local model through the macOS appliance against the host's Ollama, and through the Linux appliance against the profile's container. Both are release-tested on a real appliance.

### P5 — Model inference stays on this machine (D12, D16)

**Build:**

- every inventoried call site following the space's choice;
- `model_locality`, with its two tests (endpoint and execution location) and the runtime's cloud setting in diagnostics;
- embedding identity on stored vectors, identity-filtered search, the rebuild task, and identity on queued jobs;
- `truncate: false`;
- memory embedding through the space's credentials;
- the stored dimension form G4 chose.

_Exit:_ a `local_only` space runs a skill end to end, memory write and search included.

_Proof:_

- **Refusal, with the internet available:**
  - assigning a cloud model to any role is refused, naming the role;
  - a remote or cloud-suffixed tag on the local runtime is refused;
  - no platform-internal call in the inventory reaches a cloud model. Every outbound model call during the run is captured, and none goes to a cloud provider.
- **Offline:** the same run repeated with the internet cut off still completes. That proves the space works offline, which is a separate claim from refusal.
- **Embedding identity:** after the space's embedding model changes, search returns only old-identity results until the rebuild covers the scope, then only new ones, and never a mix.

### P6 — Scale and variety (D14)

**Build:**

- the OpenAI-compatible adapter, probed against vLLM and llama-server;
- runtimes on the network behind an admitted origin and token, never counted as local (D12);
- connection pools, admitted per `runtimeId`;
- discovered models: any installed tag offered as a tenant-scoped catalog overlay, persisted with its own probe result and build identity, assignable once measured.

_Exit:_ two runtimes serve one model as a pool and split a batch of eval runs. A tag outside the lineup is pulled, measured from the UI and assigned.

## 7. How it is proven

The cases that would fail if this were wrong:

- **Overflow:** a prompt that might exceed the connection's window is refused before it is sent. The model never answers with its instructions cut off.
- **Readiness:** readiness is red when the runtime is down.
- **Admission:** one runtime admits `max_parallel` requests across every caller and credential, a queued request is not killed for waiting, and local queueing never holds up cloud work.
- **Prefill:** a long prefill is not killed for silence.
- **Measured capability:** a model without measured tool calling is not sent native tools, and a build that differs from the measured one is reported as unverified.
- **Locality:** a `local_only` space cannot reach a cloud model through any role, platform-internal call or remote tag, tested with the internet available.
- **Embedding identity:** search never mixes vectors from two embedding identities.
- **Edition:** none of it exists in a hosted build.
- **Approval:** no agent changes the runtime without an approved card, an approval acts only on the impact it showed, and Runner cannot ask.
- **One diagnosis:** readiness, the models page and Helmsman report the same issue code for the same fault, because each reads `diagnoseLocalRuntime`.

Each is a test in the phase that introduces it. The P1, P3, P3b and P5 exits are live runs on the dev stack, driven through the UI or `aflow-local`.

## 8. Open questions

- **Retrieval at reduced dimensions.** G4 showed that 1,536-dimension output is available, not what it costs: its twenty-pair set scores every configuration perfectly. P5 measures recall at 1,536 against native size on a real memory corpus before the first local embedding model is recommended.
- **Image tokens.** G1 measured an 8×8 image at 11 tokens (llama.cpp) and 66 (MLX). P1 measures the image sizes the platform actually sends before images are sized by the method in D5.
- **Discovered models earlier?** If the curated lineup turns out too narrow for testing, the P6 overlay could move up to P3. It costs a table and an on-demand probe run.
- **Runtime decision models.** The current Ollama release lists models that return choices with probabilities. Whether they could back `ai.decision.decide` (plan 316) locally is a question for after P1.
- **Windows.** Ollama runs there and the dev stack's host-side executors would reach it, but nobody has measured it.

## 9. P0 results

Measured on an Apple M3 with 24 GB of unified memory against Ollama 0.40.5, running as a Homebrew service with `OLLAMA_KV_CACHE_TYPE=q8_0`, flash attention on and default parallelism. Raw output: [`323-p0/apple-m3-24gb.json`](323-p0/apple-m3-24gb.json), produced by `yarn models:local-gates <gate>`. Models: `gemma4:26b` (MLX, NVFP4), `qwen3.5:9b` (MLX, NVFP4), `qwen3.5:4b-q4_K_M` (llama.cpp, Q4_K_M). On Apple Silicon this release serves a model through MLX unless its tag names a GGUF quantisation.

### G1 — Overflow

|                                                            | llama.cpp runner                                                                | MLX runner                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| 6.4K-token prompt, `num_ctx` 4096                          | cut from the front to 2,050 tokens, system message lost, answer wrong, no error | all 6,437 tokens evaluated, answer right |
| `/api/ps` context after a 16K request                      | 16,384                                                                          | 4,096                                    |
| `prompt_eval_count` on a cached repeat                     | full count (6,437), prompt read in 0.06 s                                       | full count (6,437), 0.08 s               |
| Characters per token: English, German, code, JSON, Chinese | 4.8, 4.8, 4.0, 2.9, 1.7                                                         | 4.8, 4.8, 3.5, 2.8, 1.6                  |
| Eight tool schemas                                         | 889 tokens                                                                      | 573 tokens                               |
| An 8×8 image                                               | 11 tokens                                                                       | 66 tokens                                |
| 1,800 characters of replayed `thinking`                    | 0 tokens                                                                        | 0 tokens                                 |

A one-token evaluation counts a prompt exactly and leaves it cached: the request after it read 6,422 tokens in 0.07 s. `num_predict: 0` is not that: it means no limit. There is no tokenize endpoint. The chat template `/api/show` returns is `{{ .Prompt }}` on both runners, because the runner applies the model's own template, so a template fingerprint (D9) is taken from the model's digest and parameters rather than from that field.

### G2 — Locality

`GET /api/status` returns `{"cloud":{"disabled":false,"source":"none"}}`. A cloud model, once pulled, is a 307-byte manifest that `/api/tags` lists with `remote_host: "https://ollama.com"` and `remote_model`. `/api/show` for it has no remote field, and describes a cloud tag even before it is pulled.

### G3 — Lifecycle

Closing a pull's request cancels it and installs nothing. The next pull resumes from the bytes already downloaded. Two concurrent pulls of one tag both succeed with identical progress. A tag that does not exist fails at once with `pull model manifest: file does not exist`. A full disk was not exercised.

### G4 — Embeddings

|                                    | EmbeddingGemma                            | Qwen3-Embedding 4B                        |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Native dimensions                  | 768                                       | 2,560                                     |
| `dimensions: 1536`                 | refused: exceeds embedding length         | 1,536                                     |
| Over-long input, `truncate: false` | refused: input exceeds the context length | refused: input exceeds the context length |
| Over-long input, default           | cut silently to 2,048 tokens of ~39,000   | cut silently to 4,095 tokens              |

The built-in retrieval set scored 1.0 recall in every configuration, so it separates nothing: what reduced dimensions cost is still open (§8).

### G5 — The machine

|                                       | `qwen3.5:9b`  | `gemma4:26b`    |
| ------------------------------------- | ------------- | --------------- |
| Resident size, all on the GPU         | 7.8 GB        | 16.2 GB         |
| Cold load: weights, then first prompt | 3.9 s + 0.9 s | 10.8 s + 24.7 s |
| Switch from the other model           | —             | 48.8 s          |
| Prefill, 12K-token prompt             | 157 tokens/s  | 253 tokens/s    |
| Decode                                | 25 tokens/s   | 20 tokens/s     |

Metal's working-set limit is 19.07 GB. With `gemma4:26b` loaded and the stack's Postgres and Redis running, free memory was about 80 MB and swap held 6.6 GB. At 253 tokens a second, a prompt of about 75,000 tokens takes longer to read than the 300 s stream idle window allows (D7).

### G6 — Footprint and caching under real prompts

Measured after P1 with prompts long enough to fill the cache, `gemma4:26b` at a 32K window, the KV cache at `q8_0`:

| Prompt tokens           | Size reported by `/api/ps` | Request time |
| ----------------------- | -------------------------- | ------------ |
| 96                      | 16.18 GB                   | 78 s, cold   |
| 2,906                   | 16.66 GB                   | 12 s         |
| 12,106                  | 17.77 GB                   | 50 s         |
| 25,306                  | 19.15 GB                   | 190 s        |
| then a different 14,834 | 19.97 GB                   | 298 s        |

The cost per token is steady at about 118 KB. The size does not fall back for a shorter prompt, and grows again for a different one: the runner keeps more than one conversation's cache until the model unloads. The P1 live session reached 22.7 GB at a 32K window. Past Metal's 19.07 GB working set prefill fell from about 240 to 130 tokens a second and swap grew by 2.5 GB. The runner process's own resident memory stays near 40 MB; the model's memory is what `/api/ps` reports.

The prefix cache keeps checkpoints at 8,192-token steps and at the end of each prompt. An identical prompt is read back whole (`cached=13140` of 13,144, 1.9 s), and so is a prompt counted with one token and then sent (4.3 s + 4.7 s). A prompt that extends the previous one, as an agent's next turn does, diverges just before the previous end checkpoint, where the request's closing turn tokens were, and falls back to the 8,192 checkpoint: 4,958 of 13,150 tokens read again, 92 s under memory pressure. Every agent turn on the MLX runner past 8K tokens pays for that. The llama.cpp runner read an extended prompt from its cache in P0; whether a GGUF build of the same model is the faster one for agent loops on Apple silicon is a P2 question.

### P1 on the dev stack

Helmsman on `gemma-local` at the 32K default, on the 24 GB machine with the dev stack and a browser running: the first turn, model load included, took 6 m 42 s; the turns after it 15–56 s each at 17.7–19.9K prompt tokens. Helmsman answered from `catalog.tool.search` and `catalog.tool.list` correctly, and recovered on its own from one rejected call (`stepTypes: ['platform']`, not a step type). The model held 22.7 GB, past the working set, which accounts for the pace.

### Call sites outside role resolution

Every production model call was inventoried. The ones a `local_only` space (D12) would miss today:

| #     | Call                                                                                                                      | Process                      | How the model is chosen                                                                                                               | Credentials                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1     | Agent turn, for an agent that is not a platform role, or a delegated Runner or Coach given `runner_model` / `coach_model` | AI executor                  | the agent's own config or the caller's argument, else `haiku`                                                                         | space's                       |
| 2     | Compaction summary                                                                                                        | AI executor                  | constant `RETENTION_POLICY.compactionSummaryModel` (`flash-lite`)                                                                     | space's                       |
| 3–7   | `ai.*` text, JSON, stream, decide, embed, image and video operations                                                      | AI executor                  | step input, else a constant per operation (`haiku`, `jev`, `text-embedding-3-small`, `flash-image`, `veo`)                            | space's                       |
| 8–9   | UI surface and applet generation, and their repair                                                                        | UI executor                  | step input, the calling agent's model, `UI_GEN_MODEL`, a constant, then the first entry of `TEXT_MODELS` with a resolvable credential | space's                       |
| 10    | API-simulation answers                                                                                                    | API executor                 | the simulation's model, the caller's, `SIMULATION_GEN_MODEL`, a constant, then the same sweep                                         | space's                       |
| 11    | Session titles and metadata (clerk)                                                                                       | orchestrator                 | the clerk role; `auto` picks a catalog candidate on the default's provider and refuses a `local` one                                  | space's                       |
| 12–14 | Post-run judge, eval-batch judge, re-judge                                                                                | orchestrator, API server     | a criterion's `model` wins over the judge role                                                                                        | space's                       |
| 15–17 | Memory document, memory query and memory entry embedding                                                                  | memory executor, AI executor | `memory_embed_config`, else `text-embedding-3-small`                                                                                  | **platform environment keys** |

Rows 1–14 use the space's credentials, so a space holding only a local connection fails on them rather than leaking; a space or tenant that also holds a cloud key routes them to the cloud. Rows 15–17 never consult the space: its memory text goes to whichever provider the platform's environment keys name. Row 2 and row 11 are moved into P1, because a local-only Helmsman needs both. The rest are P5's coverage list.
