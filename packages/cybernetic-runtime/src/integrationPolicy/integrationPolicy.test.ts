import { describe, it, expect } from 'vitest';
import type { TenantIntegrationPolicy } from '@aflow/database';
import type { HostManifest } from '@aflow/schemas';
import {
  collectApiBindingHosts,
  collectApiDefinitionHosts,
  collectAuthHosts,
  collectMcpBindingHosts,
  collectMcpServerHosts,
  collectRepoDesignationHosts,
} from './collectDeclaredHosts.js';
import { assertHostsAllowed, IntegrationHostPolicyError } from './assertHostsAllowed.js';

const OPEN: TenantIntegrationPolicy = { mode: 'open', allowlist: [] };

function allowlist(
  ...rows: Array<{ kind: 'api' | 'mcp'; hostPattern: string }>
): TenantIntegrationPolicy {
  return { mode: 'allowlist', allowlist: rows };
}

function manifest(overrides: Partial<HostManifest> = {}): HostManifest {
  return { apiHosts: [], oauthHosts: [], mcpHosts: [], redirectHosts: [], ...overrides };
}

describe('collectApiDefinitionHosts', () => {
  it('collects the baseUrl host and suggested additional hosts', () => {
    expect(
      collectApiDefinitionHosts({
        baseUrl: 'https://api.github.com',
        suggestedEgressPolicy: { additionalHosts: ['uploads.github.com'] },
      }),
    ).toEqual(['api.github.com', 'uploads.github.com']);
  });

  it('widens a baseUrlTemplate to the manifest leading-wildcard pattern', () => {
    expect(
      collectApiDefinitionHosts({ baseUrlTemplate: 'https://{domain}.atlassian.net' }),
    ).toEqual(['*.atlassian.net']);
  });

  it('widens interior placeholders up to the last placeholder label', () => {
    expect(
      collectApiDefinitionHosts({ baseUrlTemplate: 'https://api.{region}.example.com/v1' }),
    ).toEqual(['*.example.com']);
  });

  it('ignores an unparseable baseUrl and dedupes', () => {
    expect(
      collectApiDefinitionHosts({
        baseUrl: 'not a url',
        suggestedEgressPolicy: { additionalHosts: ['a.example.com', 'a.example.com'] },
      }),
    ).toEqual(['a.example.com']);
  });
});

describe('collectAuthHosts', () => {
  it('collects the client-credentials token endpoint host', () => {
    expect(
      collectAuthHosts({
        type: 'oauth2_client_credentials',
        tokenEndpoint: 'https://id.example.com/token',
      }),
    ).toEqual(['id.example.com']);
  });

  it('collects explicit authorization-code endpoints and registry issuer hosts', () => {
    expect(
      collectAuthHosts({
        type: 'oauth2_authorization_code',
        authorizationServer: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        issuerKey: 'github',
      }),
    ).toEqual(['auth.example.com', 'github.com']);
  });

  it('resolves a discovery-style issuer to its discovery host plus curated endpoint hosts', () => {
    expect(collectAuthHosts({ type: 'oauth2_authorization_code', issuerKey: 'google' })).toEqual([
      'accounts.google.com',
      'oauth2.googleapis.com',
    ]);
  });

  it('returns nothing for credential-key-only auth', () => {
    expect(collectAuthHosts({ type: 'bearer', credentialKey: 'k' })).toEqual([]);
    expect(collectAuthHosts(null)).toEqual([]);
  });
});

describe('collectApiBindingHosts / collectMcpServerHosts / collectMcpBindingHosts / repo', () => {
  it('unions egress allowedHosts with auth hosts', () => {
    expect(
      collectApiBindingHosts({
        auth: { type: 'oauth2_client_credentials', tokenEndpoint: 'https://id.example.com/t' },
        egressPolicy: { allowedHosts: ['api.example.com', '*.cdn.example.com'] },
      }),
    ).toEqual(['api.example.com', '*.cdn.example.com', 'id.example.com']);
  });

  it('collects the MCP serverUrl host', () => {
    expect(collectMcpServerHosts({ serverUrl: 'https://mcp.example.com/rpc' })).toEqual([
      'mcp.example.com',
    ]);
  });

  it('collects MCP binding auth hosts', () => {
    expect(
      collectMcpBindingHosts({
        type: 'oauth2_client_credentials',
        tokenEndpoint: 'https://id.example.com/token',
      }),
    ).toEqual(['id.example.com']);
  });

  it('collects the repo git host, which is all a designation declares', () => {
    expect(collectRepoDesignationHosts({ gitHost: 'github.com' })).toEqual(['github.com']);
  });
});

describe('assertHostsAllowed', () => {
  it('passes everything in open mode', () => {
    expect(() => assertHostsAllowed(OPEN, ['anything.example'], { kind: 'api' })).not.toThrow();
  });

  it('passes hosts covered by allowlist rows of the matching kind', () => {
    const policy = allowlist({ kind: 'api', hostPattern: '*.example.com' });
    expect(() => assertHostsAllowed(policy, ['api.example.com'], { kind: 'api' })).not.toThrow();
  });

  it('ignores allowlist rows of the other kind', () => {
    const policy = allowlist({ kind: 'mcp', hostPattern: 'api.example.com' });
    expect(() => assertHostsAllowed(policy, ['api.example.com'], { kind: 'api' })).toThrow(
      IntegrationHostPolicyError,
    );
  });

  it('denies with every uncovered host and the admin fix path in the message', () => {
    const policy = allowlist({ kind: 'api', hostPattern: 'ok.example.com' });
    try {
      assertHostsAllowed(policy, ['ok.example.com', 'bad-a.example', 'bad-b.example'], {
        kind: 'api',
      });
      expect.unreachable('expected a denial');
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationHostPolicyError);
      const denial = (err as IntegrationHostPolicyError).denial;
      expect(denial.code).toBe('INTEGRATION_HOST_NOT_ALLOWED');
      expect(denial.deniedHosts).toEqual(['bad-a.example', 'bad-b.example']);
      expect(denial.message).toContain('tenant admin');
      expect(denial.message).toContain('Tenant Admin → Integrations Policy');
      expect(denial.message).toContain('Request access');
    }
  });

  it('denies a wildcard requirement not covered by an equal-or-wider wildcard', () => {
    const policy = allowlist({ kind: 'api', hostPattern: 'sub.atlassian.net' });
    expect(() => assertHostsAllowed(policy, ['*.atlassian.net'], { kind: 'api' })).toThrow(
      IntegrationHostPolicyError,
    );
    const wide = allowlist({ kind: 'api', hostPattern: '*.atlassian.net' });
    expect(() => assertHostsAllowed(wide, ['*.atlassian.net'], { kind: 'api' })).not.toThrow();
  });

  it('exempts hosts covered by the catalog grant, across manifest surfaces', () => {
    const policy = allowlist();
    const grant = manifest({
      apiHosts: ['api.github.com'],
      oauthHosts: ['github.com'],
      redirectHosts: ['objects.githubusercontent.com'],
    });
    expect(() =>
      assertHostsAllowed(
        policy,
        ['api.github.com', 'github.com', 'objects.githubusercontent.com'],
        { kind: 'api', catalogGrant: grant },
      ),
    ).not.toThrow();
  });

  it('still denies hosts beyond the catalog grant (custom edit drops to allowlist rules)', () => {
    const policy = allowlist();
    const grant = manifest({ apiHosts: ['api.github.com'] });
    expect(() =>
      assertHostsAllowed(policy, ['api.github.com', 'exfil.example'], {
        kind: 'api',
        catalogGrant: grant,
      }),
    ).toThrow(IntegrationHostPolicyError);
  });

  it('passes trivially on an empty host set', () => {
    expect(() => assertHostsAllowed(allowlist(), [], { kind: 'api' })).not.toThrow();
  });
});
