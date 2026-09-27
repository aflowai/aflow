// Must precede all other imports so Sentry can patch redis/pg before they load.
import './instrument.js';
import {
  ExecutorRuntime,
  DEFAULT_EXECUTOR_CONFIG,
  createServiceLogger,
  type ExecutorConfig,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import {
  getRedisConnection,
  closeRedisConnection,
  createRedisConnection,
  createBlockingRedisConnection,
  getExecutorRedisConfig,
  quitRedisWithTimeout,
  attachRedisErrorGuard,
} from '@aflow/redis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import { StreamKeys, ConsumerGroups } from '@aflow/schemas';
import { createDatabase, getDatabaseConfig } from '@aflow/database';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { ComputeExecHandler } from './handlers/computeExecHandler.js';
import { SessionManager } from './handlers/sessionManager.js';
import { WorkspaceManager } from './handlers/workspaceManager.js';
import { runSandboxSelfTest } from './handlers/sandboxSelfTest.js';

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): ExecutorConfig {
  const hostname = process.env['HOSTNAME'] ?? `compute-executor-${String(process.pid)}`;

  return {
    ...DEFAULT_EXECUTOR_CONFIG,
    consumerName: hostname,
    consumerGroup: ConsumerGroups.executor('compute'),
    streamKey: StreamKeys.jobStream('compute'),
    stepType: 'compute',
    // Lower concurrency — each job spawns a Docker container with resource limits
    concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '5', 10),
    // Executor-level timeout — must exceed the max container timeout (3600s max + startup overhead)
    defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '3660000', 10),
  };
}

// ============================================================================
// Main
// ============================================================================

const log = createServiceLogger('compute-executor');

async function main(): Promise<void> {
  log.info('Starting Compute Executor...');

  const redis = getRedisConnection(getExecutorRedisConfig());
  const redisBlocking = createBlockingRedisConnection(
    `compute-executor-${String(process.pid)}-blocking`,
    getExecutorRedisConfig(),
  );
  const redisSubscriber = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `compute-executor-${String(process.pid)}-subscriber`,
  });

  // Initialize database connection for loading space compute policies
  let db: PostgresJsDatabase | undefined;
  try {
    const dbConfig = getDatabaseConfig();
    const dbInstance = createDatabase(dbConfig);
    db = dbInstance.db;
    log.info('Database connection established for compute policy resolution');
  } catch (err: unknown) {
    log.warn('Database not available — compute policy checks will deny all requests', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sessionManager = new SessionManager({
    log,
    maxTotalMemoryMb: parseInt(process.env['SESSION_MAX_TOTAL_MEMORY_MB'] ?? '12288', 10),
    maxTotalCpuCores: parseInt(process.env['SESSION_MAX_TOTAL_CPU_CORES'] ?? '6', 10),
    maxSessions: parseInt(process.env['SESSION_MAX_CONCURRENT'] ?? '5', 10),
  });
  sessionManager.startReaper();

  const controller = createShutdownController({
    name: 'Compute Executor',
    logger: log,
    onShutdown: async () => {
      // Shutdown sessions first (checkpoint + destroy containers)
      await sessionManager.shutdownAll();
      await runtime.stop();
      await quitRedisWithTimeout(redisBlocking);
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  attachRedisErrorGuard(redisBlocking, () => controller.shuttingDown, log);

  // No in-memory fallback: this process writes refs another one reads, and a
  // process-local store would resolve none of them. Refusing to start names
  // the missing configuration; taking it would surface as empty step inputs.
  const resolved = resolvePayloadStore({ redis });
  if (!resolved) {
    log.error(
      'No payload store: set PHOENIX_PAYLOAD_DIR, configure GCS, or leave USE_REDIS_PAYLOAD_STORE unset so Redis can serve it.',
    );
    process.exit(1);
  }
  const payloadStore = resolved.store;
  log.debug(resolved.reason);

  // Build dependencies
  const deps: ExecutorDependencies = {
    redis,
    redisBlocking,
    redisSubscriber,
    payloadStore,
  };

  const workspaceManager = new WorkspaceManager({
    log,
    db,
    redis,
    payloadStore,
  });
  sessionManager.setLifecycleHooks({
    beforeDestroy: async (payload) => {
      const ws = payload.workspace;
      if (!ws) return;
      // Best-effort flush. Errors are logged inside; SessionManager swallows
      // them so destruction always proceeds.
      const [tenantId, runId] = payload.key.split(':') as [string, string];
      const reason: 'session-end' | 'idle' =
        payload.reason === 'idle' || payload.reason === 'max_lifetime' ? 'idle' : 'session-end';
      try {
        const result = await workspaceManager.flush({
          tenantId: tenantId as never,
          runId: runId as never,
          spaceId: ws.spaceId,
          hostDir: ws.hostDir,
          // Reviewer fix: forward the resolved Math.min(agent, policy) quotas
          // captured at hydrate time so flush enforces the same caps the agent
          // saw — instead of silently falling back to DEFAULT_WORKSPACE_QUOTAS.
          quotas: ws.quotas,
          reason,
        });
        if (result.conflicts.length > 0 || result.skipped.length > 0) {
          log.warn('Workspace flush had conflicts or skipped files', {
            tenantId,
            runId,
            reason,
            conflictCount: result.conflicts.length,
            skippedCount: result.skipped.length,
            conflicts: result.conflicts.map((c) => ({ path: c.path, sidecar: c.sidecarPath })),
            skipped: result.skipped,
          });
        }
      } finally {
        // Review fix: release (host dir + Redis manifest) MUST run even if
        // flush() threw on an infra failure — otherwise the tmp workspace dir
        // and manifest leak on teardown.
        await workspaceManager.release(tenantId as never, runId as never, ws.hostDir);
      }
    },
  });

  // Verify the sandbox bind-mount path namespace before accepting jobs. A
  // misconfigured Docker-in-Docker mount makes every workspace / inputPaths /
  // /tmp/output mount silently empty (the "hydrated but empty" bug); this probe
  // turns that into a loud boot failure instead of a confusing mid-run error.
  const selfTestOk = await runSandboxSelfTest(log);
  if (!selfTestOk) {
    log.error('Refusing to start compute executor — sandbox bind-mount self-test failed');
    process.exit(1);
  }

  // Create executor runtime
  const config = getConfig();
  const runtime = new ExecutorRuntime(config, deps);

  // Signal handlers wire onShutdown → runtime.stop(); attach only after runtime exists.
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });

  // Register handler with session manager
  runtime.registerHandler(new ComputeExecHandler({ db, sessionManager, redis, workspaceManager }));

  // Start the executor
  await runtime.start();

  log.info('Compute Executor started', {
    pid: process.pid,
    consumer: config.consumerName,
    group: config.consumerGroup,
    stream: config.streamKey,
    concurrency: config.concurrency,
    sessionsEnabled: true,
    maxSessions: sessionManager.activeCount,
  });
}

main().catch((error: unknown) => {
  log.error('Failed to start Compute Executor', { error });
  process.exit(1);
});
