/**
 * The host executor's two runtimes and the connections each one holds.
 */
import { ExecutorRuntime, DEFAULT_EXECUTOR_CONFIG } from '@aflow/executor-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import type { BlockingRedisConnection } from '@aflow/redis';
import { ConsumerGroups, StreamKeys } from '@aflow/schemas';
import type { Redis } from 'ioredis';

export const STEP_TYPE = 'host';
export const BROWSER_STEP_TYPE = 'browser';

export interface HostRuntimes {
  runtime: ExecutorRuntime;
  browserRuntime: ExecutorRuntime;
  /** Withdrawals, sign-in requests, the Done of each hand-off, and the harness runtime's aborts. */
  hostChannels: BlockingRedisConnection;
  /** Every connection opened here, for shutdown to close. */
  connections: {
    blocking: BlockingRedisConnection;
    hostChannels: BlockingRedisConnection;
    browserBlocking: BlockingRedisConnection;
    browserChannels: BlockingRedisConnection;
  };
}

export function createHostRuntimes(params: {
  hostname: string;
  redis: Redis;
  payloadStore: PayloadStore;
  connect: (name: string) => BlockingRedisConnection;
}): HostRuntimes {
  const { hostname, redis, payloadStore, connect } = params;
  const blocking = connect(`${hostname}-blocking`);
  const hostChannels = connect(`${hostname}-host-channels`);
  // Each runtime has its own blocking connection: a runtime blocks on its
  // stream between jobs, and two runtimes sharing one would wait on each other.
  const browserBlocking = connect(`${hostname}-browser-blocking`);
  // And its own subscriber: a pattern subscription belongs to the connection,
  // so the browser runtime stopping early in a drain would otherwise end the
  // harness runtime's aborts for runs still going.
  const browserChannels = connect(`${hostname}-browser-channels`);

  const runtime = new ExecutorRuntime(
    {
      ...DEFAULT_EXECUTOR_CONFIG,
      consumerName: hostname,
      consumerGroup: ConsumerGroups.executor(STEP_TYPE),
      streamKey: StreamKeys.jobStream(STEP_TYPE),
      stepType: STEP_TYPE,
      concurrency: parseInt(process.env['EXECUTOR_CONCURRENCY'] ?? '4', 10),
      defaultTimeoutMs: parseInt(process.env['DEFAULT_TIMEOUT_MS'] ?? '300000', 10),
    },
    { redis, redisBlocking: blocking, redisSubscriber: hostChannels, payloadStore },
  );

  // The browser is served from this executor because it lives on this machine:
  // a profile's directory is under the host directory, and its Chrome is in the
  // process table that withdrawal, shutdown and the orphan sweep read.
  const browserRuntime = new ExecutorRuntime(
    {
      ...DEFAULT_EXECUTOR_CONFIG,
      consumerName: hostname,
      consumerGroup: ConsumerGroups.executor(BROWSER_STEP_TYPE),
      streamKey: StreamKeys.jobStream(BROWSER_STEP_TYPE),
      stepType: BROWSER_STEP_TYPE,
      concurrency: parseInt(process.env['BROWSER_EXECUTOR_CONCURRENCY'] ?? '4', 10),
      defaultTimeoutMs: 120_000,
    },
    { redis, redisBlocking: browserBlocking, redisSubscriber: browserChannels, payloadStore },
  );

  return {
    runtime,
    browserRuntime,
    hostChannels,
    connections: { blocking, hostChannels, browserBlocking, browserChannels },
  };
}
