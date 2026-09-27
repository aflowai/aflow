/**
 * Repo binding model — the space-scoped coding-lane repo authority.
 *
 * Fixes the repo (by host-qualified coordinate), default branch, allowed
 * push-branch patterns, egress hosts, and named operator-authored check profiles
 * outside the workflow. The git credential is referenced by name (`credentialKey`);
 * the token itself never lives on the row. The agent references a repo by its
 * coordinate (Plan 222) and chooses only branch + task.
 */
import { z } from 'zod';
import { isValidBranchName, isValidPushBranchPattern } from './repoBranchMatching.js';
import { RepoCoordinateInputSchema } from './repoCoordinate.js';

export const RepoBindingStatusSchema = z.enum(['provisioning', 'ready', 'error', 'archived']);
export type RepoBindingStatus = z.infer<typeof RepoBindingStatusSchema>;

/**
 * Operator-authored named check profile. Shell commands are permitted here
 * because the profile is operator-authored — the agent never proposes commands.
 */
export const CheckProfileSchema = z.object({
  name: z.string(),
  commands: z.array(
    z
      .string()
      .describe(
        'Shell command run in the repo root, token-less, as a review-readiness SIGNAL ' +
          'after the patch is bundled — a non-zero exit marks the PR a DRAFT (not ' +
          'review-ready), it NEVER rejects the patch (Plan 232: a real diff always ' +
          'lands). `$BASE_SHA` is the ' +
          'branch-point commit: scope format/lint to the change with ' +
          '`git diff -z --name-only --diff-filter=ACMR "$BASE_SHA" | xargs -0 -r <linter>` — ' +
          'a whole-repo check fails on pre-existing drift the scope-disciplined harness ' +
          "won't touch. Keep typecheck/build whole-repo (a change's blast radius). Put " +
          'auto-fixable concerns (formatting) in `fixCommands`, not here.',
      ),
  ),
  fixCommands: z
    .array(
      z
        .string()
        .describe(
          'Shell command run in the repo root, token-less, AFTER the harness and ' +
            'BEFORE the patch is bundled — for DETERMINISTIC auto-fixes the harness ' +
            'should not have to do by hand, above all formatting. Scope to the change: ' +
            '`git diff -z --name-only --diff-filter=ACMR "$BASE_SHA" | xargs -0 -r ' +
            'prettier --write --ignore-unknown`. Non-gating: a failure is logged, not ' +
            'fatal. This normalizes the patch so a formatting miss never even reaches the ' +
            'check `commands` signal — which (Plan 232) only marks the PR a draft, never ' +
            'rejects it or forces a re-run.',
        ),
    )
    .optional(),
});
export type CheckProfile = z.infer<typeof CheckProfileSchema>;

/**
 * The SINGLE authority for whether a remote URL may be used by the coding lane.
 * A bare https remote with no embedded userinfo. Allowlisting the scheme (not just
 * denying `user:pass@`) is what closes git transport-helper RCE: `ext::sh -c …` and
 * `fd::` run arbitrary commands inside the lane container, and scp-style
 * `git@host:path` smuggles a host — none of which are `https://…`. http:// is
 * rejected too: git sends the PAT in the Authorization header, so a plaintext
 * remote would exfiltrate the credential on the wire. Embedded credentials are
 * rejected because they leak into argv/reflog.
 *
 * Imported by BOTH the lane backend (`prepare`/`push`) and the operator REST route
 * (binding creation). A guard test forbids any second copy — validating one form
 * and executing another is the failure this consolidation prevents.
 */
export function isAllowedRemoteUrl(remoteUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  return parsed.username === '' && parsed.password === '';
}

/**
 * The git hosts a lane can actually reach.
 *
 * `isAllowedRemoteUrl` above allowlists the SCHEME and says nothing about the
 * host, because the coordinate deliberately keeps the lane's host generality —
 * GitHub Enterprise, forks across hosts, later GitLab. The lane's egress
 * allowlist is host-specific, so without a shared authority the two disagree: a
 * designation for an unreachable host validates, stores, and reports `ready`,
 * and the run fails at its first clone with a proxy refusal that names nothing
 * the operator configured.
 *
 * Stated once, here, and read by BOTH the designation write boundary and the
 * lane's egress policy — the same consolidation `isAllowedRemoteUrl` exists for.
 * Widening it is Plan 286 §4.7b, where per-designation egress makes the host a
 * property of the designation rather than of the deployment.
 */
export const LANE_SUPPORTED_GIT_HOSTS: readonly string[] = ['github.com'];

export function isLaneSupportedGitHost(host: string): boolean {
  return LANE_SUPPORTED_GIT_HOSTS.includes(host.trim().toLowerCase());
}

/**
 * inet_aton-style IPv4 parse: accepts the dotted/short forms with decimal, octal
 * (`0`-prefixed), or hex (`0x`) octets that libcurl/glibc resolve — so a host like
 * `2852039166`, `0xa9.0xfe.0xa9.0xfe`, or `127.1` is recognized as the IP it really
 * is, not waved through as a "hostname". Returns the uint32 address, or null when the
 * host is not an IPv4 literal in any of these encodings.
 */
function parseIpv4Loose(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isInteger(n) || n < 0) return null;
    vals.push(n);
  }
  const last = vals[vals.length - 1]!;
  let addr = 0;
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i]! > 255) return null;
    addr = addr * 256 + vals[i]!;
  }
  const remaining = 4 - (vals.length - 1);
  if (last > Math.pow(256, remaining) - 1) return null;
  addr = addr * Math.pow(256, remaining) + last;
  return addr >>> 0;
}

/**
 * A host (already `*.`-stripped + lowercased) the lane must NEVER reach: loopback,
 * the link-local range that contains the cloud metadata endpoint (in ANY IP
 * encoding), `0.0.0.0/8`, IPv6 literals, and the GCE metadata DNS names. RFC1918
 * private ranges stay allowed — a self-hosted GHE can live on a private network.
 */
function isBlockedInternalHost(lowered: string): boolean {
  if (lowered === 'localhost' || lowered === 'metadata') return true;
  if (lowered.endsWith('.internal')) return true; // GCE/internal private TLD
  if (lowered.includes(':')) return true; // IPv6 literal — raw-IPv6 git hosts are not used
  const ip = parseIpv4Loose(lowered);
  if (ip !== null) {
    const o1 = (ip >>> 24) & 0xff;
    const o2 = (ip >>> 16) & 0xff;
    // 0.0.0.0/8 (this-network), 127.0.0.0/8 (loopback), 169.254.0.0/16 (link-local,
    // which contains 169.254.169.254 — the metadata/credential SSRF sink).
    return o1 === 0 || o1 === 127 || (o1 === 169 && o2 === 254);
  }
  return false;
}

/**
 * The SINGLE authority for whether an egress-allowlist entry / git host is host-safe.
 * A bare hostname (optionally a leading-`*.` wildcard for subdomains) — no scheme, no
 * userinfo, no port, no path, no query. This keeps an entry from smuggling a URL
 * delimiter that would widen the allowlist (`evil.com/@trusted.com`, an embedded port,
 * a `//` authority). Matches the host grammar the API egress allowlist accepts.
 *
 * Hard-blocked SSRF targets — the cloud metadata endpoint (`169.254.169.254` and the
 * `metadata.google.internal` DNS name, in ANY IP encoding), `localhost`, the loopback
 * range (`127.0.0.0/8`), `0.0.0.0/8`, and IPv6 literals — are rejected even though they
 * pass the bare-host grammar (see `isBlockedInternalHost`). RFC1918 private ranges stay
 * allowed: a self-hosted GHE can legitimately live on a private network.
 */
export function isHostSafeEgressEntry(host: string): boolean {
  if (host.length === 0 || host.length > 255) return false;
  const body = host.startsWith('*.') ? host.slice(2) : host;
  const lowered = body.toLowerCase();
  if (isBlockedInternalHost(lowered)) return false;
  // Labels: alphanumeric with internal hyphens, separated by dots. No empty labels.
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?))*$/.test(
    body,
  );
}

/**
 * Operator create/upsert input for a repo designation. The repo is named by its
 * coordinate (`owner/repo`, `host/owner/repo`, or an https remote URL); the clone
 * remote is derived from it, so no raw remote string is accepted (the https-only /
 * no-userinfo authority is provable, not validated).
 *
 * A repo designation resolves through a GitHub **connection** (Plan 222 P3): an
 * XOR-ish contract — EITHER link an existing connection by `connectionBindingId`,
 * OR bootstrap one by naming a `credentialKey` (the route ensures the github API
 * definition + a bearer binding from it). At least one MUST be supplied; with
 * neither there is no connection to resolve git/API through. When both are
 * supplied, `credentialKey` is the per-repo git override — the route HARD-FAILS
 * if it names a credential that differs from the linked connection's (no silent
 * skip). The git credential is referenced by NAME only (→ api_credentials in the
 * same space); a raw token is never accepted. `egressHosts` is refused while
 * non-empty — the lane applies one allowlist for the whole deployment, so a
 * per-repo entry would be stored and never enforced (§4.7b re-opens it). The
 * route also enforces that no allowed push pattern may match the default branch,
 * that the coordinate's host is both an allowed git host and one the lane can
 * reach, and that the linked/bootstrapped connection is a same-space, enabled,
 * host-coherent github connection.
 */
export const RepoBindingCreateInputSchema = z
  .object({
    repo: RepoCoordinateInputSchema,
    description: z.string().max(2000).optional(),
    defaultBranch: z.string().min(1).max(255).refine(isValidBranchName, {
      message:
        'defaultBranch must be a plain branch name (no refs/heads/ prefix, no whitespace, no .. or //).',
    }),
    allowedPushBranchPatterns: z.array(
      z
        .string()
        .min(1)
        .max(255)
        .refine(isValidPushBranchPattern, {
          message:
            'allowedPushBranchPatterns entries must be a plain branch name or a "prefix/*" / "prefix*" ' +
            'glob with a valid branch prefix (no whitespace, no .. or //).',
        }),
    ),
    /**
     * Refused while non-empty. The lane's egress allowlist is fixed for the
     * deployment, so a per-designation entry constrains nothing at run time —
     * and it did not fail silently: it was judged against the tenant host
     * allowlist at write and rendered back as chips, which is what made it read
     * as working. Plan 286 §4.7b is where it becomes real; until then the field
     * is refused rather than accepted and ignored.
     */
    egressHosts: z
      .array(
        z.string().refine(isHostSafeEgressEntry, {
          message:
            'egressHosts entries must be bare hostnames (no scheme, port, path, or userinfo).',
        }),
      )
      .max(0, {
        message:
          'egressHosts cannot be set. The coding lane applies one egress allowlist for the ' +
          'whole deployment, so a per-repo entry would be stored and never enforced. Per-repo ' +
          'egress is a planned change to the lane, not a setting on this designation.',
      })
      .default([]),
    checkProfiles: z.array(CheckProfileSchema).default([]),
    /** Link an existing GitHub connection (its `api_bindings.bindingId`). */
    connectionBindingId: z.string().min(1).max(128).optional(),
    /** Bootstrap-from / per-repo git override — a credential NAME in this space. */
    credentialKey: z.string().min(1).max(256).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.connectionBindingId === undefined && val.credentialKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either connectionBindingId (link an existing GitHub connection) or ' +
          'credentialKey (bootstrap a connection from a git credential).',
        path: ['connectionBindingId'],
      });
    }
  });
export type RepoBindingCreateInput = z.infer<typeof RepoBindingCreateInputSchema>;

/** Response DTO for a repo designation — never carries a secret (credentialKey is a name). */
export const RepoBindingResponseSchema = z.object({
  repoDesignationId: z.string(),
  spaceId: z.string(),
  coordinate: z.string(),
  remoteUrl: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  allowedPushBranchPatterns: z.array(z.string()),
  egressHosts: z.array(z.string()),
  checkProfiles: z.array(CheckProfileSchema),
  /** The GitHub connection this designation resolves git + API through. */
  connectionBindingId: z.string(),
  credentialKey: z.string().nullable(),
  status: RepoBindingStatusSchema,
  lastValidatedAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RepoBindingResponse = z.infer<typeof RepoBindingResponseSchema>;
