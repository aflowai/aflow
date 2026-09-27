/**
 * Mock Executor Service (DEV-ONLY)
 *
 * Starts one ExecutorRuntime per configured step type, each backed by a MockHandler.
 *
 * Why:
 * - Validate Redis Streams wiring and result emission early
 * - Provide deterministic success/failure/pause behavior via an input `__mock` directive
 */
// Must precede all other imports so Sentry can patch redis/pg before they load.
import './instrument.js';
import {
  ExecutorRuntime,
  DEFAULT_EXECUTOR_CONFIG,
  createServiceLogger,
  type ExecutorDependencies,
} from '@aflow/executor-runtime';
import {
  getRedisConnection,
  closeRedisConnection,
  createBlockingRedisConnection,
  getExecutorRedisConfig,
  quitRedisWithTimeout,
  attachRedisErrorGuard,
  type BlockingRedisConnection,
} from '@aflow/redis';
import { createShutdownController, attachSignalHandlers } from '@aflow/lib';
import { resolvePayloadStore } from '@aflow/payload-store';
import { StreamKeys } from '@aflow/schemas';

import { MockHandler } from './handlers/mockHandler.js';

const log = createServiceLogger('mock-executor');

const ALL_STEP_TYPES = [
  'ai',
  'api',
  'user',
  'memory',
  'search',
  'compute',
  'agent',
  'eval',
  'guardrail',
  'ui',
  'mcp',
  'catalog',
  'space',
  'workflow',
] as const;

type StepType = (typeof ALL_STEP_TYPES)[number];

function parseStepTypesEnv(raw: string | undefined): StepType[] {
  if (!raw) return Array.from(ALL_STEP_TYPES);
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return requested.filter((s): s is StepType => (ALL_STEP_TYPES as readonly string[]).includes(s));
}

async function main(): Promise<void> {
  const hostname = process.env['HOSTNAME'] ?? `mock-executor-${String(process.pid)}`;
  const stepTypes = parseStepTypesEnv(process.env['MOCK_STEP_TYPES']);

  const redis = getRedisConnection(getExecutorRedisConfig());

  const { store: payloadStore, reason: payloadStoreReason } = resolvePayloadStore({
    redis,
    allowMemory: true,
  });

  log.info('Starting Mock Executor (DEV-ONLY)', {
    stepTypes: stepTypes.join(', '),
    payloadStore: payloadStoreReason,
  });

  // Start one runtime per step type (single process convenience).
  const runtimes: ExecutorRuntime[] = [];
  const blockingConnections: BlockingRedisConnection[] = [];
  for (const stepType of stepTypes) {
    const redisBlocking = createBlockingRedisConnection(
      `${hostname}-${stepType}-blocking`,
      getExecutorRedisConfig(),
    );
    blockingConnections.push(redisBlocking);

    const deps: ExecutorDependencies = {
      redis,
      redisBlocking,
      payloadStore,
    };

    const runtime = new ExecutorRuntime(
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        consumerName: `${hostname}-${stepType}`,
        // Use the default consumer group to work with the orchestrator's addStepJob
        consumerGroup: `exec_${stepType}`,
        streamKey: StreamKeys.jobStream(stepType),
        stepType,
        concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '10', 10),
        defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '30000', 10),
      },
      deps,
    );

    runtime.registerHandler(new MockHandler(stepType));
    await runtime.start();
    runtimes.push(runtime);

    log.info('Mock executor runtime started', { stepType });
  }

  const controller = createShutdownController({
    name: 'Mock Executor',
    logger: log,
    onShutdown: async () => {
      for (const rt of runtimes) {
        await rt.stop();
      }
      for (const c of blockingConnections) {
        await quitRedisWithTimeout(c);
      }
      await closeRedisConnection();
    },
  });

  attachRedisErrorGuard(redis, () => controller.shuttingDown, log);
  for (const c of blockingConnections) {
    attachRedisErrorGuard(c, () => controller.shuttingDown, log);
  }
  attachSignalHandlers({ onShutdown: () => controller.shutdownOnce(), exitCode: 0 });
}

main().catch((error: unknown) => {
  log.error('Failed to start Mock Executor', { error });
  process.exit(1);
});
