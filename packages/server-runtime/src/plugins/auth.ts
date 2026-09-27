/**
 * Authentication Plugin — Dual-mode JWT + API Key
 *
 * Validates authentication credentials and resolves internal user identity.
 *
 * Two credential formats are supported:
 *   1. **JWT** — `Bearer ey...` — OIDC access tokens verified via JWKS or
 *      a static dev secret.  After verification the IdP `sub` is resolved
 *      to an internal `UserId` via the `user_identities` table (cached in
 *      Redis for 5 minutes).
 *   2. **API Key** — `Bearer phx_...` — SHA-256 hashed, looked up in
 *      Redis cache (5-min TTL) then the `api_keys` table.  `last_used_at`
 *      is updated asynchronously so it never blocks the request.
 *
 * In development mode (no Auth0 config, NODE_ENV !== 'production'), requests
 * without a token are assigned a real dev user that is upserted into the
 * `users` and `tenant_memberships` tables on first use.
 */
import { randomBytes } from 'crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import {
  users,
  userIdentities,
  apiKeys,
  tenantMemberships,
  invites,
  getTenantSignupPolicy,
} from '@aflow/database';
import type { TenantId, UserId } from '@aflow/schemas';
import type { AuthMethod } from '@aflow/schemas';
import { hasIdentityProviderConfig } from '@aflow/schemas';
import { decideJitAdmission } from '../lib/signupAdmission.js';
import { databaseErrorText } from '../lib/databaseErrors.js';
import { syncUserProfile } from '../lib/profileSync.js';
import { redeemSpaceGrantsForVerifiedEmail } from '../services/spaceGrants.js';
import { clientIp } from '../lib/clientIp.js';
import { consumeSignupRateLimit, SIGNUP_RATE_LIMIT_WINDOW_MS } from '../lib/rateLimitPolicy.js';
import {
  developmentTokenVerification,
  type IdentityPlane,
  type TokenVerification,
} from '../compose/tokenVerification.js';
import { assertProductionSecurityConfig } from '../lib/productionSecurityConfig.js';
import { API_KEY_PREFIX, hashApiKey } from '../lib/apiKeys.js';
import {
  authenticateLocalInstance,
  findLocalAuthConfigViolations,
  resolveInstanceSecret,
} from './localInstanceAuth.js';

// ============================================================================
// Constants
// ============================================================================

/** Redis TTL for identity resolution cache (seconds). */
const IDENTITY_CACHE_TTL = 300; // 5 minutes

/** Redis TTL for API key lookup cache (seconds). */
const API_KEY_CACHE_TTL = 300; // 5 minutes

/** Well-known dev user UUID. */
const DEV_USER_ID = '00000000-0000-0000-0000-000000000001' as UserId;

// ============================================================================
// Types
// ============================================================================

/**
 * Auth0 JWT claims structure.
 */
export interface Auth0Claims {
  /** Subject (user ID from Auth0) */
  sub: string;
  /** Issuer (Auth0 domain) */
  iss: string;
  /** Audience */
  aud: string | string[];
  /** Expiration time */
  exp: number;
  /** Issued at */
  iat: number;
  /** Email (if requested in scope) */
  email?: string;
  /** Email verified */
  email_verified?: boolean;
  /** Custom namespace claims (e.g., roles, tenant) */
  [key: string]: unknown;
}

/**
 * Authenticated user context attached to every request.
 */
export interface AuthUser {
  /** Internal Phoenix user ID (from public.users table) */
  userId: UserId;
  /** User email */
  email?: string | undefined;
  /** Display name */
  displayName?: string | undefined;
  /** Roles extracted from JWT custom claims */
  roles: string[];
  /** Authentication method used for this request */
  authMethod: AuthMethod;
  /** Whether this is a service principal (non-human) identity */
  isServicePrincipal: boolean;
  /** API key prefix (only set when authMethod is 'api_key') */
  apiKeyPrefix?: string | undefined;
  /** Tenant ID bound to the API key (only set when authMethod is 'api_key') */
  apiKeyTenantId?: TenantId | undefined;
  /** Raw JWT claims (only set when authMethod is 'jwt' or 'dev_bypass') */
  claims?: Auth0Claims | undefined;
}

// Extend Fastify types — use a custom property to avoid conflicts with jwt.user
declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser | undefined;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Redis key holding the resolved identity for an IdP subject. */
function identityCacheKey(provider: string, providerSub: string): string {
  return `aflow:identity:${provider}:${providerSub}`;
}

/**
 * The name stored on an identity row, and half of the key it is looked up by.
 *
 * Deliberately not the issuer. A directory answers on more than one domain —
 * its own and any custom one — and the subject is the same across them, so
 * recording the issuer meant a domain change turned every existing user into a
 * stranger. What the row identifies is the directory, which does not change
 * when the address does.
 *
 * It is also not the provider's to choose. A verifier that named its own would
 * strand every row written under the previous answer, development included,
 * where the same value is stored as a hosted login writes.
 *
 * This is safe precisely because a token reaches this point only after passing
 * the verifier's issuer check, so every issuer seen here is one an operator
 * named — which places a constraint on any provider that accepts more than
 * one: they must all be the same directory. Two there would let subjects from
 * one resolve to identities of the other.
 */
function identityProviderKey(): string {
  return 'auth0';
}

// ============================================================================
// Plugin
// ============================================================================

export interface AuthPluginOptions {
  /**
   * The distribution's identity plane, where it has one. Absent in core, which
   * verifies bearer tokens with a development symmetric secret and refuses a
   * production boot that would rely on it.
   */
  identityPlane?: IdentityPlane | undefined;
}

export const authPlugin = fp(
  async (fastify: FastifyInstance, options: AuthPluginOptions) => {
    const localAuthViolations = findLocalAuthConfigViolations(fastify.edition);
    if (localAuthViolations.length > 0) {
      throw new Error(
        `Local edition authentication is not usable:\n${localAuthViolations
          .map((v) => `  - ${v.key}: ${v.message}`)
          .join('\n')}`,
      );
    }

    // ---- Bearer-token verification -----------------------------------------
    // Redundant with the boot-time assertion in `buildApp`, but this plugin is
    // the thing that would otherwise register a symmetric verifier — the guard
    // belongs where the mistake would be made.
    assertProductionSecurityConfig(options.identityPlane);

    const isLocalInstance = fastify.edition.authProvider === 'local-instance';
    const provided = options.identityPlane?.verification(process.env) ?? null;

    // Identity configuration this build composes no reader for is refused
    // rather than ignored, and at every NODE_ENV rather than only in
    // production. The operator has said a directory is in front of this
    // deployment; carrying on would verify real tokens with a development
    // symmetric secret, and would answer "the token did not say" as "not
    // verified" for an address the directory would have vouched for. Both
    // degradations are silent, and neither is what was configured. The local
    // edition refuses the same configuration one layer up, which is why it is
    // excluded here rather than checked twice.
    if (!provided && !isLocalInstance && hasIdentityProviderConfig(process.env)) {
      throw new Error(
        'Refusing to start: identity provider configuration is present and this build composes no provider. ' +
          'Run the distribution root that supplies one, or remove the configuration.',
      );
    }

    // Never a shipped constant: an unset JWT_SECRET gets a per-process random
    // value, so a token minted against a value read out of this repository
    // cannot verify anywhere.
    const verification: TokenVerification =
      provided ??
      developmentTokenVerification(process.env['JWT_SECRET'] ?? randomBytes(32).toString('hex'));

    if (isLocalInstance) {
      fastify.log.info(
        'Auth plugin: local instance identity — no identity provider, no development bypass',
      );
    } else if (!provided) {
      fastify.log.warn(
        `No identity provider configured. Verifying bearer tokens with a ${verification.name}.`,
      );
    } else {
      fastify.log.info(`Auth plugin: ${verification.name}`);
    }

    await verification.register(fastify);

    const isDevelopment = process.env['NODE_ENV'] !== 'production';
    // The local edition has a credential of its own, so the bypass is both
    // unreachable and untrue to announce.
    const allowDevBypass = isDevelopment && !provided && !isLocalInstance;

    if (allowDevBypass) {
      fastify.log.info(
        'Development auth bypass enabled — requests without tokens will use dev user',
      );
    }

    // ---- Helper: resolve IdP subject → internal UserId ---------------------
    async function resolveUserByIdpSub(
      provider: string,
      providerSub: string,
      _email: string | undefined,
    ): Promise<{
      userId: UserId;
      displayName: string;
      kind: string;
      email: string | null;
      avatarUrl: string | null;
    } | null> {
      const ctx = fastify.appContext;
      if (!ctx?.db || !ctx.redis) return null;

      const db = ctx.db as PostgresJsDatabase;
      const redis = ctx.redis;

      // Check Redis cache first
      const cacheKey = identityCacheKey(provider, providerSub);
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as {
            userId: UserId;
            displayName: string;
            kind: string;
            email: string | null;
            avatarUrl: string | null;
          };
        } catch {
          // Corrupted cache entry — fall through to DB
        }
      }

      // DB lookup: user_identities JOIN users
      const rows = await db
        .select({
          userId: userIdentities.userId,
          displayName: users.displayName,
          kind: users.kind,
          email: users.email,
          avatarUrl: users.avatarUrl,
        })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(
          and(eq(userIdentities.provider, provider), eq(userIdentities.providerSub, providerSub)),
        )
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const result = {
        userId: row.userId as UserId,
        displayName: row.displayName,
        kind: row.kind,
        email: row.email,
        avatarUrl: row.avatarUrl,
      };

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(result), 'EX', IDENTITY_CACHE_TTL);

      // Update lastLoginAt asynchronously (fire-and-forget)
      db.update(userIdentities)
        .set({ lastLoginAt: new Date() })
        .where(
          and(eq(userIdentities.provider, provider), eq(userIdentities.providerSub, providerSub)),
        )
        .then(() => {})
        .catch((err: unknown) => {
          fastify.log.warn({ err, provider, providerSub }, 'Failed to update lastLoginAt');
        });

      // Whether a stored address still has grants waiting on it is a standing
      // property, not something a past run stamped: every place that redeems
      // at admission does so for immediacy, and a redemption that failed there
      // leaves no trace to retry from — the address is already stored, so no
      // later login sees anything to repair. Recomputing it here, off the
      // response path and only when the identity was read from the database,
      // costs two indexed reads per identity-cache lifetime and bounds how
      // long any missed redemption can survive.
      if (result.email) {
        redeemSpaceGrantsForVerifiedEmail({
          db,
          redis,
          userId: result.userId,
          email: result.email,
          log: fastify.log,
        }).catch((err: unknown) => {
          fastify.log.warn({ err, userId: result.userId }, 'Standing grant reconciliation failed');
        });
      }

      return result;
    }

    // ---- Helper: Sync profile from IdP claims (fire-and-forget) -------------
    function scheduleProfileSync(
      userId: UserId,
      cachedIdentityKey: string,
      profile: { avatarUrl?: string; displayName?: string; email?: string },
    ) {
      const ctx = fastify.appContext;
      if (!ctx?.db) return;

      void syncUserProfile({
        db: ctx.db as PostgresJsDatabase,
        redis: ctx.redis,
        log: fastify.log,
        userId,
        identityCacheKey: cachedIdentityKey,
        profile,
      });
    }

    // ---- Helper: JIT provision a new Auth0 user -----------------------------
    async function jitProvisionUser(
      provider: string,
      providerSub: string,
      email: string | undefined,
      displayName: string | undefined,
      avatarUrl: string | undefined,
      emailVerified: boolean,
    ): Promise<
      | {
          userId: UserId;
          displayName: string;
          kind: string;
          email: string | null;
          avatarUrl: string | null;
        }
      | 'not_admitted'
      | null
    > {
      const ctx = fastify.appContext;
      if (!ctx?.db || !ctx.redis) return null;

      const db = ctx.db as PostgresJsDatabase;
      const redis = ctx.redis;
      const isProduction = process.env['NODE_ENV'] === 'production';

      const name = displayName || email || providerSub;

      // One normalization for storage and every lookup: the uniqueness index
      // is case-sensitive, so a case variant would otherwise create a second
      // account rather than collide with the first.
      const normalizedEmail = email?.trim().toLowerCase() || undefined;

      // An address the IdP has not verified proves nothing about who is
      // holding it, so it may not be used to reach any pre-existing record:
      // not an invite, not another user's row. Anyone can sign up a database
      // connection with someone else's address.
      const trustedEmail = emailVerified ? normalizedEmail : undefined;

      try {
        const defaultTenantId = process.env['DEFAULT_TENANT_ID'];

        // A pending invite for ANY tenant admits the user. Only a
        // default-tenant invite is consumed here (the auto-join fast path);
        // other tenants' invites stay pending so the accept endpoint can
        // claim them and create the membership.
        let pendingInvite: { id: string; role: string; tenantId: string } | undefined;
        if (normalizedEmail) {
          const inviteRows = await db
            .select({
              id: invites.id,
              role: invites.role,
              tenantId: invites.tenantId,
              status: invites.status,
              expiresAt: invites.expiresAt,
            })
            .from(invites)
            .where(and(eq(invites.email, normalizedEmail), eq(invites.status, 'pending')))
            .limit(20);

          const now = new Date();
          const valid = inviteRows.filter((r) => r.expiresAt > now);
          pendingInvite = valid.find((r) => r.tenantId === defaultTenantId) ?? valid[0];
        }

        // Only a verified address may *consume* an invite, because consuming it
        // grants the role it carries. An unverified address that merely matches
        // one still gets a session — the invite token is the mailbox proof, and
        // the accept endpoint cannot run until the caller can authenticate.
        const inviteRow = trustedEmail ? pendingInvite : undefined;

        const signupPolicy = defaultTenantId
          ? await getTenantSignupPolicy(db, defaultTenantId)
          : 'invite_only';
        const admission = decideJitAdmission({
          isProduction,
          hasDefaultTenant: Boolean(defaultTenantId),
          invited: Boolean(inviteRow),
          inviteRole: inviteRow?.role,
          signupPolicy,
        });
        if (!admission.admitted && !pendingInvite) {
          fastify.log.warn(
            { email, provider, providerSub },
            'JIT provisioning rejected — no valid invite found',
          );
          return 'not_admitted';
        }

        // Try inserting new user; if email already exists, link identity to existing user.
        let newUser: {
          id: string;
          displayName: string;
          kind: string;
          email: string | null;
          avatarUrl: string | null;
        } | null = null;

        try {
          const [inserted] = await db
            .insert(users)
            .values({
              displayName: name,
              // Only a verified address is ever written. Persisting an
              // unverified one lets an attacker reserve a victim's address:
              // the victim's later verified login collides on the unique
              // index and merges into the attacker's row, which is the same
              // takeover from the other direction.
              email: trustedEmail ?? null,
              avatarUrl: avatarUrl ?? null,
              kind: 'human',
              status: 'active',
            })
            .returning({
              id: users.id,
              displayName: users.displayName,
              kind: users.kind,
              email: users.email,
              avatarUrl: users.avatarUrl,
            });
          newUser = inserted ?? null;
        } catch (insertErr: unknown) {
          // Duplicate email — the address already belongs to a user. Attaching
          // this IdP subject to that user is an account merge, so it needs the
          // IdP's word that this login controls the address. Without it the
          // signup is refused rather than linked: silently minting a second
          // identity for someone else's account is the takeover.
          const isDuplicate = databaseErrorText(insertErr).includes('users_email_unique');
          if (isDuplicate && trustedEmail) {
            const existing = await db
              .select({
                id: users.id,
                displayName: users.displayName,
                kind: users.kind,
                email: users.email,
                avatarUrl: users.avatarUrl,
              })
              .from(users)
              .where(eq(users.email, trustedEmail))
              .limit(1);
            newUser = existing[0] ?? null;
            if (newUser) {
              fastify.log.info(
                { userId: newUser.id, email: trustedEmail, provider, providerSub },
                'Linking new IdP identity to existing user (verified same email)',
              );
            }
          } else if (isDuplicate) {
            fastify.log.warn(
              { email, provider, providerSub },
              'Refusing to link identity to an existing account on an unverified email',
            );
            return 'not_admitted';
          } else {
            throw insertErr;
          }
        }

        if (!newUser) return null;

        await db
          .insert(userIdentities)
          .values({
            userId: newUser.id,
            provider,
            providerSub,
            email: trustedEmail ?? null,
            lastLoginAt: new Date(),
          })
          .onConflictDoNothing();

        // Auto-join the default tenant — but never on the strength of another
        // tenant's invite: that user gets a bare user row and joins their
        // tenant when the accept endpoint claims the invite.
        if (defaultTenantId && admission.admitted) {
          const defaultTenantInvite =
            inviteRow?.tenantId === defaultTenantId ? inviteRow : undefined;

          if (defaultTenantInvite || !inviteRow) {
            const tenantRole = admission.tenantRole;

            await db
              .insert(tenantMemberships)
              .values({
                tenantId: defaultTenantId,
                userId: newUser.id,
                role: tenantRole,
                status: 'active',
                joinedAt: new Date(),
              })
              .onConflictDoNothing();

            if (defaultTenantInvite) {
              await db
                .update(invites)
                .set({
                  status: 'accepted',
                  acceptedAt: new Date(),
                  acceptedByUserId: newUser.id,
                })
                .where(eq(invites.id, defaultTenantInvite.id));

              fastify.log.info(
                { userId: newUser.id, inviteId: defaultTenantInvite.id, role: tenantRole },
                'Invite accepted during JIT provisioning',
              );
            }

            // Share grants redeem only against a VERIFIED email — an
            // unverified password signup with someone else's address must
            // not inherit their space access.
            if (trustedEmail) {
              const { redeemSpaceGrantsForUser } = await import('../services/spaceGrants.js');
              await redeemSpaceGrantsForUser({
                db,
                redis,
                tenantId: defaultTenantId,
                userId: newUser.id,
                email: trustedEmail,
                log: fastify.log,
              }).catch((err: unknown) => {
                fastify.log.warn({ err }, 'Space-grant redemption failed during JIT admission');
              });
            }
          }
        }

        const result = {
          userId: newUser.id as UserId,
          displayName: newUser.displayName,
          kind: newUser.kind,
          email: newUser.email,
          avatarUrl: newUser.avatarUrl,
        };

        // Cache the new identity
        await redis.set(
          identityCacheKey(provider, providerSub),
          JSON.stringify(result),
          'EX',
          IDENTITY_CACHE_TTL,
        );

        fastify.log.info(
          { userId: newUser.id, provider, providerSub, email },
          'JIT provisioned new user from Auth0 login',
        );

        return result;
      } catch (err) {
        fastify.log.error({ err, provider, providerSub }, 'JIT user provisioning failed');
        return null;
      }
    }

    // ---- Helper: validate API key ------------------------------------------
    interface ApiKeyResult {
      userId: UserId;
      tenantId: TenantId;
      displayName: string;
      keyPrefix: string;
      kind: string;
    }

    async function validateApiKey(plaintext: string): Promise<ApiKeyResult | null> {
      const ctx = fastify.appContext;
      if (!ctx?.db || !ctx.redis) return null;

      const db = ctx.db as PostgresJsDatabase;
      const redis = ctx.redis;
      const keyHash = hashApiKey(plaintext);

      // Check Redis cache
      const cacheKey = `aflow:apikey:${keyHash}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as ApiKeyResult;
        } catch {
          // Corrupted — fall through
        }
      }

      // DB lookup: api_keys JOIN users
      const rows = await db
        .select({
          id: apiKeys.id,
          keyPrefix: apiKeys.keyPrefix,
          userId: apiKeys.userId,
          tenantId: apiKeys.tenantId,
          name: apiKeys.name,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          displayName: users.displayName,
          kind: users.kind,
        })
        .from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.userId))
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      // Verify key is not revoked
      if (row.revokedAt) return null;

      // Verify key is not expired
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

      const result: ApiKeyResult = {
        userId: row.userId as UserId,
        tenantId: row.tenantId as TenantId,
        displayName: row.displayName,
        keyPrefix: row.keyPrefix,
        kind: row.kind,
      };

      // Never cache past the key's own expiry. The expiry check above is what
      // enforces it, and it runs only on a cache miss — so a fixed TTL keeps
      // answering from cache after the key has stopped being valid, for as
      // long as the remainder of that TTL.
      const secondsUntilExpiry = row.expiresAt
        ? Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)
        : API_KEY_CACHE_TTL;
      const cacheTtl = Math.min(API_KEY_CACHE_TTL, secondsUntilExpiry);
      if (cacheTtl > 0) {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', cacheTtl);
      }

      // Update last_used_at asynchronously (fire-and-forget)
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.keyHash, keyHash))
        .then(() => {})
        .catch((err: unknown) => {
          fastify.log.warn({ err }, 'Failed to update apiKeys.lastUsedAt');
        });

      return result;
    }

    /** Resolve an API key onto the request, or answer 401. */
    async function applyApiKey(
      request: FastifyRequest,
      reply: FastifyReply,
      token: string,
    ): Promise<void> {
      try {
        const keyResult = await validateApiKey(token);

        if (!keyResult) {
          reply.status(401).send({
            error: 'Unauthorized',
            message: 'Invalid or revoked API key',
          });
          return;
        }

        request.authUser = {
          userId: keyResult.userId,
          displayName: keyResult.displayName,
          roles: [],
          authMethod: 'api_key',
          isServicePrincipal: keyResult.kind === 'service_principal',
          apiKeyPrefix: keyResult.keyPrefix,
          apiKeyTenantId: keyResult.tenantId,
        };
      } catch (err) {
        fastify.log.error({ err }, 'API key validation error');
        reply.status(401).send({
          error: 'Unauthorized',
          message: 'API key validation failed',
        });
      }
    }

    // ---- Helper: ensure dev user exists ------------------------------------
    async function ensureDevUser(): Promise<void> {
      const ctx = fastify.appContext;
      if (!ctx?.db) return;

      const db = ctx.db as PostgresJsDatabase;

      // Upsert user row
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, DEV_USER_ID as string))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(users).values({
          id: DEV_USER_ID as string,
          displayName: 'Dev User',
          email: 'dev@phoenix.local',
          kind: 'human',
          status: 'active',
        });
        fastify.log.info('Created dev user row');
      }

      // Ensure default tenant membership
      const defaultTenantId = process.env['DEFAULT_TENANT_ID'];
      if (defaultTenantId) {
        const existingMembership = await db
          .select({ id: tenantMemberships.id })
          .from(tenantMemberships)
          .where(
            and(
              eq(tenantMemberships.userId, DEV_USER_ID as string),
              eq(tenantMemberships.tenantId, defaultTenantId),
            ),
          )
          .limit(1);

        if (existingMembership.length === 0) {
          await db.insert(tenantMemberships).values({
            tenantId: defaultTenantId,
            userId: DEV_USER_ID as string,
            role: 'owner',
            status: 'active',
            joinedAt: new Date(),
          });
          fastify.log.info({ tenantId: defaultTenantId }, 'Created dev user tenant membership');
        }
      }
    }

    // Run dev user upsert once at startup (non-blocking)
    if (allowDevBypass) {
      ensureDevUser().catch((err: unknown) => {
        fastify.log.warn({ err }, 'Failed to upsert dev user — DB may not be ready');
      });
    }

    // ---- Authenticate preHandler -------------------------------------------
    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;

      // --- Local edition: instance secret or API key, never a JWT ---
      if (fastify.edition.authProvider === 'local-instance') {
        const outcome = authenticateLocalInstance(request, {
          instanceSecret: resolveInstanceSecret(),
          apiKeyPrefix: API_KEY_PREFIX,
        });
        if (outcome.kind === 'owner') {
          request.authUser = outcome.authUser;
          return;
        }
        if (outcome.kind === 'api-key') {
          await applyApiKey(request, reply, outcome.token);
          return;
        }
        reply.status(401).send({
          error: 'Unauthorized',
          message: 'Missing or invalid instance credential',
        });
        return;
      }

      // --- Dev bypass: no header in development ---
      if (allowDevBypass && !authHeader) {
        const devUser: AuthUser = {
          userId: DEV_USER_ID,
          email: 'dev@phoenix.local',
          displayName: 'Dev User',
          roles: ['admin'],
          authMethod: 'dev_bypass',
          isServicePrincipal: false,
          claims: {
            sub: 'dev-user',
            iss: 'phoenix-dev',
            aud: 'phoenix-api',
            exp: Math.floor(Date.now() / 1000) + 3600,
            iat: Math.floor(Date.now() / 1000),
            email: 'dev@phoenix.local',
            // The dev address is a fixture, so it is verified by construction.
            // Leaving it out gave dev a strictly weaker identity than any real
            // login, and every path gated on verification went unexercised.
            email_verified: true,
          },
        };
        request.authUser = devUser;
        return;
      }

      // Require Authorization header from here on
      if (!authHeader?.startsWith('Bearer ')) {
        reply.status(401).send({
          error: 'Unauthorized',
          message: 'Missing or malformed Authorization header',
        });
        return;
      }

      const token = authHeader.slice(7); // strip "Bearer "

      // --- API Key path: `Bearer phx_...` ---
      if (token.startsWith(API_KEY_PREFIX)) {
        await applyApiKey(request, reply, token);
        return;
      }

      // --- JWT path: `Bearer ey...` ---
      try {
        await request.jwtVerify();

        const claims = request.user as unknown as Auth0Claims;
        const provider = identityProviderKey();
        const providerSub = claims.sub;

        const profile = verification.readProfile(claims as unknown as Record<string, unknown>);
        const picture = profile.pictureUrl;
        const displayName = profile.displayName;
        const email = profile.email;
        const normalizedEmail = email?.trim().toLowerCase();

        // Asked at most once per request, and only where the answer decides
        // something: a steady-state login whose stored address already matches
        // reaches no trust decision and so never pays for one.
        let verificationAnswer: Promise<boolean> | undefined;
        const isEmailVerified = (): Promise<boolean> => {
          verificationAnswer ??= verification.isEmailVerified({
            claims: claims as unknown as Record<string, unknown>,
            email: normalizedEmail,
            accessToken: token,
            subject: `${provider}:${providerSub}`,
            redis: fastify.appContext.redis,
            log: fastify.log,
          });
          return verificationAnswer;
        };

        // Resolve existing user or JIT-provision on first login
        let identity = await resolveUserByIdpSub(provider, providerSub, email);
        if (!identity) {
          const redis = fastify.appContext.redis;
          if (redis && !(await consumeSignupRateLimit(redis, clientIp(request)))) {
            // Without Retry-After a client has no basis for when to come back,
            // and one that retries on a fixed short timer will hold the window
            // open indefinitely — the refusal then sustains the very load it
            // exists to shed.
            reply
              .header('Retry-After', String(Math.ceil(SIGNUP_RATE_LIMIT_WINDOW_MS / 1000)))
              .status(429)
              .send({
                error: 'TooManyRequests',
                message: 'Too many new sign-ups from this address — try again later',
              });
            return;
          }
          const provisioned = await jitProvisionUser(
            provider,
            providerSub,
            email,
            displayName,
            picture,
            await isEmailVerified(),
          );
          if (provisioned === 'not_admitted') {
            // Distinct from the transient-failure 503 below — clients key on
            // this code to show the invite-only surface.
            reply.status(503).send({
              error: 'NotAdmitted',
              message: 'This account has not been admitted yet — an invite is required',
            });
            return;
          }
          identity = provisioned;
        }

        // Sync profile from IdP claims only when stored values differ (fire-and-forget).
        // Compared against the cached/stored identity to avoid unnecessary DB writes.
        if (identity) {
          const needsSync: { avatarUrl?: string; displayName?: string; email?: string } = {};
          if (picture && picture !== identity.avatarUrl) needsSync.avatarUrl = picture;
          if (displayName && displayName !== identity.displayName)
            needsSync.displayName = displayName;
          // Same rule as provisioning: an unverified address never lands on a
          // user row, or this path would reintroduce what JIT refuses to do.
          // This is also how a user admitted before verifying gets their
          // address once the IdP confirms it.
          if (normalizedEmail && normalizedEmail !== identity.email && (await isEmailVerified())) {
            needsSync.email = normalizedEmail;
          }
          if (Object.keys(needsSync).length > 0) {
            scheduleProfileSync(
              identity.userId,
              identityCacheKey(provider, providerSub),
              needsSync,
            );
          }
        }

        if (identity) {
          const authUser: AuthUser = {
            userId: identity.userId,
            email,
            displayName: identity.displayName,
            roles: profile.roles,
            authMethod: 'jwt',
            isServicePrincipal: identity.kind === 'service_principal',
            claims,
          };
          request.authUser = authUser;
        } else {
          reply.status(503).send({
            error: 'ServiceUnavailable',
            message: 'Unable to resolve or provision user identity',
          });
        }
      } catch (jwtErr) {
        fastify.log.warn({ err: jwtErr }, 'JWT verification failed');
        reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired authentication token',
        });
      }
    });
  },
  { name: 'auth-plugin', dependencies: ['edition-plugin'] },
);

// Extend Fastify with authenticate decorator
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
