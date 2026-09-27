import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  mcpServerBindings,
  mcpServerDefinitions,
  apiBindings,
} from '@aflow/database';
import {
  McpServerBindingSchema,
  McpServerDefinitionSchema,
  ApiBindingSchema,
  TenantIdSchema,
  type McpServerBinding,
  type McpServerDefinition,
  type ApiBinding,
} from '@aflow/schemas';
import {
  completeConsent,
  parseStateToken,
  resolveOAuthCallbackUrl,
  resolveCimdDocumentUrl,
  buildMcpOAuthDescriptor,
  type CompleteConsentContext,
} from '@aflow/oauth';
import { getDb, getRedis, getPayloadStore } from './integrations/shared.js';
import { createSessionService } from '../services/sessions.js';
import { resumeSessionsForCompletedConsent } from '../services/oauthConsentResume.js';
import { resumeWorkflowRunFromOperatorUi } from '../services/workflowRunOperatorResume.js';

export const oauthCallbackRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/oauth/callback',
    {
      // The provider redirects the browser here with no session of ours; the
      // signed `state` parameter is the whole authorization.
      config: { public: true },
      schema: {
        tags: ['Integrations'],
        summary: 'OAuth 2.1 callback for MCP + API consent flows (no auth required)',
        querystring: z.object({
          state: z.string().max(2048).optional(),
          code: z.string().max(2048).optional(),
          error: z.string().max(256).optional(),
          error_description: z.string().max(1024).optional(),
        }),
      },
    },
    async (request, reply) => {
      const q = request.query as {
        state?: string;
        code?: string;
        error?: string;
        error_description?: string;
      };

      // AS-reported failure: render the message rather than blow up.
      if (q.error) {
        renderHtml(
          reply,
          400,
          'Consent failed',
          `Authorization server returned: <code>${escapeHtml(q.error)}</code>` +
            (q.error_description ? `<br>${escapeHtml(q.error_description)}` : ''),
        );
        return;
      }

      if (!q.state || !q.code) {
        renderHtml(
          reply,
          400,
          'Invalid callback',
          'Missing required `state` and/or `code` parameters.',
        );
        return;
      }

      // Parse tenantId out of state before touching the DB so we can pin
      // tenant context for everything below. parseStateToken returns null on
      // malformed input; render rather than 500.
      const parsed = parseStateToken(q.state);
      if (!parsed) {
        renderHtml(reply, 400, 'Invalid state', 'Could not parse the OAuth state token.');
        return;
      }

      const db = getDb(fastify);
      if (!db) {
        renderHtml(reply, 500, 'Server misconfigured', 'Database not configured.');
        return;
      }

      try {
        const result = await completeConsent({
          state: q.state,
          code: q.code,
          db,
          resolveContext: async ({ bindingId, spaceId, integrationKind }) =>
            integrationKind === 'api'
              ? resolveApiBindingForCallback(db, parsed.tenantId, bindingId, spaceId)
              : resolveBindingForCallback(db, parsed.tenantId, bindingId, spaceId),
        });

        // Consent completing is the resume trigger (Plan 185 §9.3). Resume the
        // sessions parked on this consent: step-plane (direct callers) via
        // `sessionService.resumeSession`, run-plane (harness-routed Runner
        // callers) via the run-resume authority — see
        // `resumeSessionsForCompletedConsent`.
        const redis = getRedis(fastify);
        const payloadStore = getPayloadStore(fastify);
        if (redis && payloadStore) {
          try {
            const { resumedSessionIds, resumedRunIds } = await resumeSessionsForCompletedConsent(
              {
                db,
                redis,
                payloadStore,
                sessionService: createSessionService(fastify.appContext),
                resumeRunPlane: (a) =>
                  resumeWorkflowRunFromOperatorUi(
                    { db, redis, payloadStore },
                    {
                      tenantId: a.tenantId,
                      spaceId: a.spaceId,
                      userId: a.userId,
                      input: {
                        runId: a.runId,
                        pauseVersion: a.pauseVersion,
                        resolution: { mode: 're_execute' },
                        takeOver: false,
                      },
                    },
                  ),
              },
              {
                tenantId: parsed.tenantId,
                spaceId: result.spaceId,
                integrationKind: result.integrationKind,
                resourceKey: result.resourceKey,
                bindingId: result.bindingId,
                ownerScope: result.ownerScope,
                ownerId: result.ownerId,
              },
            );
            request.log.info(
              {
                bindingId: result.bindingId,
                resumedSessionIds,
                resumedRunIds,
              },
              'OAuth consent completed — resumed parked sessions and runs',
            );
          } catch (resumeErr) {
            // Resume is best-effort relative to the consent itself: the token
            // is already stored. Log and still render the success page.
            request.log.warn(
              { err: resumeErr instanceof Error ? resumeErr.message : String(resumeErr) },
              'OAuth consent stored but resume failed',
            );
          }
        }

        // The browser is currently at `/v1/oauth/callback?state=...&code=...`.
        // Any cross-origin link or redirect would leak both via the Referer
        // header. Set `Referrer-Policy: no-referrer` first so even an inline
        // success page (with no redirect at all) is hardened against a user
        // clicking "back" or a CDN injecting analytics. Cheap and uniform.
        reply.header('referrer-policy', 'no-referrer');

        // Operator override: bounce to a UI URL that lives in the SAME
        // ORIGIN as API_BASE_URL. Cross-origin redirects out of a no-auth
        // endpoint with `state` + `code` still on the URL is an exfiltration
        // path — gate aggressively.
        const redirectTarget = process.env['MCP_OAUTH_SUCCESS_REDIRECT'];
        if (redirectTarget) {
          if (!isSameOriginRedirect(redirectTarget)) {
            request.log.warn(
              { redirectTarget },
              'MCP_OAUTH_SUCCESS_REDIRECT is cross-origin or malformed — falling back to inline confirmation',
            );
            // Fall through to the inline page rather than honoring an
            // unsafe operator override.
          } else {
            reply.redirect(redirectTarget);
            return;
          }
        }
        renderHtml(
          reply,
          200,
          'Connection authorized',
          `Binding <code>${escapeHtml(result.bindingId)}</code> is now connected. ` +
            'You can close this window and return to Phoenix.',
          // The consent popup was script-opened by the app, so it may close
          // itself cross-origin. The visible text above is the fallback for the
          // rare popup-blocked / direct-landing case where this no-ops.
          '<script>window.close();</script>',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn({ err: msg, state: q.state.slice(0, 32) }, 'MCP OAuth callback failed');
        renderHtml(reply, 400, 'Consent could not be completed', escapeHtml(msg));
      }
    },
  );
};

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

async function resolveBindingForCallback(
  db: unknown,
  tenantId: string,
  bindingId: string,
  spaceId: string,
): Promise<CompleteConsentContext> {
  const tenantContext = createTenantContext(TenantIdSchema.parse(tenantId));

  const bindingRows = (await withTenantSchema(
    db as Parameters<typeof withTenantSchema>[0],
    tenantContext,
    async (tx) => {
      return tx
        .select()
        .from(mcpServerBindings)
        .where(
          and(eq(mcpServerBindings.bindingId, bindingId), eq(mcpServerBindings.spaceId, spaceId)),
        )
        .limit(1);
    },
  )) as Array<Record<string, unknown>>;
  if (bindingRows.length === 0) {
    throw new Error(
      `oauth_callback_binding_not_found: bindingId="${bindingId}" spaceId="${spaceId}"`,
    );
  }
  const bindingRow = bindingRows[0]!;
  const binding = parseBindingRow(bindingRow);
  if (!binding) {
    throw new Error(
      `oauth_callback_binding_invalid: bindingId="${bindingId}" failed schema validation`,
    );
  }

  const definitionRows = (await withTenantSchema(
    db as Parameters<typeof withTenantSchema>[0],
    tenantContext,
    async (tx) => {
      return tx
        .select()
        .from(mcpServerDefinitions)
        .where(
          and(
            eq(mcpServerDefinitions.serverId, binding.serverId),
            eq(mcpServerDefinitions.spaceId, spaceId),
          ),
        )
        .limit(1);
    },
  )) as Array<{ definitionJson?: unknown }>;
  if (definitionRows.length === 0) {
    throw new Error(
      `oauth_callback_definition_not_found: serverId="${binding.serverId}" spaceId="${spaceId}"`,
    );
  }
  const definition = parseDefinitionRow(definitionRows[0]!);
  if (!definition) {
    throw new Error(`oauth_callback_definition_invalid: serverId="${binding.serverId}"`);
  }

  const descriptor = buildMcpOAuthDescriptor(binding, definition);
  return {
    tenantId,
    discovery: descriptor.discovery,
    issuerKey: descriptor.issuerKey,
    platformClientId: descriptor.platformClientId,
  };
}

/**
 * Build the consent-completion context for an `oauth2_authorization_code` API
 * binding. Unlike MCP, there is no PRM discovery descriptor: the binding pins
 * `authorizationServer` (and `issuerKey`) directly, and the platform client is
 * the hosted CIMD document URL.
 */
async function resolveApiBindingForCallback(
  db: unknown,
  tenantId: string,
  bindingId: string,
  spaceId: string,
): Promise<CompleteConsentContext> {
  const tenantContext = createTenantContext(TenantIdSchema.parse(tenantId));

  const bindingRows = (await withTenantSchema(
    db as Parameters<typeof withTenantSchema>[0],
    tenantContext,
    async (tx) => {
      return tx
        .select()
        .from(apiBindings)
        .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, spaceId)))
        .limit(1);
    },
  )) as Array<Record<string, unknown>>;
  if (bindingRows.length === 0) {
    throw new Error(
      `oauth_callback_binding_not_found: bindingId="${bindingId}" spaceId="${spaceId}"`,
    );
  }
  const binding = parseApiBindingRow(bindingRows[0]!);
  if (!binding) {
    throw new Error(
      `oauth_callback_binding_invalid: bindingId="${bindingId}" failed schema validation`,
    );
  }
  if (binding.auth.type !== 'oauth2_authorization_code') {
    throw new Error(
      `oauth_callback_binding_not_oauth: bindingId="${bindingId}" auth.type="${binding.auth.type}"`,
    );
  }
  const auth = binding.auth;

  return {
    tenantId,
    issuerKey: auth.issuerKey,
    platformClientId: resolveCimdDocumentUrl(),
    ...(auth.authorizationServer ? { authorizationServer: auth.authorizationServer } : {}),
  };
}

function parseApiBindingRow(row: Record<string, unknown>): ApiBinding | null {
  const rowSpaceId =
    typeof row['spaceId'] === 'string'
      ? row['spaceId']
      : typeof row['space_id'] === 'string'
        ? row['space_id']
        : undefined;
  const rawScope = (row['scopeJson'] ?? row['scope_json'] ?? {}) as Record<string, unknown>;
  const scope = { ...rawScope, ...(rowSpaceId ? { spaceId: rowSpaceId } : {}) };

  const variableValues = row['variableValuesJson'] ?? row['variable_values_json'];
  const raw: Record<string, unknown> = {
    bindingId: row['bindingId'] ?? row['binding_id'],
    apiId: row['apiId'] ?? row['api_id'],
    name: row['name'],
    ...(row['description'] ? { description: row['description'] } : {}),
    scope,
    auth: row['authJson'] ?? row['auth_json'],
    egressPolicy: row['egressPolicyJson'] ?? row['egress_policy_json'],
    ...(variableValues ? { variableValues } : {}),
    enabled: (row['enabled'] ?? 1) === 1,
  };
  const result = ApiBindingSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function parseBindingRow(row: Record<string, unknown>): McpServerBinding | null {
  const rowSpaceId =
    typeof row['spaceId'] === 'string'
      ? row['spaceId']
      : typeof row['space_id'] === 'string'
        ? row['space_id']
        : undefined;
  const rawScope = (row['scopeJson'] ?? row['scope_json'] ?? {}) as Record<string, unknown>;
  const scope = { ...rawScope, ...(rowSpaceId ? { spaceId: rowSpaceId } : {}) };

  const raw: Record<string, unknown> = {
    bindingId: row['bindingId'] ?? row['binding_id'],
    serverId: row['serverId'] ?? row['server_id'],
    name: row['name'],
    ...(row['description'] ? { description: row['description'] } : {}),
    scope,
    auth: row['authJson'] ?? row['auth_json'],
    connectionPolicy: row['connectionPolicyJson'] ?? row['connection_policy_json'] ?? {},
    ...((row['toolAccessPolicyJson'] ?? row['tool_access_policy_json'])
      ? { toolAccessPolicy: row['toolAccessPolicyJson'] ?? row['tool_access_policy_json'] }
      : {}),
    subscribeListChanged: (row['subscribeListChanged'] ?? row['subscribe_list_changed']) === 1,
    samplingPolicy:
      ((row['samplingPolicy'] ?? row['sampling_policy']) as string | undefined) ?? 'off',
    ownerScope: (row['ownerScope'] ?? row['owner_scope']) as string | undefined,
    clientScope: (row['clientScope'] ?? row['client_scope']) as string | undefined,
    ...((row['pinnedOrigin'] ?? row['pinned_origin'])
      ? { pinnedOrigin: row['pinnedOrigin'] ?? row['pinned_origin'] }
      : {}),
    enabled: (row['enabled'] ?? 1) === 1,
  };
  const result = McpServerBindingSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function parseDefinitionRow(row: { definitionJson?: unknown }): McpServerDefinition | null {
  const result = McpServerDefinitionSchema.safeParse(row.definitionJson ?? {});
  return result.success ? result.data : null;
}

/**
 * True only if `redirectTarget` is a relative path OR shares its origin with
 * `API_BASE_URL`. Anything else (cross-origin URL, javascript:, malformed,
 * data:) is rejected so the operator-controlled env var can't be used to
 * exfiltrate the current page's `state` + `code` via the Referer header.
 *
 * Relative paths are always safe — the browser resolves them against the
 * current origin (which is by definition the API origin since the user just
 * hit `/v1/oauth/callback`).
 */
export function isSameOriginRedirect(redirectTarget: string): boolean {
  // Reject obvious script schemes before URL parsing — `new URL('javascript:…')`
  // succeeds with `protocol: 'javascript:'`, which would slip past an origin
  // check that only compares host/port.
  if (/^\s*(javascript|data|vbscript|file):/i.test(redirectTarget)) return false;
  // Relative path: always same-origin in the browser.
  if (redirectTarget.startsWith('/') && !redirectTarget.startsWith('//')) return true;
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(redirectTarget);
    allowed = new URL(resolveOAuthCallbackUrl());
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  return target.origin === allowed.origin;
}

/**
 * `scriptExtra` is appended verbatim before `</body>` and is the ONLY raw-HTML
 * sink — callers MUST pass a static, code-controlled string (never user input).
 * Used by the success branch to inject `window.close()` so a script-opened
 * consent popup closes itself.
 */
function renderHtml(
  reply: FastifyReply,
  status: number,
  title: string,
  body: string,
  scriptExtra = '',
): void {
  reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:640px;margin:0 auto;">` +
        `<h1 style="margin-top:0;">${escapeHtml(title)}</h1>` +
        `<p>${body}</p>` +
        scriptExtra +
        `</body></html>`,
    );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
