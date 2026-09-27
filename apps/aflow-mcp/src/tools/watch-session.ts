/**
 * watch_session tool — follow a session until it updates, pauses for input,
 * or reaches a terminal state.
 *
 * Interval-polls the same reads inspect_session uses and returns only the
 * steps after the caller's cursor. On timeout the response carries a
 * `continuation` (exact tool + args) so callers chain watches instead of
 * falling back to manual polling.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Watcher } from '../client/Watcher.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { type SpaceGate, SpaceRequiredError } from '../middleware/spaceGate.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import { successResponse, errorResponse } from '../util/envelope.js';
import { log } from '../util/logger.js';

type SessionResolver = () => Session;

const WatchSessionInputSchema = z.object({
  session_id: z.string().min(1).describe('The session ID to watch.'),
  space_id: z
    .string()
    .min(1)
    .describe('Space ID the session belongs to (required). Call space_list to discover spaces.'),
  until: z
    .enum(['update', 'pause', 'terminal'])
    .optional()
    .describe(
      "Wait condition (default 'update'): 'update' = any new step, step-status change, or " +
        "session-status change since cursor; 'pause' = session paused awaiting input; 'terminal' = " +
        'SUCCEEDED/FAILED/CANCELLED. A pause needing input or a terminal state always ends ' +
        'the watch — the session cannot move without external action.',
    ),
  timeout_seconds: z
    .number()
    .min(1)
    .max(240)
    .optional()
    .describe(
      'Max wait in seconds (default 60, max 240). On timeout the response has done=false ' +
        'and a `continuation` with the exact next call.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      'Opaque cursor from a prior watch_session response. Pass it back to receive only ' +
        'steps and changes you have not seen yet.',
    ),
});

export function registerWatchSessionTool(
  server: McpServer,
  watcher: Watcher,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'watch_session',
    {
      title: 'watch_session',
      description:
        'Follow a session without manual polling: blocks until new activity, a pause that ' +
        'needs input, or completion (per `until`), then returns the steps since your cursor. ' +
        'If the response has done=false (timed out), call the tool named in `continuation` ' +
        'with its args verbatim to keep following.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: WatchSessionInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = WatchSessionInputSchema.parse(args);

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
          tool: 'watch_session',
          session: session.id,
          space_id: spaceId,
          session_id: input.session_id,
          until: input.until ?? 'update',
        });

        const result = await watcher.watchSession(session, {
          session_id: input.session_id,
          space_id: spaceId,
          until: input.until,
          timeout_seconds: input.timeout_seconds,
          cursor: input.cursor,
        });

        log('info', 'tool_complete', {
          tool: 'watch_session',
          session: session.id,
          session_id: input.session_id,
          status: result.status,
          done: result.done,
          new_step_count: result.new_steps.length,
        });

        return successResponse(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', {
          tool: 'watch_session',
          session: session.id,
          error: message,
        });
        return errorResponse('WATCH_FAILED', message);
      }
    },
  );
}
