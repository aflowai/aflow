/**
 * The MCP server's HTTP front: one transport and server instance per MCP session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServerConfig } from './config.js';
import type { SessionStore, Session } from './auth/SessionStore.js';
import type { AuthManager } from './auth/AuthManager.js';
import { ApiClient } from './client/ApiClient.js';
import { SessionRunner } from './client/FlowRunner.js';
import { Watcher } from './client/Watcher.js';
import { SpaceGate } from './middleware/spaceGate.js';
import { registerAllTools } from './tools/index.js';
import { log } from './util/logger.js';
import {
  admitRequest,
  requestGatePolicy,
  transportRebindingOptions,
  type AdmittedHeaders,
  type RequestGatePolicy,
} from './requestGate.js';

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  session: Session;
  spaceGate: SpaceGate;
}

export interface McpHttpServer {
  httpServer: Server;
  activeSessions: Map<string, McpSession>;
}

function extractHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

export function createMcpHttpServer(deps: {
  config: McpServerConfig;
  sessionStore: SessionStore;
  authManager: AuthManager;
}): McpHttpServer {
  const { config, sessionStore, authManager } = deps;
  const gatePolicy: RequestGatePolicy = requestGatePolicy(config);
  const activeSessions = new Map<string, McpSession>();

  function createMcpSession(
    sessionId: string,
    headers: AdmittedHeaders,
    admittedHost: string,
  ): McpSession {
    const session = sessionStore.getOrCreate(sessionId);

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

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      ...transportRebindingOptions(gatePolicy, admittedHost),
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

    // Cast needed: StreamableHTTPServerTransport has optional onclose/onerror but
    // Transport interface has them as required in strict mode.
    void mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);

    return mcpSession;
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = req.url ?? '/';

      // Ahead of the gate so a load balancer's probe needs no Host of ours: it
      // reads no session and no credential.
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

      const decision = admitRequest(gatePolicy, extractHeaders(req));
      if (!decision.admitted) {
        log('warn', 'request_refused', {
          status: decision.status,
          host: req.headers.host,
          origin: req.headers.origin,
        });
        res.writeHead(decision.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: decision.reason }));
        return;
      }
      const { headers } = decision;

      // The gate has already refused any origin not explicitly allowed, so one
      // that reaches here is echoed back, never a wildcard. Set on the response
      // itself so the transport's own writeHead keeps them.
      if (decision.origin !== undefined) {
        res.setHeader('Access-Control-Allow-Origin', decision.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
      }

      // All MCP traffic goes to the root path
      if (url !== '/' && !url.startsWith('/?')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const mcpSessionId = headers['mcp-session-id'];

      try {
        if (req.method === 'POST') {
          let mcpSession: McpSession | undefined;

          if (mcpSessionId) {
            mcpSession = activeSessions.get(mcpSessionId);
            if (!mcpSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found. Re-initialize.' }));
              return;
            }
          } else {
            mcpSession = createMcpSession(randomUUID(), headers, decision.host);
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
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers':
              'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Space-ID, X-Resolve-Payloads, X-Request-ID',
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

  return { httpServer, activeSessions };
}
