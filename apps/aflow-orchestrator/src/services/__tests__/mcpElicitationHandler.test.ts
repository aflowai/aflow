import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { startMcpElicitationRouter } from '../mcpElicitationHandler.js';
import {
  publishMcpElicitationRequest,
  getMcpElicitationRequest,
  type McpElicitationRequestEnvelope,
} from '@aflow/redis';
import { StreamKeys } from '@aflow/schemas';

function mockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

function envelope(
  overrides: Partial<McpElicitationRequestEnvelope> = {},
): McpElicitationRequestEnvelope {
  return {
    request: {
      mode: 'form',
      elicitationId: 'elic-1',
      message: 'Pick a flavor',
      requestedSchema: { type: 'object', properties: { flavor: { type: 'string' } } },
    },
    tenantId: '00000000-0000-0000-0000-000000000001',
    stepExecutionId: 'step-1',
    sessionId: 'session-1',
    bindingId: 'kaggle-default',
    serverId: 'kaggle',
    executorInstanceId: 'exec-A',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe('startMcpElicitationRouter — end-to-end via pub/sub', () => {
  let publisher: RedisType;
  let subscriber: RedisType;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    publisher = mockRedis();
    subscriber = mockRedis();
    await publisher.flushall();
  });

  afterEachStop: {
    // (no-op placeholder — `stop` is awaited at end of each `it` for cleanup
    // via the test body's finally pattern below.)
  }

  it('writes the captured request + emits a session event for a session-scoped envelope', async () => {
    stop = await startMcpElicitationRouter({
      redis: publisher,
      subscriberRedis: subscriber,
    });
    try {
      publishMcpElicitationRequest(publisher, envelope());

      // Let the pub/sub dispatch + async handler drain.
      await new Promise((r) => setTimeout(r, 50));

      const stored = await getMcpElicitationRequest(
        publisher,
        '00000000-0000-0000-0000-000000000001',
        'elic-1',
      );
      expect(stored).not.toBeNull();
      expect(stored!.tenantId).toBe('00000000-0000-0000-0000-000000000001');
      expect(stored!.request.elicitationId).toBe('elic-1');

      // Session event written.
      const eventsKey = StreamKeys.sessionEventsStream(
        '00000000-0000-0000-0000-000000000001',
        'session-1',
      );
      const events = await publisher.xrange(eventsKey, '-', '+');
      expect(events.length).toBeGreaterThan(0);
      const fields = events[0]![1] as string[];
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]!] = fields[i + 1]!;
      expect(obj['eventType']).toBe('McpElicitationRequested');
    } finally {
      if (stop) await stop();
    }
  });

  it('persists the request but skips the session event when sessionId is absent', async () => {
    stop = await startMcpElicitationRouter({
      redis: publisher,
      subscriberRedis: subscriber,
    });
    try {
      const env = envelope();
      delete (env as Partial<McpElicitationRequestEnvelope>).sessionId;
      publishMcpElicitationRequest(publisher, env);

      await new Promise((r) => setTimeout(r, 50));

      // Request stash present — a future headless responder could pick it up.
      const stored = await getMcpElicitationRequest(
        publisher,
        '00000000-0000-0000-0000-000000000001',
        'elic-1',
      );
      expect(stored).not.toBeNull();

      // No session stream key was created (no host session to render into).
      const dummyStreamKey = StreamKeys.sessionEventsStream(
        '00000000-0000-0000-0000-000000000001',
        'session-1',
      );
      const events = await publisher.xrange(dummyStreamKey, '-', '+');
      expect(events.length).toBe(0);
    } finally {
      if (stop) await stop();
    }
  });

  it('survives a malformed envelope without crashing the subscriber', async () => {
    stop = await startMcpElicitationRouter({
      redis: publisher,
      subscriberRedis: subscriber,
    });
    try {
      // Publish raw garbage to the channel — the subscriber's
      // safeParse path should ignore it.
      await publisher.publish('aflow:pubsub:mcp-elicitation-request:tenant-x', '{not-json');
      await publisher.publish(
        'aflow:pubsub:mcp-elicitation-request:tenant-x',
        JSON.stringify({ tenantId: 'tenant-x' /* missing request */ }),
      );
      // Then a valid one — confirms the subscriber didn't die.
      publishMcpElicitationRequest(publisher, envelope({ tenantId: 'tenant-good' }));
      await new Promise((r) => setTimeout(r, 50));
      expect(await getMcpElicitationRequest(publisher, 'tenant-good', 'elic-1')).not.toBeNull();
    } finally {
      if (stop) await stop();
    }
  });
});
