/**
 * `auth_status` says whether an orchestrator is consuming, beside who the
 * session is: it is the first call a client makes, and without an orchestrator
 * every run it starts afterwards is accepted and never moves.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import type { ApiClient } from '../client/ApiClient.js';
import type { McpToolResult } from '../util/envelope.js';
import { ORCHESTRATOR_HEALTH_PATH, registerAuthTools } from './auth.js';

/** As the API words it (`ORCHESTRATOR_ABSENT_NOTICE` in `@aflow/redis`). */
const NOTICE =
  'No orchestrator is running: messages, step results and cancellations wait until one starts.';

const session = {
  id: 'mcp-session',
  auth: { method: 'api_key', apiKey: 'phx_test', user: { id: 'owner' } },
  createdAt: 0,
  lastActivityAt: 0,
} as unknown as Session;

/** The `auth_status` handler, registered against an API whose orchestrator check is `get`. */
function authStatus(get: ApiClient['get']): () => Promise<McpToolResult> {
  let handler: (() => Promise<McpToolResult>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, registered: () => Promise<McpToolResult>) => {
      handler = registered;
    },
  } as unknown as McpServer;
  const authManager = { isAuthenticated: () => true } as unknown as AuthManager;
  const apiClient = { baseUrl: 'http://localhost:3000', get } as unknown as ApiClient;
  registerAuthTools(server, authManager, apiClient, () => session);
  if (handler === undefined) throw new Error('auth_status was not registered');
  return handler;
}

function orchestratorOf(result: McpToolResult): unknown {
  const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
    data?: { orchestrator?: unknown };
  };
  return envelope.data?.orchestrator;
}

describe('auth_status', () => {
  it('reports an orchestrator consuming, with nothing to warn of', async () => {
    const get = vi.fn().mockResolvedValue({
      alive: true,
      lastHeartbeat: '2026-10-05T12:00:00.000Z',
      notice: null,
    });

    const orchestrator = orchestratorOf(await authStatus(get)());

    expect(get).toHaveBeenCalledWith(session, ORCHESTRATOR_HEALTH_PATH);
    expect(orchestrator).toEqual({ consuming: true, last_heartbeat: '2026-10-05T12:00:00.000Z' });
  });

  it('says when no orchestrator is consuming, in the words the API gives every surface', async () => {
    const get = vi.fn().mockResolvedValue({
      alive: false,
      lastHeartbeat: '2026-10-05T11:20:00.000Z',
      notice: NOTICE,
    });

    expect(orchestratorOf(await authStatus(get)())).toEqual({
      consuming: false,
      last_heartbeat: '2026-10-05T11:20:00.000Z',
      notice: NOTICE,
    });
  });

  it('says it could not tell, rather than reporting one consuming, when the API does not answer', async () => {
    const get = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    expect(orchestratorOf(await authStatus(get)())).toEqual({
      consuming: 'unknown',
      notice: expect.stringContaining('fetch failed') as string,
    });
  });
});
