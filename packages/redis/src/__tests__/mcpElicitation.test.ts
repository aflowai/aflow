import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  publishMcpElicitationRequest,
  subscribeMcpElicitationRequests,
  publishMcpElicitationResponse,
  subscribeMcpElicitationResponse,
  type McpElicitationRequestEnvelope,
} from '../mcpElicitation.js';
import type { McpElicitationResponse } from '@aflow/schemas';

function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

function makeEnvelope(
  overrides: Partial<McpElicitationRequestEnvelope> = {},
): McpElicitationRequestEnvelope {
  return {
    request: {
      mode: 'form',
      elicitationId: 'elic-1',
      message: 'Please confirm',
      requestedSchema: { type: 'object', properties: {} },
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

describe('mcp elicitation request channel (executor → orchestrator)', () => {
  let publisher: RedisType;
  let subscriber: RedisType;
  let unsubscribe: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    publisher = createMockRedis();
    subscriber = createMockRedis();
    await publisher.flushall();
  });

  afterEach(async () => {
    if (unsubscribe) await unsubscribe();
  });

  it('delivers a published envelope to the pattern subscriber', async () => {
    const received: McpElicitationRequestEnvelope[] = [];
    unsubscribe = await subscribeMcpElicitationRequests(subscriber, (env) => {
      received.push(env);
    });

    publishMcpElicitationRequest(publisher, makeEnvelope());

    // ioredis-mock dispatches synchronously on next microtask; give it one tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]!.request.elicitationId).toBe('elic-1');
    expect(received[0]!.bindingId).toBe('kaggle-default');
  });

  it('subscriber sees envelopes from any tenant (pattern subscribe)', async () => {
    const received: McpElicitationRequestEnvelope[] = [];
    unsubscribe = await subscribeMcpElicitationRequests(subscriber, (env) => {
      received.push(env);
    });

    publishMcpElicitationRequest(publisher, makeEnvelope({ tenantId: 'tenant-a' }));
    publishMcpElicitationRequest(publisher, makeEnvelope({ tenantId: 'tenant-b' }));

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(2);
    expect(new Set(received.map((r) => r.tenantId))).toEqual(new Set(['tenant-a', 'tenant-b']));
  });

  it('ignores malformed payloads without crashing', async () => {
    const received: McpElicitationRequestEnvelope[] = [];
    unsubscribe = await subscribeMcpElicitationRequests(subscriber, (env) => {
      received.push(env);
    });

    // Garbage JSON — should be swallowed by the subscriber's try/catch.
    await publisher.publish('aflow:pubsub:mcp-elicitation-request:tenant-x', '{not-json');
    // Schema-invalid payload (missing required request field) — also dropped.
    await publisher.publish(
      'aflow:pubsub:mcp-elicitation-request:tenant-x',
      JSON.stringify({ tenantId: 'tenant-x' }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});

describe('mcp elicitation response channel (orchestrator → executor)', () => {
  let publisher: RedisType;
  let subscriber: RedisType;
  let unsubscribe: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    publisher = createMockRedis();
    subscriber = createMockRedis();
    await publisher.flushall();
  });

  afterEach(async () => {
    if (unsubscribe) await unsubscribe();
  });

  it('delivers a response only on the matching elicitationId channel', async () => {
    const received: McpElicitationResponse[] = [];
    unsubscribe = await subscribeMcpElicitationResponse(subscriber, 'elic-target', (r) => {
      received.push(r);
    });

    // Wrong elicitationId — should not reach us.
    publishMcpElicitationResponse(publisher, {
      elicitationId: 'elic-other',
      action: 'accept',
      content: { foo: 'bar' },
    });
    // Targeted response.
    publishMcpElicitationResponse(publisher, {
      elicitationId: 'elic-target',
      action: 'accept',
      content: { answer: 42 },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]!.elicitationId).toBe('elic-target');
    expect(received[0]!.action).toBe('accept');
  });

  it('forwards decline + cancel actions with no content', async () => {
    const received: McpElicitationResponse[] = [];
    unsubscribe = await subscribeMcpElicitationResponse(subscriber, 'elic-1', (r) => {
      received.push(r);
    });

    publishMcpElicitationResponse(publisher, { elicitationId: 'elic-1', action: 'decline' });
    publishMcpElicitationResponse(publisher, { elicitationId: 'elic-1', action: 'cancel' });

    await new Promise((r) => setTimeout(r, 10));
    expect(received.map((r) => r.action)).toEqual(['decline', 'cancel']);
    expect(received.every((r) => r.content === undefined)).toBe(true);
  });

  it('unsubscribe stops further delivery', async () => {
    const received: McpElicitationResponse[] = [];
    const off = await subscribeMcpElicitationResponse(subscriber, 'elic-1', (r) => {
      received.push(r);
    });
    publishMcpElicitationResponse(publisher, { elicitationId: 'elic-1', action: 'accept' });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);

    await off();
    publishMcpElicitationResponse(publisher, { elicitationId: 'elic-1', action: 'cancel' });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1); // no second delivery
  });

  it('drops schema-invalid response payloads', async () => {
    const received: McpElicitationResponse[] = [];
    unsubscribe = await subscribeMcpElicitationResponse(subscriber, 'elic-1', (r) => {
      received.push(r);
    });

    // Invalid `action` value — schema rejects.
    await publisher.publish(
      'aflow:pubsub:mcp-elicitation-response:elic-1',
      JSON.stringify({ elicitationId: 'elic-1', action: 'approve' }),
    );
    // Malformed JSON.
    await publisher.publish('aflow:pubsub:mcp-elicitation-response:elic-1', '{bad');

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});
