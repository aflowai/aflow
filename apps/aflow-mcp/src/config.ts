/**
 * MCP Server configuration — parsed from environment variables.
 */

export interface McpServerConfig {
  /** Platform API base URL */
  readonly apiUrl: string;
  /** MCP HTTP server port */
  readonly port: number;
  /**
   * The interface the HTTP server listens on: `MCP_HOST`, else loopback
   * outside production and every interface in production.
   *
   * Outside production a session that picks up the local auth file is the
   * instance's owner. Loopback keeps other machines from reaching the port; the
   * Host and Origin checks in `requestGate.ts` keep a web page the operator
   * visits from reaching it through a name rebound to loopback. It takes both to
   * keep the owner on this machine. Production reads no auth file and runs in a
   * container behind a load balancer, which reaches it on the container's own
   * interface; there `ALLOWED_HOSTS` and the same checks bound who is answered.
   * Not `HOST`: the shared `.env` sets that to every interface for the API
   * server.
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
   * Whether any browser origin may be admitted; `allowedOrigins` names which.
   *
   * MCP clients are not browsers. This is for a developer driving the endpoint
   * from one, and is unrelated to whether a session may go uncredentialed. A
   * configured local auth file overrides it: no browser page is admitted while
   * a session could be handed the owner's key.
   */
  readonly allowBrowserOrigins: boolean;
  /** `MCP_ALLOWED_ORIGINS`: the exact origins (`scheme://host[:port]`) a browser request may carry. */
  readonly allowedOrigins: readonly string[];
  /**
   * `ALLOWED_HOSTS`: the hostnames this server answers to, on any port. Empty:
   * `localhost`, `127.0.0.1` and `[::1]` on `port`, and nothing else.
   */
  readonly allowedHosts: readonly string[];
  /** Shared secret for Cloudflare origin verification (skips bot challenges) */
  readonly cfOriginSecret: string | undefined;
  /**
   * Absolute or relative path to a JSON credentials file (dev only).
   * Ignored when NODE_ENV=production — never set this in prod deploys.
   */
  readonly localAuthJsonPath: string | undefined;
}

function listFromEnv(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

function isLoopbackListenHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Throws instead of returning a production config with an empty `ALLOWED_HOSTS`
 * on a non-loopback interface: the gate would answer only loopback names, so
 * every request that reaches the server would get a 421 while `/health`,
 * answered before the gate, stayed green.
 */
export function loadConfig(): McpServerConfig {
  const logLevel = (process.env['LOG_LEVEL'] ?? 'info') as McpServerConfig['logLevel'];
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';

  const allowedHosts = listFromEnv('ALLOWED_HOSTS');
  const allowedOrigins = listFromEnv('MCP_ALLOWED_ORIGINS').map((o) => o.replace(/\/+$/, ''));

  const localAuthJsonRaw = process.env['AFLOW_MCP_LOCAL_AUTH_JSON']?.trim();
  const localAuthJsonPath =
    nodeEnv === 'production' || !localAuthJsonRaw ? undefined : localAuthJsonRaw;
  const configuredHost = process.env['MCP_HOST']?.trim();
  const host =
    configuredHost !== undefined && configuredHost !== ''
      ? configuredHost
      : nodeEnv === 'production'
        ? '0.0.0.0'
        : '127.0.0.1';

  if (nodeEnv === 'production' && allowedHosts.length === 0 && !isLoopbackListenHost(host)) {
    throw new Error(
      `MCP server not started: it listens on ${host} in production and ALLOWED_HOSTS is empty, ` +
        'so it would answer only to localhost and refuse every request that reaches it from ' +
        'elsewhere. Set ALLOWED_HOSTS to the hostnames clients reach this server by, ' +
        'comma-separated: the name the load balancer serves it under, such as mcp.example.com.',
    );
  }

  return {
    apiUrl: process.env['AFLOW_API_URL'] ?? 'http://localhost:3000',
    cfOriginSecret: process.env['CF_ORIGIN_SECRET'],
    // MCP_PORT first (avoids conflict with API server on 3000 when both run in yarn dev).
    // PORT fallback for hosts that inject PORT for the listening process.
    port: Number(process.env['MCP_PORT'] ?? process.env['PORT'] ?? '3100'),
    host,
    logLevel,
    // The local edition composes no development bypass, so the fallback has
    // nothing to reach whatever NODE_ENV says.
    unauthenticatedFallback:
      nodeEnv !== 'production' && process.env['PHOENIX_EDITION']?.trim() !== 'community-local',
    allowBrowserOrigins: nodeEnv !== 'production',
    allowedOrigins,
    allowedHosts,
    localAuthJsonPath,
  };
}
