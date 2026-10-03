import {
  BackgroundScanExceptionSchema,
  BackgroundTaskDefinitionSchema,
  type BackgroundDiscoveryRule,
  type BackgroundScanException,
  type BackgroundScanExceptionInput,
  type BackgroundTaskDefinition,
  type BackgroundTaskDefinitionInput,
} from './backgroundTask.js';

/**
 * Every stateful background task in production, with its owner, invariant,
 * safety class, budget, and recovery story.
 *
 * `idleOperationBudgetPerMinute` is the number the whole control plane exists
 * to protect: it must not grow with logical shards, tenant schemas, stored
 * Redis keys, or connected subscribers. Where an entry's budget is still
 * cardinality-proportional, its `note` names the multiplier and the phase that
 * removes it.
 */
const DEFINITIONS: readonly BackgroundTaskDefinitionInput[] = [
  // ==========================================================================
  // Orchestrator — authoritative transport
  // ==========================================================================
  {
    id: 'orchestrator.result_consumer',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Deliver executor step results into the single-writer state machine.',
    invariant: 'Every step result is applied exactly once per attempt or retried from the PEL.',
    criticality: 'correctness',
    trigger: 'blocking',
    scope: 'shard_owner',
    substrate: 'redis-stream',
    maxBatch: 50,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 120,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Executors XADD the result they already produce.',
    },
    disablePolicy: 'never',
    recovery: 'Unacked entries stay in the PEL and are reclaimed on shard acquisition.',
    note: 'Blocks for 1s per empty read and wakes immediately on arrival, so idle cost is two reads per second and delivery latency is unaffected. Stream keys are derived from shard ownership rather than rebuilt per read.',
    sites: [
      'apps/aflow-orchestrator/src/services/ResultConsumer.ts',
      'packages/redis/src/streams/results.ts',
      { path: 'packages/redis/src/streams/shardReads.ts', discovery: ['blocking-consumer'] },
    ],
  },
  {
    id: 'orchestrator.control_consumer',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Deliver control messages (start, cancel, resume) to the state machine.',
    invariant: 'A control request is acted on once or remains pending for the next owner.',
    criticality: 'correctness',
    trigger: 'blocking',
    scope: 'shard_owner',
    substrate: 'redis-stream',
    maxBatch: 50,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 120,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers XADD the control message they already produce.',
    },
    disablePolicy: 'never',
    recovery: 'Unacked entries stay in the PEL and are reclaimed on shard acquisition.',
    note: 'Blocks for 1s per empty read and wakes immediately on arrival, so idle cost is two reads per second and delivery latency is unaffected. Stream keys are derived from shard ownership rather than rebuilt per read.',
    sites: [
      'apps/aflow-orchestrator/src/services/ControlConsumer.ts',
      'packages/redis/src/streams/control.ts',
      // The shard read helper is shared with the result consumer, which owns its
      // occurrence; listed here because this task reads through it too.
      'packages/redis/src/streams/shardReads.ts',
    ],
  },

  // ==========================================================================
  // Orchestrator — timers, ownership, liveness
  // ==========================================================================
  {
    id: 'orchestrator.timer_dispatch',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Wake delayed starts, retries, snoozes, and delegation timeouts when they come due.',
    invariant: 'A scheduled timer fires once at or after its due time, or survives a crash.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'shard_owner',
    substrate: 'redis-zset',
    baseCadenceMs: 1000,
    maxBatch: 100,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 120,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'One Lua call replaces the ZADD the scheduler already issued.',
    },
    disablePolicy: 'never',
    recovery: 'A claimed timer whose worker dies becomes due again at lease expiry.',
    note: 'One indexed claim per second regardless of how many shards are owned. A claim leases the timer rather than deleting it, so a worker that dies before dispatching does not lose the wake-up.',
    sites: [
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/timers.ts',
      'packages/redis/src/streams/shardTimers.ts',
      // The interval that drives dispatch lives in the result consumer's file;
      // it executes this task, so this entry owns that loop.
      {
        path: 'apps/aflow-orchestrator/src/services/ResultConsumer.ts',
        discovery: ['setInterval'],
      },
    ],
  },
  {
    id: 'orchestrator.stream_retention',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose:
      'Reclaim transport-stream entries every consumer group has delivered and acknowledged.',
    invariant:
      'An entry is removed only after every consumer group has both been delivered and acknowledged it; undelivered work is never trimmed.',
    criticality: 'operational',
    trigger: 'candidate',
    scope: 'per_instance',
    substrate: 'redis-stream',
    baseCadenceMs: 60_000,
    maxBatch: 64,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 1,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'Enqueues and acks arm the candidate set inside the pipeline they already issue.',
    },
    disablePolicy: 'safe',
    recovery:
      'A candidate whose trim did not complete is put back on the set in the same cycle; retention is idempotent and has no deadline.',
    note: 'Job, shard result, and shard control streams are work queues, so they are trimmed to the frontier every consumer group has finished with rather than capped by count — a count cap would delete a backlog out from under an executor that is merely down. One SPOP per cycle when nothing is armed, flat in shards, tenants, and keys. Candidates are armed on enqueue as well as ack, so a stream whose consumer group has been abandoned still reports its growth through the retained-entries metric even though it will never produce another ack. Such a stream is held forever by design: its entries are undelivered work.',
    sites: [
      'apps/aflow-orchestrator/src/services/streamRetention.ts',
      'packages/redis/src/streams/retention.ts',
    ],
  },
  {
    id: 'orchestrator.instance_heartbeat',
    service: 'orchestrator',
    ownerDomain: 'ownership',
    purpose: "Publish this process's liveness so dead shard owners are detectable.",
    invariant:
      "A live orchestrator has an unexpired member in the liveness index, and shard acquisition resolves ownership through the registered owner's entry rather than through any per-shard marker.",
    criticality: 'correctness',
    trigger: 'heartbeat',
    scope: 'per_instance',
    substrate: 'redis-lease',
    baseCadenceMs: 10_000,
    maxBatch: 1,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 6,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'No producer coupling.',
    },
    disablePolicy: 'never',
    recovery: 'Lease expiry is the death signal; a restarted instance re-registers immediately.',
    note: "One sorted-set write per process per cycle, with expired members pruned in the same call, so the cost tracks live processes rather than shards held. Expiry is stamped from Redis time because instances compare each other's leases and clock skew would otherwise decide who is alive.",
    sites: [
      { path: 'apps/aflow-orchestrator/src/index.ts', discovery: ['setInterval'] },
      'packages/redis/src/streams/orchestratorHeartbeat.ts',
    ],
  },
  {
    id: 'host.runtime_inventory',
    // Runs in the paired host executor, not the orchestrator. Naming the wrong
    // owner is not cosmetic: task overrides, ownership and control-plane
    // reporting are resolved by service, so none of them could ever reach it.
    service: 'executor-host',
    ownerDomain: 'ownership',
    purpose:
      "Publish what the operator's machine has installed, so a workspace can say whether it can run something.",
    invariant:
      'An inventory exists only while the executor that observed it runs: written with a lifetime twice its refresh, and renewed by nothing else.',
    criticality: 'feature',
    trigger: 'heartbeat',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 60_000,
    maxBatch: 1,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'No producer coupling — nothing arms this.',
    },
    disablePolicy: 'safe',
    recovery:
      'The key expires on its own, so a stopped executor stops being described within two cycles; a restarted one republishes on start.',
    note: 'Observed rather than declared, because a declared list drifts the first time something is installed. The probe runs a handful of version calls with a short timeout, so a hung binary costs one cycle rather than the process. One SETEX and one ZADD per machine per minute, independent of bindings, jobs or workspaces — the scored set is what keeps listing machines proportional to the live ones rather than to every executor that ever started.',
    sites: [
      // No `setInterval` to declare: this runs through the shared runner, so the
      // cycle guard, jitter, budget and backoff come from there.
      'apps/aflow-executor-host/src/index.ts',
      'apps/aflow-executor-host/src/runtimes.ts',
    ],
  },
  {
    id: 'host.browser_idle',
    service: 'executor-host',
    ownerDomain: 'ownership',
    purpose:
      "Close browser pages nothing has used for their profile's idle limit, and stop a profile's browser once it has had no page for as long.",
    invariant:
      "No page outlives its profile's idle limit unused, and no profile's browser runs pageless for longer than that limit — sign-ins stay on disk, not loaded behind an abandoned page.",
    criticality: 'feature',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 60_000,
    maxBatch: 20,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Traverses the in-memory page table and the browsers this process started.',
    },
    disablePolicy: 'safe',
    recovery:
      "Pages and browsers then stay until the executor stops; shutdown ends every browser it started, and the next boot's orphan sweep ends any it left.",
    note: 'Per instance because the resource is per instance: the browsers are processes this executor started and the pages live in its memory. The executor is not told when a run ends, so this is what bounds a page a run abandoned. A cycle with no browser running reads nothing. The batch counts closures — a page closed or a browser stopped — and a cycle stops at 20, leaving the rest for the next: each closure is one call to a browser on this machine, so 20 sit well inside the cycle budget, while a run that abandoned a page per step still drains at 20 a minute rather than one. A profile with an operation in flight is passed over until that operation ends.',
    sites: [
      'apps/aflow-executor-host/src/browser/idleSweep.ts',
      'apps/aflow-executor-host/src/browser/driver.ts',
    ],
  },
  {
    id: 'host.browser_requests',
    service: 'executor-host',
    ownerDomain: 'ownership',
    purpose:
      "Serve the machine's `aflow browser` requests — a sign-in window, a list — while the watch on the host directory is down.",
    invariant:
      'A request written beside the policy is claimed while its command line still waits for a claim, whether or not the directory can be watched; with the watch up the poll reads nothing.',
    criticality: 'feature',
    trigger: 'candidate',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 1_500,
    maxBatch: 1,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Reads one local directory; nothing in Redis.',
    },
    disablePolicy: 'safe',
    recovery:
      'Without it, a request arriving while the watch is down goes unclaimed and the command line refuses to act on a profile the executor holds, saying which process holds it; the requests pending at startup are still served once.',
    note: 'Polls only while the directory watch is down — a filesystem without one, or a watch that failed — and its cadence sits inside the command line’s three-second claim timeout so a request is claimed before the command line gives up on it. Each cycle is one directory listing on this machine.',
    sites: ['apps/aflow-executor-host/src/browser/requestPoll.ts'],
  },
  {
    id: 'orchestrator.shard_acquisition',
    service: 'orchestrator',
    ownerDomain: 'ownership',
    purpose: 'Claim unowned or expired shards and reclaim their pending stream entries.',
    invariant: 'Every shard with work has exactly one live owner holding a fencing token.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'per_instance',
    substrate: 'redis-lease',
    baseCadenceMs: 30_000,
    maxBatch: 128,
    maxCycleMs: 20_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'No producer coupling.',
    },
    disablePolicy: 'never',
    recovery: 'Startup acquisition plus periodic retry; fencing rejects a stale owner mid-write.',
    sites: [
      {
        path: 'apps/aflow-orchestrator/src/services/ShardManager.ts',
        discovery: [{ rule: 'setInterval', count: 2 }],
      },
    ],
    note: 'One acquire Lua per shard runs only while capacity is free; a full instance short-circuits.',
  },
  {
    id: 'orchestrator.pending_recovery',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Reclaim stream entries left pending by a dead or superseded consumer.',
    invariant: 'A delivered-but-unacked result or control message is eventually reprocessed.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'shard_owner',
    substrate: 'redis-stream',
    baseCadenceMs: 30_000,
    maxBatch: 100,
    maxCycleMs: 20_000,
    idleOperationBudgetPerMinute: 258,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'No producer coupling.',
    },
    disablePolicy: 'never',
    recovery: 'Acquisition reclaim is the crash path; the periodic pass catches stragglers.',
    sites: ['apps/aflow-orchestrator/src/services/ShardManager.ts'],
    note: 'Control is swept across every owned shard each cycle because start_run and retry_run arrive before their run is active; results are swept only on shards holding active runs, where a stranded entry implies one. One registry read covers the whole sweep, and a full sweep of both streams runs every 15 minutes as drift repair. Both consumers re-drain their own pending entries in their read loop, so this covers entries left by a fenced-out instance rather than by a failed handler.',
  },

  // ==========================================================================
  // Orchestrator — projection
  // ==========================================================================
  {
    id: 'orchestrator.projection',
    service: 'orchestrator',
    ownerDomain: 'durability',
    purpose: 'Project Redis session hot state and events into the durable Postgres read model.',
    invariant:
      'Every session mutation — and every durable event its stream still holds — eventually reaches Postgres without losing a newer version.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'singleton',
    substrate: 'redis-zset',
    baseCadenceMs: 3000,
    maxBatch: 50,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 20,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'Arming rides the pipeline the state mutation already issues: two more commands, no extra round trip.',
    },
    featureGate: 'PROJECTION_WORKER_ENABLED',
    disablePolicy: 'breakglass',
    recovery:
      'A claim leases the candidate; an unacknowledged one is redelivered at lease expiry. A version raised mid-projection refuses the acknowledgement and leaves the session due. A candidate is dropped only once a durable failure record names it, and when that record cannot be written — which is what a Postgres outage looks like from here — the candidate stays armed instead.',
    sites: [
      'packages/redis/src/hotState/events.ts',
      {
        path: 'packages/redis/src/hotState/legacyDirtyCarryOver.ts',
        discovery: ['full-set-read'],
      },
      {
        path: 'apps/aflow-orchestrator/src/services/ProjectionWorker.ts',
        discovery: ['setInterval'],
      },
      'packages/redis/src/hotState/projectionCandidates.ts',
      'packages/redis/src/hotState/dirty.ts',
      'packages/database/src/repositories/projectionFailures.ts',
      { path: 'packages/redis/src/shard.ts', discovery: ['full-set-read'] },
    ],
    note: 'One claim EVAL per cycle whether or not anything is due, and it returns only what is due, so cost tracks the backlog rather than how many sessions exist. Version and due time are separate scores on separate indexes: sharing one would force a choice between starving a session that changes often and losing two marks that land in the same millisecond. The attempt ceiling lives on the failure record rather than in the process, so it survives a restart and means the same thing on five instances as on one. This is also where an on_completion schedule fires: recording its occurrences inside the transaction that stamps the run as fired makes the pair retriable, and it reaches every terminal writer rather than the two that remembered to call it. Durable events flush incrementally — for running sessions too — from a per-session cursor on the session row, advanced only in the transaction that inserts them, so the stream MAXLEN cap is a memory backstop rather than a retention policy.',
  },
  // ==========================================================================
  // Orchestrator — reconcilers
  // ==========================================================================
  {
    id: 'orchestrator.step_stall_watchdog',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Surface and recover steps whose executor result will never arrive.',
    invariant: 'A step with no completion path becomes a retryable failure instead of hanging.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'shard_owner',
    substrate: 'redis-zset',
    baseCadenceMs: 30_000,
    maxBatch: 200,
    maxCycleMs: 20_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The deadline is armed inside the scheduling transition that already runs.',
    },
    disablePolicy: 'never',
    recovery:
      'Deadlines persist across restarts, and shard recovery rewrites the hot state of every run it restores, which re-arms them. A candidate the sweep does not reach stays due for the next cycle: reading is non-destructive, so nothing is consumed by a pass that dies part-way.',
    sites: [
      'packages/redis/src/hotState/atomic.ts',
      'packages/redis/src/hotState/step.ts',
      'packages/redis/src/hotState/session.ts',
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/timers.ts',
      'packages/redis/src/hotState/stepStallCandidates.ts',
    ],
    note: 'Reads one bounded, due-ordered slice of the deadline index per cycle, so cost tracks steps past their earliest reapable instant rather than how many sessions hold Redis state. The score is a lower bound on when to look and never a verdict — classifyStepCompletionPath reads the executor in-flight key at examination time and is the only thing that may conclude a step is unreachable. Still piggybacks the timer tick rather than holding its own runner, self-gated to the cadence above.',
  },
  {
    id: 'orchestrator.orphan_recovery',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose:
      'At boot, resolve sessions left RUNNING by a process that died holding their only result.',
    invariant:
      'A session whose in-flight result is irrecoverably lost is paused or failed, never left running.',
    criticality: 'correctness',
    trigger: 'audit',
    scope: 'per_instance',
    substrate: 'redis-zset',
    maxBatch: 500,
    maxCycleMs: 120_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'No producer coupling.',
    },
    disablePolicy: 'never',
    recovery:
      'Runs once per boot before consumers start; the stall watchdog covers the steady state.',
    sites: [
      'packages/redis/src/hotState/atomic.ts',
      'packages/redis/src/hotState/step.ts',
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/recovery.ts',
      'packages/redis/src/hotState/stepStallCandidates.ts',
    ],
    note: 'Boot-only, so it has no cadence and no idle cost. Shares the step-deadline index and the completion-path predicate with the stall watchdog, differing only in cadence, batch ceiling, and its willingness to pause a SCHEDULED agent step rather than fail it.',
  },
  {
    id: 'orchestrator.active_run_reconcile',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Release active-run membership for runs whose session state is gone.',
    invariant: 'The admission count reflects runs that still exist.',
    criticality: 'operational',
    trigger: 'audit',
    scope: 'per_instance',
    substrate: 'redis-zset',
    maxBatch: 5000,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Membership is written by the transitions themselves.',
    },
    disablePolicy: 'safe',
    recovery: 'Runs at boot; a missed pass only leaves the count conservative until the next one.',
    sites: [{ path: 'packages/redis/src/shard.ts', discovery: ['full-set-read'] }],
    note: "A process killed between a run's terminal write and its release leaves that run counted forever, and admission control turns an inflated count into a 429 against real traffic.",
  },
  {
    id: 'orchestrator.barrier_watchdog',
    service: 'orchestrator',
    ownerDomain: 'run-execution',
    purpose: 'Repair parallel barriers whose children finished but never released the parent.',
    invariant: 'A satisfied barrier always resumes its parent.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'shard_owner',
    substrate: 'redis-zset',
    baseCadenceMs: 30_000,
    maxBatch: 100,
    maxCycleMs: 20_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Barrier candidates are armed in the existing barrier mutation.',
    },
    disablePolicy: 'never',
    recovery: 'The candidate ZSET is durable; a missed sweep is retried on the next cycle.',
    note: 'On the standard runner, so cycles cannot overlap and the cadence, batch and cycle ceiling come from this entry rather than from literals at the call site. The peek is bounded and score-ordered; the staleness threshold is a domain constant at the wiring site because it is a property of how long a tool call may legitimately take, not a scheduling budget.',
    sites: [
      'apps/aflow-orchestrator/src/index.ts',
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/scheduling/barrierSweep.ts',
    ],
  },
  {
    id: 'orchestrator.delegation_pending',
    service: 'orchestrator',
    ownerDomain: 'delegation',
    purpose: 'Deliver child-session completions back to a parent waiting on them.',
    invariant: 'A parent in WAITING_ON_CHILD is always released when its children rest.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'shard_owner',
    substrate: 'redis-zset',
    baseCadenceMs: 30_000,
    maxBatch: 50,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The candidate is armed in the existing delegation transition.',
    },
    disablePolicy: 'never',
    recovery: 'Lease expiry re-arms an abandoned candidate; attempts are bounded with backoff.',
    note: "On the standard runner, so cadence and batch come from this entry rather than from the module's own defaults. The lease and attempt ceiling stay at the call site: they bound how long one delegation may be worked and how often it may be retried before escalating, which is a property of the delegation rather than of the drain.",
    sites: [
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/delegationPendingDrain.ts',
    ],
  },
  {
    id: 'orchestrator.delegation_supervision',
    service: 'orchestrator',
    ownerDomain: 'delegation',
    purpose: 'Watch the parent side of a delegation so a child that dies still releases it.',
    invariant:
      'A parent left waiting is always resolved: a rested or vanished child is handed to the delegation lifecycle, and a wait that outlived every child it tracked is released.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'shard_owner',
    substrate: 'redis-zset',
    baseCadenceMs: 30_000,
    maxBatch: 100,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The wait itself arms the marker, inside the session write it already issues.',
    },
    disablePolicy: 'never',
    recovery:
      'Reading is non-destructive and nothing is leased, so a pass that dies leaves its candidates where the next shard owner finds them. Parents already waiting when the index appeared are armed by a one-shot carry-over at boot.',
    note: 'Complements the pending drain rather than duplicating it: that index is armed when a child completes, so it is blind to a child that dies first. This one holds no attempt counter — a healthy wait is pushed forward indefinitely, and every action it takes goes through the existing lifecycle, so escalation stays owned by the drain alone.',
    sites: [
      'packages/redis/src/hotState/atomic.ts',
      'packages/redis/src/hotState/session.ts',
      'packages/redis/src/hotState/delegationSupervisionCandidates.ts',
      {
        path: 'packages/redis/src/hotState/delegationSupervisionCarryOver.ts',
        discovery: ['full-set-read'],
      },
      'apps/aflow-orchestrator/src/index.ts',
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/delegationSupervisionSweep.ts',
    ],
  },
  {
    id: 'orchestrator.workflow_run_reconcile',
    service: 'orchestrator',
    ownerDomain: 'cybernetic',
    purpose:
      'Converge workflow runs whose tasks are complete but whose run never finalized, and write the evaluation envelope a run reached terminal state without.',
    invariant:
      'A completion-pending workflow run always reaches a terminal state, and every terminal cybernetic run records an evaluation decision.',
    criticality: 'correctness',
    trigger: 'candidate',
    // The claim is the exclusion: SKIP LOCKED hands a tenant to one instance
    // inside a cycle and the lease keeps it there across cycles, so this needs
    // no fleet-wide singleton lease on top.
    scope: 'per_instance',
    substrate: 'postgres-due',
    baseCadenceMs: 10_000,
    maxBatch: 100,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 6,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'A row trigger arms the due pointer inside the statement that writes the tenant row.',
    },
    disablePolicy: 'never',
    recovery:
      'A claim leases the tenant rather than clearing it, so a claimant that dies mid-cycle loses nothing at lease expiry. The tenant rows stay authoritative: the pointer is recomputed from them after every claim, so an over-armed pointer costs one wasted claim and cannot go stale in the other direction. Runs in flight before the pointer existed are armed by a one-shot carry-over at boot.',
    sites: [
      'apps/aflow-orchestrator/src/services/cybernetic/workflowRunSweeperLoop.ts',
      'apps/aflow-orchestrator/src/services/cybernetic/evaluationEnvelopeBackfill.ts',
      'packages/database/src/tenant/workflowRunDue.ts',
      'packages/database/src/repositories/workflowRunDue.ts',
    ],
    note: 'Idle cost is one indexed claim per cycle. The pointer holds a row only for a tenant that has reconcilable work, so cost tracks pending runs rather than tenant count.',
  },
  {
    id: 'orchestrator.workflow_progress',
    service: 'orchestrator',
    ownerDomain: 'cybernetic',
    purpose: 'Fan live workflow-task progress out to the surface layer.',
    invariant: 'Progress frames are a live feed only; the workflow record is authoritative.',
    criticality: 'feature',
    trigger: 'blocking',
    scope: 'per_instance',
    substrate: 'redis-stream',
    maxBatch: 100,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 120,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers keep the single XADD they already perform.',
    },
    disablePolicy: 'safe',
    recovery: 'A dropped frame is superseded by the next one; no durable state depends on it.',
    sites: [
      {
        path: 'packages/cybernetic-runtime/src/workflowTaskProgressConsumer.ts',
        discovery: ['blocking-consumer', 'keyspace-scan', { rule: 'full-set-read', count: 2 }],
      },
    ],
    note: "Reads an index of active per-task streams rather than scanning the keyspace, so its cost tracks running tasks. The XREAD stream list is still proportional to active tasks, and the per-task streams stay individually addressable because session catch-up replays one task's stream to rebuild its surface. The remaining scan is a one-time boot seed.",
  },
  {
    id: 'orchestrator.workflow_harness_advance',
    service: 'orchestrator',
    ownerDomain: 'cybernetic',
    purpose: 'Advance workflow harness state from queued advance requests.',
    invariant: 'An advance request is applied once or stays pending for the next owner.',
    criticality: 'correctness',
    trigger: 'blocking',
    scope: 'per_instance',
    substrate: 'redis-stream',
    maxBatch: 50,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 60,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers XADD the advance request they already produce.',
    },
    disablePolicy: 'never',
    recovery: 'Unacked entries stay in the PEL and are reclaimed by the next consumer.',
    sites: [
      {
        path: 'apps/aflow-orchestrator/src/services/cybernetic/workflowHarnessAdvanceConsumer.ts',
        discovery: ['blocking-consumer'],
      },
    ],
  },

  // ==========================================================================
  // Orchestrator — feature maintenance
  // ==========================================================================
  {
    id: 'orchestrator.schedule_evaluator',
    service: 'orchestrator',
    ownerDomain: 'schedules',
    purpose: 'Record an occurrence for every schedule whose next fire time has arrived.',
    invariant:
      'A due occurrence is recorded exactly once: the schedule advance and the dispatch record commit together.',
    criticality: 'feature',
    trigger: 'candidate',
    // The claim is the exclusion: SKIP LOCKED hands a tenant to one instance
    // inside a cycle and the lease keeps it there across cycles, so this needs
    // no fleet-wide leader lock — the lock it replaces was renewed by
    // unconditional SET and could overwrite a successor after lease expiry.
    scope: 'per_instance',
    substrate: 'postgres-due',
    baseCadenceMs: 15_000,
    maxBatch: 100,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 4,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'A row trigger arms the due pointer inside the statement that writes a schedule.',
    },
    featureGate: 'SCHEDULES_ENABLED',
    disablePolicy: 'safe',
    recovery:
      'The schedule row stays due until the advance commits, and the advance cannot commit without the dispatch record; an expired claim is re-claimable. The advance itself is guarded on the row state it was computed from, so an instance working past its tenant lease loses rather than minting a second occurrence for one due time.',
    sites: [
      'apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts',
      'packages/database/src/tenant/duePointers.ts',
    ],
    note: "One indexed empty read per cadence is the complete idle cost. The contended resource is the tenant pointer row: every write to a fire-eligible schedule takes it, including the evaluator's own advance, so a tenant's schedule writes serialise on that row for the duration of the trigger. The batch ceiling bounds occurrences across the whole cycle rather than per claimed tenant: reused per tenant it multiplied by the tenants claimed, and the cycle then outlived the leases that are its only exclusion. A tenant the budget could not reach is handed back still due, and the cycle reports more work rather than waiting a cadence.",
  },
  {
    id: 'orchestrator.schedule_dispatch',
    service: 'orchestrator',
    ownerDomain: 'schedules',
    purpose: 'Lower recorded schedule occurrences to control messages.',
    invariant: 'A recorded occurrence starts exactly one run, or is retired with a reason.',
    criticality: 'feature',
    trigger: 'candidate',
    scope: 'per_instance',
    substrate: 'postgres-due',
    baseCadenceMs: 15_000,
    maxBatch: 100,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 4,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The outbox row is written in the transaction that advances the schedule.',
    },
    featureGate: 'SCHEDULES_ENABLED',
    disablePolicy: 'safe',
    recovery:
      'The record outlives the emit and is deleted only after it; a drain killed between the two is redelivered and loses the control-dispatch idempotency claim, so it retires the record instead of emitting again.',
    sites: [
      'apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts',
      'packages/database/src/repositories/scheduleOutbox.ts',
    ],
    note: 'Its own cycle rather than a tail call of discovery: draining only when something new came due leaves a recorded occurrence waiting on an unrelated schedule anywhere in the fleet. Discovery still drains what it just recorded, so the cadence is recovery latency, not fire latency.',
  },
  {
    id: 'orchestrator.completion_schedule_recorder',
    service: 'orchestrator',
    ownerDomain: 'schedules',
    purpose: "Record on_completion occurrences when a run's terminal state becomes durable.",
    invariant:
      'A durable terminal transition fires its on_completion schedules exactly once, or the firing stays owed on an armed projection candidate.',
    criticality: 'correctness',
    trigger: 'candidate',
    scope: 'singleton',
    substrate: 'redis-zset',
    baseCadenceMs: 3000,
    maxBatch: 50,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        "Rides the projection worker's candidate claim; nothing is armed beyond what the terminal write already armed.",
    },
    featureGate: 'SCHEDULES_ENABLED',
    disablePolicy: 'breakglass',
    recovery:
      'A refused or failed recording throws out of the projection transaction, so the candidate stays armed — and off the projection eviction budget — until recording lands; the fired-at mark makes the retry free rather than a second firing.',
    sites: [
      'apps/aflow-orchestrator/src/services/ScheduleEvaluator.ts',
      'apps/aflow-orchestrator/src/services/ProjectionWorker.ts',
    ],
    note: "Not a runner of its own — it executes inside the projection cycle at the one point guaranteed to see every durable terminal transition. Its mode is deliberately separate from due-time discovery's: disabling discovery is safe (cron firings just wait), while disabling this parks every terminal session's candidate armed and re-flushed each cycle, which is why it needs break-glass.",
  },
  {
    id: 'orchestrator.eval_batch_engine',
    service: 'orchestrator',
    ownerDomain: 'cybernetic',
    purpose:
      'Advance every eval batch that still owes work — dispatch trials, grade the runs they produced, and terminalize.',
    invariant:
      'A launched eval batch reaches a terminal status with every trial graded, its spend accrued against the ceiling, and its validation slice minted; every fixture space its trials created is collected at expiry.',
    criticality: 'correctness',
    trigger: 'candidate',
    // The claim is the exclusion: SKIP LOCKED hands a tenant to one instance
    // inside a cycle and the lease keeps it there across cycles, so this needs
    // no fleet-wide leader lock on top. Trial leases then only have to survive
    // worker death, which is what they were for.
    scope: 'per_instance',
    substrate: 'postgres-due',
    baseCadenceMs: 10_000,
    maxBatch: 25,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 6,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'A row trigger arms the due pointer inside the statement that writes the batch head or a fixture space expiry.',
    },
    disablePolicy: 'breakglass',
    recovery:
      'The batch and trial rows are the state machine, so a pass is a pure re-derivation of what a batch still owes: an expired trial lease is adopted, a trial whose launch died is reconciled against the run ledger rather than re-launched, and the validation slice is minted from the settled rows before the terminal CAS so a crash between them re-derives the identical draw. A claim leases the tenant rather than clearing it, so a claimant that dies mid-cycle loses nothing at lease expiry.',
    sites: [
      'apps/aflow-orchestrator/src/services/cybernetic/evalBatch/evalBatchWorkerLoop.ts',
      'apps/aflow-orchestrator/src/services/cybernetic/evalBatch/EvalBatchEngine.ts',
      'packages/database/src/tenant/evalBatchDue.ts',
      'packages/database/src/repositories/evalBatchDue.ts',
    ],
    note: "Idle cost is one indexed claim per cycle. A tenant with a non-terminal batch stays nominated on purpose — observing its in-flight trials is the work, and no other write reports that a trial's run has finished — so the cadence is the grading latency, and the cycle deliberately never reports more work rather than re-arming at zero delay. Cost tracks tenants with live batches; a tenant whose batches are all terminal is nominated again only when a fixture space comes up for collection. Disabling this strands launched trials ungraded with their spend still accruing and leaks their fixture spaces, which is why it needs break-glass.",
  },
  {
    id: 'orchestrator.session_metadata',
    service: 'orchestrator',
    ownerDomain: 'cybernetic',
    purpose: 'Give conversations a recognizable name and a current summary.',
    invariant:
      'A conversation with committed activity ends with a title and a summary covering the evidence revision they were written from, or a diagnostic saying why not — and never blocks, pauses, or spends a turn of the conversation it describes.',
    criticality: 'feature',
    trigger: 'candidate',
    // The lease is the exclusion: a claim holds the conversation across cycles
    // and instances, so this needs no fleet-wide singleton on top.
    scope: 'per_instance',
    substrate: 'redis-zset',
    baseCadenceMs: 5_000,
    maxBatch: 10,
    maxCycleMs: 120_000,
    idleOperationBudgetPerMinute: 12,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'A committed turn boundary arms the candidate inside the pipeline the session write already issues.',
    },
    disablePolicy: 'safe',
    recovery:
      'A claim leases the conversation rather than consuming it, so a worker that dies mid-generation loses nothing past lease expiry. A newer boundary during generation raises the evidence revision, the acknowledgement no longer matches, and the conversation stays due. A failed generation backs off and retires after three attempts, leaving the deterministic title in place.',
    sites: [
      'apps/aflow-orchestrator/src/services/sessionMetadataTask.ts',
      'packages/redis/src/hotState/sessionMetadataCandidates.ts',
      'packages/cybernetic-runtime/src/sessionMetadataGeneration.ts',
      'packages/database/src/repositories/sessionMetadata.ts',
    ],
    note: 'Idle cost is one indexed range read per cycle. The index holds a member only for a conversation someone has spoken in since it was last named, so cost tracks live conversations rather than stored sessions.',
  },
  {
    id: 'orchestrator.mcp_elicitation_router',
    service: 'orchestrator',
    ownerDomain: 'mcp',
    purpose: 'Route MCP elicitation requests and responses between executor and human.',
    invariant: 'An elicitation response reaches the executor that holds the lease.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'per_instance',
    substrate: 'redis-pubsub',
    maxBatch: 1,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Piggybacks the existing publish.',
    },
    disablePolicy: 'safe',
    recovery: 'A lost message is healed by the elicitation lease reconciler.',
    sites: ['apps/aflow-orchestrator/src/services/mcpElicitationHandler.ts'],
  },
  {
    id: 'orchestrator.mcp_elicitation_reconcile',
    service: 'orchestrator',
    ownerDomain: 'mcp',
    purpose: 'Release elicitation leases held by executors that died mid-prompt.',
    invariant: 'An elicitation whose holder is gone is failed rather than left hanging.',
    criticality: 'feature',
    trigger: 'candidate',
    // The candidate claim is the exclusion: a compare-and-set on the score hands
    // one due lease to one instance, so no fleet-wide lease sits on top of it.
    scope: 'per_instance',
    substrate: 'redis-zset',
    baseCadenceMs: 30_000,
    maxBatch: 100,
    maxCycleMs: 30_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The candidate ZADD rides the existing lease grant and heartbeat Lua.',
    },
    featureGate: 'MCP_ELICITATION_ENABLED',
    disablePolicy: 'safe',
    recovery:
      'The index is re-armed by every lease heartbeat, so an entry lost to eviction returns within one heartbeat period; a claimed candidate whose claimant dies is due again at claim expiry.',
    sites: [
      'apps/aflow-orchestrator/src/services/mcpElicitationReconciler.ts',
      'packages/redis/src/mcpElicitationLeaseCandidates.ts',
    ],
    note: 'Two indexed reads per minute at idle. Under load the cost is one liveness read per distinct holder instance, not per lease: the candidate member carries the holder, so a hash is read only for a holder already found dead. The score is a re-check time rather than the lease deadline, because the reconciler acts on holder death and a healthy lease sits a full TTL from its own expiry.',
  },

  // ==========================================================================
  // Server — watchdog and realtime brokers
  // ==========================================================================
  {
    id: 'server.run_watchdog',
    service: 'server',
    ownerDomain: 'run-execution',
    purpose: 'Make queued work visibly stalled while no orchestrator is alive.',
    invariant: 'A user never watches a queued run sit silent with no orchestrator behind it.',
    criticality: 'operational',
    trigger: 'candidate',
    scope: 'per_instance',
    substrate: 'redis-zset',
    baseCadenceMs: 15_000,
    maxBatch: 200,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 4,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The queued deadline is armed in the existing session start.',
    },
    disablePolicy: 'safe',
    recovery:
      'Purely advisory; the orchestrator owns the real recovery. A claim leases the candidate, so one whose claimant died is stalled by a later cycle instead of being lost.',
    sites: [
      'packages/redis/src/hotState/atomic.ts',
      'packages/redis/src/hotState/session.ts',
      'packages/server-runtime/src/services/runWatchdog.ts',
      'packages/redis/src/hotState/queuedSessionCandidates.ts',
    ],
    note: 'Reads the orchestrator heartbeat first and only touches the queued-session index when it is absent, so the expensive path runs only while the orchestrator is down. The claim leases what it returns, which is what stops every warm instance from writing the same STALLED transition and emitting the same event.',
  },
  {
    id: 'server.space_action_center',
    service: 'server',
    ownerDomain: 'human-in-the-loop',
    purpose: 'Push human-action list changes to subscribed operators.',
    invariant: 'An open human action becomes visible to an authorized actor promptly.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'active_subscription',
    substrate: 'redis-stream',
    maxBatch: 200,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description:
        'The wake PUBLISH after the producing write commits is fire-and-forget — the producing path never waits on it.',
    },
    disablePolicy: 'safe',
    recovery:
      'Snapshot on mount; a rebuild on subscriber join and on Pub/Sub reconnect closes a missed wake.',
    sites: [
      {
        path: 'packages/server-runtime/src/routes/realtimeTopics/spaceActionCenter.ts',
        discovery: ['recursive-timer'],
      },
      'packages/redis/src/actionCenterFocus.ts',
    ],
    note: 'Rebuilds are wake-driven: the pool entry subscribes its one connection to the per-space and per-tenant action-center wake channels (producers: session projection flush, egress/host-request routes, invitation routes, speech-implies-join when it consumes an invitation, the Action Center resolve route) plus the space entity-events channel (workflow-run pause/resume, the paused-contract rewrite, and every Coach mutation announce themselves there). A 2s floor between passes caps a sustained wake stream at the old poll’s cadence — the first wake after a quiet spell still rebuilds immediately; wakes inside the floor coalesce into one trailing pass. A rebuild is 7 space-scoped source reads, each its own `withTenantSchema` transaction, plus one indexed invitation read per subscriber — that read stays per-reader because the source returns the reader’s own rows, and pooling it would replace a structural guarantee with a filter. No timer arms at any point: a subscribed space that nothing changes costs nothing, matching the sibling realtime topics. Cascade deletions still publish no wake — their failure mode is a card that outlives its row rather than an action nobody sees, and a mount, a visibility return, or a reconnect retires it.',
  },
  {
    id: 'server.space_coach_surface',
    service: 'server',
    ownerDomain: 'cybernetic',
    purpose: 'Push Coach surface changes to subscribed operators.',
    invariant: 'A Coach state change becomes visible without a manual refresh.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'active_subscription',
    substrate: 'redis-stream',
    maxBatch: 200,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Entity events already ride the producer transaction.',
    },
    disablePolicy: 'safe',
    recovery:
      'Snapshot on mount; a rebuild on subscriber join and on Pub/Sub reconnect closes a missed wake.',
    sites: ['packages/server-runtime/src/routes/realtimeTopics/spaceCoachSurface.ts'],
    note: 'Rebuilds on any entity event for the space, coalesced to one pass per burst, and once at the snapshot-declared next time-derived change. Pooled per space, so a second watcher adds no rebuild. An idle space holds no timer.',
  },
  {
    id: 'server.space_entity_events',
    service: 'server',
    ownerDomain: 'realtime',
    purpose: 'Deliver durable per-space entity events to subscribers.',
    invariant: 'No durable entity event is skipped for a connected subscriber.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'active_subscription',
    substrate: 'redis-stream',
    maxBatch: 500,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The wake rides the same transaction as the durable append.',
    },
    disablePolicy: 'safe',
    recovery: 'Cursor drain on Pub/Sub reconnect; the durable stream is the recoverable fact.',
    sites: ['packages/server-runtime/src/routes/realtimeTopics/spaceEntityEvents.ts'],
    note: 'Drains from the cursor on the wake and on reconnect, looping until the stream is exhausted. A wake landing mid-drain is re-armed, not dropped. Idle costs nothing.',
  },
  {
    id: 'server.session_tail',
    service: 'server',
    ownerDomain: 'realtime',
    purpose: 'Deliver durable and live session updates to an open chat.',
    invariant: 'A connected client converges on the session record without gaps.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'active_subscription',
    substrate: 'redis-stream',
    maxBatch: 200,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers already append to the session event stream.',
    },
    disablePolicy: 'safe',
    recovery: 'Cursor drain on the wake and on Pub/Sub reconnect.',
    sites: [
      'packages/server-runtime/src/services/sessionTail.ts',
      'packages/server-runtime/src/services/sessionWakeup.ts',
    ],
    note: 'Drains from the cursor on a durable wake and on Pub/Sub reconnect, looping until the stream is exhausted. Idle costs nothing: the safety poll is gone, and both reasons it existed are closed at the source — the wake rides the append transaction (packages/redis/src/hotState/events.ts, hotState/atomic.ts), and the process-wide subscriber wakes its sessions on reconnect (packages/server-runtime/src/services/pubsub.ts), which is the only way to recover a publish lost to an outage since Pub/Sub keeps no backlog. The drain seeks to its cursor rather than reading the stream from the beginning to find it, so a wake costs what followed the cursor rather than the whole retained history.',
  },
  {
    id: 'server.audit_flush',
    service: 'server',
    ownerDomain: 'compliance',
    purpose: 'Flush buffered audit events to Postgres.',
    invariant: 'A buffered audit event is persisted or reported as lost.',
    criticality: 'operational',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'local',
    // Matches the service's own defaults. A registry that overstates the
    // cadence understates how long evidence sits unwritten, which is the one
    // number this entry exists to make visible.
    baseCadenceMs: 1000,
    maxBatch: 100,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Buffering is in-process.',
    },
    disablePolicy: 'safe',
    recovery: 'Shutdown flushes the remaining buffer.',
    sites: [{ path: 'packages/server-runtime/src/plugins/audit.ts', discovery: ['setInterval'] }],
    note: 'Cycles over an in-memory buffer and issues no datastore read when empty.',
  },
  {
    id: 'server.agui_run_stream',
    service: 'server',
    ownerDomain: 'interop',
    purpose: 'Serve the AG-UI run event stream to an external client.',
    invariant: 'A connected AG-UI client receives every run event in order.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'active_subscription',
    substrate: 'redis-pubsub',
    residualPollMs: 1000,
    maxBatch: 100,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 60,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers already append session events.',
    },
    disablePolicy: 'safe',
    recovery: 'Cursor drain on reconnect.',
    sites: [
      {
        path: 'packages/server-runtime/src/routes/agui.ts',
        discovery: [{ rule: 'setInterval', count: 3 }],
      },
    ],
    note: 'Interop surface for external agents; slows its poll while Pub/Sub is live and also re-checks space authorization so a revoked member is disconnected.',
  },
  {
    id: 'server.a2a_task_stream',
    service: 'server',
    ownerDomain: 'interop',
    purpose: 'Serve the A2A task event stream to an external client.',
    invariant: 'A connected A2A client receives every task event in order.',
    criticality: 'feature',
    trigger: 'event',
    scope: 'active_subscription',
    substrate: 'redis-stream',
    residualPollMs: 1000,
    maxBatch: 100,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 60,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers already append session events.',
    },
    disablePolicy: 'safe',
    recovery: 'Cursor drain on reconnect.',
    sites: [{ path: 'packages/server-runtime/src/routes/a2a.ts', discovery: ['setInterval'] }],
    note: 'Interop surface for external agents.',
  },

  // ==========================================================================
  // Executors
  // ==========================================================================
  {
    id: 'executor.heartbeat',
    service: 'shared-runtime',
    ownerDomain: 'ownership',
    purpose: 'Publish executor availability per step type.',
    invariant: 'A step type with a live executor is dispatchable; one without is rejected early.',
    criticality: 'correctness',
    trigger: 'heartbeat',
    scope: 'per_instance',
    substrate: 'redis-lease',
    baseCadenceMs: 10_000,
    maxBatch: 1,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 6,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The availability index is maintained in the same heartbeat pipeline.',
    },
    disablePolicy: 'never',
    recovery: 'TTL expiry is the death signal.',
    sites: [
      {
        path: 'packages/executor-runtime/src/executor/ExecutorRuntime.ts',
        discovery: ['setInterval'],
      },
      { path: 'packages/redis/src/streams/executorHeartbeat.ts', discovery: ['redis-keys'] },
    ],
    note: 'The heartbeat write itself is one command per process, but availability lookups discover heartbeats with KEYS, which blocks Redis for the traversal.',
  },
  {
    id: 'executor.job_consumer',
    service: 'shared-runtime',
    ownerDomain: 'run-execution',
    purpose: "Pull step jobs for this executor's step type off its Redis stream.",
    invariant:
      'Every dispatched job is executed once per attempt or stays pending for the next consumer.',
    criticality: 'correctness',
    trigger: 'blocking',
    scope: 'per_instance',
    substrate: 'redis-stream',
    maxBatch: 10,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 60,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'The orchestrator XADDs the job it already produces.',
    },
    disablePolicy: 'never',
    recovery: 'Unacked entries stay in the PEL and are reclaimed by the next consumer.',
    sites: [{ path: 'packages/redis/src/streams/jobs.ts', discovery: ['blocking-consumer'] }],
  },
  {
    id: 'executor.memory.embed_consumer',
    service: 'executor-memory',
    ownerDomain: 'memory',
    purpose: 'Consume memory embedding jobs and write their vectors.',
    invariant: 'A queued embedding job is embedded once or stays pending for the next consumer.',
    criticality: 'feature',
    trigger: 'blocking',
    scope: 'per_instance',
    substrate: 'redis-stream',
    maxBatch: 10,
    maxCycleMs: 120_000,
    idleOperationBudgetPerMinute: 60,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers XADD the job they already produce.',
    },
    disablePolicy: 'safe',
    recovery: 'Unacked entries stay in the PEL; the backfill pass catches anything never enqueued.',
    sites: [{ path: 'packages/redis/src/memoryEmbed.ts', discovery: ['blocking-consumer'] }],
  },
  {
    id: 'executor.memory.doc_embed_consumer',
    service: 'executor-memory',
    ownerDomain: 'memory',
    purpose: 'Consume memory document embedding jobs and write their vectors.',
    invariant: 'A queued document embedding job is embedded once or stays pending.',
    criticality: 'feature',
    trigger: 'blocking',
    scope: 'per_instance',
    substrate: 'redis-stream',
    maxBatch: 10,
    maxCycleMs: 120_000,
    idleOperationBudgetPerMinute: 60,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Producers XADD the job they already produce.',
    },
    disablePolicy: 'safe',
    recovery: 'Unacked entries stay in the PEL; the backfill pass catches anything never enqueued.',
    sites: [{ path: 'packages/redis/src/memoryDocEmbed.ts', discovery: ['blocking-consumer'] }],
  },
  {
    id: 'executor.step_inflight_refresh',
    service: 'shared-runtime',
    ownerDomain: 'run-execution',
    purpose:
      'Refresh the in-flight key for each step attempt this process has claimed, running or waiting for a slot, and for one it could not give back to its stream until this process stops.',
    invariant: 'A live step attempt is never reaped as stalled by the orchestrator watchdog.',
    criticality: 'correctness',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'redis-lease',
    baseCadenceMs: 10_000,
    maxBatch: 1,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Scoped to one active step attempt; no timer exists at idle.',
    },
    disablePolicy: 'never',
    recovery: 'Key TTL expiry surrenders the step to the stall watchdog.',
    sites: [
      {
        path: 'packages/executor-runtime/src/executor/processJob.ts',
        discovery: [{ rule: 'setInterval', count: 2 }],
      },
      {
        path: 'packages/executor-runtime/src/executor/operationAdmission.ts',
        discovery: ['setInterval'],
      },
    ],
  },
  {
    id: 'executor.compute.session_reaper',
    service: 'executor-compute',
    ownerDomain: 'compute',
    purpose: 'Tear down sandbox containers whose session expired.',
    invariant: 'An expired sandbox does not keep host resources.',
    criticality: 'feature',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 60_000,
    maxBatch: 100,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Traverses an in-memory map of locally owned sessions.',
    },
    disablePolicy: 'safe',
    recovery: 'Executor restart releases every container it owned.',
    sites: ['apps/aflow-executor-compute/src/handlers/sessionManager.ts'],
    note: 'Per instance because the resource is per instance: the sessions are containers this process started, and no other process can tear them down. On the standard runner, so a teardown that outruns the cadence cannot have the next cycle started on top of it.',
  },
  {
    id: 'executor.mcp.connection_pool_reaper',
    service: 'executor-mcp',
    ownerDomain: 'mcp',
    purpose: 'Evict idle MCP client connections held by this process.',
    invariant: 'An idle upstream connection is closed rather than leaked.',
    criticality: 'feature',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 30_000,
    maxBatch: 100,
    maxCycleMs: 10_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Traverses an in-memory pool.',
    },
    disablePolicy: 'safe',
    recovery: 'Process exit closes every pooled connection.',
    sites: ['apps/aflow-executor-mcp/src/handlers/connectionPool.ts'],
    note: 'Per instance because the resource is per instance: the pool holds transports this process opened. On the standard runner, so a slow upstream close cannot have the next sweep started on top of it.',
  },
  {
    id: 'executor.mcp.elicitation_lease_heartbeat',
    service: 'executor-mcp',
    ownerDomain: 'mcp',
    purpose: 'Hold the elicitation lease while this process waits on a human answer.',
    invariant: 'A live elicitation holder is not reconciled away as dead.',
    criticality: 'feature',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'redis-lease',
    baseCadenceMs: 10_000,
    maxBatch: 1,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Scoped to one suspended elicitation; no timer exists at idle.',
    },
    featureGate: 'MCP_ELICITATION_ENABLED',
    disablePolicy: 'safe',
    recovery: 'Lease expiry hands the elicitation to the reconciler.',
    sites: [
      {
        path: 'apps/aflow-executor-mcp/src/handlers/elicitationSuspend.ts',
        discovery: [{ rule: 'setInterval', count: 2 }],
      },
    ],
  },
  {
    id: 'executor.oauth.consent_state_reaper',
    service: 'executor-mcp',
    ownerDomain: 'integrations',
    purpose: 'Delete OAuth consent-state rows past their expiry.',
    invariant: 'Expired consent state does not accumulate indefinitely.',
    criticality: 'feature',
    trigger: 'candidate',
    // The claim is the exclusion: SKIP LOCKED hands a tenant to one replica
    // inside a cycle and the lease keeps it there across cycles.
    scope: 'per_instance',
    substrate: 'postgres-due',
    baseCadenceMs: 300_000,
    maxBatch: 500,
    maxCycleMs: 60_000,
    idleOperationBudgetPerMinute: 0.2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'A row trigger arms the due pointer inside the consent-state insert.',
    },
    disablePolicy: 'safe',
    recovery:
      'Expiry times are durable and the pointer is recomputed from them; a claim whose holder dies is re-claimable at lease expiry.',
    sites: [
      'apps/aflow-executor-mcp/src/oauthConsentStateReaper.ts',
      'packages/database/src/tenant/duePointers.ts',
      'packages/database/src/repositories/tenantDue.ts',
    ],
    note: 'The consent-state table is cross-kind — API connector and MCP server consents are the same rows — so this reaps for the whole integration surface and is only hosted in the MCP executor. One indexed empty read per cadence per replica is the whole idle cost; a consent row exists only between the start and the end of one consent flow, so the steady state has no due tenants at all.',
  },
  {
    id: 'executor.code.harness_progress',
    service: 'executor-code',
    ownerDomain: 'coding-lane',
    purpose: 'Emit progress heartbeats while a coding harness run is in flight.',
    invariant: 'A live coding run reports activity so the lane is not reaped as stalled.',
    criticality: 'feature',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 10_000,
    maxBatch: 1,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Scoped to one active harness run; no timer exists at idle.',
    },
    disablePolicy: 'safe',
    recovery: 'Run completion clears the reporter.',
    sites: [
      {
        path: 'apps/aflow-executor-code/src/backend/harnessProgressReporter.ts',
        discovery: ['setInterval'],
      },
    ],
    note: 'Carries no feature gate on purpose. A feature gate here reads an unset variable as "on", which is the wrong polarity for the coding lane and would leave CODE_LANE_ENABLED looking like the lane switch without being it. The lane breaker (packages/schemas/src/runtime/codeLaneBreaker.ts) is that switch, and it is upstream of this task in every direction: no harness run exists to report on unless it let one start.',
  },
  {
    id: 'executor.memory.embed_backfill',
    service: 'executor-memory',
    ownerDomain: 'memory',
    purpose: 'Re-embed memory documents whose embed job was lost or never enqueued.',
    invariant: 'A document marked pending is eventually embedded.',
    criticality: 'feature',
    trigger: 'candidate',
    // The claim is the exclusion: SKIP LOCKED hands a tenant to one replica
    // inside a cycle and the lease keeps it there across cycles.
    scope: 'per_instance',
    substrate: 'postgres-due',
    baseCadenceMs: 30_000,
    maxBatch: 100,
    maxCycleMs: 120_000,
    idleOperationBudgetPerMinute: 2,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'A row trigger arms the due pointer inside the document write.',
    },
    disablePolicy: 'safe',
    recovery:
      'Pending status is durable and the pointer is recomputed from it; a claim whose holder dies is re-claimable at lease expiry.',
    sites: [
      'apps/aflow-executor-memory/src/embedder.ts',
      'packages/database/src/tenant/duePointers.ts',
    ],
    note: "Two indexed empty reads per minute per replica at idle. The contended resource is the tenant pointer row: every write to a pending document takes it, so all of a tenant's memory writes serialise on that one row for the duration of the trigger. A pending document stays pending until its embedding lands, so a tenant with a backlog is re-claimed each cadence and its jobs re-published — the stream consumer, not the pointer, is what makes that idempotent.",
  },

  // ==========================================================================
  // MCP server
  // ==========================================================================
  {
    id: 'mcp-server.session_store_cleanup',
    service: 'mcp-server',
    ownerDomain: 'mcp',
    purpose: 'Expire in-memory MCP auth sessions past their TTL.',
    invariant: 'An expired auth session cannot be reused.',
    criticality: 'operational',
    trigger: 'active-resource',
    scope: 'per_instance',
    substrate: 'local',
    baseCadenceMs: 300_000,
    maxBatch: 1000,
    maxCycleMs: 5_000,
    idleOperationBudgetPerMinute: 0,
    hotPathProducerBudget: {
      maxAdditionalNetworkRoundTrips: 0,
      description: 'Traverses an in-memory map.',
    },
    disablePolicy: 'safe',
    recovery: 'Process restart clears the store.',
    sites: [{ path: 'apps/aflow-mcp/src/auth/SessionStore.ts', discovery: ['setInterval'] }],
  },
];

/**
 * Wildcard/keyspace discovery that survives outside the candidate model. Each
 * exception is operator-, migration-, or anomaly-triggered — never a recurring
 * scheduler — and carries the bound that keeps it that way.
 */
const SCAN_EXCEPTIONS: readonly BackgroundScanExceptionInput[] = [
  {
    site: 'packages/web-product/src/ui/lib/oauthConsentPopup.ts',
    discovery: ['setInterval'],
    owner: 'web',
    reason:
      'A browser watching a consent popup it opened. There is no event for "the user closed that window", so polling is how the web platform answers the question — and it is a question about one window in one tab, not work discovered on a server.',
    bound:
      'One interval per popup, started when the window opens and cleared when it closes or the component unmounts; nothing about its cost scales with anything this fleet holds.',
  },
  {
    site: 'packages/web-product/src/ui/hooks/session-events-broker.ts',
    discovery: [{ rule: 'recursive-timer', count: 2 }],
    owner: 'web',
    reason:
      "A browser reconnect backoff, not background work on a server. It exists only while a tab holds a session open, and the registry above bounds processes — a timer in someone else's browser is bounded by that tab, not by this fleet.",
    bound:
      'Armed only by a transport error or a reconcile, cleared on connect, and capped at MAX_RECONNECT_ATTEMPTS; one entry per session the tab is watching, torn down when the last subscriber releases it.',
  },
  {
    site: 'packages/web-product/src/ui/hooks/use-session-presence.ts',
    discovery: ['setInterval'],
    owner: 'web',
    reason:
      'The presence heartbeat a tab sends while someone has a session open. It is what keeps the entry alive, so its absence is the signal that the viewer left; it also carries whether this tab is still typing, which is why typing decays without a second timer.',
    bound:
      'One interval per open session per tab, started with the subscription and cleared when it ends; its cost does not grow with sessions, spaces, or other viewers.',
  },
  {
    site: 'packages/web-product/src/ui/components/workflow-run-surface/useWorkflowRunPauseRefresh.ts',
    discovery: ['recursive-timer'],
    owner: 'web',
    reason:
      'A bounded re-fetch wave in a browser, not a scheduler. The rich pause contract lives behind `workflow.run.detail` rather than on the SSE event, and one-shot rehydration has already settled by the time a run pauses mid-flight, so without this the surface holds only the coarse reason string.',
    bound:
      'Three delays and then it gives up; armed only while a mounted run is paused without a contract, and cleared on unmount or on the contract arriving.',
  },
  {
    site: 'packages/web-product/src/ui/components/workflow-run-surface/useWorkflowRunUsageRefresh.ts',
    discovery: ['recursive-timer'],
    owner: 'web',
    reason:
      "A browser waiting for the projection worker's next flush to carry a finished task's usage. Polling is how a client learns that a write it does not participate in has landed.",
    bound:
      'Three widening delays per wave and then it gives up; a later task completing or a manual refresh starts a new one. Armed only while a mounted run has a terminal task whose usage is still missing.',
  },
  {
    site: 'packages/web-product/src/ui/lib/realtimeClient.ts',
    discovery: ['setInterval'],
    owner: 'web',
    reason:
      'The socket heartbeat a browser keeps while a tab is open. Same reasoning as the broker beside it: this is a client holding its own connection, not a process discovering work.',
    bound:
      'One interval per tab, started with the socket and cleared when it closes; its cost does not grow with sessions, spaces, or anything the tab subscribes to.',
  },
  {
    site: 'packages/redis/src/streams/shardTimers.ts',
    discovery: ['full-set-read'],
    owner: 'orchestrator',
    reason:
      'The one-off migration of timers written before shard timers carried ids reads each shard set whole, because a pre-id member cannot be found by the id it lacks.',
    bound:
      'Migration-triggered and run once per deployment, over a fixed set of shards rather than anything discovered, and deleted when no deployment can still hold a pre-id timer.',
  },
  {
    site: 'packages/cybernetic-runtime/src/coachTriggerValidity.ts',
    discovery: ['full-set-read'],
    owner: 'cybernetic',
    reason:
      "Clearing a skill's pending-repair fingerprints reads the space's set whole: the members carry a slug prefix, and Redis has no way to remove by prefix.",
    bound:
      "Triggered by one skill's invalid-to-valid transition, never by a scheduler, and sized by a single space's outstanding repairs.",
  },
  {
    site: 'packages/server-runtime/src/routes/hostPairing.ts',
    discovery: ['full-set-read'],
    owner: 'ownership',
    reason:
      'The host status view reads the set each paired executor announces itself into, to report which machines are connected and what they have installed.',
    bound:
      'Request-scoped and admin-only, never reached from a scheduler, and sized by LIVE machines rather than by everything that has ever paired: members are scored by when each was last heard from, and the read drops anything older than an inventory lifetime before listing. A plain set only shrank on a clean shutdown, so every crashed executor left a name behind for good.',
  },
  {
    site: 'packages/redis/src/streams/engineHealth.ts',
    discovery: ['redis-keys'],
    owner: 'ownership',
    reason: 'Operator health view enumerates executor heartbeats for the diagnostics page.',
    bound: 'Request-scoped and admin-only; never reached from a scheduler.',
  },
  {
    site: 'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/coachCrud.ts',
    discovery: [{ rule: 'full-set-read', count: 2 }],
    owner: 'cybernetic',
    reason: 'Reads one bounded per-session Coach proposal ledger key.',
    bound: 'Keyed by a single coach session; not keyspace discovery.',
  },
  {
    site: 'packages/redis/src/hotState/session.ts',
    discovery: [{ rule: 'redis-keys', count: 2 }],
    owner: 'run-execution',
    reason: 'Corrupt-state salvage locates the quarantine copies of one session.',
    bound: 'Pattern is anchored to a single tenant and run; runs only after a state corruption.',
  },
  {
    site: 'packages/redis/src/sessionResidue.ts',
    discovery: ['keyspace-scan'],
    owner: 'run-execution',
    reason: 'Clears leftover keys for one purged session.',
    bound: 'Patterns are anchored to a single session; triggered by that purge, not a schedule.',
  },
  {
    site: 'packages/cybernetic-runtime/src/spaceLifecycle.ts',
    discovery: ['keyspace-scan'],
    owner: 'spaces',
    reason: 'Space deletion must find sessions still active in the space being removed.',
    bound: 'Bounded SCAN with COUNT 200, anchored to one tenant; runs once per deletion attempt.',
  },
  {
    site: 'packages/redis/src/mcpElicitationLeaseRollout.ts',
    discovery: ['keyspace-scan'],
    owner: 'mcp',
    reason:
      'Arms the elicitation lease candidate index from leases held when it was installed — the ' +
      'population whose holders the installing deploy kills is the one nothing else re-arms.',
    bound:
      'Guarded by a fleet-wide marker, so it walks the lease prefix once per rollout and never ' +
      'again; not wired to any scheduler.',
  },
  {
    site: 'packages/redis/src/entityEventsLegacyRelabel.ts',
    discovery: ['keyspace-scan'],
    owner: 'realtime',
    reason: 'One-time relabel of entity-event streams written before the taxonomy reset.',
    bound: 'Migration only; not wired to any scheduler.',
  },
  {
    site: 'packages/authz/src/cache.ts',
    discovery: ['redis-keys'],
    owner: 'access-control',
    reason: 'Drops every cached RBAC decision for one user when their membership changes.',
    bound:
      'Triggered by the membership mutation itself, never by a scheduler; patterns are anchored ' +
      'to one tenant and user.',
  },
  {
    site: 'packages/server-runtime/src/plugins/tenant.ts',
    discovery: ['redis-keys'],
    owner: 'access-control',
    reason: 'Drops space-scoped caches for one user when their membership changes.',
    bound: 'Triggered by the membership mutation itself; patterns are anchored to one user.',
  },
  {
    site: 'apps/aflow-orchestrator/src/services/GuardrailGate/policyCompiler.ts',
    discovery: ['keyspace-scan'],
    owner: 'guardrails',
    reason: 'Drops compiled guardrail policies for one tenant when its policy set changes.',
    bound:
      'Triggered by the policy mutation itself; bounded SCAN with COUNT 100 anchored to one tenant.',
  },
  {
    site: 'packages/executor-runtime/src/timeout.ts',
    discovery: ['recursive-timer'],
    owner: 'run-execution',
    reason: "Re-arms a step attempt's deadline when progress extends it.",
    bound: 'Scoped to one in-flight step attempt; cleared when the attempt settles.',
  },
  {
    site: 'packages/lib/src/shutdown.ts',
    discovery: ['recursive-timer'],
    owner: 'run-execution',
    reason:
      "Re-reads a draining executor's deadline when it falls due, since a step that was still queued has a timeout of its own by then and a progress-aware one has slid.",
    bound:
      'One timer per process, armed only once a drain begins; cleared when the last step ends, and never re-armed once the latest deadline has passed.',
  },
  {
    site: 'packages/database/src/tenant/applyAll.ts',
    discovery: ['tenant-enumeration'],
    owner: 'platform',
    reason: 'Migration fan-out across tenant schemas.',
    bound: 'Deploy/release phase only; never runs from a scheduler.',
  },
  {
    site: 'packages/database/src/seeds/cyberneticAgents.ts',
    discovery: ['tenant-enumeration'],
    owner: 'platform',
    reason: 'Seed fan-out across tenant schemas.',
    bound: 'Seed command only.',
  },
  {
    site: 'packages/database/src/seeds/capabilityFlows.ts',
    discovery: ['tenant-enumeration'],
    owner: 'platform',
    reason: 'Seed fan-out across tenant schemas.',
    bound: 'Seed command only.',
  },
];

export const BACKGROUND_TASKS: readonly BackgroundTaskDefinition[] = DEFINITIONS.map((task) =>
  BackgroundTaskDefinitionSchema.parse(task),
);

export const BACKGROUND_SCAN_EXCEPTIONS: readonly BackgroundScanException[] = SCAN_EXCEPTIONS.map(
  (exception) => BackgroundScanExceptionSchema.parse(exception),
);

const BY_ID = new Map(BACKGROUND_TASKS.map((task) => [task.id, task]));

export function getBackgroundTask(id: string): BackgroundTaskDefinition | undefined {
  return BY_ID.get(id);
}

export function isRegisteredBackgroundTask(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * `file -> mechanism -> declared occurrences`, summed across every task and
 * exception that names the file.
 *
 * Ownership is per occurrence, not per file: two tasks sharing a file each
 * declare the loops they own, and the total must match what the scanner finds.
 * Declaring only the mechanism would let a second unrelated loop join a file
 * that already has one and still pass.
 */
export function declaredBackgroundDiscovery(): ReadonlyMap<
  string,
  ReadonlyMap<BackgroundDiscoveryRule, number>
> {
  const declared = new Map<string, Map<BackgroundDiscoveryRule, number>>();
  const add = (
    path: string,
    claims: ReadonlyArray<{ rule: BackgroundDiscoveryRule; count: number }>,
  ): void => {
    const perFile = declared.get(path) ?? new Map<BackgroundDiscoveryRule, number>();
    for (const claim of claims) {
      perFile.set(claim.rule, (perFile.get(claim.rule) ?? 0) + claim.count);
    }
    declared.set(path, perFile);
  };
  for (const task of BACKGROUND_TASKS) {
    for (const site of task.sites) add(site.path, site.discovery);
  }
  for (const exception of BACKGROUND_SCAN_EXCEPTIONS) {
    add(exception.site, exception.discovery);
  }
  return declared;
}

/** Every repo-relative path named by a registered task or an exception. */
export function declaredBackgroundSitePaths(): ReadonlySet<string> {
  return new Set(declaredBackgroundDiscovery().keys());
}
