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
import { loadConfig } from './config.js';
import { SessionStore } from './auth/SessionStore.js';
import { AuthManager } from './auth/AuthManager.js';
import { createMcpHttpServer } from './httpServer.js';
import { requestGatePolicy } from './requestGate.js';
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
const { httpServer, activeSessions } = createMcpHttpServer({ config, sessionStore, authManager });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

httpServer.listen(config.port, config.host, () => {
  const gate = requestGatePolicy(config);
  log('info', 'server_started', {
    host: config.host,
    port: config.port,
    api_url: config.apiUrl,
    unauthenticated_fallback: config.unauthenticatedFallback,
    answers_to: gate.allowedHosts.length > 0 ? gate.allowedHosts : 'loopback',
    browser_origins: gate.allowedOrigins,
  });
  console.error(`Aflow MCP server v2 listening on http://${config.host}:${config.port}`);
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
