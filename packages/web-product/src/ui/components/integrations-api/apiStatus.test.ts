import { describe, it, expect } from 'vitest';
import type { ApiBindingSummary, IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
import { getApiStatus } from './helpers.js';

function binding(over: Partial<ApiBindingSummary> = {}): ApiBindingSummary {
  return {
    bindingId: 'bnpl-sim',
    apiId: 'bnpl-core',
    name: 'BNPL',
    description: null,
    scope: {},
    authType: 'bearer',
    auth: { type: 'bearer', credentialKey: 'token' },
    credentialKeys: [],
    egressPolicy: {},
    fulfillment: { mode: 'live' },
    enabled: true,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

const noCredentials = new Map<string, IntegrationCredentialMeta>();

describe('getApiStatus', () => {
  it('reports a credential-less live binding as needing setup', () => {
    expect(getApiStatus(binding(), noCredentials)).toBe('needs_setup');
  });

  it('reports the same binding ready once it is fulfilled by a simulation', () => {
    // The call reaches no host, so the missing credential gates nothing. The
    // two cases differ only by fulfillment, which is the point.
    const simulated = binding({
      fulfillment: { mode: 'simulated', simulationId: 'bnpl-desk' },
    });

    expect(getApiStatus(simulated, noCredentials)).toBe('ready');
  });

  it('does not let an unfilled base-URL variable gate a simulated binding', () => {
    const simulated = binding({
      fulfillment: { mode: 'simulated', simulationId: 'bnpl-desk' },
      variableValues: {},
    });

    expect(getApiStatus(simulated, noCredentials, ['domain'])).toBe('ready');
  });
});
