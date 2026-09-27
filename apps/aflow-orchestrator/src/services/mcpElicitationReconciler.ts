/**
 * Release elicitation leases held by MCP executors that died mid-prompt.
 *
 * Candidates come from the lease deadline index, so a cycle asks which leases
 * are due a look rather than asking the keyspace which leases exist. Liveness is
 * still the only verdict — a candidate is due because its re-check time passed,
 * never because anything concluded its holder was gone — and the check is
 * memoized per holder, so a cycle over many leases costs one liveness read per
 * distinct executor instance.
 */
import type { Redis } from 'ioredis';
import {
  appendSessionEvent,
  claimMcpElicitationLeaseCandidate,
  dropMcpElicitationLeaseCandidate,
  forceDeleteMcpElicitationLease,
  isExecutorConsumerAlive,
  peekDueMcpElicitationLeaseCandidates,
  readMcpElicitationLease,
  refreshMcpElicitationLeaseCandidate,
  deleteMcpElicitationRequest,
  seedMcpElicitationLeaseCandidatesOnce,
  type McpElicitationLeaseCandidate,
  type SessionEvent,
} from '@aflow/redis';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane, type BackgroundTaskMode } from '@aflow/schemas';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';

const TASK_ID = 'orchestrator.mcp_elicitation_reconcile';

export interface McpElicitationReconcilerOptions {
  redis: Redis;
  intervalMs?: number;
  maxBatch?: number;
  maxCycleMs?: number;
  /** Override the registry's mode, for tests. Production resolves it. */
  mode?: BackgroundTaskMode;
}

export interface McpElicitationReconcilerHandle {
  start(): void;
  stop(): Promise<void>;
  /** Run one cycle now. Used by tests and operator tools. */
  sweepOnce(): Promise<BackgroundTaskCycleResult>;
}

export function createMcpElicitationReconciler(
  opts: McpElicitationReconcilerOptions,
): McpElicitationReconcilerHandle {
  const log = getOrchestratorLogger();
  const runtime = backgroundTaskControlPlane().resolve(TASK_ID);
  const intervalMs = opts.intervalMs ?? runtime.intervalMs ?? 30_000;
  const maxBatch = opts.maxBatch ?? runtime.maxBatch;
  const maxCycleMs = opts.maxCycleMs ?? runtime.maxCycleMs;

  async function reap(candidate: McpElicitationLeaseCandidate): Promise<boolean> {
    const lease = await readMcpElicitationLease(opts.redis, candidate.elicitationId);
    if (lease?.executorInstanceId !== candidate.executorInstanceId) {
      // The lease was released, expired, or re-acquired by a peer under its own
      // member. Either way this candidate stands for a lease that no longer
      // exists, and reaping on its authority would delete a live one.
      await dropMcpElicitationLeaseCandidate(opts.redis, candidate);
      return false;
    }

    // Emit before deleting: the event is what clears the form in front of a
    // human, and the hash it is assembled from is the only place those
    // identifiers live.
    await emitExecutorLost(opts.redis, lease);
    await forceDeleteMcpElicitationLease(
      opts.redis,
      candidate.executorInstanceId,
      candidate.elicitationId,
    );
    await deleteMcpElicitationRequest(opts.redis, lease.tenantId, candidate.elicitationId);
    log.info('[mcp-elicitation-reconciler] reaped orphaned lease', {
      elicitationId: candidate.elicitationId,
      deadExecutorInstanceId: candidate.executorInstanceId,
      bindingId: lease.bindingId,
      ...(lease.sessionId ? { sessionId: lease.sessionId } : {}),
    });
    return true;
  }

  const runner: BackgroundTaskRunner = createBackgroundTaskRunner(
    {
      taskId: TASK_ID,
      scope: runtime.scope,
      intervalMs,
      maxBatch,
      maxCycleMs,
      mode: opts.mode ?? runtime.mode,
      logger: log,
    },
    async (ctx): Promise<BackgroundTaskCycleResult> => {
      const candidates = await peekDueMcpElicitationLeaseCandidates(opts.redis, ctx.maxBatch);
      if (candidates.length === 0) return { candidates: 0 };

      // One liveness read per distinct holder, not per lease: the executor
      // heartbeat is a per-instance fact and a cycle that asked once per
      // candidate would have kept the per-lease cost the keyspace walk had.
      const liveness = new Map<string, boolean>();
      let processed = 0;
      let failed = 0;
      for (const candidate of candidates) {
        if (ctx.budgetExhausted()) break;
        try {
          let alive = liveness.get(candidate.executorInstanceId);
          if (alive === undefined) {
            alive = await isExecutorConsumerAlive(opts.redis, 'mcp', candidate.executorInstanceId);
            liveness.set(candidate.executorInstanceId, alive);
          }
          if (alive) {
            if (ctx.mode !== 'observe') {
              await refreshMcpElicitationLeaseCandidate(opts.redis, candidate);
            }
            continue;
          }
          if (ctx.mode === 'observe') continue;
          // Hold the candidate for this cycle's budget. Reaping emits an event
          // and deletes keys, so two orchestrators finding the same dead holder
          // must not both act; the claim leases rather than removes, so a
          // claimant that dies leaves the work where the next cycle finds it.
          const claimed = await claimMcpElicitationLeaseCandidate(
            opts.redis,
            candidate,
            Date.now() + maxCycleMs,
          );
          if (!claimed) continue;
          if (await reap(candidate)) processed++;
        } catch (err) {
          failed++;
          log.warn('[mcp-elicitation-reconciler] failed to process lease', {
            elicitationId: candidate.elicitationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (backgroundWorkVerboseLogsEnabled()) {
        log.info('[background-work] mcp-elicitation-reconciler cycle', {
          trigger: 'candidate',
          candidates: candidates.length,
          processed,
          failed,
        });
      }

      return {
        candidates: candidates.length,
        processed,
        failed,
        hasMore: candidates.length === ctx.maxBatch,
      };
    },
  );

  return {
    start(): void {
      void seedMcpElicitationLeaseCandidatesOnce(opts.redis)
        .then((result) => {
          if (result.ran && result.armed > 0) {
            log.info('[mcp-elicitation-reconciler] seeded lease candidate index', {
              scanned: result.scanned,
              armed: result.armed,
            });
          }
        })
        .catch((err: unknown) => {
          log.warn('[mcp-elicitation-reconciler] lease candidate seed failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      runner.start();
    },
    stop: () => runner.stop(),
    sweepOnce: () => runner.runOnce(),
  };
}

async function emitExecutorLost(
  redis: Redis,
  lease: NonNullable<Awaited<ReturnType<typeof readMcpElicitationLease>>>,
): Promise<void> {
  // Workflow-task dispatch (no host session) has no UI artifact to clear — skip
  // the event but still reap the keys.
  if (!lease.sessionId) return;
  const event: SessionEvent = {
    eventId: crypto.randomUUID(),
    eventType: 'McpElicitationExecutorLost',
    timestamp: Date.now(),
    sessionId: lease.sessionId,
    stepExecutionId: lease.stepExecutionId,
    stepType: 'mcp',
    metadata: {
      elicitationId: lease.elicitationId,
      bindingId: lease.bindingId,
      serverId: lease.serverId,
      deadExecutorInstanceId: lease.executorInstanceId,
    },
  };
  await appendSessionEvent(redis, lease.tenantId, lease.sessionId, event);
}
