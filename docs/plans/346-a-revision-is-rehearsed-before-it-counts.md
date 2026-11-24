# Plan 346 — A revision is rehearsed before it counts

**Status:** P0 built. The gate, the alpaca-thesis-trading plan, the production-size fixtures, the output-budget estimate and the date check are in. The first rehearsal of alpaca-thesis-trading version 37 is on record as `skipped`: it ran in a sandbox that refuses loopback connections, with no API key and no space. Its exit is open (see **Done when**).

**Builds on:** Plan 190 (skill validity), Plan 253 (the write policy), Plan 345 (Store updates without a click), Plan 333 (D2's writing rules).

**Leaves alone:** the review loops, the skill validity verdict's existing dimensions, the eval plane, the Store's install and update paths.

## The rule

The operator's direction, 2026-11-23 22:50Z: "let's ensure a rehearsal is part of building skills, agents, integrations or anything really here.. make this a track of work that things can be tested before being released.. MUST REHEARSE -- REMOVE BUREAUCRACY and focus on getting things done."

## Decision card

**What changes**

- Today: review, skill validity, schemas and unit tests certify a bundle's artifact. None runs the installed bundle in a real space at real data sizes.
- After: a rehearsed bundle's new version counts as done only on a passing go-live rehearsal of that version and content hash. The rehearsal runs the installed bundle in its space, and its record is what the publication reads.

**Why**

- Six Trading Joe defects passed every gate and failed only in a real run: PRs #359, #360, #361, #362 and two in #365.
- Two of them, the offloaded read (#361) and the output budget (#362), appear only at a 30-member universe. Every fixture held three members.
- One of them, the model-supplied trading day (#365), is a class a graph check can see before any run.

**What it affects**

- `@aflow/schemas`: `store/rehearsal.ts`, with the plan, the step results, the outcome rule `deriveRehearsalOutcome` and the ledger.
- `@aflow/platform-artifacts`: `rehearsal/` (the engine, the HTTP client, the alpaca plan and the publication gate), `storeRehearsals.json`, and the production-size fixtures in `__tests__/productionSize.ts`.
- `@aflow/cybernetic-runtime`: two always-on advisories in skill validity, `output_budget_exceeded` (an error where no model can hold the output) and `clock_value_from_caller` with `clock_value_from_model`.
- `scripts/rehearse-bundle.ts` (`yarn store:rehearse`), and `scripts/regenerate-store-catalog-hashes.ts`, which now reads the ledger.
- `vitest.config.ts`: Node tests resolve `@aflow/*` to source in Vite's SSR environment too. Before, a checkout without built `dist` could not run them, and a built one ran `dist`.

**Risks**

- A rehearsal's campaign start archives the space's thesis ledger. Mitigation: rehearse in a space kept for rehearsals. A start is refused while another campaign of a ledger-keeping skill is active.
- A cycle could place a paper order. Mitigation: the rehearsal sets the space's write policy to hold every tier, and it refuses each held write. The release step restores the policy.
- The output-budget estimate is a typical token cost, not a tokenizer's. Mitigation: it is advisory where some recommended model can hold the output. It is an error only where none can, or on a pinned model.

**Open questions**

- Should a followed Store update (Plan 345 B) refuse a rehearsed bundle's version without a pass? Recommended: no. The snapshot cannot be re-stamped without one, so no such version is published.

**Not done on purpose**

- The rehearsal does not run `performance-review` or `campaign-successor`. Each needs a closed week or a campaign boundary. The plan names both in `uncovered`, and every result lists them.
- No version below a plan's `gateFromVersion` is held. Alpaca-thesis-trading version 37 was published before the gate. Version 38 is the first it holds.
- The Daily Trading Cycle's `resolve-theses` still writes `tradingDay` itself. The date check flags it, and the fix is a new revision, which this gate now holds to a passing rehearsal.

**Done when**

- A rehearsal of alpaca-thesis-trading on the live stack, in a rehearsal space with the paper credential and a connected folder, records `pass` for the version the catalog publishes.

## D1 — the rehearsal runs the installed bundle

`rehearseInstalledBundle` takes a plan, the catalog's version and content hash, a space and a `RehearsalClient`. It runs these steps, each with an outcome and a detail:

1. `install`: the space holds the published version, uncustomized. `--update` applies the Store update first, so a Store update and its rehearsal are one command.
2. `hold-writes`: every write tier waits for approval. The rehearsal refuses each held write while a run is under way and counts it on the step.
3. The plan's steps: `campaign_start`, then one `run` per slot or skill. A run starts through `workflow.run.start` with `catalogId`, so it runs the skill exactly as the Store installed it.
4. `release`: the write policy is restored, and the campaigns the rehearsal started end.

A run step passes only when the run completes, no task fails outside `toleratedFailures`, and every `requiredTasks` entry succeeded. A run that skips a required task is `skipped`, never passed. A pause no held write explains fails the step, because a bundle that goes live without a person must not pause.

The outcome has one rule. A failed step fails the rehearsal and names it. A skipped step, or no step at all, skips it with the reason. Only steps that all passed give a pass. The result schema refuses a record whose outcome disagrees with its steps.

_Rejected:_ rehearsing against repository fixtures. They are the artifact the other gates already certify.

_Rejected:_ simulating the order binding. The write policy already stops every write at the platform's own gate, with no second fulfilment to maintain.

## D2 — the record is where the publication reads

`yarn store:rehearse <catalogId> --space <id>` writes the result to `packages/platform-artifacts/src/storeRehearsals.json`. Two readers hold a version to it through `rehearsalRefusal`:

- `regenerate-store-catalog-hashes.ts` refuses to re-stamp a rehearsed bundle at a new version without a passing record of that version and hash.
- `storeRehearsals.guard.test.ts` fails when the committed snapshot publishes such a version. It runs in `yarn verify`, the check a publication runs.

## D3 — production-size fixtures

`__tests__/productionSize.ts` builds Alpaca's full bar shape for a 30-member universe over the regime's 100-day lookback. That read is above the 64 KB inline limit, so the fixture offloads it behind a `dataRef`, as the API executor does. `alpacaProductionSize.test.ts` projects both reads through `loadProjectionSource`, computes the regime of all 30 members, and runs the universe check. It also asks the budget estimate about every agent task of the bundle at the campaign's ceiling.

## D4 — the output-budget estimate

`estimatePinnedOutputTokens` reads an agent task's pinned output schema. An array whose count a `count:` binding ties to an input counts at that input's declared `maxItems`, a campaign field's or an upstream contract's. `outputBudgetDiagnostics` compares the estimate with each recommended agent model's `maxOutputTokens` from the catalog, or with the task's pinned model. The gather-regime agent of version 11 estimates over Claude Haiku 4.5's 8192 tokens at 30 members and under it at three.

## D5 — dates a clock gives

`deterministicInputDiagnostics` flags a required run input whose schema is a date, and an agent's unpinned date output that a later task reads. Today it flags four: `daily-trading-cycle` `resolve-theses.tradingDay`, `strategy-desk` `tradingDay`, and `performance-review` `periodStart` and `periodEnd`. `clockValueSources.test.ts` pins that list, so a new one fails until it is read from the clock or added on purpose.
