/**
 * Tool registration — wires all tools to the MCP server.
 *
 * Up to 9 tools (fetch_payload hidden in eager mode). Every space-scoped tool takes
 * an explicit space_id — there is no session default and no set_space:
 *   1. auth_status     — whoami
 *   2. space_list      — list accessible spaces (direct API)
 *   3. catalog         — two-phase operation discovery (via mcp-runner agent)
 *   4. run_operation   — run any operation by ID (via mcp-runner agent)
 *   5. start_session   — start agent sessions / resume conversations
 *   6. fetch_payload   — resolve a payload reference on demand (lazy/auto only)
 *   7. inspect_session — debug summary for any session (direct API)
 *   8. watch_session   — follow a session until update/pause/terminal (direct API)
 *   9. watch_run       — follow a workflow run until pause/terminal (direct API)
 *
 * There is no login tool. A session authenticates with the credential its
 * client supplies on the connection.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import type { ApiClient } from '../client/ApiClient.js';
import type { SessionRunner } from '../client/FlowRunner.js';
import type { Watcher } from '../client/Watcher.js';
import type { SpaceGate } from '../middleware/spaceGate.js';
import type { McpServerConfig } from '../config.js';
import type { PayloadResolveMode } from '../client/FlowRunner.js';
import { registerAuthTools } from './auth.js';
import { registerSpaceTools } from './space.js';
import { registerCatalogTool } from './catalog.js';
import { registerRunOperationTool } from './run-operation.js';
import { registerRunFlowTool } from './run-flow.js';
import { registerFetchPayloadTool } from './fetch-payload.js';
import { registerInspectRunTool } from './inspect-run.js';
import { registerWatchSessionTool } from './watch-session.js';
import { registerWatchRunTool } from './watch-run.js';

export interface ToolDeps {
  authManager: AuthManager;
  apiClient: ApiClient;
  sessionRunner: SessionRunner;
  watcher: Watcher;
  spaceGate: SpaceGate;
  config: McpServerConfig;
  getSession: () => Session;
  /**
   * Controls payload resolution behavior for non-inline refs.
   * - "eager": all payloads resolved automatically (fetch_payload tool hidden)
   * - "lazy": all payloads returned as handles (fetch_payload tool registered)
   * - "auto": operations eager, sessions lazy (fetch_payload tool registered)
   */
  payloadResolveMode: PayloadResolveMode | 'auto';
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerAuthTools(server, deps.authManager, deps.getSession);

  registerSpaceTools(server, deps.apiClient, deps.authManager, deps.getSession);

  registerCatalogTool(
    server,
    deps.sessionRunner,
    deps.authManager,
    deps.spaceGate,
    deps.getSession,
  );

  registerRunOperationTool(
    server,
    deps.sessionRunner,
    deps.authManager,
    deps.spaceGate,
    deps.getSession,
  );

  registerRunFlowTool(
    server,
    deps.sessionRunner,
    deps.authManager,
    deps.spaceGate,
    deps.getSession,
    deps.payloadResolveMode,
  );

  // fetch_payload is only useful when some payloads are returned as lazy handles
  if (deps.payloadResolveMode !== 'eager') {
    registerFetchPayloadTool(
      server,
      deps.sessionRunner,
      deps.authManager,
      deps.spaceGate,
      deps.getSession,
    );
  }

  registerInspectRunTool(server, deps.apiClient, deps.authManager, deps.spaceGate, deps.getSession);

  registerWatchSessionTool(server, deps.watcher, deps.authManager, deps.spaceGate, deps.getSession);

  registerWatchRunTool(server, deps.watcher, deps.authManager, deps.spaceGate, deps.getSession);
}
