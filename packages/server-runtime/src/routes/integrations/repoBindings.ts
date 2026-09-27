/**
 * Repo-designation CRUD routes — the operator-created authority boundary the coding
 * lane references (Plan 219 §0.3, re-keyed by coordinate in Plan 222). A designation
 * fixes the repo (by host-qualified coordinate), default branch, allowed push-branch
 * patterns, egress hosts, and named check profiles OUTSIDE any workflow; the git
 * credential is referenced by name (never the secret on the row). The clone remote is
 * derived from the coordinate, so no raw remote string is ever accepted.
 *
 * Security boundary (NON-NEGOTIABLE):
 *  - the clone remote is the DERIVED `https://host/owner/repo.git`; the coordinate's
 *    host is host-safe via the SAME shared `isHostSafeEgressEntry` (blocks the
 *    metadata IP, localhost, loopback), and the derived URL re-passes the SAME
 *    `isAllowedRemoteUrl` the lane backend enforces. No operator-supplied remote can
 *    smuggle ext::/fd:: transport helpers, scp-style, http://, or user:pass@.
 *  - no allowed push pattern may match the default branch, via the SAME
 *    `branchMatchesAllowed` the push handler uses — the lane must never be
 *    grantable push to the default branch.
 *  - credentialKey is a NAME reference verified to resolve in THIS space; a raw
 *    token is never accepted or stored.
 *  - egressHosts is refused non-empty: the lane's allowlist is deployment-wide,
 *    so a per-repo entry would be stored and never enforced (Plan 286 §4.7b).
 *
 * Authz: space-write via `api_config:write` (mirrors API bindings — repo
 * designations are space infrastructure config at the same altitude). Admin-gating
 * the coding lane (space-opt-in, admin-enabled) is the intended hardening once the
 * lane is generally exposed.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  apiBindings,
  apiCredentials,
  apiDefinitions,
  repoBindings,
  type RepoBindingRow,
} from '@aflow/database';
import {
  apiHostMatchesGitHost,
  RepoBindingCreateInputSchema,
  RepoBindingResponseSchema,
  branchMatchesAllowed,
  isAllowedRemoteUrl,
  isHostSafeEgressEntry,
  isLaneSupportedGitHost,
  LANE_SUPPORTED_GIT_HOSTS,
  parseRepoCoordinate,
  formatRepoCoordinate,
  repoCoordinateRemoteUrl,
  type ApiDefinition,
  type EgressPolicy,
  type RepoBindingCreateInput,
  type SuggestedEgressPolicyDraft,
} from '@aflow/schemas';
import {
  collectRepoDesignationHosts,
  enforceIntegrationHostPolicy,
  mergeSuggestedEgressIntoBaseline,
  parseHostFromUrl,
  writeApiDefinition,
  writePlaceholderBinding,
} from '@aflow/cybernetic-runtime';
import { getConnectorCatalogEntry } from '@aflow/platform-artifacts';
import { publishApiCatalogInvalidation } from '@aflow/redis';
import {
  IntegrationWriteErrorSchema,
  getDb,
  getRedis,
  integrationPolicyDenialPayload,
} from './shared.js';

type TenantContext = ReturnType<typeof createTenantContext>;

/** The git credentialKey a connection's auth resolves, iff it is a non-empty bearer. */
function bearerCredentialKey(authJson: unknown): string | null {
  const auth = (authJson ?? {}) as Record<string, unknown>;
  if (auth['type'] !== 'bearer') return null;
  const key = auth['credentialKey'];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Whether a credential NAME resolves to an api_credentials row in this space. */
async function credentialKeyExists(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  spaceId: string,
  key: string,
): Promise<boolean> {
  return withTenantSchema(db, tenantContext, async (tx) => {
    const rows = await tx
      .select({ credentialKey: apiCredentials.credentialKey })
      .from(apiCredentials)
      .where(and(eq(apiCredentials.credentialKey, key), eq(apiCredentials.spaceId, spaceId)))
      .limit(1);
    return rows.length > 0;
  });
}

/** The API host a connection serves (its definition's base-URL host, lowercased). */
async function apiHostForApiId(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  spaceId: string,
  apiId: string,
): Promise<string | null> {
  const baseUrl = await withTenantSchema(db, tenantContext, async (tx) => {
    const rows = await tx
      .select({ baseUrl: apiDefinitions.baseUrl })
      .from(apiDefinitions)
      .where(and(eq(apiDefinitions.apiId, apiId), eq(apiDefinitions.spaceId, spaceId)))
      .limit(1);
    return rows[0]?.baseUrl ?? null;
  });
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

type ConnectionResolution =
  | { ok: true; connectionBindingId: string; credentialOverrideKey: string | null }
  | { ok: false; error: string };

/**
 * Resolve (and, on the bootstrap path, ENSURE) the GitHub connection a repo
 * designation will resolve git + API through (Plan 222 P3 §5). XOR-ish:
 *  - LINK an existing connection (`connectionBindingId`): it must be a same-space,
 *    enabled, host-coherent github connection. A supplied `credentialKey` is the
 *    per-repo git override (validated to resolve), but if it NAMES a credential
 *    that DIFFERS from the connection's own bearer credential we HARD-FAIL (no
 *    silent skip). With no override, the connection must be git-resolvable
 *    (bearer-with-key) so status='ready' is honest on the git plane.
 *  - BOOTSTRAP from a named `credentialKey`: idempotently ensure the github API
 *    definition + a bearer `github-default` binding whose authJson is HAND-BUILT
 *    as `{ type:'bearer', credentialKey }` (NOT the connector's derived
 *    `${bindingId}-token` key, which would not match the named credential). If a
 *    `github-default` connection already exists with a DIFFERENT credential, HARD-
 *    FAIL rather than silently link to it.
 */
async function resolveConnectionForCreate(args: {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantContext: TenantContext;
  tenantId: string;
  spaceId: string;
  coordinateHost: string;
  body: RepoBindingCreateInput;
}): Promise<ConnectionResolution> {
  const { db, redis, tenantContext, tenantId, spaceId, coordinateHost, body } = args;

  // ── LINK an existing connection ──────────────────────────────────────────
  if (body.connectionBindingId !== undefined) {
    const connectionBindingId = body.connectionBindingId;
    const overrideKey = body.credentialKey;
    const connection = await withTenantSchema(db, tenantContext, async (tx) => {
      const rows = await tx
        .select()
        .from(apiBindings)
        .where(
          and(eq(apiBindings.bindingId, connectionBindingId), eq(apiBindings.spaceId, spaceId)),
        )
        .limit(1);
      return rows[0];
    });
    if (!connection) {
      return {
        ok: false,
        error: `GitHub connection "${connectionBindingId}" was not found in this space.`,
      };
    }
    if (connection.apiId !== 'github') {
      return {
        ok: false,
        error: `Connection "${connectionBindingId}" is not a GitHub connection (apiId="${connection.apiId}").`,
      };
    }
    if (connection.enabled !== 1) {
      return {
        ok: false,
        error: `GitHub connection "${connectionBindingId}" is disabled. Enable it before linking a repo.`,
      };
    }
    const apiHost = await apiHostForApiId(db, tenantContext, spaceId, connection.apiId);
    if (!apiHost || !apiHostMatchesGitHost(apiHost, coordinateHost)) {
      return {
        ok: false,
        error:
          `GitHub connection "${connectionBindingId}" serves API host "${apiHost ?? '(unknown)'}", ` +
          `which does not match repo host "${coordinateHost}". Link a connection for the same host.`,
      };
    }

    const connectionGitKey = bearerCredentialKey(connection.authJson);
    if (overrideKey !== undefined) {
      // Per-repo git override. Reject silently ignoring a credential that differs
      // from the connection's own — the operator must reconcile, not be surprised.
      if (connectionGitKey !== null && connectionGitKey !== overrideKey) {
        return {
          ok: false,
          error:
            `Connection "${connectionBindingId}" already resolves git through credential ` +
            `"${connectionGitKey}", but a different credentialKey "${overrideKey}" was supplied. ` +
            'Omit credentialKey to use the connection, or reconcile them.',
        };
      }
      if (!(await credentialKeyExists(db, tenantContext, spaceId, overrideKey))) {
        return {
          ok: false,
          error: `credentialKey "${overrideKey}" does not resolve to a credential in this space.`,
        };
      }
      return { ok: true, connectionBindingId, credentialOverrideKey: overrideKey };
    }

    // No override: the connection itself must be git-resolvable (bearer-with-key)
    // AND that key must resolve, so status='ready' is honest on the git plane.
    if (connectionGitKey === null) {
      return {
        ok: false,
        error:
          `GitHub connection "${connectionBindingId}" has no bearer git credential. Supply a ` +
          'per-repo credentialKey, or link a PAT (bearer) connection.',
      };
    }
    if (!(await credentialKeyExists(db, tenantContext, spaceId, connectionGitKey))) {
      return {
        ok: false,
        error:
          `GitHub connection "${connectionBindingId}" references git credential "${connectionGitKey}", ` +
          'which is not set in this space. Fill the connection credential first.',
      };
    }
    return { ok: true, connectionBindingId, credentialOverrideKey: null };
  }

  // ── BOOTSTRAP a connection from a named credential ───────────────────────
  // The schema's superRefine guarantees credentialKey is present when no
  // connectionBindingId was supplied.
  const credentialKey = body.credentialKey;
  if (credentialKey === undefined) {
    return {
      ok: false,
      error: 'Provide a connectionBindingId to link, or a credentialKey to bootstrap a connection.',
    };
  }
  if (!(await credentialKeyExists(db, tenantContext, spaceId, credentialKey))) {
    return {
      ok: false,
      error:
        `credentialKey "${credentialKey}" does not resolve to a credential in this space. ` +
        'Create the git credential first, then reference it by name.',
    };
  }

  const entry = getConnectorCatalogEntry('github');
  if (!entry) {
    return {
      ok: false,
      error: 'The github connector is unavailable; cannot bootstrap a connection.',
    };
  }
  const definition = JSON.parse(JSON.stringify(entry.definition)) as ApiDefinition;
  const apiHost = parseHostFromUrl(definition.baseUrl ?? '');
  if (!apiHost || !apiHostMatchesGitHost(apiHost, coordinateHost)) {
    return {
      ok: false,
      error:
        `The github connector serves host "${apiHost ?? '(unknown)'}", which does not match repo ` +
        `host "${coordinateHost}". Link an existing connection for that host instead of bootstrapping.`,
    };
  }
  const bindingId = `${definition.apiId}-default`;

  // Idempotent ensure: reuse an existing github-default connection only when its
  // credential MATCHES the supplied one (else HARD-FAIL — no silent skip).
  const existingBinding = await withTenantSchema(db, tenantContext, async (tx) => {
    const rows = await tx
      .select()
      .from(apiBindings)
      .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, spaceId)))
      .limit(1);
    return rows[0];
  });
  if (existingBinding) {
    if (existingBinding.apiId !== 'github') {
      return {
        ok: false,
        error: `A binding "${bindingId}" already exists in this space but is not a GitHub connection.`,
      };
    }
    // Mirror the LINK path + the runtime resolver: a disabled connection must not
    // yield a 'ready' designation (the lane fails closed at run time otherwise).
    if (existingBinding.enabled !== 1) {
      return {
        ok: false,
        error:
          `GitHub connection "${bindingId}" already exists but is disabled. Enable it in ` +
          'Integrations before binding a repo, or create a named GitHub connection there and link ' +
          'it to this repository.',
      };
    }
    const existingKey = bearerCredentialKey(existingBinding.authJson);
    if (existingKey !== credentialKey) {
      return {
        ok: false,
        error:
          `A GitHub connection "${bindingId}" already exists with a different credential ` +
          `("${existingKey ?? 'none'}"). Create a named GitHub connection in Integrations and link ` +
          'it to this repository, or reconcile the credential.',
      };
    }
    return { ok: true, connectionBindingId: bindingId, credentialOverrideKey: null };
  }

  const initialEgress = mergeSuggestedEgressIntoBaseline(
    { allowedHosts: apiHost ? [apiHost] : [] },
    definition.suggestedEgressPolicy as SuggestedEgressPolicyDraft | undefined,
  ) as EgressPolicy;

  await withTenantSchema(db, tenantContext, async (tx) => {
    await writeApiDefinition({ definition, spaceId, conflictPolicy: 'skip', tx });
    await writePlaceholderBinding({
      bindingId,
      apiId: definition.apiId,
      spaceId,
      name: definition.name,
      description: 'GitHub connection bootstrapped for a coding repo.',
      scope: { tenantId, spaceId },
      // HAND-BUILT bearer auth pointing at the operator-named credential — NOT the
      // connector's derived `${bindingId}-token` key (which wouldn't match it).
      authJson: { type: 'bearer', credentialKey },
      egressPolicy: initialEgress,
      conflictPolicy: 'skip',
      tx,
    });
  });

  if (redis) {
    publishApiCatalogInvalidation(redis, tenantId, spaceId, {
      kind: 'definition',
      apiId: definition.apiId,
    });
    publishApiCatalogInvalidation(redis, tenantId, spaceId, {
      kind: 'binding',
      apiId: definition.apiId,
    });
  }

  return { ok: true, connectionBindingId: bindingId, credentialOverrideKey: null };
}

function rowRemoteUrl(coordinate: string): string {
  const parsed = parseRepoCoordinate(coordinate);
  return parsed ? repoCoordinateRemoteUrl(parsed) : '';
}

function mapRepoBindingRow(row: RepoBindingRow): z.infer<typeof RepoBindingResponseSchema> {
  return {
    repoDesignationId: row.repoDesignationId,
    spaceId: row.spaceId,
    coordinate: row.coordinate,
    remoteUrl: rowRemoteUrl(row.coordinate),
    description: row.description ?? null,
    defaultBranch: row.defaultBranch,
    allowedPushBranchPatterns: row.allowedPushBranchPatterns,
    egressHosts: row.egressHosts,
    checkProfiles: row.checkProfilesJson,
    connectionBindingId: row.connectionBindingId,
    credentialKey: row.credentialKey ?? null,
    status: row.status as z.infer<typeof RepoBindingResponseSchema>['status'],
    lastValidatedAt: row.lastValidatedAt ? new Date(row.lastValidatedAt).toISOString() : null,
    lastErrorAt: row.lastErrorAt ? new Date(row.lastErrorAt).toISOString() : null,
    lastErrorCode: row.lastErrorCode ?? null,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function registerRepoBindingRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/repo-bindings',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List repo bindings in the current space',
        response: {
          200: z.object({ repoBindings: z.array(RepoBindingResponseSchema) }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);

      if (!db) {
        reply.send({ repoBindings: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = await withTenantSchema(db, tenantContext, async (tx) => {
        return tx.select().from(repoBindings).where(eq(repoBindings.spaceId, space.spaceId));
      });

      reply.send({ repoBindings: rows.map(mapRepoBindingRow) });
    },
  );

  app.get(
    '/repo-bindings/:repoDesignationId',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get repo designation detail',
        params: z.object({ repoDesignationId: z.string().min(1).max(128) }),
        response: {
          200: z.object({ repoBinding: RepoBindingResponseSchema }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { repoDesignationId } = request.params as { repoDesignationId: string };

      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(repoBindings)
          .where(
            and(
              eq(repoBindings.repoDesignationId, repoDesignationId),
              eq(repoBindings.spaceId, space.spaceId),
            ),
          )
          .limit(1);
      });

      const row = rows[0];
      if (!row) {
        reply.code(404).send({ error: `Repo designation "${repoDesignationId}" not found` });
        return;
      }

      reply.send({ repoBinding: mapRepoBindingRow(row) });
    },
  );

  app.post(
    '/repo-bindings',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Create or update a repo designation',
        body: RepoBindingCreateInputSchema,
        response: {
          200: z.object({
            repoDesignationId: z.string(),
            coordinate: z.string(),
            status: z.string(),
          }),
          400: IntegrationWriteErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const body = request.body;

      if (!db) throw new Error('Database not configured');

      // Resolve the repo coordinate the operator supplied (owner/repo, host/owner/repo,
      // or an https remote). The clone remote is DERIVED from it, so the operator can
      // never inject a raw remote string.
      const coordinate = parseRepoCoordinate(body.repo);
      if (!coordinate) {
        reply.code(400).send({
          error: `"${body.repo}" is not a repo coordinate (owner/repo, host/owner/repo, or an https remote URL).`,
        });
        return;
      }
      // The git host must be host-safe (blocks the metadata IP, localhost, loopback),
      // and the derived https remote must pass the SAME authority the lane enforces.
      const remoteUrl = repoCoordinateRemoteUrl(coordinate);
      if (!isHostSafeEgressEntry(coordinate.host) || !isAllowedRemoteUrl(remoteUrl)) {
        reply.code(400).send({
          error: `Repo host "${coordinate.host}" is not an allowed git host.`,
        });
        return;
      }
      // Host-safe and https is not the same question as reachable. The lane runs
      // on a network with no route out and one static egress allowlist, so a
      // designation for a host absent from it would store, report 'ready', and
      // fail at its first clone with a refusal naming nothing the operator set.
      if (!isLaneSupportedGitHost(coordinate.host)) {
        reply.code(400).send({
          error:
            `The coding lane cannot reach "${coordinate.host}". It reaches ` +
            `${LANE_SUPPORTED_GIT_HOSTS.join(', ')} only, because its egress allowlist is fixed ` +
            'for the deployment rather than per designation. Support for another host is a ' +
            'deployment change, not a designation setting.',
        });
        return;
      }
      const canonicalCoordinate = formatRepoCoordinate(coordinate);

      // The lane must NEVER be grantable push to the default branch via a designation.
      // Use the SAME matcher the push handler enforces so the route can't accept a
      // pattern the push handler would later admit.
      if (branchMatchesAllowed(body.defaultBranch, body.allowedPushBranchPatterns)) {
        reply.code(400).send({
          error:
            `allowedPushBranchPatterns must not match the default branch "${body.defaultBranch}". ` +
            'The coding lane may never push to the default branch via a binding; restrict the ' +
            'patterns (e.g. "agent/*") so they cannot admit it.',
        });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);

      const createdBy = request.authUser?.userId;
      if (!createdBy) {
        reply.code(400).send({ error: 'Authenticated user required to create a repo binding.' });
        return;
      }

      try {
        await enforceIntegrationHostPolicy({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId as string,
          kind: 'api',
          hosts: collectRepoDesignationHosts({ gitHost: coordinate.host }),
          grantRefs: [
            { artifactType: 'api_definition', artifactKey: 'github' },
            {
              artifactType: 'api_binding',
              artifactKey: body.connectionBindingId ?? 'github-default',
            },
          ],
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        throw err;
      }

      // A repo designation resolves git + the github API THROUGH a GitHub connection.
      // Resolve (or, on the bootstrap path, ENSURE) that connection and the optional
      // per-repo git override, validating the git plane up front so status='ready' is
      // honest (no OAuth / missing-credential late-failure at run time).
      const resolution = await resolveConnectionForCreate({
        db,
        redis: getRedis(fastify),
        tenantContext,
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId as string,
        coordinateHost: coordinate.host,
        body,
      });
      if (!resolution.ok) {
        reply.code(400).send({ error: resolution.error });
        return;
      }
      const { connectionBindingId, credentialOverrideKey } = resolution;

      // 'ready' = passed STATIC validation only (no live probe ran, so lastValidatedAt
      // stays NULL). Live reachability/clone/push is checked at FIRST USE on the
      // lane/code-worker (it owns egress to the remote and the decrypted credential),
      // where errors surface cleanly; the ls-remote/clone probe is a tracked follow-up.
      // The API server has no egress to repo hosts and never decrypts the token.
      //
      // egressHosts is refused non-empty at the schema: the lane applies one egress
      // allowlist for the whole deployment, so a per-repo entry would be stored and
      // never enforced. Per-repo egress is Plan 286 §4.7b.
      const persisted = await withTenantSchema(db, tenantContext, async (tx) => {
        const result = await tx.execute(sql`
          INSERT INTO repo_bindings (
            repo_designation_id, space_id, coordinate, description, default_branch,
            allowed_push_branch_patterns, egress_hosts, check_profiles_json,
            connection_binding_id, credential_key, status, created_by
          )
          VALUES (
            ${randomUUID()},
            ${space.spaceId}::uuid,
            ${canonicalCoordinate},
            ${body.description ?? null},
            ${body.defaultBranch},
            ${JSON.stringify(body.allowedPushBranchPatterns)}::jsonb,
            ${JSON.stringify(body.egressHosts)}::jsonb,
            ${JSON.stringify(body.checkProfiles)}::jsonb,
            ${connectionBindingId},
            ${credentialOverrideKey},
            'ready',
            ${createdBy}::uuid
          )
          ON CONFLICT (space_id, coordinate) DO UPDATE SET
            description = EXCLUDED.description,
            default_branch = EXCLUDED.default_branch,
            allowed_push_branch_patterns = EXCLUDED.allowed_push_branch_patterns,
            egress_hosts = EXCLUDED.egress_hosts,
            check_profiles_json = EXCLUDED.check_profiles_json,
            connection_binding_id = EXCLUDED.connection_binding_id,
            credential_key = EXCLUDED.credential_key,
            status = 'ready',
            last_error_at = NULL,
            last_error_code = NULL,
            updated_at = NOW()
          RETURNING repo_designation_id
        `);
        const rows = result as unknown as Array<{ repo_designation_id: string }>;
        return rows[0]?.repo_designation_id ?? null;
      });

      if (!persisted) {
        reply.code(400).send({ error: 'Failed to persist repo designation.' });
        return;
      }

      reply.send({
        repoDesignationId: persisted,
        coordinate: canonicalCoordinate,
        status: 'ready',
      });
    },
  );

  app.delete(
    '/repo-bindings/:repoDesignationId',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Archive a repo designation (soft delete)',
        params: z.object({ repoDesignationId: z.string().min(1).max(128) }),
        response: {
          200: z.object({ repoDesignationId: z.string(), status: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { repoDesignationId } = request.params as { repoDesignationId: string };

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);

      // Archive (status='archived'), never hard-delete: the designation may be
      // referenced by run history, and resolveRepoBinding rejects archived
      // designations at use time so one cannot drive a new run.
      const archived = await withTenantSchema(db, tenantContext, async (tx) => {
        const rows = await tx
          .select({ repoDesignationId: repoBindings.repoDesignationId })
          .from(repoBindings)
          .where(
            and(
              eq(repoBindings.repoDesignationId, repoDesignationId),
              eq(repoBindings.spaceId, space.spaceId),
            ),
          )
          .limit(1);
        if (rows.length === 0) return false;
        await tx.execute(
          sql`UPDATE repo_bindings SET status = 'archived', updated_at = NOW()
              WHERE repo_designation_id = ${repoDesignationId} AND space_id = ${space.spaceId}::uuid`,
        );
        return true;
      });

      if (!archived) {
        reply.code(404).send({ error: `Repo designation "${repoDesignationId}" not found` });
        return;
      }

      reply.send({ repoDesignationId, status: 'archived' });
    },
  );
}
