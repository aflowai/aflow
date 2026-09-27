import { describe, it, expect } from 'vitest';
import { apiError } from './api-errors.js';

describe('apiError — API_BINDING_EGRESS_BLOCKED', () => {
  it('classifies as configuration (operator-fixable, distinct from permission)', () => {
    const err = apiError('API_BINDING_EGRESS_BLOCKED', 'host blocked');
    expect(err.classification).toBe('configuration');
  });

  it('is non-retryable by default', () => {
    const err = apiError('API_BINDING_EGRESS_BLOCKED', 'host blocked');
    expect(err.retryable).toBe(false);
  });

  it('preserves details verbatim', () => {
    const err = apiError('API_BINDING_EGRESS_BLOCKED', 'host blocked', {
      details: {
        blockedTarget: 'storage.googleapis.com',
        reason: 'cross-host-redirect-blocked',
        suggestedFix: 'use bind-capability',
        doNot: ['Do NOT synthesize'],
      },
    });
    expect(err.details).toEqual({
      blockedTarget: 'storage.googleapis.com',
      reason: 'cross-host-redirect-blocked',
      suggestedFix: 'use bind-capability',
      doNot: ['Do NOT synthesize'],
    });
  });
});

describe('apiError — API_SSRF_BLOCKED (contrast)', () => {
  it('stays classified as permission (never agent-fixable)', () => {
    const err = apiError('API_SSRF_BLOCKED', 'private IP');
    expect(err.classification).toBe('permission');
    expect(err.retryable).toBe(false);
  });
});
