#!/usr/bin/env node
/**
 * Aflow MCP Server v2
 *
 * Production-grade MCP server using Streamable HTTP transport.
 * Exposes up to 9 tools: auth_status, space_list, catalog, run_operation,
 * start_session, fetch_payload, inspect_session, watch_session, watch_run.
 *
 * Each MCP session gets its own transport + server instance.
 * Auth state is per-session (in-memory Map, Redis in Phase 2).
 */

// Must precede all other imports so Sentry can patch http before it loads.
import './instrument.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { SessionStore, type Session } from './auth/SessionStore.js';
import { AuthManager } from './auth/AuthManager.js';
import { ApiClient } from './client/ApiClient.js';
import { SessionRunner } from './client/FlowRunner.js';
import { Watcher } from './client/Watcher.js';
import { SpaceGate } from './middleware/spaceGate.js';
import { registerAllTools } from './tools/index.js';
import { log, setLogLevel } from './util/logger.js';
import { installBackgroundTaskControlPlane } from '@aflow/schemas';
import { recordBackgroundTaskDisabled } from '@aflow/observability';
import { flushCrashReporting } from '@aflow/observability/crashReporting';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = loadConfig();
setLogLevel(config.logLevel);

installBackgroundTaskControlPlane({
  services: ['mcp-server'],
  hooks: {
    logError: (message, data) => {
      log('error', message, data);
    },
    logWarn: (message, data) => {
      log('warn', message, data);
    },
    onDisabled: recordBackgroundTaskDisabled,
  },
});

// ---------------------------------------------------------------------------
// Shared services (stateless — safe to share across sessions)
// ---------------------------------------------------------------------------

const sessionStore = new SessionStore();
const authManager = new AuthManager(config);

// ---------------------------------------------------------------------------
// Per-session MCP server factory
// ---------------------------------------------------------------------------

interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  session: Session;
  spaceGate: SpaceGate;
}

const activeSessions = new Map<string, McpSession>();

/**
 * Create a new MCP server instance for a session.
 */
function createMcpSession(
  sessionId: string,
  headers: Record<string, string | undefined>,
): McpSession {
  const session = sessionStore.getOrCreate(sessionId);

  // Initialize auth from request headers
  authManager.initFromHeaders(session, headers);

  // Per-session space gate (every space-scoped tool passes space_id explicitly)
  const spaceGate = new SpaceGate();

  // Per-session payload resolve mode (default: eager)
  const rawResolveMode = headers['x-resolve-payloads']?.toLowerCase();
  const payloadResolveMode: 'eager' | 'lazy' | 'auto' =
    rawResolveMode === 'lazy' ? 'lazy' : rawResolveMode === 'auto' ? 'auto' : 'eager';

  // Per-session API client, session runner, and watcher
  const apiClient = new ApiClient(config, authManager);
  const sessionRunner = new SessionRunner(apiClient);
  const watcher = new Watcher(apiClient);

  // Create MCP server + transport for this session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      log('info', 'session_created', {
        session: sid,
        auth_method: session.auth.method,
        payload_resolve: payloadResolveMode,
      });
    },
  });

  const mcpServer = new McpServer(
    {
      name: 'aflow-mcp',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register tools with a session resolver that returns this session
  registerAllTools(mcpServer, {
    authManager,
    apiClient,
    sessionRunner,
    watcher,
    spaceGate,
    config,
    getSession: () => session,
    payloadResolveMode,
  });

  const mcpSession: McpSession = { transport, mcpServer, session, spaceGate };
  activeSessions.set(sessionId, mcpSession);

  // Connect MCP server to transport
  // Cast needed: StreamableHTTPServerTransport has optional onclose/onerror but
  // Transport interface has them as required in strict mode.
  void mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);

  return mcpSession;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function extractHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url = req.url ?? '/';

    // Health check (always allowed — load balancers need this)
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version: '2.0.0',
          sessions: activeSessions.size,
        }),
      );
      return;
    }

    // Host header gate: reject requests to direct provider URLs (e.g. a platform-assigned hostname)
    // Only enforced when ALLOWED_HOSTS is set (production). Skipped in dev.
    if (config.allowedHosts.length > 0) {
      const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      if (!config.allowedHosts.includes(host)) {
        log('warn', 'host_rejected', { host, allowed: config.allowedHosts });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }

    // All MCP traffic goes to the root path
    if (url !== '/' && !url.startsWith('/?')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const headers = extractHeaders(req);
    const mcpSessionId = headers['mcp-session-id'];

    try {
      if (req.method === 'POST') {
        let mcpSession: McpSession | undefined;

        if (mcpSessionId) {
          // Existing session
          mcpSession = activeSessions.get(mcpSessionId);
          if (!mcpSession) {
            // Session expired or unknown — client needs to re-initialize
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found. Re-initialize.' }));
            return;
          }
        } else {
          // New session — create on initialization request
          const newId = randomUUID();
          mcpSession = createMcpSession(newId, headers);
        }

        await mcpSession.transport.handleRequest(req, res);
      } else if (req.method === 'GET') {
        // SSE stream for server-initiated messages
        if (!mcpSessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Mcp-Session-Id header required for GET' }));
          return;
        }

        const mcpSession = activeSessions.get(mcpSessionId);
        if (!mcpSession) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        await mcpSession.transport.handleRequest(req, res);
      } else if (req.method === 'DELETE') {
        // Session termination
        if (mcpSessionId) {
          const mcpSession = activeSessions.get(mcpSessionId);
          if (mcpSession) {
            await mcpSession.transport.close();
            activeSessions.delete(mcpSessionId);
            sessionStore.delete(mcpSessionId);
            log('info', 'session_closed', { session: mcpSessionId });
          }
        }
        res.writeHead(200);
        res.end();
      } else if (req.method === 'OPTIONS') {
        // CORS preflight — MCP clients are not browsers, but we handle OPTIONS
        // defensively. No wildcard origin in production.
        const origin = req.headers.origin ?? '';
        const allowedOrigin = config.allowBrowserOrigins ? origin || '*' : '';
        res.writeHead(204, {
          ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, Mcp-Session-Id, X-Space-ID, X-Resolve-Payloads, X-Request-ID',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      }
    } catch (err: unknown) {
      log('error', 'http_error', { error: String(err), method: req.method, url });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  })();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

httpServer.listen(config.port, () => {
  log('info', 'server_started', {
    port: config.port,
    api_url: config.apiUrl,
    unauthenticated_fallback: config.unauthenticatedFallback,
    browser_origins: config.allowBrowserOrigins,
  });
  console.error(`Aflow MCP server v2 listening on http://localhost:${config.port}`);
  console.error(`  Platform API: ${config.apiUrl}`);
  console.error(
    `  Uncredentialed sessions: ${config.unauthenticatedFallback ? 'allowed' : 'refused'}`,
  );
});

// Graceful shutdown
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', 'server_stopping', { sessions: activeSessions.size });

  // Close all MCP transports first so SSE streams and in-flight requests end
  const closeTasks: Array<Promise<void>> = [];
  for (const [id, session] of activeSessions) {
    closeTasks.push(
      session.transport.close().catch((err: unknown) => {
        log('warn', 'session_close_error', { session: id, error: String(err) });
      }),
    );
  }
  activeSessions.clear();

  void Promise.allSettled(closeTasks).then(() => {
    httpServer.close(() => {
      sessionStore.destroy();
      log('info', 'server_stopped', {});
      // Short flush budget to stay within the 4s hard-exit backstop below.
      void flushCrashReporting(1500).finally(() => process.exit(0));
    });
  });

  setTimeout(() => process.exit(1), 4_000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
