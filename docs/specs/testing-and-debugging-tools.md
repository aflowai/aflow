# Spec: Testing & Debugging Tools Improvements

**Status**: Implemented
**Priority**: Medium
**Effort**: 2-3 days
**Related**: `docs/dev/debugging-runs.md`, `scripts/test-flows.sh`, `apps/aflow-orchestrator/src/services/ResultConsumer.ts`

---

## Context

We recently implemented two scalability improvements:

1. **Keyed-concurrency ResultConsumer** — results for different runs process in parallel, but results for the same run are serialised to preserve ordering and single-writer semantics.
2. **Transaction consolidation** for memory handlers — `put`/`patch` operations run all DB writes in a single Postgres transaction instead of 5 separate ones.

Testing these changes revealed gaps in the debugging tools and test coverage. This spec defines improvements that make it easier to verify correctness and catch regressions.

---

## 1. Unit Tests

### 1a. ResultConsumer keyed concurrency (HIGH PRIORITY)

**File**: `apps/aflow-orchestrator/src/services/__tests__/ResultConsumer.test.ts`

The `ResultConsumer` is the first place results enter the orchestrator. Its keyed concurrency model must be rock-solid.

**Test cases**:

| #   | Test                           | What it verifies                                                                                                                           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Serial ordering within a run   | Submit results A1, A2, A3 for run "A". Assert `applyResult` is called in order: A1 before A2, A2 before A3.                                |
| 2   | Parallel across runs           | Submit A1 for run "A" and B1 for run "B" where `applyResult` has a 100ms delay. Assert wall clock < 200ms (they ran concurrently).         |
| 3   | Backpressure                   | Set `maxConcurrent=3`, submit 6 results. Assert no more than 3 `applyResult` calls are in-flight simultaneously (use a semaphore counter). |
| 4   | Error isolation                | Result A1 throws. Assert A2 for the same run still executes. Assert B1 for a different run is not affected.                                |
| 5   | Graceful drain on stop()       | Submit 3 results, immediately call `stop()`. Assert all 3 `applyResult` calls complete (not interrupted).                                  |
| 6   | Chain cleanup (no memory leak) | Submit results for 100 distinct runIds. After all complete, assert `runChains` map is empty.                                               |

**Mock strategy** — no Redis or DB needed:

- `readStepResults`: return canned results, then return `[]` (idle), then throw on `stopRequested`
- `ackStepResult`: no-op (or count calls)
- `executionService.applyResult`: controllable delay + optional throw

**Implementation hint**: inject a fake `readStepResults` that pulls from a `Promise`-based queue so tests can precisely control what the consumer reads and when.

### 1b. MemoryDocRepository `withTransaction` (MEDIUM PRIORITY)

**File**: `packages/database/src/repositories/memoryDocRevival.pg.test.ts`

These need a real Postgres connection (or a Drizzle mock). Mark as integration tests.

| #   | Test                                | What it verifies                                                                                                        |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Single transaction for put + chunks | Call `repo.withTransaction(txRepo => { txRepo.put(); txRepo.insertChunks(); })`. Assert only one `BEGIN`/`COMMIT` pair. |
| 2   | Nested withTransaction is a no-op   | Inside `withTransaction`, calling `withTransaction` again reuses the same tx.                                           |
| 3   | Rollback on error                   | If the callback throws, none of the writes persist.                                                                     |

### 1c. `prepareChunksAndEmbedJob` (MEDIUM PRIORITY)

**File**: `apps/aflow-executor-memory/src/handlers/__tests__/memoryHandler.test.ts`

| #   | Test                                | What it verifies                                                                                               |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Returns job with correct fields     | Given a doc with indexing=auto, returns `MemoryDocEmbedJob` with correct tenantId, docId, embeddingModel, etc. |
| 2   | Returns null when indexing disabled | Given a doc with `indexingMode='disabled'`, returns null.                                                      |
| 3   | Returns null when no content        | Given a doc with no inline content and no payloadRef, returns null.                                            |
| 4   | Redis publish NOT called            | The function returns data only — assert no Redis interaction.                                                  |

---

## 2. Integration Test Flows

### 2a. Add memory tests to `test-flows.sh`

Add two test cases to the existing test runner:

```bash
test_memory_put_get() {
  run_and_wait "Memory: put then get" \
    "$(cat scripts/test-flows/memory-put-get.json)" 10
  # Assert: status=SUCCEEDED
}

test_memory_full_cycle() {
  run_and_wait "Memory: full cycle (put→list→grep→get)" \
    "$(cat scripts/test-flows/memory-full-cycle.json)" 15
  # Assert: status=SUCCEEDED, <3s total
}
```

Register them in the `case` block at the bottom of the script.

### 2b. Add concurrent-runs integration test

New test case in `test-flows.sh` or a separate script:

```bash
test_concurrent_memory() {
  # Start 5 memory-put-get runs simultaneously
  # Wait for all to complete
  # Assert: all SUCCEEDED, max wall time < 5s
  # This exercises: keyed-concurrency ResultConsumer,
  # transaction consolidation, DB pool pressure
}
```

---

## 3. Debugging Tool Improvements

### 3a. Step-level timing in `tail-run-events.ts`

**Current**: shows timestamps and event types
**Desired**: add `--timing` flag that computes per-step latency

Example output with `--timing`:

```
[10:43:37.337] StepScheduled  step=put-poem   memory.put
[10:43:37.379] StepStarted    step=put-poem   memory.put     +42ms (queue wait)
[10:43:37.542] StepSucceeded  step=put-poem   memory.put     +163ms (execution)  total=205ms
[10:43:37.553] StepScheduled  step=put-note   memory.put     +11ms (orchestrator)
...
── Summary ──
Steps: 6 succeeded, 0 failed
Total wall: 784ms
Slowest step: put-poem (205ms)
Fastest step: get-doc (87ms)
Orchestrator overhead: 48ms (avg 8ms between steps)
```

Implementation: track `Map<stepId, { scheduledAt, startedAt, succeededAt }>`, compute deltas, print summary.

### 3b. Parallel run launcher in `run-flow.ts`

Add `--parallel N` flag:

```bash
npx tsx scripts/run-flow.ts \
  --flow-config scripts/test-flows/memory-put-get.json \
  --parallel 5 --wait
```

Output:

```
Starting 5 parallel runs...
  run 487ca14... SUCCEEDED  320ms
  run 660ea7b... SUCCEEDED  290ms
  run 32e688a... SUCCEEDED  305ms
  run 42f688a... SUCCEEDED  310ms
  run e2fc8df... SUCCEEDED  340ms

Summary: 5/5 succeeded, avg=313ms, max=340ms, overlap=95%
```

Implementation: `Promise.all` over N `startRun()` calls, then poll all in parallel with `Promise.allSettled`.

### 3c. Debug view event enrichment

The `/v1/runs/:runId/debug` endpoint returns events where `stepId` is nested inside `data`, which makes it harder for agents and scripts to parse. Consider:

- Add `stepId` at the event root level (alongside `eventType`) for convenience
- Or add a `flattenedEvents` key that denormalises the common fields

### 3d. Performance regression test script

New script: `scripts/perf-check.ts`

```bash
npx tsx scripts/perf-check.ts --flow-config scripts/test-flows/memory-put-get.json \
  --runs 10 --max-p95 500
```

Runs a flow N times, computes p50/p95/p99 latency, fails if p95 > threshold. Useful in CI for catching performance regressions early.

---

## 4. Acceptance Criteria

- [x] ResultConsumer unit tests pass with `yarn test` (6 tests)
- [x] MemoryHandler unit tests pass with `yarn test` (6 tests)
- [x] `test-flows.sh memory` added (put-get + full-cycle)
- [x] `test-flows.sh memory-concurrent` added (5 parallel runs)
- [x] `tail-run-events.ts --timing` shows per-step latency summary
- [x] `run-flow.ts --parallel 5 --wait` works for concurrent runs
- [x] `perf-check.ts` performance regression script created
- [x] No new lint errors introduced
- [x] `scripts/README.md` updated with new test flow descriptions

---

## Files to Change

| File                                                                      | Change                             |
| ------------------------------------------------------------------------- | ---------------------------------- |
| `apps/aflow-orchestrator/src/services/__tests__/ResultConsumer.test.ts`   | New: unit tests                    |
| `packages/database/src/repositories/memoryDocRevival.pg.test.ts`          | New: integration tests             |
| `apps/aflow-executor-memory/src/handlers/__tests__/memoryHandler.test.ts` | New: unit tests                    |
| `scripts/test-flows.sh`                                                   | Add memory + concurrent test cases |
| `scripts/test-flows/memory-full-cycle.json`                               | Already exists                     |
| `scripts/tail-run-events.ts`                                              | Add `--timing` flag + summary      |
| `scripts/run-flow.ts`                                                     | Add `--parallel` flag              |
| `scripts/perf-check.ts`                                                   | New: performance regression script |
| `scripts/README.md`                                                       | Document new flows/scripts         |
