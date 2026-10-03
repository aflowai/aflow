/**
 * AuthManager — per-session credential handling.
 *
 * Every path here is a credential the client supplies; this server mints none
 * and holds no directory configuration of its own:
 * - API key (`Bearer phx_...`), forwarded upstream
 * - Bearer token, forwarded upstream verbatim and never refreshed
 * - Dev-only JSON file (AFLOW_MCP_LOCAL_AUTH_JSON — disabled in production)
 * - Dev bypass, which sends no credential at all and therefore only reaches a
 *   stack that has one to spare
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from '../config.js';
import type { AdmittedHeaders } from '../requestGate.js';
import type { Session } from './SessionStore.js';
import { log } from '../util/logger.js';

/** Schema for dev-only local MCP auth file (see mcp.local.json.example). */
const LocalMcpAuthJsonSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    tokenExpiresAt: z.number().optional(),
    tenantId: z.string().optional(),
    defaultSpaceId: z.string().optional(),
    user: z
      .object({
        email: z.string(),
        name: z.string().optional(),
        userId: z.string().optional(),
      })
      .optional(),
  })
  .strict()
  .refine((d) => !!(d.apiKey ?? d.accessToken), {
    message: 'Provide apiKey (phx_...) or accessToken',
  });

/**
 * The `exp` a token asserts, in epoch ms, without verifying the signature.
 *
 * Deliberately unverified: this server is not the verifier and never was — it
 * forwards the credential and the API decides. What the claim is good for is
 * not guessing a local expiry.
 */
function assertedExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class AuthManager {
  constructor(private readonly config: McpServerConfig) {}

  /**
   * Initialize auth for a session from incoming request headers.
   * Called once when a new MCP session is created.
   */
  initFromHeaders(session: Session, headers: AdmittedHeaders): void {
    const authHeader = headers['authorization'];

    if (authHeader?.startsWith('Bearer phx_')) {
      // API key mode
      session.auth = {
        method: 'api_key',
        apiKey: authHeader.slice('Bearer '.length),
      };
      log('info', 'session_auth', { session: session.id, method: 'api_key' });
      return;
    }

    if (authHeader?.startsWith('Bearer ey')) {
      // Forwarded verbatim, with the expiry the token itself asserts. Guessing
      // one is wrong in both directions: a short-lived credential goes on
      // reporting itself authenticated while every call 401s, and a long-lived
      // one is refused here while it is still good. A token that claims no
      // expiry gets none — the API is the verifier, and it is entitled to
      // answer.
      const token = authHeader.slice('Bearer '.length);
      const expiry = assertedExpiry(token);
      session.auth = {
        method: 'bearer_token',
        accessToken: token,
        ...(expiry === undefined ? {} : { tokenExpiresAt: expiry }),
      };
      log('info', 'session_auth', { session: session.id, method: 'bearer_token' });
      return;
    }

    if (this.tryApplyLocalAuthJson(session)) {
      return;
    }

    if (this.config.unauthenticatedFallback) {
      session.auth = { method: 'dev_bypass' };
      log('info', 'session_auth', { session: session.id, method: 'dev_bypass' });
      return;
    }

    // No credential. The client has to supply one on its next connection —
    // `auth_status` says what is missing.
    session.auth = { method: 'none' };
  }

  /**
   * Get authorization headers for Platform API requests.
   */
  getAuthHeaders(session: Session): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (session.auth.apiKey) {
      headers['Authorization'] = `Bearer ${session.auth.apiKey}`;
    } else if (session.auth.accessToken) {
      headers['Authorization'] = `Bearer ${session.auth.accessToken}`;
    }

    // Include tenant context if resolved (from /v1/users/me after login)
    if (session.auth.tenantId) {
      headers['X-Tenant-ID'] = session.auth.tenantId;
    }

    return headers;
  }

  /**
   * Check if the session is authenticated.
   */
  isAuthenticated(session: Session): boolean {
    if (session.auth.method === 'dev_bypass') return true;
    if (session.auth.method === 'api_key' && session.auth.apiKey) return true;
    if (session.auth.method === 'bearer_token' && session.auth.accessToken) {
      // Unknown expiry is not expiry. Refusing here would deny a credential
      // the API would have accepted, and this server never verified it anyway.
      const { tokenExpiresAt } = session.auth;
      return tokenExpiresAt === undefined || Date.now() < tokenExpiresAt;
    }
    return false;
  }

  /**
   * Dev-only: load API key or bearer token from a JSON file.
   * `localAuthJsonPath` is stripped in production by loadConfig().
   */
  private tryApplyLocalAuthJson(session: Session): boolean {
    const filePath = this.config.localAuthJsonPath;
    if (!filePath) return false;

    try {
      const absolute = resolve(process.cwd(), filePath);
      const raw = readFileSync(absolute, 'utf8');
      const parsed = LocalMcpAuthJsonSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        log('warn', 'local_auth_json_invalid', {
          path: absolute,
          issues: parsed.error.flatten(),
        });
        return false;
      }

      const j = parsed.data;
      const user =
        j.user !== undefined
          ? {
              email: j.user.email,
              name: j.user.name ?? '',
              userId: j.user.userId ?? '',
            }
          : undefined;

      if (j.apiKey) {
        session.auth = {
          method: 'api_key',
          apiKey: j.apiKey,
          tenantId: j.tenantId,
          ...(user !== undefined ? { user } : {}),
        };
        log('info', 'session_auth', {
          session: session.id,
          method: 'api_key',
          source: 'local_auth_json',
        });
      } else if (j.accessToken) {
        session.auth = {
          method: 'bearer_token',
          accessToken: j.accessToken,
          ...(j.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: j.tokenExpiresAt }),
          tenantId: j.tenantId,
          ...(user !== undefined ? { user } : {}),
        };
        log('info', 'session_auth', {
          session: session.id,
          method: 'bearer_token',
          source: 'local_auth_json',
        });
      } else {
        return false;
      }

      if (j.defaultSpaceId) {
        session.mcpLocalDefaults = { defaultSpaceId: j.defaultSpaceId };
      }

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', 'local_auth_json_read_failed', { path: filePath, message });
      return false;
    }
  }
}
