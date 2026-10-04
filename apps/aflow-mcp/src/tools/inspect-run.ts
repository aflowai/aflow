/**
 * inspect_session tool — a session's state, bounded, from GET /v1/sessions/:id/debug.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import type { ApiClient } from '../client/ApiClient.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { type SpaceGate, SpaceRequiredError } from '../middleware/spaceGate.js';
import {
  CONTROL_STEP_OPERATION,
  DEFAULT_INSPECT_LAST_N_STEPS,
  inspectSession,
} from '../client/sessionInspection.js';
import { successResponse, errorResponse } from '../util/envelope.js';
import { log } from '../util/logger.js';

type SessionResolver = () => Session;

const InspectSessionInputSchema = z.object({
  session_id: z.string().min(1).describe('The session ID to inspect.'),
  space_id: z
    .string()
    .min(1)
    .describe('Space ID the session belongs to (required). Call space_list to discover spaces.'),
  last_n_steps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `How many of the newest matching steps to return (default ${String(DEFAULT_INSPECT_LAST_N_STEPS)}). ` +
        'The census names the number that returns every matching step; 0 returns none, for status alone.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      'Opaque cursor from a prior inspect_session or watch_session response. Pass it back to ' +
        'return only steps that are new, or whose status changed, since then.',
    ),
  status: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Only steps in these states, e.g. ['FAILED'] or ['RUNNING','PAUSED']. States: SCHEDULED, " +
        'RUNNING, SUCCEEDED, FAILED, PAUSED; NOT_SCHEDULED for a listed step no event has scheduled yet; ' +
        'NOT_READ and HOT_STATE_EXPIRED where a status cannot be read.',
    ),
  operation: z
    .array(z.string().min(1))
    .optional()
    .describe("Only steps of these operation ids, e.g. ['browser.page.open']."),
  include_control_steps: z
    .boolean()
    .optional()
    .describe(
      `Include the ${CONTROL_STEP_OPERATION} wrappers (default false). Each wraps a tool step ` +
        'listed on its own and carries nothing of its own.',
    ),
});

export function registerInspectRunTool(
  server: McpServer,
  apiClient: ApiClient,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'inspect_session',
    {
      title: 'inspect_session',
      description:
        "A session's status and target, its newest steps, the agent's latest reply or the " +
        'question it is paused on, and — when it FAILED — the failing step with its stored error ' +
        '(code, message, classification, provider details). Steps left out are counted by status ' +
        'in `census`, with the parameter that returns them. Pass the returned `cursor` back to ' +
        'see only what is new.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: InspectSessionInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = InspectSessionInputSchema.parse(args);

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
          tool: 'inspect_session',
          session: session.id,
          space_id: spaceId,
          session_id: input.session_id,
        });

        const result = await inspectSession(apiClient, session, { ...input, space_id: spaceId });

        log('info', 'tool_complete', {
          tool: 'inspect_session',
          session: session.id,
          session_id: input.session_id,
          status: result.status,
        });

        return successResponse(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', {
          tool: 'inspect_session',
          session: session.id,
          error: message,
        });
        return errorResponse('INSPECT_FAILED', message);
      }
    },
  );
}
