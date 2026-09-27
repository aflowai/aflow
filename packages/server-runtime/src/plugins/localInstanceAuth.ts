/**
 * Authentication for the single-user local edition.
 *
 * The appliance has no identity provider and no browser login. Its web BFF
 * holds a generated instance secret and presents it on every proxied call; the
 * loopback bind is what keeps that secret reachable only from the host. An MCP
 * client or automation script uses an ordinary API key instead, so the two
 * credentials stay separately revocable.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOCAL_EDITION_OWNER_ID, type UserId, type EditionDescriptor } from '@aflow/schemas';
import type { AuthUser } from './auth.js';

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

export function localOwner(env: NodeJS.ProcessEnv = process.env): AuthUser {
  return {
    userId: resolveOwnerId(env) as UserId,
    displayName: 'Local user',
    roles: [],
    authMethod: 'local',
    isServicePrincipal: false,
  };
}

export type LocalAuthOutcome =
  /** The instance secret was presented; the request is the local owner. */
  | { kind: 'owner'; authUser: AuthUser }
  /** An API key was presented; the shared key path authenticates it. */
  | { kind: 'api-key'; token: string }
  /** Nothing usable was presented. */
  | { kind: 'unauthenticated' };

export function authenticateLocalInstance(
  request: FastifyRequest,
  opts: { instanceSecret: string; apiKeyPrefix: string; env?: NodeJS.ProcessEnv },
): LocalAuthOutcome {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return { kind: 'unauthenticated' };

  const token = header.slice(7);

  // The secret is compared first. An operator may supply one, and a supplied
  // secret that happens to begin with the API-key prefix would otherwise be
  // dispatched to the key path and never match anything — locking the owner
  // out of their own instance with a generic 401.
  if (secretsMatch(token, opts.instanceSecret)) {
    return { kind: 'owner', authUser: localOwner(opts.env) };
  }
  if (token.startsWith(opts.apiKeyPrefix)) return { kind: 'api-key', token };
  return { kind: 'unauthenticated' };
}
