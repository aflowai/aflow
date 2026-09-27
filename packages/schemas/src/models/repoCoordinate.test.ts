import { describe, expect, it } from 'vitest';
import {
  apiHostMatchesGitHost,
  coordinateFromRemoteUrl,
  formatRepoCoordinate,
  parseRepoCoordinate,
  repoCoordinateRemoteUrl,
  repoCoordinateShorthand,
  RepoCoordinateInputSchema,
} from './repoCoordinate.js';

describe('apiHostMatchesGitHost', () => {
  it('matches GitHub split hosts (api.github.com ⇔ github.com)', () => {
    expect(apiHostMatchesGitHost('api.github.com', 'github.com')).toBe(true);
  });

  it('matches a single-host provider (GHE / GitLab serve API + git from one host)', () => {
    expect(apiHostMatchesGitHost('git.acme.com', 'git.acme.com')).toBe(true);
  });

  it('rejects a cross-host pairing (github.com API for a non-github coordinate)', () => {
    expect(apiHostMatchesGitHost('api.github.com', 'git.acme.com')).toBe(false);
    expect(apiHostMatchesGitHost('api.github.com', 'gitlab.com')).toBe(false);
  });

  it('rejects empty hosts', () => {
    expect(apiHostMatchesGitHost('', 'github.com')).toBe(false);
    expect(apiHostMatchesGitHost('api.github.com', '')).toBe(false);
  });
});

describe('parseRepoCoordinate', () => {
  it('parses owner/repo with github.com as the default host', () => {
    expect(parseRepoCoordinate('munchist/duality')).toEqual({
      host: 'github.com',
      owner: 'munchist',
      repo: 'duality',
    });
  });

  it('parses host/owner/repo with an explicit host', () => {
    expect(parseRepoCoordinate('git.acme.com/team/service')).toEqual({
      host: 'git.acme.com',
      owner: 'team',
      repo: 'service',
    });
  });

  it('parses an https remote URL and strips a .git suffix', () => {
    expect(parseRepoCoordinate('https://github.com/munchist/duality.git')).toEqual({
      host: 'github.com',
      owner: 'munchist',
      repo: 'duality',
    });
  });

  it('folds owner/repo case on case-insensitive hosts (one canonical per repo)', () => {
    expect(parseRepoCoordinate('GitHub.com/Munchist/Duality')).toEqual({
      host: 'github.com',
      owner: 'munchist',
      repo: 'duality',
    });
    // Same repo, different casing → the SAME canonical coordinate (no divergent designations).
    expect(parseRepoCoordinate('munchist/duality')).toEqual(
      parseRepoCoordinate('Munchist/Duality'),
    );
  });

  it('preserves owner/repo case on unknown (possibly case-sensitive) hosts', () => {
    expect(parseRepoCoordinate('git.acme.com/Team/Service')).toEqual({
      host: 'git.acme.com',
      owner: 'Team',
      repo: 'Service',
    });
  });

  it('rejects garbage, single segments, and deep paths', () => {
    expect(parseRepoCoordinate('')).toBeNull();
    expect(parseRepoCoordinate('justone')).toBeNull();
    expect(parseRepoCoordinate('a/b/c/d')).toBeNull();
    expect(parseRepoCoordinate('owner/has space')).toBeNull();
  });
});

describe('coordinateFromRemoteUrl', () => {
  it('rejects non-https and credential-bearing remotes', () => {
    expect(coordinateFromRemoteUrl('http://github.com/o/r')).toBeNull();
    expect(coordinateFromRemoteUrl('ssh://git@github.com/o/r')).toBeNull();
    expect(coordinateFromRemoteUrl('https://user:tok@github.com/o/r')).toBeNull();
  });

  it('ignores path segments past owner/repo', () => {
    expect(coordinateFromRemoteUrl('https://github.com/o/r/tree/main')).toEqual({
      host: 'github.com',
      owner: 'o',
      repo: 'r',
    });
  });
});

describe('formatting helpers', () => {
  const c = { host: 'github.com', owner: 'munchist', repo: 'duality' } as const;

  it('formats the host-qualified canonical key', () => {
    expect(formatRepoCoordinate(c)).toBe('github.com/munchist/duality');
  });

  it('shortens github.com coordinates but keeps other hosts qualified', () => {
    expect(repoCoordinateShorthand(c)).toBe('munchist/duality');
    expect(repoCoordinateShorthand({ host: 'git.acme.com', owner: 'a', repo: 'b' })).toBe(
      'git.acme.com/a/b',
    );
  });

  it('builds a credential-free https clone URL', () => {
    expect(repoCoordinateRemoteUrl(c)).toBe('https://github.com/munchist/duality.git');
  });
});

describe('RepoCoordinateInputSchema', () => {
  it('accepts parseable forms and rejects the rest', () => {
    expect(RepoCoordinateInputSchema.safeParse('munchist/duality').success).toBe(true);
    expect(RepoCoordinateInputSchema.safeParse('https://github.com/o/r').success).toBe(true);
    expect(RepoCoordinateInputSchema.safeParse('nope').success).toBe(false);
  });
});
