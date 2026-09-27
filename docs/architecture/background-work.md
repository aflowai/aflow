<!-- GENERATED FILE — edit packages/schemas/src/background/registry.ts and run `yarn background-work:docs`. -->

# Background work catalog

Every stateful background task in production, generated from the checked registry in
`packages/schemas/src/background/registry.ts`.

Production background discovery must be event- or candidate-driven. A task may not find its
work by scanning the Redis keyspace, reading a whole dirty set, or enumerating tenant schemas;
idle cost may not grow with logical shards, tenants, stored keys, or connected subscribers.

**44 registered tasks** across 8 services.
2 task(s) still carry a residual poll — a periodic datastore read that
exists only because an event or candidate path is incomplete.

## Declared idle budget

Datastore operations per minute with zero due work, grouped by what each scope multiplies by.

| Execution scope | Multiplies by | Operations/minute |
| --------------- | ------------- | ----------------: |
| per_instance | per live process | 415 |
| singleton | once per fleet | 20 |
| shard_owner | per shard-owning orchestrator | 626 |
| active_subscription | per active subscription | 120 |

## Summary

| Task | Service | Criticality | Trigger | Scope | Cadence | Idle ops/min | Disable |
| ---- | ------- | ----------- | ------- | ----- | ------- | -----------: | ------- |
| `executor.compute.session_reaper` | executor-compute | feature | active-resource | per_instance | 1m | 0 | safe |
| `executor.heartbeat` | shared-runtime | correctness | heartbeat | per_instance | 10s | 6 | never |
| `executor.job_consumer` | shared-runtime | correctness | blocking | per_instance | event-driven | 60 | never |
| `executor.mcp.connection_pool_reaper` | executor-mcp | feature | active-resource | per_instance | 30s | 0 | safe |
| `executor.mcp.elicitation_lease_heartbeat` | executor-mcp | feature | active-resource | per_instance | 10s | 0 | safe |
| `executor.memory.doc_embed_consumer` | executor-memory | feature | blocking | per_instance | event-driven | 60 | safe |
| `executor.memory.embed_backfill` | executor-memory | feature | candidate | per_instance | 30s | 2 | safe |
| `executor.memory.embed_consumer` | executor-memory | feature | blocking | per_instance | event-driven | 60 | safe |
| `executor.oauth.consent_state_reaper` | executor-mcp | feature | candidate | per_instance | 5m | 0.2 | safe |
| `executor.step_inflight_refresh` | shared-runtime | correctness | active-resource | per_instance | 10s | 0 | never |
| `host.runtime_inventory` | executor-host | feature | heartbeat | per_instance | 1m | 2 | safe |
| `mcp-server.session_store_cleanup` | mcp-server | operational | active-resource | per_instance | 5m | 0 | safe |
| `orchestrator.active_run_reconcile` | orchestrator | operational | audit | per_instance | event-driven | 0 | safe |
| `orchestrator.barrier_watchdog` | orchestrator | correctness | candidate | shard_owner | 30s | 2 | never |
| `orchestrator.completion_schedule_recorder` | orchestrator | correctness | candidate | singleton | 3s | 0 | breakglass |
| `orchestrator.control_consumer` | orchestrator | correctness | blocking | shard_owner | event-driven | 120 | never |
| `orchestrator.delegation_pending` | orchestrator | correctness | candidate | shard_owner | 30s | 2 | never |
| `orchestrator.delegation_supervision` | orchestrator | correctness | candidate | shard_owner | 30s | 2 | never |
| `orchestrator.eval_batch_engine` | orchestrator | correctness | candidate | per_instance | 10s | 6 | breakglass |
| `orchestrator.instance_heartbeat` | orchestrator | correctness | heartbeat | per_instance | 10s | 6 | never |
| `orchestrator.mcp_elicitation_reconcile` | orchestrator | feature | candidate | per_instance | 30s | 2 | safe |
| `orchestrator.mcp_elicitation_router` | orchestrator | feature | event | per_instance | event-driven | 0 | safe |
| `orchestrator.orphan_recovery` | orchestrator | correctness | audit | per_instance | event-driven | 0 | never |
| `orchestrator.pending_recovery` | orchestrator | correctness | candidate | shard_owner | 30s | 258 | never |
| `orchestrator.projection` | orchestrator | correctness | candidate | singleton | 3s | 20 | breakglass |
| `orchestrator.result_consumer` | orchestrator | correctness | blocking | shard_owner | event-driven | 120 | never |
| `orchestrator.schedule_dispatch` | orchestrator | feature | candidate | per_instance | 15s | 4 | safe |
| `orchestrator.schedule_evaluator` | orchestrator | feature | candidate | per_instance | 15s | 4 | safe |
| `orchestrator.session_metadata` | orchestrator | feature | candidate | per_instance | 5s | 12 | safe |
| `orchestrator.shard_acquisition` | orchestrator | correctness | candidate | per_instance | 30s | 0 | never |
| `orchestrator.step_stall_watchdog` | orchestrator | correctness | candidate | shard_owner | 30s | 2 | never |
| `orchestrator.stream_retention` | orchestrator | operational | candidate | per_instance | 1m | 1 | safe |
| `orchestrator.timer_dispatch` | orchestrator | correctness | candidate | shard_owner | 1s | 120 | never |
| `orchestrator.workflow_harness_advance` | orchestrator | correctness | blocking | per_instance | event-driven | 60 | never |
| `orchestrator.workflow_progress` | orchestrator | feature | blocking | per_instance | event-driven | 120 | safe |
| `orchestrator.workflow_run_reconcile` | orchestrator | correctness | candidate | per_instance | 10s | 6 | never |
| `server.a2a_task_stream` | server | feature | event | active_subscription | event-driven | 60 | safe |
| `server.agui_run_stream` | server | feature | event | active_subscription | event-driven | 60 | safe |
| `server.audit_flush` | server | operational | active-resource | per_instance | 1s | 0 | safe |
| `server.run_watchdog` | server | operational | candidate | per_instance | 15s | 4 | safe |
| `server.session_tail` | server | feature | event | active_subscription | event-driven | 0 | safe |
| `server.space_action_center` | server | feature | event | active_subscription | event-driven | 0 | safe |
| `server.space_coach_surface` | server | feature | event | active_subscription | event-driven | 0 | safe |
| `server.space_entity_events` | server | feature | event | active_subscription | event-driven | 0 | safe |

## Tasks

### `executor.compute.session_reaper`

**Purpose.** Tear down sandbox containers whose session expired.

**Invariant.** An expired sandbox does not keep host resources.

**Recovery.** Executor restart releases every container it owned.

| Field | Value |
| ----- | ----- |
| Service | executor-compute |
| Owner domain | compute |
| Criticality | feature |
| Trigger | active-resource |
| Execution scope | per_instance |
| Substrate | local |
| Base cadence | 1m |
| Max batch | 100 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Traverses an in-memory map of locally owned sessions. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-executor-compute/src/handlers/sessionManager.ts` |

> Per instance because the resource is per instance: the sessions are containers this process started, and no other process can tear them down. On the standard runner, so a teardown that outruns the cadence cannot have the next cycle started on top of it.

### `executor.heartbeat`

**Purpose.** Publish executor availability per step type.

**Invariant.** A step type with a live executor is dispatchable; one without is rejected early.

**Recovery.** TTL expiry is the death signal.

| Field | Value |
| ----- | ----- |
| Service | shared-runtime |
| Owner domain | ownership |
| Criticality | correctness |
| Trigger | heartbeat |
| Execution scope | per_instance |
| Substrate | redis-lease |
| Base cadence | 10s |
| Max batch | 1 |
| Max cycle | 5000 ms |
| Idle datastore ops/min | 6 |
| Hot-path producer budget | 0 added RTT — The availability index is maintained in the same heartbeat pipeline. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `packages/executor-runtime/src/executor/ExecutorRuntime.ts`<br>`packages/redis/src/streams/executorHeartbeat.ts` |

> The heartbeat write itself is one command per process, but availability lookups discover heartbeats with KEYS, which blocks Redis for the traversal.

### `executor.job_consumer`

**Purpose.** Pull step jobs for this executor's step type off its Redis stream.

**Invariant.** Every dispatched job is executed once per attempt or stays pending for the next consumer.

**Recovery.** Unacked entries stay in the PEL and are reclaimed by the next consumer.

| Field | Value |
| ----- | ----- |
| Service | shared-runtime |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | blocking |
| Execution scope | per_instance |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 10 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 60 |
| Hot-path producer budget | 0 added RTT — The orchestrator XADDs the job it already produces. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `packages/redis/src/streams/jobs.ts` |

### `executor.mcp.connection_pool_reaper`

**Purpose.** Evict idle MCP client connections held by this process.

**Invariant.** An idle upstream connection is closed rather than leaked.

**Recovery.** Process exit closes every pooled connection.

| Field | Value |
| ----- | ----- |
| Service | executor-mcp |
| Owner domain | mcp |
| Criticality | feature |
| Trigger | active-resource |
| Execution scope | per_instance |
| Substrate | local |
| Base cadence | 30s |
| Max batch | 100 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Traverses an in-memory pool. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-executor-mcp/src/handlers/connectionPool.ts` |

> Per instance because the resource is per instance: the pool holds transports this process opened. On the standard runner, so a slow upstream close cannot have the next sweep started on top of it.

### `executor.mcp.elicitation_lease_heartbeat`

**Purpose.** Hold the elicitation lease while this process waits on a human answer.

**Invariant.** A live elicitation holder is not reconciled away as dead.

**Recovery.** Lease expiry hands the elicitation to the reconciler.

| Field | Value |
| ----- | ----- |
| Service | executor-mcp |
| Owner domain | mcp |
| Criticality | feature |
| Trigger | active-resource |
| Execution scope | per_instance |
| Substrate | redis-lease |
| Base cadence | 10s |
| Max batch | 1 |
| Max cycle | 5000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Scoped to one suspended elicitation; no timer exists at idle. |
| Feature gate | MCP_ELICITATION_ENABLED |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-executor-mcp/src/handlers/elicitationSuspend.ts` |

### `executor.memory.doc_embed_consumer`

**Purpose.** Consume memory document embedding jobs and write their vectors.

**Invariant.** A queued document embedding job is embedded once or stays pending.

**Recovery.** Unacked entries stay in the PEL; the backfill pass catches anything never enqueued.

| Field | Value |
| ----- | ----- |
| Service | executor-memory |
| Owner domain | memory |
| Criticality | feature |
| Trigger | blocking |
| Execution scope | per_instance |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 10 |
| Max cycle | 120000 ms |
| Idle datastore ops/min | 60 |
| Hot-path producer budget | 0 added RTT — Producers XADD the job they already produce. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/redis/src/memoryDocEmbed.ts` |

### `executor.memory.embed_backfill`

**Purpose.** Re-embed memory documents whose embed job was lost or never enqueued.

**Invariant.** A document marked pending is eventually embedded.

**Recovery.** Pending status is durable and the pointer is recomputed from it; a claim whose holder dies is re-claimable at lease expiry.

| Field | Value |
| ----- | ----- |
| Service | executor-memory |
| Owner domain | memory |
| Criticality | feature |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | postgres-due |
| Base cadence | 30s |
| Max batch | 100 |
| Max cycle | 120000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — A row trigger arms the due pointer inside the document write. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-executor-memory/src/embedder.ts`<br>`packages/database/src/tenant/duePointers.ts` |

> Two indexed empty reads per minute per replica at idle. The contended resource is the tenant pointer row: every write to a pending document takes it, so all of a tenant's memory writes serialise on that one row for the duration of the trigger. A pending document stays pending until its embedding lands, so a tenant with a backlog is re-claimed each cadence and its jobs re-published — the stream consumer, not the pointer, is what makes that idempotent.

### `executor.memory.embed_consumer`

**Purpose.** Consume memory embedding jobs and write their vectors.

**Invariant.** A queued embedding job is embedded once or stays pending for the next consumer.

**Recovery.** Unacked entries stay in the PEL; the backfill pass catches anything never enqueued.

| Field | Value |
| ----- | ----- |
| Service | executor-memory |
| Owner domain | memory |
| Criticality | feature |
| Trigger | blocking |
| Execution scope | per_instance |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 10 |
| Max cycle | 120000 ms |
| Idle datastore ops/min | 60 |
| Hot-path producer budget | 0 added RTT — Producers XADD the job they already produce. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/redis/src/memoryEmbed.ts` |

### `executor.oauth.consent_state_reaper`

**Purpose.** Delete OAuth consent-state rows past their expiry.

**Invariant.** Expired consent state does not accumulate indefinitely.

**Recovery.** Expiry times are durable and the pointer is recomputed from them; a claim whose holder dies is re-claimable at lease expiry.

| Field | Value |
| ----- | ----- |
| Service | executor-mcp |
| Owner domain | integrations |
| Criticality | feature |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | postgres-due |
| Base cadence | 5m |
| Max batch | 500 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 0.2 |
| Hot-path producer budget | 0 added RTT — A row trigger arms the due pointer inside the consent-state insert. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-executor-mcp/src/oauthConsentStateReaper.ts`<br>`packages/database/src/tenant/duePointers.ts`<br>`packages/database/src/repositories/tenantDue.ts` |

> The consent-state table is cross-kind — API connector and MCP server consents are the same rows — so this reaps for the whole integration surface and is only hosted in the MCP executor. One indexed empty read per cadence per replica is the whole idle cost; a consent row exists only between the start and the end of one consent flow, so the steady state has no due tenants at all.

### `executor.step_inflight_refresh`

**Purpose.** Refresh the in-flight key for the step attempt this process is running.

**Invariant.** A live step attempt is never reaped as stalled by the orchestrator watchdog.

**Recovery.** Key TTL expiry surrenders the step to the stall watchdog.

| Field | Value |
| ----- | ----- |
| Service | shared-runtime |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | active-resource |
| Execution scope | per_instance |
| Substrate | redis-lease |
| Base cadence | 10s |
| Max batch | 1 |
| Max cycle | 5000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Scoped to one active step attempt; no timer exists at idle. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `packages/executor-runtime/src/executor/processJob.ts` |

### `host.runtime_inventory`

**Purpose.** Publish what the operator's machine has installed, so a workspace can say whether it can run something.

**Invariant.** An inventory exists only while the executor that observed it runs: written with a lifetime twice its refresh, and renewed by nothing else.

**Recovery.** The key expires on its own, so a stopped executor stops being described within two cycles; a restarted one republishes on start.

| Field | Value |
| ----- | ----- |
| Service | executor-host |
| Owner domain | ownership |
| Criticality | feature |
| Trigger | heartbeat |
| Execution scope | per_instance |
| Substrate | local |
| Base cadence | 1m |
| Max batch | 1 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — No producer coupling — nothing arms this. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-executor-host/src/index.ts`<br>`apps/aflow-executor-host/src/runtimes.ts` |

> Observed rather than declared, because a declared list drifts the first time something is installed. The probe runs a handful of version calls with a short timeout, so a hung binary costs one cycle rather than the process. One SETEX and one ZADD per machine per minute, independent of bindings, jobs or workspaces — the scored set is what keeps listing machines proportional to the live ones rather than to every executor that ever started.

### `mcp-server.session_store_cleanup`

**Purpose.** Expire in-memory MCP auth sessions past their TTL.

**Invariant.** An expired auth session cannot be reused.

**Recovery.** Process restart clears the store.

| Field | Value |
| ----- | ----- |
| Service | mcp-server |
| Owner domain | mcp |
| Criticality | operational |
| Trigger | active-resource |
| Execution scope | per_instance |
| Substrate | local |
| Base cadence | 5m |
| Max batch | 1000 |
| Max cycle | 5000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Traverses an in-memory map. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-mcp/src/auth/SessionStore.ts` |

### `orchestrator.active_run_reconcile`

**Purpose.** Release active-run membership for runs whose session state is gone.

**Invariant.** The admission count reflects runs that still exist.

**Recovery.** Runs at boot; a missed pass only leaves the count conservative until the next one.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | operational |
| Trigger | audit |
| Execution scope | per_instance |
| Substrate | redis-zset |
| Base cadence | event-driven |
| Max batch | 5000 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Membership is written by the transitions themselves. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/redis/src/shard.ts` |

> A process killed between a run's terminal write and its release leaves that run counted forever, and admission control turns an inflated count into a 429 against real traffic.

### `orchestrator.barrier_watchdog`

**Purpose.** Repair parallel barriers whose children finished but never released the parent.

**Invariant.** A satisfied barrier always resumes its parent.

**Recovery.** The candidate ZSET is durable; a missed sweep is retried on the next cycle.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | shard_owner |
| Substrate | redis-zset |
| Base cadence | 30s |
| Max batch | 100 |
| Max cycle | 20000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — Barrier candidates are armed in the existing barrier mutation. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/index.ts`<br>`apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/barrierSweep.ts` |

> On the standard runner, so cycles cannot overlap and the cadence, batch and cycle ceiling come from this entry rather than from literals at the call site. The peek is bounded and score-ordered; the staleness threshold is a domain constant at the wiring site because it is a property of how long a tool call may legitimately take, not a scheduling budget.

### `orchestrator.completion_schedule_recorder`

**Purpose.** Record on_completion occurrences when a run's terminal state becomes durable.

**Invariant.** A durable terminal transition fires its on_completion schedules exactly once, or the firing stays owed on an armed projection candidate.

**Recovery.** A refused or failed recording throws out of the projection transaction, so the candidate stays armed — and off the projection eviction budget — until recording lands; the fired-at mark makes the retry free rather than a second firing.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | schedules |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | singleton |
| Substrate | redis-zset |
| Base cadence | 3s |
| Max batch | 50 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Rides the projection worker's candidate claim; nothing is armed beyond what the terminal write already armed. |
| Feature gate | SCHEDULES_ENABLED |
| Disable policy | breakglass |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts`<br>`apps/aflow-orchestrator/src/services/ProjectionWorker.ts` |

> Not a runner of its own — it executes inside the projection cycle at the one point guaranteed to see every durable terminal transition. Its mode is deliberately separate from due-time discovery's: disabling discovery is safe (cron firings just wait), while disabling this parks every terminal session's candidate armed and re-flushed each cycle, which is why it needs break-glass.

### `orchestrator.control_consumer`

**Purpose.** Deliver control messages (start, cancel, resume) to the state machine.

**Invariant.** A control request is acted on once or remains pending for the next owner.

**Recovery.** Unacked entries stay in the PEL and are reclaimed on shard acquisition.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | blocking |
| Execution scope | shard_owner |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 50 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 120 |
| Hot-path producer budget | 0 added RTT — Producers XADD the control message they already produce. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ControlConsumer.ts`<br>`packages/redis/src/streams/control.ts`<br>`packages/redis/src/streams/shardReads.ts` |

> Blocks for 1s per empty read and wakes immediately on arrival, so idle cost is two reads per second and delivery latency is unaffected. Stream keys are derived from shard ownership rather than rebuilt per read.

### `orchestrator.delegation_pending`

**Purpose.** Deliver child-session completions back to a parent waiting on them.

**Invariant.** A parent in WAITING_ON_CHILD is always released when its children rest.

**Recovery.** Lease expiry re-arms an abandoned candidate; attempts are bounded with backoff.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | delegation |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | shard_owner |
| Substrate | redis-zset |
| Base cadence | 30s |
| Max batch | 50 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — The candidate is armed in the existing delegation transition. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/delegationPendingDrain.ts` |

> On the standard runner, so cadence and batch come from this entry rather than from the module's own defaults. The lease and attempt ceiling stay at the call site: they bound how long one delegation may be worked and how often it may be retried before escalating, which is a property of the delegation rather than of the drain.

### `orchestrator.delegation_supervision`

**Purpose.** Watch the parent side of a delegation so a child that dies still releases it.

**Invariant.** A parent left waiting is always resolved: a rested or vanished child is handed to the delegation lifecycle, and a wait that outlived every child it tracked is released.

**Recovery.** Reading is non-destructive and nothing is leased, so a pass that dies leaves its candidates where the next shard owner finds them. Parents already waiting when the index appeared are armed by a one-shot carry-over at boot.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | delegation |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | shard_owner |
| Substrate | redis-zset |
| Base cadence | 30s |
| Max batch | 100 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — The wait itself arms the marker, inside the session write it already issues. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `packages/redis/src/hotState/atomic.ts`<br>`packages/redis/src/hotState/session.ts`<br>`packages/redis/src/hotState/delegationSupervisionCandidates.ts`<br>`packages/redis/src/hotState/delegationSupervisionCarryOver.ts`<br>`apps/aflow-orchestrator/src/index.ts`<br>`apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/delegationSupervisionSweep.ts` |

> Complements the pending drain rather than duplicating it: that index is armed when a child completes, so it is blind to a child that dies first. This one holds no attempt counter — a healthy wait is pushed forward indefinitely, and every action it takes goes through the existing lifecycle, so escalation stays owned by the drain alone.

### `orchestrator.eval_batch_engine`

**Purpose.** Advance every eval batch that still owes work — dispatch trials, grade the runs they produced, and terminalize.

**Invariant.** A launched eval batch reaches a terminal status with every trial graded, its spend accrued against the ceiling, and its validation slice minted; every fixture space its trials created is collected at expiry.

**Recovery.** The batch and trial rows are the state machine, so a pass is a pure re-derivation of what a batch still owes: an expired trial lease is adopted, a trial whose launch died is reconciled against the run ledger rather than re-launched, and the validation slice is minted from the settled rows before the terminal CAS so a crash between them re-derives the identical draw. A claim leases the tenant rather than clearing it, so a claimant that dies mid-cycle loses nothing at lease expiry.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | cybernetic |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | postgres-due |
| Base cadence | 10s |
| Max batch | 25 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 6 |
| Hot-path producer budget | 0 added RTT — A row trigger arms the due pointer inside the statement that writes the batch head or a fixture space expiry. |
| Feature gate | — |
| Disable policy | breakglass |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/cybernetic/evalBatch/evalBatchWorkerLoop.ts`<br>`apps/aflow-orchestrator/src/services/cybernetic/evalBatch/EvalBatchEngine.ts`<br>`packages/database/src/tenant/evalBatchDue.ts`<br>`packages/database/src/repositories/evalBatchDue.ts` |

> Idle cost is one indexed claim per cycle. A tenant with a non-terminal batch stays nominated on purpose — observing its in-flight trials is the work, and no other write reports that a trial's run has finished — so the cadence is the grading latency, and the cycle deliberately never reports more work rather than re-arming at zero delay. Cost tracks tenants with live batches; a tenant whose batches are all terminal is nominated again only when a fixture space comes up for collection. Disabling this strands launched trials ungraded with their spend still accruing and leaks their fixture spaces, which is why it needs break-glass.

### `orchestrator.instance_heartbeat`

**Purpose.** Publish this process's liveness so dead shard owners are detectable.

**Invariant.** A live orchestrator has an unexpired member in the liveness index, and shard acquisition resolves ownership through the registered owner's entry rather than through any per-shard marker.

**Recovery.** Lease expiry is the death signal; a restarted instance re-registers immediately.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | ownership |
| Criticality | correctness |
| Trigger | heartbeat |
| Execution scope | per_instance |
| Substrate | redis-lease |
| Base cadence | 10s |
| Max batch | 1 |
| Max cycle | 5000 ms |
| Idle datastore ops/min | 6 |
| Hot-path producer budget | 0 added RTT — No producer coupling. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/index.ts`<br>`packages/redis/src/streams/orchestratorHeartbeat.ts` |

> One sorted-set write per process per cycle, with expired members pruned in the same call, so the cost tracks live processes rather than shards held. Expiry is stamped from Redis time because instances compare each other's leases and clock skew would otherwise decide who is alive.

### `orchestrator.mcp_elicitation_reconcile`

**Purpose.** Release elicitation leases held by executors that died mid-prompt.

**Invariant.** An elicitation whose holder is gone is failed rather than left hanging.

**Recovery.** The index is re-armed by every lease heartbeat, so an entry lost to eviction returns within one heartbeat period; a claimed candidate whose claimant dies is due again at claim expiry.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | mcp |
| Criticality | feature |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | redis-zset |
| Base cadence | 30s |
| Max batch | 100 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — The candidate ZADD rides the existing lease grant and heartbeat Lua. |
| Feature gate | MCP_ELICITATION_ENABLED |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/mcpElicitationReconciler.ts`<br>`packages/redis/src/mcpElicitationLeaseCandidates.ts` |

> Two indexed reads per minute at idle. Under load the cost is one liveness read per distinct holder instance, not per lease: the candidate member carries the holder, so a hash is read only for a holder already found dead. The score is a re-check time rather than the lease deadline, because the reconciler acts on holder death and a healthy lease sits a full TTL from its own expiry.

### `orchestrator.mcp_elicitation_router`

**Purpose.** Route MCP elicitation requests and responses between executor and human.

**Invariant.** An elicitation response reaches the executor that holds the lease.

**Recovery.** A lost message is healed by the elicitation lease reconciler.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | mcp |
| Criticality | feature |
| Trigger | event |
| Execution scope | per_instance |
| Substrate | redis-pubsub |
| Base cadence | event-driven |
| Max batch | 1 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Piggybacks the existing publish. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/mcpElicitationHandler.ts` |

### `orchestrator.orphan_recovery`

**Purpose.** At boot, resolve sessions left RUNNING by a process that died holding their only result.

**Invariant.** A session whose in-flight result is irrecoverably lost is paused or failed, never left running.

**Recovery.** Runs once per boot before consumers start; the stall watchdog covers the steady state.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | audit |
| Execution scope | per_instance |
| Substrate | redis-zset |
| Base cadence | event-driven |
| Max batch | 500 |
| Max cycle | 120000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — No producer coupling. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `packages/redis/src/hotState/atomic.ts`<br>`packages/redis/src/hotState/step.ts`<br>`apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/recovery.ts`<br>`packages/redis/src/hotState/stepStallCandidates.ts` |

> Boot-only, so it has no cadence and no idle cost. Shares the step-deadline index and the completion-path predicate with the stall watchdog, differing only in cadence, batch ceiling, and its willingness to pause a SCHEDULED agent step rather than fail it.

### `orchestrator.pending_recovery`

**Purpose.** Reclaim stream entries left pending by a dead or superseded consumer.

**Invariant.** A delivered-but-unacked result or control message is eventually reprocessed.

**Recovery.** Acquisition reclaim is the crash path; the periodic pass catches stragglers.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | shard_owner |
| Substrate | redis-stream |
| Base cadence | 30s |
| Max batch | 100 |
| Max cycle | 20000 ms |
| Idle datastore ops/min | 258 |
| Hot-path producer budget | 0 added RTT — No producer coupling. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ShardManager.ts` |

> Control is swept across every owned shard each cycle because start_run and retry_run arrive before their run is active; results are swept only on shards holding active runs, where a stranded entry implies one. One registry read covers the whole sweep, and a full sweep of both streams runs every 15 minutes as drift repair. Both consumers re-drain their own pending entries in their read loop, so this covers entries left by a fenced-out instance rather than by a failed handler.

### `orchestrator.projection`

**Purpose.** Project Redis session hot state and events into the durable Postgres read model.

**Invariant.** Every session mutation — and every durable event its stream still holds — eventually reaches Postgres without losing a newer version.

**Recovery.** A claim leases the candidate; an unacknowledged one is redelivered at lease expiry. A version raised mid-projection refuses the acknowledgement and leaves the session due. A candidate is dropped only once a durable failure record names it, and when that record cannot be written — which is what a Postgres outage looks like from here — the candidate stays armed instead.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | durability |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | singleton |
| Substrate | redis-zset |
| Base cadence | 3s |
| Max batch | 50 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 20 |
| Hot-path producer budget | 0 added RTT — Arming rides the pipeline the state mutation already issues: two more commands, no extra round trip. |
| Feature gate | PROJECTION_WORKER_ENABLED |
| Disable policy | breakglass |
| Residual poll | — |
| Source | `packages/redis/src/hotState/events.ts`<br>`packages/redis/src/hotState/legacyDirtyCarryOver.ts`<br>`apps/aflow-orchestrator/src/services/ProjectionWorker.ts`<br>`packages/redis/src/hotState/projectionCandidates.ts`<br>`packages/redis/src/hotState/dirty.ts`<br>`packages/database/src/repositories/projectionFailures.ts`<br>`packages/redis/src/shard.ts` |

> One claim EVAL per cycle whether or not anything is due, and it returns only what is due, so cost tracks the backlog rather than how many sessions exist. Version and due time are separate scores on separate indexes: sharing one would force a choice between starving a session that changes often and losing two marks that land in the same millisecond. The attempt ceiling lives on the failure record rather than in the process, so it survives a restart and means the same thing on five instances as on one. This is also where an on_completion schedule fires: recording its occurrences inside the transaction that stamps the run as fired makes the pair retriable, and it reaches every terminal writer rather than the two that remembered to call it. Durable events flush incrementally — for running sessions too — from a per-session cursor on the session row, advanced only in the transaction that inserts them, so the stream MAXLEN cap is a memory backstop rather than a retention policy.

### `orchestrator.result_consumer`

**Purpose.** Deliver executor step results into the single-writer state machine.

**Invariant.** Every step result is applied exactly once per attempt or retried from the PEL.

**Recovery.** Unacked entries stay in the PEL and are reclaimed on shard acquisition.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | blocking |
| Execution scope | shard_owner |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 50 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 120 |
| Hot-path producer budget | 0 added RTT — Executors XADD the result they already produce. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ResultConsumer.ts`<br>`packages/redis/src/streams/results.ts`<br>`packages/redis/src/streams/shardReads.ts` |

> Blocks for 1s per empty read and wakes immediately on arrival, so idle cost is two reads per second and delivery latency is unaffected. Stream keys are derived from shard ownership rather than rebuilt per read.

### `orchestrator.schedule_dispatch`

**Purpose.** Lower recorded schedule occurrences to control messages.

**Invariant.** A recorded occurrence starts exactly one run, or is retired with a reason.

**Recovery.** The record outlives the emit and is deleted only after it; a drain killed between the two is redelivered and loses the control-dispatch idempotency claim, so it retires the record instead of emitting again.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | schedules |
| Criticality | feature |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | postgres-due |
| Base cadence | 15s |
| Max batch | 100 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 4 |
| Hot-path producer budget | 0 added RTT — The outbox row is written in the transaction that advances the schedule. |
| Feature gate | SCHEDULES_ENABLED |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts`<br>`packages/database/src/repositories/scheduleOutbox.ts` |

> Its own cycle rather than a tail call of discovery: draining only when something new came due leaves a recorded occurrence waiting on an unrelated schedule anywhere in the fleet. Discovery still drains what it just recorded, so the cadence is recovery latency, not fire latency.

### `orchestrator.schedule_evaluator`

**Purpose.** Record an occurrence for every schedule whose next fire time has arrived.

**Invariant.** A due occurrence is recorded exactly once: the schedule advance and the dispatch record commit together.

**Recovery.** The schedule row stays due until the advance commits, and the advance cannot commit without the dispatch record; an expired claim is re-claimable. The advance itself is guarded on the row state it was computed from, so an instance working past its tenant lease loses rather than minting a second occurrence for one due time.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | schedules |
| Criticality | feature |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | postgres-due |
| Base cadence | 15s |
| Max batch | 100 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 4 |
| Hot-path producer budget | 0 added RTT — A row trigger arms the due pointer inside the statement that writes a schedule. |
| Feature gate | SCHEDULES_ENABLED |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts`<br>`packages/database/src/tenant/duePointers.ts` |

> One indexed empty read per cadence is the complete idle cost. The contended resource is the tenant pointer row: every write to a fire-eligible schedule takes it, including the evaluator's own advance, so a tenant's schedule writes serialise on that row for the duration of the trigger. The batch ceiling bounds occurrences across the whole cycle rather than per claimed tenant: reused per tenant it multiplied by the tenants claimed, and the cycle then outlived the leases that are its only exclusion. A tenant the budget could not reach is handed back still due, and the cycle reports more work rather than waiting a cadence.

### `orchestrator.session_metadata`

**Purpose.** Give conversations a recognizable name and a current summary.

**Invariant.** A conversation with committed activity ends with a title and a summary covering the evidence revision they were written from, or a diagnostic saying why not — and never blocks, pauses, or spends a turn of the conversation it describes.

**Recovery.** A claim leases the conversation rather than consuming it, so a worker that dies mid-generation loses nothing past lease expiry. A newer boundary during generation raises the evidence revision, the acknowledgement no longer matches, and the conversation stays due. A failed generation backs off and retires after three attempts, leaving the deterministic title in place.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | cybernetic |
| Criticality | feature |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | redis-zset |
| Base cadence | 5s |
| Max batch | 10 |
| Max cycle | 120000 ms |
| Idle datastore ops/min | 12 |
| Hot-path producer budget | 0 added RTT — A committed turn boundary arms the candidate inside the pipeline the session write already issues. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/sessionMetadataTask.ts`<br>`packages/redis/src/hotState/sessionMetadataCandidates.ts`<br>`packages/cybernetic-runtime/src/sessionMetadataGeneration.ts`<br>`packages/database/src/repositories/sessionMetadata.ts` |

> Idle cost is one indexed range read per cycle. The index holds a member only for a conversation someone has spoken in since it was last named, so cost tracks live conversations rather than stored sessions.

### `orchestrator.shard_acquisition`

**Purpose.** Claim unowned or expired shards and reclaim their pending stream entries.

**Invariant.** Every shard with work has exactly one live owner holding a fencing token.

**Recovery.** Startup acquisition plus periodic retry; fencing rejects a stale owner mid-write.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | ownership |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | redis-lease |
| Base cadence | 30s |
| Max batch | 128 |
| Max cycle | 20000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — No producer coupling. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/ShardManager.ts` |

> One acquire Lua per shard runs only while capacity is free; a full instance short-circuits.

### `orchestrator.step_stall_watchdog`

**Purpose.** Surface and recover steps whose executor result will never arrive.

**Invariant.** A step with no completion path becomes a retryable failure instead of hanging.

**Recovery.** Deadlines persist across restarts, and shard recovery rewrites the hot state of every run it restores, which re-arms them. A candidate the sweep does not reach stays due for the next cycle: reading is non-destructive, so nothing is consumed by a pass that dies part-way.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | shard_owner |
| Substrate | redis-zset |
| Base cadence | 30s |
| Max batch | 200 |
| Max cycle | 20000 ms |
| Idle datastore ops/min | 2 |
| Hot-path producer budget | 0 added RTT — The deadline is armed inside the scheduling transition that already runs. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `packages/redis/src/hotState/atomic.ts`<br>`packages/redis/src/hotState/step.ts`<br>`packages/redis/src/hotState/session.ts`<br>`apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/timers.ts`<br>`packages/redis/src/hotState/stepStallCandidates.ts` |

> Reads one bounded, due-ordered slice of the deadline index per cycle, so cost tracks steps past their earliest reapable instant rather than how many sessions hold Redis state. The score is a lower bound on when to look and never a verdict — classifyStepCompletionPath reads the executor in-flight key at examination time and is the only thing that may conclude a step is unreachable. Still piggybacks the timer tick rather than holding its own runner, self-gated to the cadence above.

### `orchestrator.stream_retention`

**Purpose.** Reclaim transport-stream entries every consumer group has delivered and acknowledged.

**Invariant.** An entry is removed only after every consumer group has both been delivered and acknowledged it; undelivered work is never trimmed.

**Recovery.** A candidate whose trim did not complete is put back on the set in the same cycle; retention is idempotent and has no deadline.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | operational |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | redis-stream |
| Base cadence | 1m |
| Max batch | 64 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 1 |
| Hot-path producer budget | 0 added RTT — Enqueues and acks arm the candidate set inside the pipeline they already issue. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/streamRetention.ts`<br>`packages/redis/src/streams/retention.ts` |

> Job, shard result, and shard control streams are work queues, so they are trimmed to the frontier every consumer group has finished with rather than capped by count — a count cap would delete a backlog out from under an executor that is merely down. One SPOP per cycle when nothing is armed, flat in shards, tenants, and keys. Candidates are armed on enqueue as well as ack, so a stream whose consumer group has been abandoned still reports its growth through the retained-entries metric even though it will never produce another ack. Such a stream is held forever by design: its entries are undelivered work.

### `orchestrator.timer_dispatch`

**Purpose.** Wake delayed starts, retries, snoozes, and delegation timeouts when they come due.

**Invariant.** A scheduled timer fires once at or after its due time, or survives a crash.

**Recovery.** A claimed timer whose worker dies becomes due again at lease expiry.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | run-execution |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | shard_owner |
| Substrate | redis-zset |
| Base cadence | 1s |
| Max batch | 100 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 120 |
| Hot-path producer budget | 0 added RTT — One Lua call replaces the ZADD the scheduler already issued. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/timers.ts`<br>`packages/redis/src/streams/shardTimers.ts`<br>`apps/aflow-orchestrator/src/services/ResultConsumer.ts` |

> One indexed claim per second regardless of how many shards are owned. A claim leases the timer rather than deleting it, so a worker that dies before dispatching does not lose the wake-up.

### `orchestrator.workflow_harness_advance`

**Purpose.** Advance workflow harness state from queued advance requests.

**Invariant.** An advance request is applied once or stays pending for the next owner.

**Recovery.** Unacked entries stay in the PEL and are reclaimed by the next consumer.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | cybernetic |
| Criticality | correctness |
| Trigger | blocking |
| Execution scope | per_instance |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 50 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 60 |
| Hot-path producer budget | 0 added RTT — Producers XADD the advance request they already produce. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/cybernetic/workflowHarnessAdvanceConsumer.ts` |

### `orchestrator.workflow_progress`

**Purpose.** Fan live workflow-task progress out to the surface layer.

**Invariant.** Progress frames are a live feed only; the workflow record is authoritative.

**Recovery.** A dropped frame is superseded by the next one; no durable state depends on it.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | cybernetic |
| Criticality | feature |
| Trigger | blocking |
| Execution scope | per_instance |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 100 |
| Max cycle | 30000 ms |
| Idle datastore ops/min | 120 |
| Hot-path producer budget | 0 added RTT — Producers keep the single XADD they already perform. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/cybernetic-runtime/src/workflowTaskProgressConsumer.ts` |

> Reads an index of active per-task streams rather than scanning the keyspace, so its cost tracks running tasks. The XREAD stream list is still proportional to active tasks, and the per-task streams stay individually addressable because session catch-up replays one task's stream to rebuild its surface. The remaining scan is a one-time boot seed.

### `orchestrator.workflow_run_reconcile`

**Purpose.** Converge workflow runs whose tasks are complete but whose run never finalized, and write the evaluation envelope a run reached terminal state without.

**Invariant.** A completion-pending workflow run always reaches a terminal state, and every terminal cybernetic run records an evaluation decision.

**Recovery.** A claim leases the tenant rather than clearing it, so a claimant that dies mid-cycle loses nothing at lease expiry. The tenant rows stay authoritative: the pointer is recomputed from them after every claim, so an over-armed pointer costs one wasted claim and cannot go stale in the other direction. Runs in flight before the pointer existed are armed by a one-shot carry-over at boot.

| Field | Value |
| ----- | ----- |
| Service | orchestrator |
| Owner domain | cybernetic |
| Criticality | correctness |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | postgres-due |
| Base cadence | 10s |
| Max batch | 100 |
| Max cycle | 60000 ms |
| Idle datastore ops/min | 6 |
| Hot-path producer budget | 0 added RTT — A row trigger arms the due pointer inside the statement that writes the tenant row. |
| Feature gate | — |
| Disable policy | never |
| Residual poll | — |
| Source | `apps/aflow-orchestrator/src/services/cybernetic/workflowRunSweeperLoop.ts`<br>`apps/aflow-orchestrator/src/services/cybernetic/evaluationEnvelopeBackfill.ts`<br>`packages/database/src/tenant/workflowRunDue.ts`<br>`packages/database/src/repositories/workflowRunDue.ts` |

> Idle cost is one indexed claim per cycle. The pointer holds a row only for a tenant that has reconcilable work, so cost tracks pending runs rather than tenant count.

### `server.a2a_task_stream`

**Purpose.** Serve the A2A task event stream to an external client.

**Invariant.** A connected A2A client receives every task event in order.

**Recovery.** Cursor drain on reconnect.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | interop |
| Criticality | feature |
| Trigger | event |
| Execution scope | active_subscription |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 100 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 60 |
| Hot-path producer budget | 0 added RTT — Producers already append session events. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | 1000 ms |
| Source | `packages/server-runtime/src/routes/a2a.ts` |

> Interop surface for external agents.

### `server.agui_run_stream`

**Purpose.** Serve the AG-UI run event stream to an external client.

**Invariant.** A connected AG-UI client receives every run event in order.

**Recovery.** Cursor drain on reconnect.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | interop |
| Criticality | feature |
| Trigger | event |
| Execution scope | active_subscription |
| Substrate | redis-pubsub |
| Base cadence | event-driven |
| Max batch | 100 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 60 |
| Hot-path producer budget | 0 added RTT — Producers already append session events. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | 1000 ms |
| Source | `packages/server-runtime/src/routes/agui.ts` |

> Interop surface for external agents; slows its poll while Pub/Sub is live and also re-checks space authorization so a revoked member is disconnected.

### `server.audit_flush`

**Purpose.** Flush buffered audit events to Postgres.

**Invariant.** A buffered audit event is persisted or reported as lost.

**Recovery.** Shutdown flushes the remaining buffer.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | compliance |
| Criticality | operational |
| Trigger | active-resource |
| Execution scope | per_instance |
| Substrate | local |
| Base cadence | 1s |
| Max batch | 100 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Buffering is in-process. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/server-runtime/src/plugins/audit.ts` |

> Cycles over an in-memory buffer and issues no datastore read when empty.

### `server.run_watchdog`

**Purpose.** Make queued work visibly stalled while no orchestrator is alive.

**Invariant.** A user never watches a queued run sit silent with no orchestrator behind it.

**Recovery.** Purely advisory; the orchestrator owns the real recovery. A claim leases the candidate, so one whose claimant died is stalled by a later cycle instead of being lost.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | run-execution |
| Criticality | operational |
| Trigger | candidate |
| Execution scope | per_instance |
| Substrate | redis-zset |
| Base cadence | 15s |
| Max batch | 200 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 4 |
| Hot-path producer budget | 0 added RTT — The queued deadline is armed in the existing session start. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/redis/src/hotState/atomic.ts`<br>`packages/redis/src/hotState/session.ts`<br>`packages/server-runtime/src/services/runWatchdog.ts`<br>`packages/redis/src/hotState/queuedSessionCandidates.ts` |

> Reads the orchestrator heartbeat first and only touches the queued-session index when it is absent, so the expensive path runs only while the orchestrator is down. The claim leases what it returns, which is what stops every warm instance from writing the same STALLED transition and emitting the same event.

### `server.session_tail`

**Purpose.** Deliver durable and live session updates to an open chat.

**Invariant.** A connected client converges on the session record without gaps.

**Recovery.** Cursor drain on the wake and on Pub/Sub reconnect.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | realtime |
| Criticality | feature |
| Trigger | event |
| Execution scope | active_subscription |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 200 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Producers already append to the session event stream. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/server-runtime/src/services/sessionTail.ts`<br>`packages/server-runtime/src/services/sessionWakeup.ts` |

> Drains from the cursor on a durable wake and on Pub/Sub reconnect, looping until the stream is exhausted. Idle costs nothing: the safety poll is gone, and both reasons it existed are closed at the source — the wake rides the append transaction (packages/redis/src/hotState/events.ts, hotState/atomic.ts), and the process-wide subscriber wakes its sessions on reconnect (packages/server-runtime/src/services/pubsub.ts), which is the only way to recover a publish lost to an outage since Pub/Sub keeps no backlog. The drain seeks to its cursor rather than reading the stream from the beginning to find it, so a wake costs what followed the cursor rather than the whole retained history.

### `server.space_action_center`

**Purpose.** Push human-action list changes to subscribed operators.

**Invariant.** An open human action becomes visible to an authorized actor promptly.

**Recovery.** Snapshot on mount; a rebuild on subscriber join and on Pub/Sub reconnect closes a missed wake.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | human-in-the-loop |
| Criticality | feature |
| Trigger | event |
| Execution scope | active_subscription |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 200 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — The wake PUBLISH after the producing write commits is fire-and-forget — the producing path never waits on it. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/server-runtime/src/routes/realtimeTopics/spaceActionCenter.ts`<br>`packages/redis/src/actionCenterFocus.ts` |

> Rebuilds are wake-driven: the pool entry subscribes its one connection to the per-space and per-tenant action-center wake channels (producers: session projection flush, egress/host-request routes, invitation routes, speech-implies-join when it consumes an invitation, the Action Center resolve route) plus the space entity-events channel (workflow-run pause/resume, the paused-contract rewrite, and every Coach mutation announce themselves there). A 2s floor between passes caps a sustained wake stream at the old poll’s cadence — the first wake after a quiet spell still rebuilds immediately; wakes inside the floor coalesce into one trailing pass. A rebuild is 7 space-scoped source reads, each its own `withTenantSchema` transaction, plus one indexed invitation read per subscriber — that read stays per-reader because the source returns the reader’s own rows, and pooling it would replace a structural guarantee with a filter. No timer arms at any point: a subscribed space that nothing changes costs nothing, matching the sibling realtime topics. Cascade deletions still publish no wake — their failure mode is a card that outlives its row rather than an action nobody sees, and a mount, a visibility return, or a reconnect retires it.

### `server.space_coach_surface`

**Purpose.** Push Coach surface changes to subscribed operators.

**Invariant.** A Coach state change becomes visible without a manual refresh.

**Recovery.** Snapshot on mount; a rebuild on subscriber join and on Pub/Sub reconnect closes a missed wake.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | cybernetic |
| Criticality | feature |
| Trigger | event |
| Execution scope | active_subscription |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 200 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — Entity events already ride the producer transaction. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/server-runtime/src/routes/realtimeTopics/spaceCoachSurface.ts` |

> Rebuilds on any entity event for the space, coalesced to one pass per burst, and once at the snapshot-declared next time-derived change. Pooled per space, so a second watcher adds no rebuild. An idle space holds no timer.

### `server.space_entity_events`

**Purpose.** Deliver durable per-space entity events to subscribers.

**Invariant.** No durable entity event is skipped for a connected subscriber.

**Recovery.** Cursor drain on Pub/Sub reconnect; the durable stream is the recoverable fact.

| Field | Value |
| ----- | ----- |
| Service | server |
| Owner domain | realtime |
| Criticality | feature |
| Trigger | event |
| Execution scope | active_subscription |
| Substrate | redis-stream |
| Base cadence | event-driven |
| Max batch | 500 |
| Max cycle | 10000 ms |
| Idle datastore ops/min | 0 |
| Hot-path producer budget | 0 added RTT — The wake rides the same transaction as the durable append. |
| Feature gate | — |
| Disable policy | safe |
| Residual poll | — |
| Source | `packages/server-runtime/src/routes/realtimeTopics/spaceEntityEvents.ts` |

> Drains from the cursor on the wake and on reconnect, looping until the stream is exhausted. A wake landing mid-drain is re-armed, not dropped. Idle costs nothing.

## Keyspace-discovery exceptions

Wildcard discovery that survives outside the candidate model. Each entry is operator-,
migration-, or anomaly-triggered and never a recurring scheduler.

| Site | Mechanism | Owner | Reason | Bound |
| ---- | --------- | ----- | ------ | ----- |
| `packages/web-product/src/ui/lib/oauthConsentPopup.ts` | setInterval | web | A browser watching a consent popup it opened. There is no event for "the user closed that window", so polling is how the web platform answers the question — and it is a question about one window in one tab, not work discovered on a server. | One interval per popup, started when the window opens and cleared when it closes or the component unmounts; nothing about its cost scales with anything this fleet holds. |
| `packages/web-product/src/ui/hooks/session-events-broker.ts` | recursive-timer ×2 | web | A browser reconnect backoff, not background work on a server. It exists only while a tab holds a session open, and the registry above bounds processes — a timer in someone else's browser is bounded by that tab, not by this fleet. | Armed only by a transport error or a reconcile, cleared on connect, and capped at MAX_RECONNECT_ATTEMPTS; one entry per session the tab is watching, torn down when the last subscriber releases it. |
| `packages/web-product/src/ui/hooks/use-session-presence.ts` | setInterval | web | The presence heartbeat a tab sends while someone has a session open. It is what keeps the entry alive, so its absence is the signal that the viewer left; it also carries whether this tab is still typing, which is why typing decays without a second timer. | One interval per open session per tab, started with the subscription and cleared when it ends; its cost does not grow with sessions, spaces, or other viewers. |
| `packages/web-product/src/ui/components/workflow-run-surface/useWorkflowRunPauseRefresh.ts` | recursive-timer | web | A bounded re-fetch wave in a browser, not a scheduler. The rich pause contract lives behind `workflow.run.detail` rather than on the SSE event, and one-shot rehydration has already settled by the time a run pauses mid-flight, so without this the surface holds only the coarse reason string. | Three delays and then it gives up; armed only while a mounted run is paused without a contract, and cleared on unmount or on the contract arriving. |
| `packages/web-product/src/ui/components/workflow-run-surface/useWorkflowRunUsageRefresh.ts` | recursive-timer | web | A browser waiting for the projection worker's next flush to carry a finished task's usage. Polling is how a client learns that a write it does not participate in has landed. | Three widening delays per wave and then it gives up; a later task completing or a manual refresh starts a new one. Armed only while a mounted run has a terminal task whose usage is still missing. |
| `packages/web-product/src/ui/lib/realtimeClient.ts` | setInterval | web | The socket heartbeat a browser keeps while a tab is open. Same reasoning as the broker beside it: this is a client holding its own connection, not a process discovering work. | One interval per tab, started with the socket and cleared when it closes; its cost does not grow with sessions, spaces, or anything the tab subscribes to. |
| `packages/redis/src/streams/shardTimers.ts` | full-set-read | orchestrator | The one-off migration of timers written before shard timers carried ids reads each shard set whole, because a pre-id member cannot be found by the id it lacks. | Migration-triggered and run once per deployment, over a fixed set of shards rather than anything discovered, and deleted when no deployment can still hold a pre-id timer. |
| `packages/cybernetic-runtime/src/coachTriggerValidity.ts` | full-set-read | cybernetic | Clearing a skill's pending-repair fingerprints reads the space's set whole: the members carry a slug prefix, and Redis has no way to remove by prefix. | Triggered by one skill's invalid-to-valid transition, never by a scheduler, and sized by a single space's outstanding repairs. |
| `packages/server-runtime/src/routes/hostPairing.ts` | full-set-read | ownership | The host status view reads the set each paired executor announces itself into, to report which machines are connected and what they have installed. | Request-scoped and admin-only, never reached from a scheduler, and sized by LIVE machines rather than by everything that has ever paired: members are scored by when each was last heard from, and the read drops anything older than an inventory lifetime before listing. A plain set only shrank on a clean shutdown, so every crashed executor left a name behind for good. |
| `packages/redis/src/streams/engineHealth.ts` | redis-keys | ownership | Operator health view enumerates executor heartbeats for the diagnostics page. | Request-scoped and admin-only; never reached from a scheduler. |
| `apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/coachCrud.ts` | full-set-read ×2 | cybernetic | Reads one bounded per-session Coach proposal ledger key. | Keyed by a single coach session; not keyspace discovery. |
| `packages/redis/src/hotState/session.ts` | redis-keys ×2 | run-execution | Corrupt-state salvage locates the quarantine copies of one session. | Pattern is anchored to a single tenant and run; runs only after a state corruption. |
| `packages/redis/src/sessionResidue.ts` | keyspace-scan | run-execution | Clears leftover keys for one purged session. | Patterns are anchored to a single session; triggered by that purge, not a schedule. |
| `packages/cybernetic-runtime/src/spaceLifecycle.ts` | keyspace-scan | spaces | Space deletion must find sessions still active in the space being removed. | Bounded SCAN with COUNT 200, anchored to one tenant; runs once per deletion attempt. |
| `packages/redis/src/mcpElicitationLeaseRollout.ts` | keyspace-scan | mcp | Arms the elicitation lease candidate index from leases held when it was installed — the population whose holders the installing deploy kills is the one nothing else re-arms. | Guarded by a fleet-wide marker, so it walks the lease prefix once per rollout and never again; not wired to any scheduler. |
| `packages/redis/src/entityEventsLegacyRelabel.ts` | keyspace-scan | realtime | One-time relabel of entity-event streams written before the taxonomy reset. | Migration only; not wired to any scheduler. |
| `packages/authz/src/cache.ts` | redis-keys | access-control | Drops every cached RBAC decision for one user when their membership changes. | Triggered by the membership mutation itself, never by a scheduler; patterns are anchored to one tenant and user. |
| `packages/server-runtime/src/plugins/tenant.ts` | redis-keys | access-control | Drops space-scoped caches for one user when their membership changes. | Triggered by the membership mutation itself; patterns are anchored to one user. |
| `apps/aflow-orchestrator/src/services/GuardrailGate/policyCompiler.ts` | keyspace-scan | guardrails | Drops compiled guardrail policies for one tenant when its policy set changes. | Triggered by the policy mutation itself; bounded SCAN with COUNT 100 anchored to one tenant. |
| `packages/executor-runtime/src/timeout.ts` | recursive-timer | run-execution | Re-arms a step attempt's deadline when progress extends it. | Scoped to one in-flight step attempt; cleared when the attempt settles. |
| `packages/database/src/tenant/applyAll.ts` | tenant-enumeration | platform | Migration fan-out across tenant schemas. | Deploy/release phase only; never runs from a scheduler. |
| `packages/database/src/seeds/cyberneticAgents.ts` | tenant-enumeration | platform | Seed fan-out across tenant schemas. | Seed command only. |
| `packages/database/src/seeds/capabilityFlows.ts` | tenant-enumeration | platform | Seed fan-out across tenant schemas. | Seed command only. |
