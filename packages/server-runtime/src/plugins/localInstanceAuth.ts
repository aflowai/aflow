/**
 * Authentication for the local edition.
 *
 * The appliance has no identity provider and no browser login. Its web BFF
 * holds a generated instance secret and presents it on every proxied call; the
 * loopback bind is what keeps that secret reachable only from the host. Beside
 * the secret the BFF forwards the browser's profile session, which names the
 * local user at the keyboard. An MCP client or automation script uses an
 * ordinary API key instead, so the two credentials stay separately revocable.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LOCAL_BROWSER_CALLER_HEADER,
  LOCAL_EDITION_OWNER_ID,
  LOCAL_PROFILE_SESSION_HEADER,
  type UserId,
  type EditionDescriptor,
} from '@aflow/schemas';
import type { AuthUser } from './auth.js';
import { readLocalProfileSession } from './localProfiles.js';

export const INSTANCE_SECRET_ENV = 'PHOENIX_INSTANCE_SECRET';

/** Shortest secret the appliance accepts, in characters. */
const MIN_SECRET_LENGTH = 32;

export interface LocalAuthConfigViolation {
  key: string;
  message: string;
}

/**
 * The secret as both the startup check and the comparison see it.
 *
 * Trimmed once here, because a secret written by `openssl rand … > .env` keeps
 * its newline: untrimmed, boot succeeds and every request 401s with nothing to
 * distinguish it from a wrong secret.
 */
export function resolveInstanceSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env[INSTANCE_SECRET_ENV]?.trim() ?? '';
}

/**
 * The owner id, defaulting when the variable is absent OR blank — `??` alone
 * keeps the `''` a stray `PHOENIX_LOCAL_OWNER_ID=` produces, and an empty id
 * reaches Postgres as a uuid parameter.
 */
function resolveOwnerId(env: NodeJS.ProcessEnv): string {
  const configured = env['PHOENIX_LOCAL_OWNER_ID']?.trim();
  return configured === undefined || configured === '' ? LOCAL_EDITION_OWNER_ID : configured;
}

/**
 * Validate the local edition's authentication configuration at startup.
 *
 * Returns violations rather than throwing so the caller can report every
 * startup problem in one message.
 */
export function findLocalAuthConfigViolations(
  edition: EditionDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): LocalAuthConfigViolation[] {
  if (edition.authProvider !== 'local-instance') return [];

  const violations: LocalAuthConfigViolation[] = [];

  const secret = resolveInstanceSecret(env);
  if (secret === '') {
    violations.push({
      key: INSTANCE_SECRET_ENV,
      message:
        'Required by the local edition — it is what the web BFF authenticates to this API with. Bootstrap generates one.',
    });
  } else if (secret.length < MIN_SECRET_LENGTH) {
    violations.push({
      key: INSTANCE_SECRET_ENV,
      message: `Must be at least ${MIN_SECRET_LENGTH} characters.`,
    });
  }

  const ownerId = resolveOwnerId(env);
  if (!z.string().uuid().safeParse(ownerId).success) {
    violations.push({
      key: 'PHOENIX_LOCAL_OWNER_ID',
      message: `Must be a UUID. Received "${ownerId}".`,
    });
  }

  return violations;
}

/**
 * Constant-time comparison over digests, so a mismatch costs the same whatever
 * the presented length is.
 *
 * An absent expected secret matches nothing. The startup check runs once at
 * registration while this reads the environment per request, so the two can
 * disagree — and without this an empty one would authenticate `Bearer ` as the
 * owner, which is the failure the startup check exists to prevent, arriving
 * through the door it does not watch.
 */
function secretsMatch(presented: string, expected: string): boolean {
  if (expected === '' || presented === '') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * How a request holding the instance secret came to name its user.
 *
 * - `sole-profile`: no profile session, on an install with one profile. The
 *   owner, granted without a membership read.
 * - `instance-secret`: no profile session and no browser behind it, on an
 *   install with several profiles. The owner, through the membership read.
 * - `profile-session`: a profile session named the user. The membership read
 *   decides, as it does for any other principal.
 */
export type LocalPrincipal = 'sole-profile' | 'instance-secret' | 'profile-session';

export function localOwner(
  env: NodeJS.ProcessEnv = process.env,
  principal: Exclude<LocalPrincipal, 'profile-session'> = 'sole-profile',
): AuthUser {
  return {
    userId: resolveOwnerId(env) as UserId,
    displayName: 'Local user',
    roles: [],
    authMethod: 'local',
    isServicePrincipal: false,
    localPrincipal: principal,
  };
}

function localProfile(userId: UserId): AuthUser {
  return {
    userId,
    roles: [],
    authMethod: 'local',
    isServicePrincipal: false,
    localPrincipal: 'profile-session',
  };
}

export type LocalRefusalCode = 'PROFILE_SESSION_REQUIRED' | 'PROFILE_SESSION_INVALID';

export type LocalAuthOutcome =
  /** The instance secret was presented, and the rule below named the user. */
  | { kind: 'local'; authUser: AuthUser }
  /** An API key was presented; the shared key path authenticates it. */
  | { kind: 'api-key'; token: string }
  /** The secret was presented, and the request still names no user it may act as. */
  | { kind: 'refused'; code: LocalRefusalCode; message: string }
  /** Nothing usable was presented. */
  | { kind: 'unauthenticated' };

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === '' ? undefined : first;
}

/**
 * Who a request to a local instance is (Plan 335 §8 question 7).
 *
 * With the instance secret, the rule is:
 *
 * 1. A profile session names its user, and the tenant plugin reads that user's
 *    membership. A session this instance did not issue is refused, never read
 *    as its absence.
 * 2. With no session, an install with one profile answers as it always has:
 *    the owner, with no membership read.
 * 3. With no session, an install with several profiles refuses a browser. The
 *    web process marks every call it makes for one, and the browser cannot
 *    remove the mark, so clearing the cookie or opening a private window
 *    reaches no profile at all.
 * 4. With no session and no mark, on an install with several profiles, the
 *    caller is the owner through the membership read. Such a caller holds the
 *    secret itself, which is the owner's whole authority, and could issue an
 *    owner session with it. Refusing it would guard nothing and break
 *    `yarn mcp:setup`.
 *
 * Rule 2 is also where the PIN lands (Plan 335 P4). A single profile that has
 * set a PIN must lose the fallback as a second profile does, so P4 extends the
 * condition. Until then a session naming the one profile is what it gets, and
 * rule 1 serves it.
 *
 * `hasSeveralProfiles` is asked only when rule 2 or 3 needs the answer. The
 * auth plugin answers it from a short cache that never rejects and answers
 * "several" when the count is unread (`cacheLocalProfileCount`).
 */
export async function authenticateLocalInstance(
  request: FastifyRequest,
  opts: {
    instanceSecret: string;
    apiKeyPrefix: string;
    hasSeveralProfiles: () => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
  },
): Promise<LocalAuthOutcome> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return { kind: 'unauthenticated' };

  const token = header.slice(7);

  // The secret is compared first. An operator may supply one, and a supplied
  // secret that happens to begin with the API-key prefix would otherwise be
  // dispatched to the key path and never match anything — locking the owner
  // out of their own instance with a generic 401.
  if (!secretsMatch(token, opts.instanceSecret)) {
    if (token.startsWith(opts.apiKeyPrefix)) return { kind: 'api-key', token };
    return { kind: 'unauthenticated' };
  }

  const session = headerValue(request, LOCAL_PROFILE_SESSION_HEADER);
  if (session !== undefined) {
    const userId = readLocalProfileSession(session, opts.instanceSecret);
    if (userId === null) {
      return {
        kind: 'refused',
        code: 'PROFILE_SESSION_INVALID',
        message: 'The profile session was not issued by this instance. Choose a profile again.',
      };
    }
    return { kind: 'local', authUser: localProfile(userId) };
  }

  if (!(await opts.hasSeveralProfiles())) {
    return { kind: 'local', authUser: localOwner(opts.env, 'sole-profile') };
  }
  if (headerValue(request, LOCAL_BROWSER_CALLER_HEADER) !== undefined) {
    return {
      kind: 'refused',
      code: 'PROFILE_SESSION_REQUIRED',
      message: 'This install has more than one profile. Choose a profile to continue.',
    };
  }
  return { kind: 'local', authUser: localOwner(opts.env, 'instance-secret') };
}
