/**
 * Repo coordinate (Plan 222) — the canonical, host-qualified identity for a
 * coding-lane repo, replacing the operator-invented `repoBindingId`. The agent
 * and the operator speak the coordinate they already know (`munchist/duality`);
 * the host qualifier keeps the lane's git-host generality (GitHub Enterprise,
 * forks across hosts, later GitLab) and is the unique-per-space designation key.
 */
import { z } from 'zod';

export const DEFAULT_REPO_HOST = 'github.com';

export interface RepoCoordinate {
  /** Lowercased host, e.g. `github.com`. */
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Hosts that treat owner/repo case-insensitively — fold to one canonical form. */
const CASE_INSENSITIVE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

function build(host: string, owner: string, repo: string): RepoCoordinate | null {
  const h = host.trim().toLowerCase();
  let o = owner.trim();
  let r = repo.trim().replace(/\.git$/i, '');
  if (!HOST_RE.test(h) || !SEGMENT_RE.test(o) || !SEGMENT_RE.test(r)) return null;
  // GitHub/GitLab/Bitbucket are case-insensitive on owner/repo, so fold them to
  // lowercase → ONE canonical designation per repo. Without this, github.com/Acme/Repo
  // and github.com/acme/repo key two divergent authorities (branch policy / credential)
  // for the same repository, and the agent's casing silently picks which one applies.
  if (CASE_INSENSITIVE_HOSTS.has(h)) {
    o = o.toLowerCase();
    r = r.toLowerCase();
  }
  return { host: h, owner: o, repo: r };
}

/**
 * Parse a coordinate from `owner/repo` (host defaults to github.com),
 * `host/owner/repo`, or an https remote URL. Returns null if unparseable.
 */
export function parseRepoCoordinate(input: string): RepoCoordinate | null {
  const s = input.trim();
  if (s.length === 0) return null;
  if (/^https?:\/\//i.test(s)) return coordinateFromRemoteUrl(s);
  const parts = s
    .replace(/\.git$/i, '')
    .split('/')
    .filter((p) => p.length > 0);
  if (parts.length === 2) return build(DEFAULT_REPO_HOST, parts[0]!, parts[1]!);
  if (parts.length === 3) return build(parts[0]!, parts[1]!, parts[2]!);
  return null;
}

/** Parse a coordinate from an https remote URL (no embedded credentials). */
export function coordinateFromRemoteUrl(remoteUrl: string): RepoCoordinate | null {
  let u: URL;
  try {
    u = new URL(remoteUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username.length > 0 || u.password.length > 0) return null;
  const segs = u.pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter((p) => p.length > 0);
  if (segs.length < 2) return null;
  return build(u.host, segs[0]!, segs[1]!);
}

/** Host-qualified canonical form — `github.com/munchist/duality`. The designation key. */
export function formatRepoCoordinate(c: RepoCoordinate): string {
  return `${c.host}/${c.owner}/${c.repo}`;
}

/** Display shorthand — `owner/repo` for github.com, host-qualified otherwise. */
export function repoCoordinateShorthand(c: RepoCoordinate): string {
  return c.host === DEFAULT_REPO_HOST ? `${c.owner}/${c.repo}` : formatRepoCoordinate(c);
}

/** The https clone URL for a coordinate (never carries credentials). */
export function repoCoordinateRemoteUrl(c: RepoCoordinate): string {
  return `https://${c.host}/${c.owner}/${c.repo}.git`;
}

/**
 * Whether a connection's API host (the host of its API base URL, e.g.
 * `api.github.com`) serves the SAME provider as a git coordinate host (e.g.
 * `github.com`). GitHub splits them (`api.github.com` ⇔ `github.com`); a
 * self-hosted GHE / GitLab serves both API and git from one host. This is the
 * Plan 222 P3 host-coherence gate: it stops a github.com PAT from being handed,
 * via `GIT_ASKPASS`, to a non-github.com coordinate (or the reverse) when a repo
 * resolves its git token THROUGH a linked connection.
 */
export function apiHostMatchesGitHost(apiHost: string, gitHost: string): boolean {
  const a = apiHost.trim().toLowerCase();
  const g = gitHost.trim().toLowerCase();
  if (a.length === 0 || g.length === 0) return false;
  return a === g || a === `api.${g}`;
}

/** A coordinate-string input (owner/repo, host/owner/repo, or an https remote). */
export const RepoCoordinateInputSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => parseRepoCoordinate(s) !== null, {
    message: 'Must be a repo coordinate: owner/repo, host/owner/repo, or an https remote URL.',
  });
