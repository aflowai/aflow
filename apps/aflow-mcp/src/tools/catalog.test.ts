/**
 * The `catalog` tool is the operator's coding agent reading the directory, not a
 * run's agent holding tools, so it asks `catalog.tool.list` for the full set:
 * op-task-only operations stay in both phases, marked, for workflow authoring.
 * The orchestrator side of this (what that input returns) is held by
 * `opTaskOnlySurfaceExclusion.contract.test.ts`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import type { SessionRunRequest, SessionRunner } from '../client/FlowRunner.js';
import type { SpaceGate } from '../middleware/spaceGate.js';
import type { McpToolResult } from '../util/envelope.js';
import { registerCatalogTool } from './catalog.js';

const SPACE_ID = '66666666-7777-4888-8999-000000000000';
const session = {
  id: 'mcp-session',
  auth: { method: 'api_key', apiKey: 'phx_test', user: { id: 'owner' } },
  createdAt: 0,
  lastActivityAt: 0,
} as unknown as Session;

function catalogTool(): {
  call: (args: Record<string, unknown>) => Promise<McpToolResult>;
  requests: SessionRunRequest[];
} {
  let handler: ((args: Record<string, unknown>) => Promise<McpToolResult>) | undefined;
  const server = {
    registerTool: (
      _name: string,
      _config: unknown,
      registered: (args: Record<string, unknown>) => Promise<McpToolResult>,
    ) => {
      handler = registered;
    },
  } as unknown as McpServer;
  const requests: SessionRunRequest[] = [];
  const runner = {
    run: (_session: Session, request: SessionRunRequest) => {
      requests.push(request);
      return Promise.resolve({
        sessionId: 'run-1',
        status: 'SUCCEEDED',
        output: { mode: 'directory', stepTypes: [] },
        durationMs: 1,
      });
    },
  } as unknown as SessionRunner;
  const authManager = { isAuthenticated: () => true } as unknown as AuthManager;
  const spaceGate = { resolve: (id: string) => id } as unknown as SpaceGate;
  registerCatalogTool(server, runner, authManager, spaceGate, () => session);
  if (handler === undefined) throw new Error('catalog was not registered');
  return { call: handler, requests };
}

describe('catalog', () => {
  it('asks catalog.tool.list for workflow steps in the overview and in the detail phase', async () => {
    const { call, requests } = catalogTool();
    await call({ space_id: SPACE_ID });
    await call({ space_id: SPACE_ID, step_types: ['learner'] });

    expect(requests.map((r) => [r.operationId, r.input?.['workflowSteps']])).toEqual([
      ['catalog.tool.list', true],
      ['catalog.tool.list', true],
    ]);
    expect(requests[1]?.input?.['stepTypes']).toEqual(['learner']);
  });
});
