/**
 * Auth tool: auth_status.
 *
 * There is no login tool. This server mints no credential and holds no
 * directory configuration — a session authenticates with what its client
 * supplies on the connection, so the only question left to ask is what
 * arrived.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { successResponse, errorResponse, type McpToolResult } from '../util/envelope.js';

type SessionResolver = () => Session;

/** What a client has to do when it turns out to have sent nothing. */
export const CREDENTIAL_GUIDANCE =
  'Supply a credential on the connection: set an `Authorization: Bearer phx_...` header ' +
  'in the MCP client configuration. Mint the key with `POST /v1/api-keys` against the ' +
  "instance, or in the web app under the workspace's API keys.";

export function registerAuthTools(
  server: McpServer,
  authManager: AuthManager,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'auth_status',
    {
      title: 'auth_status',
      description:
        'Check current authentication status. Also serves as "whoami" — returns ' +
        'auth method, user info, and default space.',
      inputSchema: {},
    },
    async (): Promise<McpToolResult> => {
      try {
        const session = getSession();
        const authenticated = authManager.isAuthenticated(session);

        return successResponse({
          authenticated,
          method: session.auth.method,
          user: session.auth.user,
          expires_at: session.auth.tokenExpiresAt
            ? new Date(session.auth.tokenExpiresAt).toISOString()
            : undefined,
          ...(authenticated ? {} : { how_to_authenticate: CREDENTIAL_GUIDANCE }),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse('INTERNAL_ERROR', message);
      }
    },
  );
}
