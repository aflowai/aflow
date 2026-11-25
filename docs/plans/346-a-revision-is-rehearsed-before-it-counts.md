# Plan 346 — A revision is rehearsed before it counts

**Status:** P0 built, and its exit is met in the checkout. P2 is open, so the plan is not done. P2's exit is **Done when**: a held version, alpaca-thesis-trading 38 or later, published on a recorded smoke pass. The gate, the alpaca-thesis-trading plan, its exchange window, the production-size fixtures, the output-budget estimate, the date check, the smoke run (D7) and the dry run of a skill (D8) are in. A passing smoke record satisfies the gate (D7). P1, the live rehearsal, is optional and open. The first rehearsal of alpaca-thesis-trading version 37 is on record as `skipped`: it ran in a sandbox that refuses loopback connections, with no API key and no space. A smoke pass of version 37 is on record in `storeSmokes.json`. See **Phases** for each exit.

**Builds on:** Plan 190 (skill validity), Plan 253 (the write policy), Plan 345 (Store updates without a click), Plan 333 (D2's writing rules).

**Leaves alone:** the review loops, the skill validity verdict's existing dimensions, the Store's install and apply-update paths. The eval plane is not left alone. D8 adds the `dry_run` decision to the run evaluation envelope, and a dry run records that decision and no score. The Store update preview is not left alone. Its response contract (`StoreUpdatePreviewResponseSchema`) and its producer (`executeStoreUpdatePreview`) gain the installed and the catalog content hash.

## The rule

The operator's direction, 2026-11-23 22:50Z: "let's ensure a rehearsal is part of building skills, agents, integrations or anything really here.. make this a track of work that things can be tested before being released.. MUST REHEARSE -- REMOVE BUREAUCRACY and focus on getting things done."

## Decision card

**What changes**

- Today: review, skill validity, schemas and unit tests certify a bundle's artifact. None runs the installed bundle in a real space at real data sizes.
- After: a rehearsed bundle's new version counts as done only on a pass of that version and content hash. A recorded smoke pass satisfies the gate (D7). A go-live rehearsal pass satisfies it too, as the optional stronger check. The publication reads both records.

**Why**

- Six Trading Joe defects passed every gate, and none of those gates runs the bundle: PRs #359, #360, #361, #362 and two in #365.
- No space can host the go-live rehearsal. The only space with the Alpaca credential is Trading Joe, and a rehearsal there ends its live campaign.
- A gate that only a live pass opens would refuse every version from 38 on. The 07:05Z direction asks for a mock run instead (D7).
- The smoke needs no space, and `storeSmoke.guard.test.ts` runs it in CI on every change. Each version bump is therefore smoked before it ships.
- Two of them, the offloaded read (#361) and the output budget (#362), appear only at a 30-member universe. Every fixture held three members.
- One of them, the model-supplied trading day (#365), is a class a graph check can see before any run.

**What it affects**

- `@aflow/schemas`: `store/rehearsal.ts`, with the plan, its exchange windows, the step results, the outcome rule `deriveRehearsalOutcome` and the ledger of each bundle's records.
- `@aflow/platform-artifacts`: `rehearsal/` (the engine, the exchange window rule, the HTTP client, the alpaca plan and the publication gate), `storeRehearsals.json`, and the production-size fixtures in `__tests__/productionSize.ts`.
- `@aflow/platform-artifacts` `rehearsal/` for D7: `MockRehearsalClient`, `smokeBundle` and the fixtures in `rehearsal/smokeFixtures/`.
- `@aflow/platform-artifacts` for D7's gate: `storeSmokes.json`, the smoke ledger. `rehearsalRefusal` and `publicationRehearsalRefusals` read it beside `storeRehearsals.json`.
- `RehearsalClient.startRun` in `rehearsal/rehearseBundle.ts`: its return type widens to `ClientResult<{ runId: string }> | RunDeclined`. A declined run is a skipped step.
- The Store update preview (`StoreUpdatePreviewResponseSchema`, `executeStoreUpdatePreview`): it reports the installed and the catalog content hash, which the install step compares.
- `@aflow/cybernetic-runtime`: two always-on advisories in skill validity, `output_budget_exceeded` (an error where no model can hold the output) and `clock_value_from_caller` with `clock_value_from_model`.
- `@aflow/cybernetic-runtime` exports for D7: `runSkillTasks` with `failWith`, which moves there from a platform-artifacts test file.
- `@aflow/cybernetic-runtime` exports `outputContractViolations`, the JSON Schema check of an agent task's output.
- `@aflow/cybernetic-runtime` exports `skillTaskRunner`, which the smoke run hands its mock client.
- `scripts/rehearse-bundle.ts` (`yarn store:rehearse`), and `scripts/regenerate-store-catalog-hashes.ts`, which now reads the ledger.
- `scripts/smoke-bundle.ts`, run by the new root script `store:smoke` in `package.json` (`yarn store:smoke`). Its `--record` flag adds the result to `storeSmokes.json`.
- The run machinery for D8: `workflow.run.start` takes `dryRun`, `workflow_runs.dry_run` and `workflow_run_held_writes` (migration 241) record it, and `workflow.run.detail` lists each held write. A dry run records no `plan_node_id`.
- The step result for D8: `StepResultMessageSchema` (`@aflow/schemas`) gains the optional `heldWrite` field, which the result consumer records.
- `@aflow/executor-runtime` for D8: `SuccessResult` gains the optional `heldWrite` field, and `successWithData` takes it as an option and sets it on the result.
- Session hot state for D8: `dryRunOf`, set by `spawnRunnerSession` and `agent.control.delegate`, and carried again by `startRun`'s DEL-then-write. `getSessionDryRunOf` reads it.
- The write tiers for D8: `dryRunWriteDisposition` (`@aflow/schemas`) names the held operations, and `dryRunHoldsHarnessRun` decides a harness run from its input. The orchestrator holds them in `scheduleStep`, `startRun` and `dispatchClaimedOperationTask`, and again on the retry, delayed-start and poll-cycle timers. The API executor holds every API write tier and every call that saves its response to memory.
- The rehearsal shares D8's hold policy: `REHEARSAL_WRITE_HOLD` gives way to `WRITE_HOLD_EVERY_TIER` (`@aflow/schemas`), which both read. `previewWrite` moves to `@aflow/schemas` for the same reason.
- The eval plane for D8: `RunEvaluationEnvelope` gains the `dry_run` decision, and post-run hooks record only that decision for a dry run.
- `@aflow/cybernetic-runtime` for D8: run counts, runs-by-input, run statistics, the campaign score series and `listRecentRuns` exclude dry runs. So do the Coach's breadth review and validity count and the causal binder's baseline.
- `vitest.config.ts`: Node tests resolve `@aflow/*` to source in Vite's SSR environment too. Before, a checkout without built `dist` could not run them, and a built one ran `dist`.

**Risks**

- A rehearsal's campaign start archives the space's thesis ledger. Mitigation: rehearse in a space kept for rehearsals. A start is refused while another campaign of a ledger-keeping skill is active.
- A cycle could place a paper order. Mitigation: the rehearsal sets the space's write policy to hold every tier, and it refuses each write its runs raise. The release step restores the policy.
- A write raised in a session the run detail does not list stays open. Mitigation: the run stays paused on it, and two quiet polls fail the step, so it never reads as a pass.
- The output-budget estimate is a typical token cost, not a tokenizer's. Mitigation: it is advisory where some recommended model can hold the output. It is an error only where none can, or on a pinned model.
- The gate now opens without a real run, so a fixture may answer where the real integration would fail. Mitigation: the smoke executes the skill's full task graph, and each agent output must hold its `outputContract.schema`. The live rehearsal (P1) stays available as the optional stronger check.
- A dry run's later tasks reason on state the run did not produce. A later read of a held write's path reads the live space's memory: an earlier live document, or nothing. Mitigation: the held result echoes the path and tells the task to carry on. `workflow.run.detail` lists each held write, so a reviewer reads which task read past one.

**Open questions**

- Should a followed Store update (Plan 345 B) refuse a rehearsed bundle's version without a pass? Recommended: no. The snapshot cannot be re-stamped without one, so no such version is published.

**Not done on purpose**

- The rehearsal does not run `performance-review` or `campaign-successor`. Each needs a closed week or a campaign boundary. The plan names both in `uncovered`, and every result lists them.
- No version below a plan's `gateFromVersion` is held. Alpaca-thesis-trading version 37 was published before the gate. Version 38 is the first it holds.
- The Daily Trading Cycle's `resolve-theses` still writes `tradingDay` itself. The date check flags it, and the fix is a new revision, which this gate now holds to a passing smoke run or rehearsal.
- The plan does not wait for a live rehearsal. P1 stays optional as the stronger check, and it is no criterion of Done when.
- A dry run keeps no overlay of its held writes. A later read of a held write's path reads the live space's memory, so the dry run proves each task's contract, not the state a live run would build.

**Done when**

- `storeCatalogHashes.json` publishes alpaca-thesis-trading at version 38 or later, a version the gate holds.
- `storeSmokes.json` records a smoke `pass` of that version, its content hash and the plan's current `planStepsHash`.
- `storeRehearsals.guard.test.ts` passes on that snapshot with no rehearsal pass of that version, so the smoke pass alone has opened the gate.

## D1 — the rehearsal runs the installed bundle

`rehearseInstalledBundle` takes a plan, the catalog's version and content hash, a space and a `RehearsalClient`. It runs these steps, each with an outcome and a detail:

1. `install`: the space holds the published version, uncustomized, and its install carries the revision's content hash.
1. `window`, in a plan that names a `window`: the rehearsal reads the exchange clock and calendar and holds the start to the plan's `startsIn` window. See D6. `--update` applies the Store update first, so a Store update and its rehearsal are one command. The update preview reports both hashes: the one the space stamped at install, and the one the stack's catalog publishes. A stack whose catalog hash differs runs another revision, so the step is skipped. A space whose installed hash differs installed other content under the same version, so the step fails before any other step runs. A pass records the installed hash it compared, not the checkout's.
1. `hold-writes`: every write tier waits for approval. While a run is under way, the rehearsal refuses each held write that run raised and counts it on the step. A write is the run's own when its operation task raised it, or a tool step in one of its agent tasks' sessions did. Write approvals that other sessions or the operator raised stay open.
1. The plan's steps: `campaign_start`, then one `run` per slot or skill. A run starts through `workflow.run.start` with `catalogId`, so it runs the skill exactly as the Store installed it. The rehearsal follows the run id that `workflow.run.start` returns in its session's output. It never takes the newest run of the slug, which a scheduled run of the same skill could be.
1. `release`: the write policy is restored, and the campaigns the rehearsal started end.

A run step passes only when the run completes, no task fails outside `toleratedFailures`, and every `requiredTasks` entry succeeded. A run that skips a required task is `skipped`, never passed. A pause no held write explains fails the step, because a bundle that goes live without a person must not pause.

The outcome has one rule. A failed step fails the rehearsal and names it. A skipped step, or no step at all, skips it with the reason. A step outside its exchange window makes the rehearsal `not_due` and names the step and the window (D6). Only steps that all passed give a pass. The result schema refuses a record whose outcome disagrees with its steps.

A run input names a parameter as `{ "$rehearsal": name }`. `BundleRehearsalPlanSchema` refuses a plan that names a parameter `REHEARSAL_PARAMETERS` does not list, and the issue names it. A step is skipped only for a parameter that exists and that the rehearsal was not given.

_Rejected:_ rehearsing against repository fixtures. They are the artifact the other gates already certify.

_Rejected:_ simulating the order binding. The write policy already stops every write at the platform's own gate, with no second fulfilment to maintain.

_Rejected:_ trusting the installed version number alone. A space can hold earlier content at the same version, and the record would then name content no run exercised.

_Rejected:_ refusing every open write approval in the space. It would also refuse the browser and local-model approvals that other sessions or the operator raised.

## D2 — the record is where the publication reads

`yarn store:rehearse <catalogId> --space <id>` adds the result to the bundle's records in `packages/platform-artifacts/src/storeRehearsals.json`, oldest first (`recordRehearsal`). A skip, a failure or a `not_due` result never replaces a pass. Every pass stays, except one a new pass repeats for the same version, content and plan steps. Only the newest record that is no pass is kept. Two readers hold a version to the records through `rehearsalRefusal`, which reads the best record. It reads the smoke records of D7 beside these. Any pass of the version, content and plan steps counts, whatever was recorded after it.

- `regenerate-store-catalog-hashes.ts` refuses to re-stamp a rehearsed bundle at a new version without a passing smoke or rehearsal record of that version and hash.
- `storeRehearsals.guard.test.ts` fails when the committed snapshot publishes such a version. It runs in `yarn verify`, the check a publication runs.

A record carries `planStepsHash`, the hash of the plan steps it ran (`rehearsalPlanStepsHash`). `rehearsalRefusal` counts a pass only when that hash equals the hash of the plan's current steps. A step added to or changed in the plan after a pass therefore needs a new pass, from a smoke run (D7) or a rehearsal.

_Rejected:_ keeping the record in the stack's database. A publication runs in the checkout, where no stack may be running, so the record lives in the repository beside the snapshot it gates.

_Rejected:_ a CI job that runs the rehearsal. CI has no rehearsal space, no paper credential and no connected folder, so every run there would be a skip.

_Rejected:_ counting any pass of the version and hash. A plan step added after that pass would never have run, and the gate could not tell.

_Rejected:_ one record per bundle, the newest. A later skip of the published version, for example on a stack that was down, would replace its valid pass, and the guard would fail for a version that has passed.

## D6 — the exchange clock decides when a step can run

A plan's steps can need the exchange in a given state. The alpaca cycles take their trading day from the clock's date and run only on a session day. The after_close cycle resolves on the close. The reflection reflects on the latest closed session. A rehearsal decides each of these from the exchange clock and calendar the bundle itself reads, never from the machine's clock.

- A run step names its `exchangeWindow`. `session_day` holds when the calendar has a session on the clock's date. `session_closed` also needs the market closed and the clock at that session's close or later. Both need the clock's date to be the rehearsal's trading day, because a plan's steps rehearse one session.
- A plan whose steps name a window names its own `window`. It holds the `source` (the clock and calendar reads, by API and endpoint), the `startsIn` window and a `schedule` in exchange hours. The plan schema refuses a step window without a plan window. `bundleRehearsalPlans.test.ts` holds the source to reads the bundle's tasks run.
- The `window` step reads the clock and calendar before any write is held. Its date becomes the rehearsal's `tradingDay` where the caller names none, so the script passes no date.
- Each windowed run step reads the clock and calendar again when it is due.

**Outcome semantics.** A window that is closed when its step is due makes that step `not_due`. Its `notDue` names the step, the window, the reason and `nextOpensAt`, the exchange-local time a fresh rehearsal would find it open. No later step starts, and each is recorded `not_due` without a `notDue` of its own. The release step still runs where the rehearsal held writes or started a campaign. The rehearsal's outcome is then `not_due`, below `fail` and `skipped` and above `pass`. A `not_due` record is no pass. The gate reports it with the window, the next opening and the plan's schedule, so the operator can start P1 inside the window. A clock or calendar read that fails is `skipped`, because no window was decided. Every result carries the plan's `window`, or null for a plan without one. The window is part of `planStepsHash`.

The alpaca plan starts in `session_closed`. Its schedule says to start on a session day after the close, at 16:00 ET or 13:00 ET on an early close, and by 19:00 ET. Its steps may take five hours in all, so every step then starts before midnight ET on the same date.

_Rejected:_ recording a closed window as `skipped`. The gate read it as a defect-shaped refusal with no time to act on, and the pass rested on a timing window no part of the plan named.

_Rejected:_ counting `not_due` as a pass. The steps it names never ran, so a pass would name content no run exercised.

_Rejected:_ reading the machine's clock in exchange time. It knows no holiday and no early close, and the runs decide their day from the broker's clock.

## D3 — production-size fixtures

`__tests__/productionSize.ts` builds Alpaca's full bar shape for a 30-member universe over the regime's 100-day lookback. That read is above the 64 KB inline limit, so the fixture offloads it behind a `dataRef`, as the API executor does. `alpacaProductionSize.test.ts` projects both reads through `loadProjectionSource`, computes the regime of all 30 members, and runs the universe check. It also asks the budget estimate about every agent task of the bundle at the campaign's ceiling.

_Rejected:_ committing recorded broker responses. They carry account data, and they age as the API changes. A generated read of the same shape and size does neither.

_Rejected:_ leaving size defects to the rehearsal alone. A rehearsal runs on a live stack now and then, and a unit test runs on every change.

## D4 — the output-budget estimate

`estimatePinnedOutputTokens` reads an agent task's pinned output schema. An array whose count a `count:` binding ties to an input counts at that input's declared `maxItems`, a campaign field's or an upstream contract's. `outputBudgetDiagnostics` compares the estimate with each recommended agent model's `maxOutputTokens` from the catalog, or with the task's pinned model. The gather-regime agent of version 11 estimates over Claude Haiku 4.5's 8192 tokens at 30 members and under it at three.

_Rejected:_ counting with each provider's tokenizer. Each provider counts differently, and skill validity must run offline as a pure function of the skill.

_Rejected:_ catching truncation only at run time. That is how #362 surfaced, after the run had spent its output budget.

_Rejected:_ an error on every estimate over some model's budget. The estimate is a typical cost, so it is an error only where no model can hold the output, or on a pinned model.

## D5 — dates a clock gives

`deterministicInputDiagnostics` flags a required run input whose schema is a date, and an agent's unpinned date output that a later task reads. Today it flags four: `daily-trading-cycle` `resolve-theses.tradingDay`, `strategy-desk` `tradingDay`, and `performance-review` `periodStart` and `periodEnd`. `clockValueSources.test.ts` pins that list, so a new one fails until it is read from the clock or added on purpose.

_Rejected:_ refusing every date input. `performance-review` takes a period on purpose, because an operator may name a past one. A pinned list lets such a date stay while a new one fails.

_Rejected:_ fixing the four dates in this change. Each fix is a new revision of its skill, which this gate now holds to a passing smoke run or rehearsal.

## D7 — the smoke run before shipping

The operator's direction, 2026-11-24 07:05Z: "all i mean is to test the code before shiiping .. new skill? then test it with a mock or something .. to make sure it can run all the way .. not simulate the project 100%".

`yarn store:smoke <catalogId>` runs a bundle's rehearsal plan through the same engine, `rehearseInstalledBundle`, with `MockRehearsalClient`. It needs no space, no API key, no network and no broker. Each run executes the skill's own task graph in memory through `runSkillTasks` (`@aflow/cybernetic-runtime`). Decide and derive tasks run as the orchestrator runs them. The fixtures in `rehearsal/smokeFixtures/` answer every integration, harness and agent task. A shared document store keeps each write for the reads after it. A task no fixture answers fails and names itself. An agent task's fixture output must hold the task's `outputContract.schema`, checked by `outputContractViolations` as the orchestrator checks a Runner's output. An output that breaks it fails the task, and the failure names the task and each path it breaks at. A skill whose contract changes therefore fails its smoke until its fixtures follow. A skill the fixtures cannot run is skipped with its reason, and a skip is no pass. The engine's one change: a client may decline a run, and the step records a skip with the client's reason. `storeSmoke.guard.test.ts` smokes every rehearsed bundle with the catalog guards.

**The smoke satisfies the gate.** The go-live rehearsal has no space to run in. The operator creates no rehearsal space, because the 07:05Z direction rules out preparing an environment by hand. The only space with the Alpaca credential is Trading Joe, and a rehearsal there ends the live campaign and archives the ledger. A gate that only a live pass could open would therefore refuse every version from 38 on. The 07:05Z direction names the smoke as the rehearsal it asks for.

`yarn store:smoke <catalogId> --record` adds the result to the bundle's records in `packages/platform-artifacts/src/storeSmokes.json`, through the same `recordRehearsal` as D2. Every record there names `SMOKE_SPACE_ID`, and the rehearsal ledger holds none that does. Each passed step of a smoke record opens with `Mock run, against fixtures.`, and its detail names the mock client, not a space. `rehearsalRefusal` counts a pass from either ledger, of the published version and content hash and the plan's current steps. A smoke pass satisfies the gate. A go-live rehearsal pass satisfies it too, as the optional stronger check. With neither, or with only a failed, skipped or `not_due` record, the refusal names what each ledger holds and the command that satisfies the gate. `storeSmoke.guard.test.ts` runs the smoke afresh in the catalog guards, and a recorded pass of the current content and steps must pass again there. Without `--record` the command records nothing. A child run a skill starts with `workflow.run.start` is answered from a fixture, not run. An operation task's projected output and an agent task's `validatorRefs` and `derivedFrom` pins are not checked, because each needs the run's store, campaign or upstream rows.

_Rejected:_ running the plan on a local stack against `aflow-executor-mock`. It needs Postgres, Redis, a space and a key, which is the cost the operator's direction asked to drop. It would also run the same task graph that `runSkillTasks` runs in memory.

_Rejected:_ leaving the go-live rehearsal as the only end-to-end run. It runs on a live stack, inside an exchange window, now and then. A plan step that cannot run would surface only there, after the version is built.

_Rejected:_ running the smoke inside the store hash script. The script would then gate on a run it starts, not on a record a reviewer reads in the diff. It would also differ from the rehearsal ledger the same script already reads.

_Rejected:_ reading the guard test's output. A test run leaves no artifact in the checkout, so the script would depend on how and where the tests last ran.

_Rejected:_ keeping the live rehearsal as the only pass that counts. No space can host it, so the gate would refuse every version from 38 on.

_Rejected:_ trusting fixture outputs as written. A fixture that breaks its task's contract passes a run the orchestrator would fail, and it keeps passing after the contract changes.

## D8 — the dry run of a skill

The operator's direction, 2026-11-24 22:05Z: "but cant we just make the skill run as a dry run (instructing all the subagents in it to just test? so we can reiterate and test quicker without having to wait an entire day just to find out the skill has a schema mismatch?" And at 22:45Z: "keep this work moving.. and make decisions to override and move fast."

The smoke answers agent tasks from fixtures, so it cannot see a model-side failure. Both failures of 2026-11-24 were model-side: the 14:26Z aggregate veto refusal (#372) and the 21:46Z `draft_patch` operations sent as a JSON string. The go-live rehearsal runs real agents, but it ends the space's campaign. A dry run runs real agents in the live space and changes nothing there.

`workflow.run.start` takes `dryRun: true`. The run row records it (`workflow_runs.dry_run`, migration 241). Every task runs with real agents and real model calls on the live stack. The hold is structural, at two tiers, and no prompt carries it:

- **Platform writes.** `dryRunWriteDisposition` (`@aflow/schemas`) names the operations a dry run holds. Every write-mode or mutating operation is held, except the run's own machinery. Machinery is named one operation at a time, never by prefix, so an operation added under a machinery group is held until it is named. Model turns, the `agent.control` task calls, questions to a person and a session's tool surface run. The `ai.media.*` operations store their output as memory documents and are held. `api.http.download` always saves its response to memory and is held before dispatch, with its `toMemoryPath` named as the target. `agent.control.resume` is held all the same. It resumes any paused session of the tenant by id, and that session carries no `dryRunOf`, so its writes would go live. An operation the registry does not know is held. The orchestrator holds these before dispatch, in `scheduleStep` for a session's tool steps, in `startRun` for a session's start step and in `dispatchClaimedOperationTask` for operation tasks. The hold is a gate on every dispatch path, not one entry point. A session's tool step passes `gateSessionStepInDryRun` when `scheduleStep` first dispatches it and again when a retry or delayed-start timer fires. An operation task passes `holdOperationTaskInDryRun` when it is claimed or retried, and again on each poll cycle its timer dispatches. That timer reads the run's `dry_run` flag, and a run it cannot read sends nothing. No executor job, inline handler or timer runs them. When `scheduleStep` or a timer cannot read the session's state, a write it could hold reads the `dryRunOf` field again. If that read fails too, the step fails as `DRY_RUN_STATE_UNAVAILABLE` and nothing is sent. That failure is not retryable, so no retry timer dispatches the write it refused.
- **Harness runs.** `host.harness.run` runs, so the desk's and the review's harness agents make their real model calls. The harness writes only its private checkout, inside the machine's sandbox. The sandbox denies the home directory's credentials and the machine's loopback, so the harness reaches no platform API. Its diff is returned and never applied, and a push is a separate publication. The browser is the one path no hold reaches, so a harness run that asks for a `browser` is held, and so is one whose input cannot be read. The sandbox does not hold a request the harness sends under the `open` posture to a host that takes no credential. A dry run has the same exposure as a live run there.
- **API writes.** The API executor holds every write tier, after the body resolves and ahead of the approval gate. It composes the tier with `WRITE_HOLD_EVERY_TIER`, the policy the rehearsal sets on the space, so the two hold the same calls. A direct-URL call writes unless its method reads. A call with `response.saveTo` is held whatever its method or tier, because the save writes a memory document, and the held result names that path. The executor reads the session's `dryRunOf` or the run row, and it refuses a write whose state it cannot read.

A held write succeeds with a `DryRunHeldOutput`: the operation, its target, a redacted preview and a message telling the task to carry on. It echoes the write's `path`, so a task that projects the path reads it. The held write puts nothing at that path. A later read of the path reads the live space's memory: an earlier live document, or nothing. A dry run's later tasks therefore reason on state the run did not produce. The step result carries `heldWrite`, and the result consumer records it in `workflow_run_held_writes`. `workflow.run.detail` reports `run.dryRun` and lists each held write with its task. A Runner session carries `dryRunOf` in its create literal, and a session it delegates to inherits it. A run a dry run starts is a dry run too.

Validation runs at full strength. A contract violation fails the task rather than pausing it, at both the Runner and the operation-task check. No one repairs a dry run's output, so the run ends and reports the mismatch. A held write's output is the held result, not the operation's output, so the operation-task check reads it differently. Each projection path the held result lacks projects as null, and the contract schema, which describes the live output, is not applied. A `fromInput` echo still fails when the task's input does not carry it. An output no hold produced gets the full check.

The run leaves the space as it found it. It needs the skill's campaign to be active and refuses `campaignConfig`, so it creates no campaign. It makes no run directory, spends no run budget and takes no concurrency slot. Post-run hooks record the `dry_run` envelope decision and nothing else: no eval, Coach, score, campaign hook or skill projection. Completion links nothing to the plan and wakes no resident. The run records no plan node, so no plan read counts it toward a node's runs, spend or in-flight work. The seams that count runs, read prior runs or take a slot exclude dry runs: `listRunsByInput`, `countProductionRuns`, `getRunStatistics`, `listRecentRuns`, campaign learnings and the campaign score series. `listRecentRuns` serves the skill projection, the ledger reads, the operator-cancel gate, the Coach review request and the campaign-end review. The Coach's breadth review, its validity count and the causal binder's baseline exclude dry runs too. Listings, active-run reads and lookups by id still show it.

_Rejected:_ telling each agent in its prompt that the run is a test. A prompt drifts across models, and the 14:26Z refusal shows a model can misread one. A held write changes nothing whatever the model does.

_Rejected:_ setting the space's write policy for the run's length, as the rehearsal does. A live run of the same space would then park on cards nobody answers. The policy also leaves memory, campaign and learnings writes untouched.

_Rejected:_ pausing on a contract violation, as a live run does. It waits on a `replace_output` that no one sends, and the run then never reports the mismatch.

_Not done:_ the revision snapshot. A dry run of a revision no run has started still writes its snapshot, as any run does. It is a cache of the definition, and it changes no content.

## Phases

### P0 — the gate in the checkout

The schemas, the engine, the HTTP client, the alpaca plan, the publication gate, the fixtures, the estimate, the date check, the smoke run and the dry run of a skill (D8) land together.

_Exit:_ every test **How it is proven** names for D1 to D8 passes. `storeRehearsals.guard.test.ts` passes on the committed snapshot, which publishes alpaca-thesis-trading version 37, below the gate. `yarn store:smoke alpaca-thesis-trading` passes every step and exits 0. With `--record` it records that pass in `storeSmokes.json`. Met in the checkout.

### P1 — the first passing live rehearsal (optional)

The gate does not wait for P1, because a smoke pass satisfies it (D7). P1 is the optional stronger check. `yarn store:rehearse alpaca-thesis-trading --space <id> --folder-binding <id> --update` runs on the live stack, in a rehearsal space with the paper credential and a connected folder. It starts inside the plan's window: a session day, after the close, by 19:00 ET (D6). A start outside it records `not_due` with the next opening.

_Exit:_ `storeRehearsals.json` records `pass` for the version the catalog publishes, with the space's installed content hash and the plan's current `planStepsHash`. Open, and optional.

### P2 — the first held version ships on a smoke pass

A new alpaca-thesis-trading revision, version 38 or later, is the first version the gate holds. `yarn store:smoke alpaca-thesis-trading --record` records its pass, and `regenerate-store-catalog-hashes.ts` re-stamps the snapshot on that record alone. The `resolve-theses` date fix (see **Not done on purpose**) is the expected revision.

_Exit:_ the three items of **Done when** hold in the checkout. `storeCatalogHashes.json` publishes alpaca-thesis-trading at version 38 or later. `storeSmokes.json` records a smoke `pass` of that version, its content hash and the plan's current `planStepsHash`. `storeRehearsals.guard.test.ts` passes on that snapshot with no rehearsal pass of that version. Open. The plan is done when this exit is met.

## How it is proven

- **D1, the probe.** `apiProbe.test.ts` runs `probeRehearsalApi` against a fixture stack that serves only `GET /health` at its root. The probe finds that stack reachable and requests no other path. It names the status and the route on a 404, and the transport error when nothing answers. `editionComposition.test.ts` builds the core application and asserts that its route table holds `GET REHEARSAL_HEALTH_PATH`, so a renamed health route fails that test.
- **D1, the steps.** `rehearseBundle.test.ts` passes a rehearsal whose steps all pass and restores the write policy. It fails a run whose task fails and names the task. It skips a run that skips a required task, and fails a run that pauses on a person or outlives its timeout.
- **D1, the content hash.** `rehearseBundle.test.ts` fails a space that installed other content under the version, before the write policy changes or a run starts. It skips a stack whose catalog publishes other content, and a pass records the installed hash. `httpRehearsalClient.test.ts` reads both hashes from the update preview, and `storeUpdateExecution.test.ts` reports them in the preview.
- **D1, the writes.** `rehearseBundle.test.ts` refuses a write an operation task raised and a write an agent task's session raised. It leaves a browser approval and another run's write open.
- **D1, the parameters.** `rehearseBundle.test.ts` refuses a plan that names a parameter that does not exist, naming it. It skips a step whose parameter the rehearsal was not given.
- **D1, the run id.** `httpRehearsalClient.test.ts` takes the run id from the `workflow.run.start` output, inline, stored or inside a `run_step` envelope. It never reads the slug's run list, so a scheduled run started at the same moment is not taken. An output with no run id, or a run of another slug, does not start.
- **D1, the outcome.** `rehearseBundle.test.ts` ranks a failure over a skip, a skip over `not_due` and `not_due` over a pass. A `not_due` step that names no window is a skip. It refuses a record whose outcome disagrees with its steps.
- **D2.** `storeRehearsals.guard.test.ts` refuses a version with no record, a pass of another version or content, a pass run with other plan steps, a failure, a skip and a `not_due` record. The `not_due` refusal names the window, the next opening and the schedule. It counts a pass of the version, content and steps, also when a later skip, failure or `not_due` record follows it. `recordRehearsal` records a later skip beside a pass, keeps the newest record that is no pass, and keeps one pass per version, content and steps. The guard holds the committed ledger to the committed snapshot.
- **D6, the window.** `rehearseBundle.test.ts` passes a rehearsal started after the close and takes the trading day from the clock. A start inside the session is `not_due` at the window step, names the next opening, and holds no write and starts no run. A step due after midnight is `not_due` against the rehearsal's trading day, and the release still runs. A day with no session names the next session's close. A failed exchange read is a skip. A plan whose step names a window and that names none does not parse. The window rule passes `session_day` before the open, in the session and after the close, and opens `session_closed` at an early close. `httpRehearsalClient.test.ts` reads the clock, then the calendar from the clock's date on. `bundleRehearsalPlans.test.ts` holds the plan's source to reads the bundle runs, and every step's window to the plan's start window.
- **D3.** `alpacaProductionSize.test.ts` offloads the 30-member read and projects both reads through their `dataRef`. It computes the regime of all 30 members and passes the universe check.
- **D4.** `outputBudget.test.ts` flags the copier at 30 members and not at three. It is an error only where no model the space may assign has the budget, or on a pinned model. `alpacaProductionSize.test.ts` finds no agent task of the bundle over every model's budget.
- **D5.** `deterministicInputs.test.ts` flags a required date input and an unpinned agent date a later task reads. `clockValueSources.test.ts` fails on a fifth date.
- **D7, the gate.** `storeRehearsals.guard.test.ts` accepts a re-stamp with a passing smoke record and no rehearsal record, and one with a passing rehearsal record and no smoke record. It refuses one with neither, and one whose smoke record failed or was skipped. It refuses a smoke pass of other content or other plan steps. Each refusal names what satisfies the gate. It holds the smoke ledger to `SMOKE_SPACE_ID` and the committed ledgers to the committed snapshot. `storeSmoke.guard.test.ts` passes again wherever `storeSmokes.json` records a pass of the current content and steps.
- **D7.** `storeSmoke.guard.test.ts` runs alpaca-thesis-trading's plan end to end against mocks and passes every step. `mockRehearsalClient.test.ts` opens each passed step's detail with `Mock run, against fixtures.` and names no space in it. It fails a step whose task fails and names the task. It fails a step whose agent-task fixture breaks the task's `outputContract.schema`, naming the task and each path. It skips a step whose skill the fixtures cannot run, or have no answers for, and the smoke then does not pass. It reaches no network.
- **D8, the hold.** `dryRun.test.ts` (`@aflow/schemas`) holds every write a trading cycle can ask for and runs reads, model turns and control calls. It holds `agent.control.resume` and an unknown operation. `dailyTradingCycleDryRun.test.ts` reads the shipped cycle and holds the order, its cancel, every ledger write and the learnings, while every read runs. The orchestrator's `dryRunHold.test.ts` holds a memory write, a campaign end and the learnings at dispatch, with the held result and no job, inline handler or timer. The API executor's `dryRunHold.test.ts` and `dryRunHandler.test.ts` hold a broker order with the held result, reach no network and no approval gate, and send it for a live session. A write whose dry-run state cannot be read is refused.
- **D8, the memory-writing holds.** `dryRun.test.ts` (`@aflow/schemas`) holds every `ai.media.*` operation the registry lists, and `api.http.download`. It runs the registry's `ai` model calls, and it holds an unregistered operation under `ai.media` or `agent.control`. Every operation it runs is named machinery. The orchestrator's `dryRunHold.test.ts` names a held download by its `toMemoryPath`. The API executor's `dryRunHold.test.ts` holds a read with `response.saveTo` and names the memory path in the held result. It passes a live session's saving read on. Its `dryRunHandler.test.ts` holds an `api.http.call` with `response.saveTo` and writes no memory document. It holds an `api.http.download` that reaches the executor, and sends the saving read for a live session.
- **D8, the production seams.** `productionRunCounts.test.ts` holds `getRunStatistics`, `countProductionRuns` and `listRecentRuns` to `dry_run = false` and `eval_batch_id IS NULL`, in one campaign too. `workflowRunStart.dryRun.test.ts` records a dry run started from a dry run's task with no plan node, and a live run's child with its parent's node.
- **D8, the session.** `dryRunSessionPropagation.test.ts` runs `spawnRunnerSession`, `startRun` and `scheduleStep` against one Redis. The queued session hash carries `dryRunOf`, and so does the hash `startRun` writes after its DEL. The session holds its start step's write and a later write, with no job dispatched. A live run's session carries no `dryRunOf` and dispatches both writes. Dropping the field at either write fails the test.
- **D8, the contract.** `dryRunContract.test.ts` checks execute-orders against the shipped contract in a dry run. `orderResults` sent as a JSON string fails the task with `OUTPUT_CONTRACT_VIOLATION`, and a well-formed output succeeds. `opTaskOutputContract.test.ts` completes a held write's task with each missing path as null. It still fails a missing `fromInput` echo, and an output no hold produced that breaks the schema.
- **D8, the harness.** `dryRun.test.ts` (`@aflow/schemas`) runs `host.harness.run` and holds one asking for a browser or with an unreadable input. `dailyTradingCycleDryRun.test.ts` runs every harness task of the strategy desk and the performance review. The orchestrator's `dryRunHold.test.ts` enqueues a harness task in a dry run and holds one asking for a browser.
- **D8, the unread session.** `dryRunStateUnread.test.ts` fails a write with `DRY_RUN_STATE_UNAVAILABLE`, not retryable, when no session state can be read. It holds the write when the `dryRunOf` field names a dry run and dispatches it when the field is empty. A read dispatches without the second read.
- **D8, the timers.** `dryRunTimerHold.test.ts` fires a session's retry and delayed-start timers for a dry run's write. Each holds the write with no job. An unread session fails the write as `DRY_RUN_STATE_UNAVAILABLE`, not retryable, and a live session dispatches it. A poll-cycle timer of a dry run's operation task holds the write. A run it cannot read sends nothing, and a live run dispatches the write.
- **D8, the start.** `workflowRunStart.dryRun.test.ts` records a dry run in the active campaign with no run directory. It refuses `campaignConfig`, skips the concurrency gate, and starts a dry run from a dry run's session or task.
- **On the live stack.** P1's exit, when it is met, is recorded here with its date. The plan does not wait for it.
