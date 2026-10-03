import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureConsumerGroup: vi.fn().mockResolvedValue(undefined),
  registerExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
  unregisterExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
  listPendingStepJobs: vi.fn().mockResolvedValue([]),
  claimPendingStepJobsByIds: vi.fn().mockResolvedValue([]),
  isExecutorConsumerAlive: vi.fn().mockResolvedValue(false),
  readStepJobs: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 5))),
}));

import type { BlockingRedisConnection } from '@aflow/redis';
import { StreamKeys } from '@aflow/schemas';

import { createHostRuntimes, type HostRuntimes } from '../hostRuntimes.js';

/** Holds pattern subscriptions the way Redis does: per connection, not per caller. */
class FakeConnection extends EventEmitter {
  readonly patterns = new Set<string>();

  psubscribe(pattern: string): Promise<number> {
    this.patterns.add(pattern);
    return Promise.resolve(this.patterns.size);
  }

  punsubscribe(pattern: string): Promise<number> {
    this.patterns.delete(pattern);
    return Promise.resolve(this.patterns.size);
  }
}

function hostOnFakeRedis(): {
  host: HostRuntimes;
  publish: (channel: string, message: string) => void;
} {
  const connections: FakeConnection[] = [];
  const host = createHostRuntimes({
    hostname: 'host-test',
    redis: {} as never,
    payloadStore: {} as never,
    connect: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection as unknown as BlockingRedisConnection;
    },
  });
  const publish = (channel: string, message: string): void => {
    for (const connection of connections) {
      for (const pattern of connection.patterns) {
        if (channel.startsWith(pattern.replace(/\*$/, ''))) {
          connection.emit('pmessage', pattern, channel, message);
        }
      }
    }
  };
  return { host, publish };
}

describe('host runtimes', () => {
  let host: HostRuntimes | undefined;

  afterEach(async () => {
    await host?.runtime.stop();
    await host?.browserRuntime.stop();
    host = undefined;
  });

  it('still delivers an operator abort to a harness run after the browser runtime has stopped', async () => {
    const fake = hostOnFakeRedis();
    host = fake.host;
    await host.runtime.start();
    await host.browserRuntime.start();

    await host.browserRuntime.stop();

    const harnessRun = new AbortController();
    host.runtime.abortControllers.set('step-harness', harnessRun);
    fake.publish(StreamKeys.stepAbortChannel('step-harness'), 'operator');

    expect(harnessRun.signal.aborted).toBe(true);
  });

  it('delivers an abort to a browser step while the harness runtime runs on', async () => {
    const fake = hostOnFakeRedis();
    host = fake.host;
    await host.runtime.start();
    await host.browserRuntime.start();

    const browserStep = new AbortController();
    host.browserRuntime.abortControllers.set('step-browser', browserStep);
    fake.publish(StreamKeys.stepAbortChannel('step-browser'), 'operator');

    expect(browserStep.signal.aborted).toBe(true);
  });
});
