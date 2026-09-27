/**
 * Auth types for the MCP server.
 */

export type AuthMethod = 'bearer_token' | 'api_key' | 'dev_bypass' | 'none';

export interface SessionAuth {
  /** How this session authenticated */
  method: AuthMethod;
  /** Bearer token supplied by the client, forwarded upstream verbatim */
  accessToken?: string | undefined;
  /** When the access token expires (epoch ms) */
  tokenExpiresAt?: number | undefined;
  /** API key (phx_...) passed via header */
  apiKey?: string | undefined;
  /** User info, where the client's credential carried any */
  user?:
    | {
        email: string;
        name: string;
        userId: string;
      }
    | undefined;
  /** Resolved tenant ID (from /v1/users/me) */
  tenantId?: string | undefined;
}
