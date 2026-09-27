import { describe, it, expect } from 'vitest';
import {
  ApiDefinitionSchema,
  normalizeBindingInput,
  effectiveWriteRiskTier,
  writeRiskTierGatedByDefault,
  requiresWriteApproval,
} from './apiDefinition.js';

const KAGGLE_MULTI_HOST = {
  allowedHosts: [
    'www.kaggle.com',
    'storage.googleapis.com',
    '*.storage.googleapis.com',
    'www.googleapis.com',
  ],
  allowedMethods: ['GET', 'POST'],
  allowCrossHostRedirects: true,
  maxResponseBodyBytes: 104_857_600,
};

describe('normalizeBindingInput — egress preservation on partial update', () => {
  it('preserves the stored multi-host egress on a credential-only upsert', () => {
    // Definition carries a suggestedEgressPolicy that, on a stateless rebuild, would
    // collapse the allowlist to just the baseUrl host — the founding bug.
    const { egressPolicy } = normalizeBindingInput({
      rawAuth: { type: 'bearer' },
      definitionBaseUrl: 'https://www.kaggle.com',
      suggestedEgressPolicy: { allowedMethods: ['GET', 'POST'] },
      existingEgressPolicy: KAGGLE_MULTI_HOST,
    });

    expect(egressPolicy.allowedHosts).toEqual(KAGGLE_MULTI_HOST.allowedHosts);
    expect(egressPolicy.allowCrossHostRedirects).toBe(true);
    expect(egressPolicy.maxResponseBodyBytes).toBe(104_857_600);
  });

  it('lets an explicit egress override the stored one (narrowing requires explicit egress)', () => {
    const { egressPolicy } = normalizeBindingInput({
      rawAuth: { type: 'bearer' },
      rawEgressPolicy: { allowedHosts: ['www.kaggle.com'], allowCrossHostRedirects: false },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingEgressPolicy: KAGGLE_MULTI_HOST,
    });

    expect(egressPolicy.allowedHosts).toEqual(['www.kaggle.com']);
    expect(egressPolicy.allowCrossHostRedirects).toBe(false);
  });

  it('first create (no existing egress) derives hosts from baseUrl + suggested additionalHosts', () => {
    const { egressPolicy } = normalizeBindingInput({
      rawAuth: { type: 'none' },
      definitionBaseUrl: 'https://www.kaggle.com',
      suggestedEgressPolicy: {
        additionalHosts: ['storage.googleapis.com'],
        allowCrossHostRedirects: true,
      },
    });

    expect(egressPolicy.allowedHosts).toEqual(['www.kaggle.com', 'storage.googleapis.com']);
    expect(egressPolicy.allowCrossHostRedirects).toBe(true);
  });
});

describe('normalizeBindingInput — auth preservation on partial update', () => {
  const STORED_BEARER = { type: 'bearer', credentialKey: 'kaggle-default-token' };

  it('omitted auth preserves the stored profile verbatim', () => {
    const { auth } = normalizeBindingInput({
      rawEgressPolicy: { allowedHosts: ['www.kaggle.com'] },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: STORED_BEARER,
    });

    expect(auth).toEqual(STORED_BEARER);
  });

  it('same type without credential-key fields inherits the stored keys', () => {
    // The dogfood wipe: an egress-only upsert re-sending `{ type: "bearer" }`
    // must not degrade the binding to needs-configuration.
    const { auth } = normalizeBindingInput({
      rawAuth: { type: 'bearer' },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: STORED_BEARER,
    });

    expect(auth).toEqual(STORED_BEARER);
  });

  it('an explicit credential key wins over the stored one', () => {
    const { auth } = normalizeBindingInput({
      rawAuth: { type: 'bearer', credentialKey: 'rotated-key' },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: STORED_BEARER,
    });

    expect(auth).toEqual({ type: 'bearer', credentialKey: 'rotated-key' });
  });

  it('a different auth type replaces the profile wholesale (no key inherit)', () => {
    const { auth } = normalizeBindingInput({
      rawAuth: { type: 'api_key' },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: STORED_BEARER,
    });

    expect(auth).toMatchObject({ type: 'api_key' });
    expect((auth as Record<string, unknown>)['credentialKey']).toBeUndefined();
  });

  it('same type round-trips the whole stored profile, not only credential keys', () => {
    // api_key with query placement: re-sending `{ type: "api_key" }` (the blessed
    // partial-update form) must not reshape the profile back to header defaults.
    const stored = {
      type: 'api_key',
      placement: 'query',
      headerName: 'X-API-Key',
      queryParamName: 'key',
      credentialKey: 'k',
    };
    const { auth } = normalizeBindingInput({
      rawAuth: { type: 'api_key' },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: stored,
    });
    expect(auth).toEqual(stored);
  });

  it('same type preserves oauth2_client_credentials tokenEndpoint and scopes', () => {
    const stored = {
      type: 'oauth2_client_credentials',
      tokenEndpoint: 'https://auth.example.com/token',
      clientIdCredentialKey: 'cid',
      clientSecretCredentialKey: 'csec',
      scopes: ['read', 'write'],
    };
    const { auth } = normalizeBindingInput({
      rawAuth: {
        type: 'oauth2_client_credentials',
        tokenEndpoint: 'https://auth.example.com/token',
      },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: stored,
    });
    expect(auth).toEqual(stored);
  });

  it('inherits per-field on basic auth (explicit username key, stored password key)', () => {
    const { auth } = normalizeBindingInput({
      rawAuth: { type: 'basic', usernameCredentialKey: 'new-user' },
      definitionBaseUrl: 'https://www.kaggle.com',
      existingAuth: {
        type: 'basic',
        usernameCredentialKey: 'old-user',
        passwordCredentialKey: 'old-pass',
      },
    });

    expect(auth).toEqual({
      type: 'basic',
      usernameCredentialKey: 'new-user',
      passwordCredentialKey: 'old-pass',
    });
  });

  it('create with omitted auth still fails with the teaching error', () => {
    expect(() =>
      normalizeBindingInput({ definitionBaseUrl: 'https://www.kaggle.com' }),
    ).toThrowError(/Invalid auth configuration/);
  });
});

describe('ApiDefinitionSchema — endpoint id uniqueness', () => {
  it('rejects duplicate endpointIds with a teaching error', () => {
    const result = ApiDefinitionSchema.safeParse({
      apiId: 'x',
      name: 'X',
      baseUrl: 'https://x.com',
      version: '1',
      endpoints: [
        { endpointId: 'list', name: 'a', method: 'GET', pathTemplate: '/a' },
        { endpointId: 'list', name: 'b', method: 'GET', pathTemplate: '/b' },
      ],
      tags: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('Duplicate endpointId'))).toBe(
        true,
      );
    }
  });
});

describe('write-risk tiers (Plan 253)', () => {
  it('effectiveWriteRiskTier: explicit wins; GET/HEAD → read; else → low', () => {
    expect(effectiveWriteRiskTier({ method: 'POST', writeRiskTier: 'high' })).toBe('high');
    expect(effectiveWriteRiskTier({ method: 'GET' })).toBe('read');
    expect(effectiveWriteRiskTier({ method: 'HEAD' })).toBe('read');
    expect(effectiveWriteRiskTier({ method: 'POST' })).toBe('low');
    expect(effectiveWriteRiskTier({ method: 'DELETE' })).toBe('low');
  });

  it('writeRiskTierGatedByDefault: medium/high gate, read/low do not', () => {
    expect(writeRiskTierGatedByDefault('read')).toBe(false);
    expect(writeRiskTierGatedByDefault('low')).toBe(false);
    expect(writeRiskTierGatedByDefault('medium')).toBe(true);
    expect(writeRiskTierGatedByDefault('high')).toBe(true);
  });

  it('requiresWriteApproval: default when no policy', () => {
    expect(requiresWriteApproval('read')).toBe(false);
    expect(requiresWriteApproval('low')).toBe(false);
    expect(requiresWriteApproval('medium')).toBe(true);
    expect(requiresWriteApproval('high')).toBe(true);
  });

  it('requiresWriteApproval: a space override raises or lowers per tier', () => {
    // Trusted space: don't gate medium (whitelist) but keep high gated.
    const trusting = { requireApprovalByTier: { medium: false } };
    expect(requiresWriteApproval('medium', trusting)).toBe(false);
    expect(requiresWriteApproval('high', trusting)).toBe(true);

    // Cautious space: gate even low.
    const cautious = { requireApprovalByTier: { low: true } };
    expect(requiresWriteApproval('low', cautious)).toBe(true);

    // Autonomy escape valve: a space may lower high.
    const autonomous = { requireApprovalByTier: { high: false } };
    expect(requiresWriteApproval('high', autonomous)).toBe(false);
  });

  it('requiresWriteApproval: read is never gateable, even by override', () => {
    expect(requiresWriteApproval('read', { requireApprovalByTier: {} })).toBe(false);
  });
});
