/**
 * Space LLM readiness — recomputed at read, never persisted (Plan 227 D4).
 * For each cybernetic role, resolves the configured model → its provider →
 * the scope-chain credential FOR THE CALLING USER (user-scoped credentials
 * participate, so readiness is per-user by design).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  providerCredentials,
} from '@aflow/database';
import {
  createDefaultModelCatalog,
  inferProviderForModelRef,
  isVerifiableProvider,
} from '@aflow/ai-client';
import {
  DEFAULT_CYBERNETIC_MODEL,
  resolveRoleModel,
  type DirectiveModelDefaults,
} from '@aflow/schemas';
import { resolveClerkModel, type ClerkModelResolution } from '@aflow/cybernetic-runtime';
import { tenants } from '@aflow/database';
import { previewCredentialResolution } from '../lib/credentialResolutionPreview.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const RoleReadinessSchema = z.object({
  model: z.string(),
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  resolved: z.boolean(),
  resolvedScope: z.enum(['user', 'space', 'tenant']).nullable(),
  status: z.enum(['active', 'error']).nullable(),
  /**
   * Whether the resolved key has been checked against the live provider.
   * `null` where the provider offers no check, which is not the same as a
   * check that has not run — one can never be satisfied and the other can.
   */
  verified: z.boolean().nullable(),
});

/**
 * What the Clerk resolves to, and whether anything does.
 *
 * Reported apart from `roles` and deliberately excluded from `ready`: the
 * Clerk names conversations and writes summaries, and a space whose
 * conversations are unnamed is a space with plain titles — not one that cannot
 * work. Folding it into `ready` would put a blocking connect-provider banner
 * in front of an operator over background upkeep.
 */
const ClerkReadinessSchema = z.object({
  /** How the assignment was arrived at. */
  mode: z.enum(['auto', 'space_default', 'explicit']),
  /** The ref that will be spent, or null when nothing resolves. */
  model: z.string().nullable(),
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  /** Whether a credential for that provider resolves for the viewing user. */
  credentialResolved: z.boolean(),
  /**
   * Why no model resolved. A settings surface shows this instead of offering
   * to connect a provider that would not change the answer.
   */
  unavailableReason: z
    .enum(['no_candidate_for_provider', 'not_permitted', 'unknown_model'])
    .nullable(),
});

const LlmReadinessSchema = z.object({
  ready: z.boolean(),
  roles: z.record(z.string(), RoleReadinessSchema),
  clerk: ClerkReadinessSchema,
  missingProviders: z.array(
    z.object({
      providerId: z.string(),
      roles: z.array(z.string()),
    }),
  ),
  erroredProviders: z.array(
    z.object({
      providerId: z.string(),
      roles: z.array(z.string()),
      lastErrorCode: z.string().nullable(),
    }),
  ),
  /**
   * Roles assigned a model the catalog no longer carries. Reported apart from
   * the credential channels because no key resolves it: the fix is to pick
   * another model, and offering "add a key" sends the operator to a setting
   * that cannot change the outcome.
   */
  unknownModelRoles: z.array(z.object({ role: z.string(), model: z.string() })),
  /**
   * Providers holding a key nothing has tried yet. Kept apart from `ready`,
   * which stays "a credential resolves": a caller that blocks on this is
   * making a stricter demand than every existing one, and changing what
   * `ready` means would make that demand on all of them at once.
   */
  unverifiedProviders: z.array(
    z.object({
      providerId: z.string(),
      roles: z.array(z.string()),
    }),
  ),
  /**
   * Whether any provider credential is visible in this space's scope chain,
   * for any provider — not only the ones the assigned models need.
   *
   * Separate from `ready` because it answers a different question: `ready` is
   * "can this workspace run right now", which changes every time an operator
   * picks a model, while this is "has this operator ever configured a key",
   * which is a property of the instance's setup. A first-run surface that
   * gates on the first re-opens itself whenever a model is chosen for a
   * provider that has no key yet — the correct remedy there is the readiness
   * banner, which names the provider and offers the one-click fix.
   */
  hasConfiguredProvider: z.boolean(),
});

const READINESS_ROLES = ['default', 'helmsman', 'runner', 'coach', 'judge'] as const;

export const spaceLlmReadinessRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/llm-readiness',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'LLM credential readiness for this space (per calling user)',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: LlmReadinessSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const authUser = request.authUser!;
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { spaceId } = request.params;

      const [row] = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
        return (tx as PostgresJsDatabase)
          .select({ directives: spaces.directives })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1);
      })) as Array<{ directives: { modelDefaults?: DirectiveModelDefaults } | null }>;
      if (!row) {
        return reply.status(404).send({ error: 'NotFound', message: 'Space not found' });
      }

      const defaults = row.directives?.modelDefaults;
      const catalog = createDefaultModelCatalog();

      const allowlistRows = (await db
        .select({ allowlist: tenants.agentModelAllowlist })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1)) as Array<{ allowlist: unknown }>;
      const storedAllowlist = allowlistRows[0]?.allowlist;
      const clerk: ClerkModelResolution = resolveClerkModel(
        defaults,
        Array.isArray(storedAllowlist) ? (storedAllowlist as string[]) : null,
      );

      const roleRefs = READINESS_ROLES.map((role) => {
        const ref =
          role === 'default'
            ? (defaults?.default ?? DEFAULT_CYBERNETIC_MODEL)
            : resolveRoleModel(defaults, role);
        const model = catalog.getModel(ref);
        const inferred = model ? model.provider : inferProviderForModelRef(ref);
        const providerId: string | null = inferred === 'local' ? null : inferred;
        // A ref the catalog does not carry names no model this space can run:
        // assigning a role is gated on a live catalog entry, so the only way to
        // hold one is for the model to have left the lineup since. Inferring a
        // provider from its spelling says which key would be spent, not that
        // anything is there to answer — reporting ready on that reads green
        // until the next run fails with the vendor's rejection.
        const unknownModel = !model;
        return { role, ref, modelId: model?.id ?? null, providerId, unknownModel };
      });

      const providerIds = [
        ...new Set(
          [...roleRefs.map((r) => r.providerId), clerk.resolved ? clerk.providerId : null].filter(
            (p): p is string => p !== null,
          ),
        ),
      ];
      const previews = await previewCredentialResolution(db, {
        tenantId: tenant.tenantId,
        userId: authUser.userId as string,
        spaceId,
        providerIds,
      });

      const roles: Record<string, z.infer<typeof RoleReadinessSchema>> = {};
      const unknownModelRoles: Array<{ role: string; model: string }> = [];
      const missing = new Map<string, string[]>();
      const unverified = new Map<string, string[]>();
      const errored = new Map<string, { roles: string[]; lastErrorCode: string | null }>();
      let ready = true;

      for (const { role, ref, modelId, providerId, unknownModel } of roleRefs) {
        const preview = providerId ? previews.get(providerId) : undefined;
        const resolved = preview?.resolved ?? false;
        const status = preview?.status ?? null;
        // A provider with no live check can never report a verified key, so it
        // reports nothing rather than a permanent `false` nobody could clear.
        const verified =
          !resolved || providerId === null || !isVerifiableProvider(providerId)
            ? null
            : preview?.verifiedAt != null;
        roles[role] = {
          model: ref,
          modelId,
          providerId,
          resolved,
          resolvedScope: preview?.resolvedScope ?? null,
          status,
          verified,
        };
        // Honest not-ready, and the credential branches below are skipped on
        // purpose. A ref whose spelling implies a provider would otherwise be
        // reported as that provider's missing key — remediation that cannot
        // work — or, where the key is present and valid, land in no channel at
        // all and leave the banner with nothing to say about a space it has
        // just called not ready.
        if (unknownModel) {
          ready = false;
          unknownModelRoles.push({ role, model: ref });
          continue;
        }
        if (!providerId) continue;
        if (!resolved) {
          ready = false;
          missing.set(providerId, [...(missing.get(providerId) ?? []), role]);
        } else if (status === 'error') {
          ready = false;
          const entry = errored.get(providerId) ?? {
            roles: [],
            lastErrorCode: preview?.lastErrorCode ?? null,
          };
          entry.roles.push(role);
          errored.set(providerId, entry);
        } else if (verified === false) {
          // Reported, not counted against `ready`. A key that failed its check
          // is the errored branch above; this one has simply never been tried.
          unverified.set(providerId, [...(unverified.get(providerId) ?? []), role]);
        }
      }

      // Asked of every provider rather than of the assigned models' providers,
      // because the question is whether this operator has configured anything
      // at all. One indexed read on the same scope chain the preview walks.
      const configuredRows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) =>
        (tx as PostgresJsDatabase)
          .select({ providerId: providerCredentials.providerId })
          .from(providerCredentials)
          .where(
            inArray(providerCredentials.scopeId, [
              authUser.userId as string,
              spaceId,
              tenant.tenantId as string,
            ]),
          )
          .limit(1),
      )) as Array<{ providerId: string }>;

      reply.send({
        ready,
        hasConfiguredProvider: configuredRows.length > 0,
        roles,
        clerk: {
          mode: clerk.mode,
          model: clerk.resolved ? clerk.modelRef : null,
          modelId: clerk.resolved ? clerk.modelId : null,
          providerId: clerk.resolved ? clerk.providerId : (clerk.providerId ?? null),
          credentialResolved: clerk.resolved
            ? (previews.get(clerk.providerId)?.resolved ?? false)
            : false,
          unavailableReason: clerk.resolved ? null : clerk.reason,
        },
        unknownModelRoles,
        unverifiedProviders: [...unverified.entries()].map(([providerId, roleList]) => ({
          providerId,
          roles: roleList,
        })),
        missingProviders: [...missing.entries()].map(([providerId, roleList]) => ({
          providerId,
          roles: roleList,
        })),
        erroredProviders: [...errored.entries()].map(([providerId, entry]) => ({
          providerId,
          roles: entry.roles,
          lastErrorCode: entry.lastErrorCode,
        })),
      });
    },
  );
};
