import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  setMcpElicitationRequest,
  getMcpElicitationRequest,
  deleteMcpElicitationRequest,
} from '../mcpElicitationRequest.js';
import { StreamKeys, type McpElicitationRequest } from '@aflow/schemas';

function mockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

describe('mcp elicitation request cache', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = mockRedis();
    await redis.flushall();
  });

  const formRequest: McpElicitationRequest = {
    mode: 'form',
    elicitationId: 'elic-1',
    message: 'Confirm details',
    requestedSchema: {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
    },
  };

  const urlRequest: McpElicitationRequest = {
    mode: 'url',
    elicitationId: 'elic-2',
    message: 'Complete the OAuth flow in your browser',
    url: 'https://oauth.example.com/authorize?...',
  };

  it('round-trips a form-mode request and stamps tenantId', async () => {
    await setMcpElicitationRequest(
      redis,
      formRequest,
      { tenantId: 'tenant-1', stepExecutionId: 'step-1', sessionId: 'session-1' },
      900_000,
    );
    const stored = await getMcpElicitationRequest(redis, 'tenant-1', 'elic-1');
    expect(stored).not.toBeNull();
    expect(stored!.tenantId).toBe('tenant-1');
    expect(stored!.request).toEqual(formRequest);
  });

  it('round-trips a url-mode request', async () => {
    await setMcpElicitationRequest(
      redis,
      urlRequest,
      { tenantId: 'tenant-1', stepExecutionId: 'step-2', sessionId: 'session-1' },
      900_000,
    );
    const stored = await getMcpElicitationRequest(redis, 'tenant-1', 'elic-2');
    expect(stored!.request).toEqual(urlRequest);
  });

  it('sets a TTL that exceeds the lease (slack for late callers)', async () => {
    await setMcpElicitationRequest(
      redis,
      formRequest,
      { tenantId: 'tenant-1', stepExecutionId: 'step-1', sessionId: 'session-1' },
      60_000,
    );
    const ttl = await redis.ttl(StreamKeys.mcpElicitationRequestKey('tenant-1', 'elic-1'));
    // 60s lease + 30s slack = 90s expected ceiling
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(91);
  });

  it('returns null for a missing key', async () => {
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-missing')).toBeNull();
  });

  it('returns null for malformed JSON in the key', async () => {
    await redis.set(StreamKeys.mcpElicitationRequestKey('tenant-1', 'elic-bad'), '{not json');
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-bad')).toBeNull();
  });

  it('returns null when payload fails schema validation', async () => {
    await redis.set(
      StreamKeys.mcpElicitationRequestKey('tenant-1', 'elic-invalid'),
      JSON.stringify({ tenantId: 'tenant-1', request: { mode: 'nope' } }),
    );
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-invalid')).toBeNull();
  });

  it('returns null when tenantId is missing', async () => {
    await redis.set(
      StreamKeys.mcpElicitationRequestKey('tenant-1', 'elic-no-tenant'),
      JSON.stringify({ request: formRequest, stepExecutionId: 'step-x' }),
    );
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-no-tenant')).toBeNull();
  });

  it('returns null when stepExecutionId is missing (new authz field)', async () => {
    await redis.set(
      StreamKeys.mcpElicitationRequestKey('tenant-1', 'elic-no-step'),
      JSON.stringify({ request: formRequest, tenantId: 'tenant-1' }),
    );
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-no-step')).toBeNull();
  });

  it('round-trips sessionId + stepExecutionId for cross-session authz checks', async () => {
    await setMcpElicitationRequest(
      redis,
      formRequest,
      { tenantId: 'tenant-1', stepExecutionId: 'step-7', sessionId: 'session-Z' },
      60_000,
    );
    const stored = await getMcpElicitationRequest(redis, 'tenant-1', 'elic-1');
    expect(stored?.sessionId).toBe('session-Z');
    expect(stored?.stepExecutionId).toBe('step-7');
  });

  it('sessionId is undefined when omitted at store time (workflow-task dispatch)', async () => {
    await setMcpElicitationRequest(
      redis,
      formRequest,
      { tenantId: 'tenant-1', stepExecutionId: 'step-8' },
      60_000,
    );
    const stored = await getMcpElicitationRequest(redis, 'tenant-1', 'elic-1');
    expect(stored?.sessionId).toBeUndefined();
    expect(stored?.stepExecutionId).toBe('step-8');
  });

  it('isolates colliding elicitationIds across tenants (key is tenant-scoped)', async () => {
    // The MCP server is free to echo back any elicitationId in `elicitation/create`
    // params; two tenants whose servers happen to mint the same id must not
    // see each other's request payload — even before the in-payload tenantId
    // check kicks in.
    await setMcpElicitationRequest(
      redis,
      { ...formRequest, message: 'tenant-1 prompt' },
      { tenantId: 'tenant-1', stepExecutionId: 'step-A', sessionId: 'session-A' },
      60_000,
    );
    await setMcpElicitationRequest(
      redis,
      { ...formRequest, message: 'tenant-2 prompt' },
      { tenantId: 'tenant-2', stepExecutionId: 'step-B', sessionId: 'session-B' },
      60_000,
    );
    const fromTenantOne = await getMcpElicitationRequest(redis, 'tenant-1', 'elic-1');
    const fromTenantTwo = await getMcpElicitationRequest(redis, 'tenant-2', 'elic-1');
    expect(fromTenantOne?.request.message).toBe('tenant-1 prompt');
    expect(fromTenantTwo?.request.message).toBe('tenant-2 prompt');
    expect(fromTenantOne?.tenantId).toBe('tenant-1');
    expect(fromTenantTwo?.tenantId).toBe('tenant-2');

    // Cross-tenant reads (wrong tenant prefix) miss the key entirely.
    expect(await getMcpElicitationRequest(redis, 'tenant-3', 'elic-1')).toBeNull();

    // Deleting one tenant's entry leaves the other intact.
    await deleteMcpElicitationRequest(redis, 'tenant-1', 'elic-1');
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-1')).toBeNull();
    expect(await getMcpElicitationRequest(redis, 'tenant-2', 'elic-1')).not.toBeNull();
  });

  it('delete is idempotent — no-op on missing keys', async () => {
    await expect(
      deleteMcpElicitationRequest(redis, 'tenant-1', 'elic-missing'),
    ).resolves.toBeUndefined();
    await setMcpElicitationRequest(
      redis,
      formRequest,
      { tenantId: 'tenant-1', stepExecutionId: 'step-1', sessionId: 'session-1' },
      60_000,
    );
    await deleteMcpElicitationRequest(redis, 'tenant-1', 'elic-1');
    expect(await getMcpElicitationRequest(redis, 'tenant-1', 'elic-1')).toBeNull();
  });
});
