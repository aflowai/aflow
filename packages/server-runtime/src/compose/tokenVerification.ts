/**
 * How this distribution verifies a bearer JWT, and what it reads out of one.
 *
 * `authenticate` has four arms — the local instance credential, the
 * development bypass, an API key, and a bearer JWT. Only the last is
 * provider-shaped, and the four share no code, so this contract replaces one
 * of them without reaching the other three.
 *
 * Everything downstream stays core: resolving the subject to an internal user,
 * the sign-up rate limit, JIT provisioning, and the `AuthUser` the rest of the
 * server reads. What a provider decides is how a token is proven and how its
 * claims spell the same few fields.
 */
import jwt from '@fastify/jwt';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import { readClaim, readStringClaim, readBooleanClaim } from '../lib/tokenClaims.js';

/** Profile fields core needs before it can provision or update a user. */
export interface TokenProfile {
  email?: string | undefined;
  displayName?: string | undefined;
  pictureUrl?: string | undefined;
  roles: string[];
}

export interface EmailVerificationInput {
  /** Verified claims from the token. */
  claims: Record<string, unknown>;
  /** The address the token asserts, already lowercased. */
  email: string | undefined;
  /** The raw bearer token, which some providers can also spend at `/userinfo`. */
  accessToken: string;
  /** Cache identity — the provider subject this answer belongs to. */
  subject: string;
  redis: Redis | null | undefined;
  log: FastifyBaseLogger;
}

export interface ConfigViolation {
  key: string;
  message: string;
}

export interface TokenVerification {
  /** Names this verifier in logs. Not the identity provider key. */
  readonly name: string;

  /**
   * Configure token verification on this instance — registering the JWT
   * plugin with whatever secret, algorithms and claim constraints the
   * provider requires. Called once, at plugin registration.
   */
  register(fastify: FastifyInstance): Promise<void>;

  readProfile(claims: Record<string, unknown>): TokenProfile;

  /**
   * Whether the directory has verified the address the token asserts.
   *
   * Admission, identity linking and grant redemption all hang off this one
   * boolean, so "the token did not say" may not be answered as "not
   * verified" — that degradation is silent and total. A provider that cannot
   * confirm an address must find out rather than assume.
   */
  isEmailVerified(input: EmailVerificationInput): Promise<boolean>;
}

/**
 * A distribution's identity contribution: how to build its verifier, and what
 * must be true for it to work.
 *
 * Two members rather than one because they answer at different times. A
 * verifier built from an unconfigured environment is null, which is exactly
 * the state the startup check exists to report — so a plane that reported
 * violations through the verifier could never report the one that matters.
 */
export interface IdentityPlane {
  /** Built from the environment, or null where this provider is unconfigured. */
  verification(env: NodeJS.ProcessEnv): TokenVerification | null;
  configurationViolations(env: NodeJS.ProcessEnv): ConfigViolation[];
}

/**
 * The verifier a process uses when no distribution supplied one.
 *
 * Symmetric. `assertProductionSecurityConfig` refuses a production boot whose
 * edition names an identity provider it has no configuration for, so this
 * cannot quietly become the thing verifying real tokens. An unset `JWT_SECRET`
 * takes a per-process random value, so a token minted against a value read out
 * of this repository verifies nowhere.
 */
export function developmentTokenVerification(secret: string): TokenVerification {
  return {
    name: 'development symmetric secret',

    async register(fastify) {
      await fastify.register(jwt, { secret });
    },

    readProfile(claims) {
      const roles = readClaim(claims, 'roles');
      return {
        email: readStringClaim(claims, 'email'),
        displayName: readStringClaim(claims, 'name'),
        pictureUrl: readStringClaim(claims, 'picture'),
        roles: Array.isArray(roles) ? (roles as string[]) : [],
      };
    },

    isEmailVerified({ claims }) {
      // No directory to ask. A development token carries the flag or it does
      // not, and an absent flag is an unverified address.
      return Promise.resolve(readBooleanClaim(claims, 'email_verified') ?? false);
    },
  };
}
