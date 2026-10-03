/**
 * MCP Server configuration — parsed from environment variables.
 */

export interface McpServerConfig {
  /** Platform API base URL */
  readonly apiUrl: string;
  /** MCP HTTP server port */
  readonly port: number;
  /**
   * The interface the HTTP server listens on: `MCP_HOST`, else loopback.
   *
   * A session that picks up the local auth file is the instance's owner, so
   * listening on every interface hands the owner to anything on the operator's
   * network that reaches the port. Not `HOST`: the shared `.env` sets that to
   * every interface for the API server.
   */
  readonly host: string;
  /** Log level */
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Proceed with no credential where a session supplies none.
   *
   * A property of the API this talks to, not of this process: sending nothing
   * reaches something only against a stack that has a development bypass of its
   * own. The local edition has none, so a session down this path arrives as
   * nobody and every call answers 401 with the cause two hops away — where
   * refusing here says which header is missing and how to mint the key.
   */
  readonly unauthenticatedFallback: boolean;
  /**
   * Answer a browser's CORS preflight with the caller's own origin.
   *
   * MCP clients are not browsers. This is for a developer driving the endpoint
   * from one, and is unrelated to whether a session may go uncredentialed.
   */
  readonly allowBrowserOrigins: boolean;
  /** Allowed Host headers in production (rejects direct provider URLs) */
  readonly allowedHosts: readonly string[];
  /** Shared secret for Cloudflare origin verification (skips bot challenges) */
  readonly cfOriginSecret: string | undefined;
  /**
   * Absolute or relative path to a JSON credentials file (dev only).
   * Ignored when NODE_ENV=production — never set this in prod deploys.
   */
  readonly localAuthJsonPath: string | undefined;
}

export function loadConfig(): McpServerConfig {
  const logLevel = (process.env['LOG_LEVEL'] ?? 'info') as McpServerConfig['logLevel'];
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';

  const allowedHostsRaw = process.env['ALLOWED_HOSTS'] ?? '';
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map((h) => h.trim().toLowerCase())
    : [];

  const localAuthJsonRaw = process.env['AFLOW_MCP_LOCAL_AUTH_JSON']?.trim();
  const localAuthJsonPath =
    nodeEnv === 'production' || !localAuthJsonRaw ? undefined : localAuthJsonRaw;
  const configuredHost = process.env['MCP_HOST']?.trim();

  return {
    apiUrl: process.env['AFLOW_API_URL'] ?? 'http://localhost:3000',
    cfOriginSecret: process.env['CF_ORIGIN_SECRET'],
    // MCP_PORT first (avoids conflict with API server on 3000 when both run in yarn dev).
    // PORT fallback for hosts that inject PORT for the listening process.
    port: Number(process.env['MCP_PORT'] ?? process.env['PORT'] ?? '3100'),
    host: configuredHost === undefined || configuredHost === '' ? '127.0.0.1' : configuredHost,
    logLevel,
    // The local edition composes no development bypass, so the fallback has
    // nothing to reach whatever NODE_ENV says.
    unauthenticatedFallback:
      nodeEnv !== 'production' && process.env['PHOENIX_EDITION']?.trim() !== 'community-local',
    allowBrowserOrigins: nodeEnv !== 'production',
    allowedHosts,
    localAuthJsonPath,
  };
}
