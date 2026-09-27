import { describe, it, expect } from 'vitest';
import {
  isAllowedRemoteUrl,
  isHostSafeEgressEntry,
  CheckProfileSchema,
  RepoBindingCreateInputSchema,
} from './repoBinding.js';

describe('isAllowedRemoteUrl', () => {
  it('accepts a bare https remote with no userinfo', () => {
    expect(isAllowedRemoteUrl('https://github.com/example/repo.git')).toBe(true);
  });

  it('rejects http:// (PAT would be sent in cleartext on the wire)', () => {
    expect(isAllowedRemoteUrl('http://github.com/example/repo.git')).toBe(false);
  });

  it('rejects embedded credentials (user:pass@ leaks into argv/reflog)', () => {
    expect(isAllowedRemoteUrl('https://user:pass@github.com/example/repo.git')).toBe(false);
    expect(isAllowedRemoteUrl('https://user@github.com/example/repo.git')).toBe(false);
  });

  it('rejects transport-helper RCE and scp-style remotes', () => {
    expect(isAllowedRemoteUrl('ext::sh -c "id"')).toBe(false);
    expect(isAllowedRemoteUrl('fd::17')).toBe(false);
    expect(isAllowedRemoteUrl('git@github.com:example/repo.git')).toBe(false);
    expect(isAllowedRemoteUrl('ssh://git@github.com/example/repo.git')).toBe(false);
    expect(isAllowedRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRemoteUrl('not a url')).toBe(false);
  });
});

describe('isHostSafeEgressEntry', () => {
  it('accepts bare hostnames and a leading-*. wildcard', () => {
    expect(isHostSafeEgressEntry('github.com')).toBe(true);
    expect(isHostSafeEgressEntry('codeload.github.com')).toBe(true);
    expect(isHostSafeEgressEntry('*.github.com')).toBe(true);
  });

  it('rejects schemes, ports, paths, userinfo, and wildcard injection', () => {
    for (const bad of [
      'https://github.com',
      'github.com:443',
      'github.com/path',
      'evil.com/@github.com',
      'user@github.com',
      '*',
      '*.*.com',
      '',
      '-bad.com',
      'bad-.com',
    ]) {
      expect(isHostSafeEgressEntry(bad)).toBe(false);
    }
  });

  it('rejects the cloud metadata IP, localhost, and loopback (SSRF sinks)', () => {
    for (const bad of [
      '169.254.169.254',
      '*.169.254.169.254',
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
    ]) {
      expect(isHostSafeEgressEntry(bad)).toBe(false);
    }
  });

  it('blocks alternate IP encodings + the GCE metadata DNS names (SSRF gate hardening)', () => {
    for (const bad of [
      '2852039166', // decimal 169.254.169.254
      '0251.0376.0251.0376', // octal 169.254.169.254
      '0xa9.0xfe.0xa9.0xfe', // hex 169.254.169.254
      '169.254.169.254',
      '127.1', // short-form loopback
      '127.0.1',
      '2130706433', // decimal 127.0.0.1
      '0', // 0.0.0.0
      '0.0.0.0',
      'metadata.google.internal',
      'metadata',
      'anything.internal',
    ]) {
      expect(isHostSafeEgressEntry(bad), bad).toBe(false);
    }
  });

  it('still allows RFC1918 private ranges (self-hosted GHE) and real hosts', () => {
    for (const ok of [
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      'github.com',
      'codeload.github.com',
    ]) {
      expect(isHostSafeEgressEntry(ok), ok).toBe(true);
    }
  });
});

describe('CheckProfileSchema', () => {
  it('leaves fixCommands undefined when omitted (optional, backward-compatible with stored profiles)', () => {
    const parsed = CheckProfileSchema.parse({ name: 'default', commands: ['yarn typecheck'] });
    expect(parsed.fixCommands).toBeUndefined();
  });

  it('accepts operator-authored fixCommands (deterministic auto-fix run before the gate)', () => {
    const parsed = CheckProfileSchema.parse({
      name: 'default',
      commands: ['yarn typecheck'],
      fixCommands: ['git diff -z --name-only "$BASE_SHA" | xargs -0 -r prettier --write'],
    });
    expect(parsed.fixCommands).toHaveLength(1);
  });

  it('requires name + commands', () => {
    expect(CheckProfileSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(CheckProfileSchema.safeParse({ commands: ['yarn typecheck'] }).success).toBe(false);
  });
});

describe('RepoBindingCreateInputSchema', () => {
  const base = {
    repo: 'example/repo',
    defaultBranch: 'main',
    allowedPushBranchPatterns: ['agent/*'],
    credentialKey: 'git-pat',
  };

  it('parses a valid input and defaults egressHosts/checkProfiles to []', () => {
    const parsed = RepoBindingCreateInputSchema.parse(base);
    expect(parsed.egressHosts).toEqual([]);
    expect(parsed.checkProfiles).toEqual([]);
  });

  it('accepts owner/repo, host/owner/repo, and an https remote as the coordinate', () => {
    for (const repo of [
      'example/repo',
      'git.acme.com/team/svc',
      'https://github.com/example/repo.git',
    ]) {
      expect(RepoBindingCreateInputSchema.safeParse({ ...base, repo }).success).toBe(true);
    }
  });

  it('rejects an unparseable repo coordinate at the schema boundary', () => {
    expect(RepoBindingCreateInputSchema.safeParse({ ...base, repo: 'ext::sh -c id' }).success).toBe(
      false,
    );
  });

  /**
   * Refused rather than accepted and ignored. The lane applies one allowlist for
   * the whole deployment, so a stored per-repo entry constrains no run — and it
   * did not fail silently, which is what made it read as working.
   */
  it('rejects a non-empty egressHosts, however well-formed', () => {
    const parsed = RepoBindingCreateInputSchema.safeParse({
      ...base,
      egressHosts: ['github.com'],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('egressHosts cannot be set');
    }
  });

  it('still accepts an omitted or empty egressHosts', () => {
    expect(RepoBindingCreateInputSchema.safeParse({ ...base, egressHosts: [] }).success).toBe(true);
    expect(RepoBindingCreateInputSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unsafe egressHosts entry', () => {
    expect(
      RepoBindingCreateInputSchema.safeParse({ ...base, egressHosts: ['https://x.com/p'] }).success,
    ).toBe(false);
  });

  it('does not accept a raw token field', () => {
    const parsed = RepoBindingCreateInputSchema.parse({
      ...base,
      token: 'ghp_should_be_stripped',
    } as unknown as typeof base);
    expect((parsed as Record<string, unknown>)['token']).toBeUndefined();
  });

  it('accepts linking a connection alone (no credentialKey)', () => {
    const { credentialKey: _omit, ...withoutCred } = base;
    const parsed = RepoBindingCreateInputSchema.safeParse({
      ...withoutCred,
      connectionBindingId: 'github-default',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts both a linked connection and a per-repo credential override', () => {
    expect(
      RepoBindingCreateInputSchema.safeParse({ ...base, connectionBindingId: 'github-default' })
        .success,
    ).toBe(true);
  });

  it('rejects neither a connection nor a credential (no way to resolve git/API)', () => {
    const { credentialKey: _omit, ...neither } = base;
    expect(RepoBindingCreateInputSchema.safeParse(neither).success).toBe(false);
  });
});
