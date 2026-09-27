/**
 * run_operation tool — run any single platform operation by operation_id.
 *
 * The workhorse tool for direct platform interaction and testing.
 * Internally starts a session of the `mcp-runner` system agent, passing
 * the operation_id and input. Returns the operation output and session_id.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionRunner } from '../client/FlowRunner.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { type SpaceGate, SpaceRequiredError } from '../middleware/spaceGate.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import { successResponse, errorResponse } from '../util/envelope.js';
import { log } from '../util/logger.js';

type SessionResolver = () => Session;

const RunOperationInputSchema = z.object({
  operation_id: z
    .string()
    .describe(
      'The operation to run (e.g. "memory.store.query", "agent.manage.create"). ' +
        'Use the catalog tool to discover available operations.',
    ),
  input: z
    .record(z.unknown())
    .optional()
    .describe('Operation-specific input fields. See the operation schema from catalog.'),
  space_id: z
    .string()
    .min(1)
    .describe('Space ID to operate in (required). Call space_list to discover spaces.'),
  timeout_seconds: z
    .number()
    .min(1)
    .max(300)
    .optional()
    .describe('Max wait time in seconds (default: 120, max: 300).'),
});

export function registerRunOperationTool(
  server: McpServer,
  sessionRunner: SessionRunner,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'run_operation',
    {
      title: 'run_operation',
      description:
        'Run a single platform operation by operation_id. This is the primary tool for ' +
        'interacting with the Aflow platform — CRUD on agents, memory operations, API calls, ' +
        'catalog queries, and more. Every call runs through the execution engine with full observability. ' +
        'Use catalog to discover available operations and their input schemas.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: RunOperationInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = RunOperationInputSchema.parse(args);

        let spaceId: string;
        try {
          spaceId = spaceGate.resolve(input.space_id);
        } catch (err) {
          if (err instanceof SpaceRequiredError) {
            return errorResponse(err.code, err.message, err.hint);
          }
          throw err;
        }

        log('info', 'tool_call', {
          tool: 'run_operation',
          session: session.id,
          space_id: spaceId,
          operation_id: input.operation_id,
        });

        const startTime = Date.now();
        const timeoutMs = (input.timeout_seconds ?? 120) * 1000;

        const result = await sessionRunner.run(session, {
          spaceId,
          operationId: input.operation_id,
          input: input.input,
          timeoutMs,
        });

        const durationMs = Date.now() - startTime;

        log('info', 'tool_complete', {
          tool: 'run_operation',
          session: session.id,
          session_id: result.sessionId,
          operation_id: input.operation_id,
          status: result.status,
          duration_ms: durationMs,
        });

        return successResponse({
          session_id: result.sessionId,
          status: result.status,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
          ...(result.steps ? { steps: result.steps } : {}),
          ...(result.timedOutWaiting ? { timed_out_waiting: true } : {}),
          ...(result.continuation ? { continuation: result.continuation } : {}),
          ...(result.note ? { note: result.note } : {}),
          duration_ms: durationMs,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', {
          tool: 'run_operation',
          session: session.id,
          error: message,
        });
        return errorResponse('SESSION_FAILED', message);
      }
    },
  );
}
