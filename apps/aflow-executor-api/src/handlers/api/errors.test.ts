import { describe, it, expect } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PayloadRef } from '@aflow/schemas';
import {
  buildEgressBlockedMessage,
  handleExecutionError,
  isRetryableNetworkError,
  SUGGESTED_FIX_BIND_CAPABILITY,
  DO_NOT_RUNNER_GUIDANCE,
} from './errors.js';
import { ApiExecutionError } from './types.js';
import { SsrfBlockedError, DnsBlockedError } from '@aflow/network-safety';
import { apiError } from '../../lib/api-errors.js';

function stubCtx(): ExecutorContext {
  return {
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    writePayload: async () => 'inline:test' as PayloadRef,
  } as unknown as ExecutorContext;
}

describe('buildEgressBlockedMessage', () => {
  it('produces actionable headline for host-not-in-allowlist', () => {
    const msg = buildEgressBlockedMessage('https://evil.com/x', 'host-not-in-allowlist');
    expect(msg).toContain('Egress blocked');
    expect(msg).toContain('https://evil.com/x');
    expect(msg).toContain('not in');
    expect(msg).toContain('allowedHosts');
  });

  it('produces actionable headline for cross-host-redirect-blocked', () => {
    const msg = buildEgressBlockedMessage('https://gcs.example/x', 'cross-host-redirect-blocked');
    expect(msg).toContain('Egress blocked');
    expect(msg).toContain('redirect');
    expect(msg).toContain('https://gcs.example/x');
  });

  it('names bind-capability as the resolution path', () => {
    const msg = buildEgressBlockedMessage('https://x.com', 'host-not-in-allowlist');
    expect(msg).toContain('bind-capability');
    expect(msg).toContain(SUGGESTED_FIX_BIND_CAPABILITY);
  });

  it('embeds all DO NOT guidance items so runner cannot miss them', () => {
    const msg = buildEgressBlockedMessage('https://x.com', 'host-not-in-allowlist');
    for (const item of DO_NOT_RUNNER_GUIDANCE) {
      expect(msg).toContain(item);
    }
  });

  it('warns explicitly against synthesizing data and using compute fallback', () => {
    const msg = buildEgressBlockedMessage('https://x.com', 'host-not-in-allowlist');
    expect(msg).toMatch(/synthesize/i);
    expect(msg).toMatch(/compute\.sandbox\.exec/);
    expect(msg).toMatch(/signal_blocked/);
  });
});

describe('isRetryableNetworkError', () => {
  it('flags ECONNREFUSED / ETIMEDOUT / fetch failed as retryable', () => {
    expect(isRetryableNetworkError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableNetworkError(new Error('ETIMEDOUT something'))).toBe(true);
    expect(isRetryableNetworkError(new Error('fetch failed'))).toBe(true);
  });

  it('does not flag arbitrary errors as retryable', () => {
    expect(isRetryableNetworkError(new Error('schema mismatch'))).toBe(false);
  });
});

describe('handleExecutionError — SsrfBlockedError kind branching', () => {
  it('routes kind=allowlist-host to API_BINDING_EGRESS_BLOCKED with configuration classification', async () => {
    const ctx = stubCtx();
    const err = new SsrfBlockedError('blocked', 'https://gcs.example/x', {
      kind: 'allowlist-host',
    });

    const result = await handleExecutionError(ctx, err);

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_BINDING_EGRESS_BLOCKED');
    expect(result.error.classification).toBe('configuration');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain('bind-capability');
    expect(result.error.details).toMatchObject({
      blockedTarget: 'https://gcs.example/x',
      reason: 'host-not-in-allowlist',
      suggestedFix: SUGGESTED_FIX_BIND_CAPABILITY,
      doNot: DO_NOT_RUNNER_GUIDANCE,
    });
  });

  it('keeps kind=private-ip as API_SSRF_BLOCKED with permission classification', async () => {
    const ctx = stubCtx();
    const err = new SsrfBlockedError('blocked private', '10.0.0.1', { kind: 'private-ip' });

    const result = await handleExecutionError(ctx, err);

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_SSRF_BLOCKED');
    expect(result.error.classification).toBe('permission');
    expect(result.error.retryable).toBe(false);
  });

  it('keeps kind=invalid-protocol as API_SSRF_BLOCKED (never agent-fixable)', async () => {
    const ctx = stubCtx();
    const err = new SsrfBlockedError('bad scheme', 'ftp://x', { kind: 'invalid-protocol' });

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_SSRF_BLOCKED');
    expect(result.error.classification).toBe('permission');
  });
});

describe('handleExecutionError — other branches still route correctly', () => {
  it('passes ApiExecutionError through with its embedded AflowError', async () => {
    const ctx = stubCtx();
    const aflow = apiError('API_RATE_LIMITED', 'slow down');
    const err = new ApiExecutionError(aflow);

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_RATE_LIMITED');
  });

  it('preserves ApiExecutionError carrying API_BINDING_EGRESS_BLOCKED (cross-host redirect path)', async () => {
    const ctx = stubCtx();
    const aflow = apiError(
      'API_BINDING_EGRESS_BLOCKED',
      buildEgressBlockedMessage('https://other.com/x', 'cross-host-redirect-blocked'),
      {
        retryable: false,
        details: {
          blockedTarget: 'https://other.com/x',
          reason: 'cross-host-redirect-blocked',
          suggestedFix: SUGGESTED_FIX_BIND_CAPABILITY,
          doNot: DO_NOT_RUNNER_GUIDANCE,
        },
      },
    );
    const err = new ApiExecutionError(aflow);

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_BINDING_EGRESS_BLOCKED');
    expect(result.error.classification).toBe('configuration');
    expect(result.error.details).toMatchObject({
      reason: 'cross-host-redirect-blocked',
    });
  });

  it('routes DnsBlockedError to API_DNS_BLOCKED', async () => {
    const ctx = stubCtx();
    const err = new DnsBlockedError('NXDOMAIN', 'nope.example');

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_DNS_BLOCKED');
  });

  it('treats AbortError as API_TIMEOUT (retryable)', async () => {
    const ctx = stubCtx();
    const err = new Error('aborted');
    err.name = 'AbortError';

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_TIMEOUT');
    expect(result.error.retryable).toBe(true);
  });

  it('classifies retryable network errors as API_NETWORK_ERROR', async () => {
    const ctx = stubCtx();
    const err = new Error('ECONNRESET while reading');

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_NETWORK_ERROR');
    expect(result.error.retryable).toBe(true);
  });

  it('classifies non-retryable arbitrary errors as API_PROVIDER_ERROR', async () => {
    const ctx = stubCtx();
    const err = new Error('something else');

    const result = await handleExecutionError(ctx, err);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.code).toBe('API_PROVIDER_ERROR');
    expect(result.error.retryable).toBe(false);
  });
});
