/**
 * watch_run tool — follow a workflow run until it pauses for a decision or
 * reaches a terminal state.
 *
 * Interval-polls the run-detail read. When the run is paused the response
 * carries the verbatim resume contract (including suggestedResumeCall) so the
 * caller can approve/resume immediately instead of polling the database.
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

const WatchRunInputSchema = z.object({
  run_id: z.string().min(1).describe('The workflow run ID to watch.'),
  space_id: z
    .string()
    .min(1)
    .describe('Space ID the run belongs to (required). Call space_list to discover spaces.'),
  until: z
    .enum(['pause', 'terminal'])
    .optional()
    .describe(
      "Wait condition (default 'pause'): 'pause' = run paused for a decision (resume " +
        "contract returned); 'terminal' = completed/failed/cancelled. A pause always ends " +
        'the watch — the run cannot progress without external action.',
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
});

export function registerWatchRunTool(
  server: McpServer,
  watcher: Watcher,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'watch_run',
    {
      title: 'watch_run',
      description:
        'Follow a workflow run without manual polling: blocks until the run pauses for a ' +
        'decision or ends. When paused, the response carries resume_contract (including the ' +
        'suggested resume call) so you can act immediately. If done=false (timed out), call ' +
        'the tool named in `continuation` with its args verbatim to keep following.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: WatchRunInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = WatchRunInputSchema.parse(args);

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
          tool: 'watch_run',
          session: session.id,
          space_id: spaceId,
          run_id: input.run_id,
          until: input.until ?? 'pause',
        });

        const result = await watcher.watchRun(session, {
          run_id: input.run_id,
          space_id: spaceId,
          until: input.until,
          timeout_seconds: input.timeout_seconds,
        });

        log('info', 'tool_complete', {
          tool: 'watch_run',
          session: session.id,
          run_id: input.run_id,
          status: result.run.status,
          done: result.done,
        });

        return successResponse(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', {
          tool: 'watch_run',
          session: session.id,
          error: message,
        });
        return errorResponse('WATCH_FAILED', message);
      }
    },
  );
}
