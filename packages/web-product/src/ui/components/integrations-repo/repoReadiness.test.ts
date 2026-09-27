import { describe, it, expect } from 'vitest';
import type { ApiBindingSummary, IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
import type { RepoBindingSummary } from '../../hooks/use-repo-bindings.js';
import { effectiveGitCredentialKey, getReadiness } from './repoReadiness.js';

function makeConn(over: Partial<ApiBindingSummary> = {}): ApiBindingSummary {
  return {
    bindingId: 'github-conn',
    apiId: 'github',
    name: 'GitHub',
    description: null,
    scope: {},
    authType: 'bearer',
    auth: { type: 'bearer', credentialKey: 'gh-token' },
    credentialKeys: ['gh-token'],
    egressPolicy: {},
    fulfillment: { mode: 'live' as const },
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function makeRepo(over: Partial<RepoBindingSummary> = {}): RepoBindingSummary {
  return {
    repoDesignationId: 'repo-1',
    spaceId: 'space-1',
    coordinate: 'github.com/acme/repo',
    remoteUrl: 'https://github.com/acme/repo.git',
    description: null,
    defaultBranch: 'main',
    allowedPushBranchPatterns: ['feat/*'],
    egressHosts: [],
    checkProfiles: [],
    connectionBindingId: 'github-conn',
    credentialKey: null,
    status: 'ready',
    lastValidatedAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    createdBy: 'op',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const connMap = (conn?: ApiBindingSummary) =>
  new Map<string, ApiBindingSummary>(conn ? [[conn.bindingId, conn]] : []);

describe('effectiveGitCredentialKey — mirrors resolveRepoBinding ordering', () => {
  it('a DISABLED connection yields null even WITH a per-repo override (the unconditional enabled gate)', () => {
    const repo = makeRepo({ credentialKey: 'repo-override' });
    const conn = makeConn({ enabled: false });
    expect(effectiveGitCredentialKey(repo, connMap(conn))).toBeNull();
  });

  it('an enabled connection + per-repo override returns the override', () => {
    const repo = makeRepo({ credentialKey: 'repo-override' });
    expect(effectiveGitCredentialKey(repo, connMap(makeConn()))).toBe('repo-override');
  });

  it('an enabled bearer connection + no override returns the connection bearer key', () => {
    expect(effectiveGitCredentialKey(makeRepo(), connMap(makeConn()))).toBe('gh-token');
  });

  it('an enabled NON-bearer connection + no override returns null', () => {
    const conn = makeConn({ authType: 'oauth2_authorization_code', auth: { type: 'oauth2' } });
    expect(effectiveGitCredentialKey(makeRepo(), connMap(conn))).toBeNull();
  });

  it('a missing connection returns null', () => {
    expect(effectiveGitCredentialKey(makeRepo(), connMap())).toBeNull();
  });

  it('an enabled bearer connection with an empty bearer key + no override returns null', () => {
    const conn = makeConn({ auth: { type: 'bearer', credentialKey: '' } });
    expect(effectiveGitCredentialKey(makeRepo(), connMap(conn))).toBeNull();
  });
});

describe('getReadiness', () => {
  const creds = (...keys: string[]) =>
    new Map<string, IntegrationCredentialMeta>(
      keys.map((k) => [k, { hasValue: true } as IntegrationCredentialMeta]),
    );

  it('ready when the connection bearer credential has a stored value', () => {
    expect(getReadiness(makeRepo(), creds('gh-token'), connMap(makeConn()))).toBe('ready');
  });

  it('needs_credential when the connection is disabled, even with a present override credential', () => {
    const repo = makeRepo({ credentialKey: 'repo-override' });
    const conn = makeConn({ enabled: false });
    expect(getReadiness(repo, creds('repo-override', 'gh-token'), connMap(conn))).toBe(
      'needs_credential',
    );
  });

  it('error / provisioning status short-circuit the credential check', () => {
    expect(getReadiness(makeRepo({ status: 'error' }), creds(), connMap(makeConn()))).toBe('error');
    expect(getReadiness(makeRepo({ status: 'provisioning' }), creds(), connMap(makeConn()))).toBe(
      'provisioning',
    );
  });
});
