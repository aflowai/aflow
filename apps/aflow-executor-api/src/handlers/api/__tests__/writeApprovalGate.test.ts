import { describe, it, expect } from 'vitest';
import type { Redis } from '@aflow/redis';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { ApiEndpoint } from '@aflow/schemas';
import {
  ApiWriteApprovalRequired,
  computeRequestHash,
  enforceWriteApprovalGate,
  redactSensitive,
} from '../writeApprovalGate.js';
import type { ResolvedCall } from '../types.js';

const ctx = {
  tenantId: 't1',
  runId: 'run-1',
  stepExecutionId: 'step-1',
  job: { credentialOwnerId: 'user-9' },
} as unknown as ExecutorContext;

function endpoint(over: Partial<ApiEndpoint>): ApiEndpoint {
  return {
    endpointId: 'ep',
    name: 'Endpoint',
    method: 'POST',
    pathTemplate: '/x',
    params: [],
    tags: [],
    ...over,
  } as ApiEndpoint;
}

function resolved(over: Partial<ResolvedCall>): ResolvedCall {
  return {
    url: 'https://api.example.com/v1/charge',
    method: 'POST',
    headers: {},
    body: { amount: 100 },
    egressPolicy: {} as ResolvedCall['egressPolicy'],
    apiId: 'stripe',
    endpointId: 'ep',
    ...over,
  };
}

const noGrant = { get: async () => null } as unknown as Redis;
const grantFor = (requestHash: string) =>
  ({
    get: async () => JSON.stringify({ requestHash, decision: 'approved' }),
  }) as unknown as Redis;

describe('computeRequestHash', () => {
  it('is stable for the same call and differs when the body changes', () => {
    const a = computeRequestHash('POST', 'https://h/x', { a: 1, b: 2 });
    const b = computeRequestHash('POST', 'https://h/x', { b: 2, a: 1 });
    const c = computeRequestHash('POST', 'https://h/x', { a: 1, b: 3 });
    expect(a).toBe(b); // key order does not matter
    expect(a).not.toBe(c);
  });
});

describe('enforceWriteApprovalGate', () => {
  it('does not gate a read-tier endpoint', async () => {
    await expect(
      enforceWriteApprovalGate(
        ctx,
        resolved({ endpoint: endpoint({ writeRiskTier: 'read' }) }),
        noGrant,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not gate a low-tier endpoint', async () => {
    await expect(
      enforceWriteApprovalGate(
        ctx,
        resolved({ endpoint: endpoint({ writeRiskTier: 'low' }) }),
        noGrant,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not gate a direct-URL call (no endpoint)', async () => {
    await expect(
      enforceWriteApprovalGate(ctx, resolved({ endpoint: undefined }), noGrant),
    ).resolves.toBeUndefined();
  });

  it('a space override can gate a low-tier endpoint (raise)', async () => {
    await expect(
      enforceWriteApprovalGate(
        ctx,
        resolved({ endpoint: endpoint({ writeRiskTier: 'low' }) }),
        noGrant,
        { requireApprovalByTier: { low: true } },
      ),
    ).rejects.toBeInstanceOf(ApiWriteApprovalRequired);
  });

  it('a space override can un-gate a medium-tier endpoint (lower/whitelist)', async () => {
    await expect(
      enforceWriteApprovalGate(
        ctx,
        resolved({ endpoint: endpoint({ writeRiskTier: 'medium' }) }),
        noGrant,
        { requireApprovalByTier: { medium: false } },
      ),
    ).resolves.toBeUndefined();
  });

  it('gates a high-tier endpoint with no grant', async () => {
    await expect(
      enforceWriteApprovalGate(
        ctx,
        resolved({ endpoint: endpoint({ writeRiskTier: 'high' }) }),
        noGrant,
      ),
    ).rejects.toBeInstanceOf(ApiWriteApprovalRequired);
  });

  it('surfaces the tier, host, and requestHash in the pause request', async () => {
    const r = resolved({ endpoint: endpoint({ writeRiskTier: 'medium', name: 'Send SMS' }) });
    try {
      await enforceWriteApprovalGate(ctx, r, noGrant);
      throw new Error('expected a gate');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiWriteApprovalRequired);
      const req = (e as ApiWriteApprovalRequired).request;
      expect(req.kind).toBe('write_approval');
      expect(req.writeRiskTier).toBe('medium');
      expect(req.urlHost).toBe('api.example.com');
      expect(req.initiatedBy).toBe('user-9');
      expect(req.requestHash).toBe(computeRequestHash(r.method, r.url, r.body));
    }
  });

  it('proceeds when an approved grant matches the exact call', async () => {
    const r = resolved({ endpoint: endpoint({ writeRiskTier: 'high' }) });
    const hash = computeRequestHash(r.method, r.url, r.body);
    await expect(enforceWriteApprovalGate(ctx, r, grantFor(hash))).resolves.toBeUndefined();
  });

  it('re-gates when the grant hash does not match (call changed)', async () => {
    const r = resolved({ endpoint: endpoint({ writeRiskTier: 'high' }) });
    await expect(enforceWriteApprovalGate(ctx, r, grantFor('stale-hash'))).rejects.toBeInstanceOf(
      ApiWriteApprovalRequired,
    );
  });

  it('does not approve on a denied grant (fails closed to a pause)', async () => {
    const r = resolved({ endpoint: endpoint({ writeRiskTier: 'high' }) });
    const hash = computeRequestHash(r.method, r.url, r.body);
    const denied = {
      get: async () => JSON.stringify({ requestHash: hash, decision: 'denied' }),
    } as unknown as Redis;
    await expect(enforceWriteApprovalGate(ctx, r, denied)).rejects.toBeInstanceOf(
      ApiWriteApprovalRequired,
    );
  });

  it('redacts sensitive keys in the body preview', async () => {
    const r = resolved({
      endpoint: endpoint({ writeRiskTier: 'high' }),
      body: { amount: 100, api_key: 'sk-secret', nested: { password: 'p', note: 'ok' } },
    });
    try {
      await enforceWriteApprovalGate(ctx, r, noGrant);
      throw new Error('expected a gate');
    } catch (e) {
      const req = (e as ApiWriteApprovalRequired).request;
      expect(req.bodyPreview).toBeDefined();
      expect(req.bodyPreview).not.toContain('sk-secret');
      expect(req.bodyPreview).not.toContain('"password":"p"');
      expect(req.bodyPreview).toContain('[redacted]');
      // Non-sensitive values are preserved so the operator still sees the call.
      expect(req.bodyPreview).toContain('100');
      expect(req.bodyPreview).toContain('ok');
      // The requestHash still binds the REAL body, not the redacted preview.
      expect(req.requestHash).toBe(computeRequestHash(r.method, r.url, r.body));
    }
  });
});

describe('redactSensitive', () => {
  it('replaces secret-like keys recursively and keeps structure', () => {
    const out = redactSensitive({
      token: 'abc',
      Authorization: 'Bearer x',
      clientSecret: 's',
      user: { name: 'Ada', apiKey: 'k', tags: ['a', 'b'] },
      amount: 42,
    }) as Record<string, unknown>;
    expect(out['token']).toBe('[redacted]');
    expect(out['Authorization']).toBe('[redacted]');
    expect(out['clientSecret']).toBe('[redacted]');
    expect(out['amount']).toBe(42);
    const user = out['user'] as Record<string, unknown>;
    expect(user['name']).toBe('Ada');
    expect(user['apiKey']).toBe('[redacted]');
    expect(user['tags']).toEqual(['a', 'b']);
  });
});
