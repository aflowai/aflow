/**
 * retry_session tool — run a FAILED session again, as the web UI's Retry does:
 * POST /v1/sessions/:id/retry with no corrective input.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import { ApiError, type ApiClient } from '../client/ApiClient.js';
import type { ToolContinuation } from '../client/Watcher.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { type SpaceGate, SpaceRequiredError } from '../middleware/spaceGate.js';
import { successResponse, errorResponse, type McpToolResult } from '../util/envelope.js';
import { log } from '../util/logger.js';

type SessionResolver = () => Session;

const RetrySessionInputSchema = z.object({
  session_id: z.string().min(1).describe('The FAILED session to run again.'),
  space_id: z
    .string()
    .min(1)
    .describe('Space ID the session belongs to (required). Call space_list to discover spaces.'),
});

interface RetryResponse {
  status: string;
  retryCount: number;
  traceId: string;
}

/** The route's own sentence, from the `{ error, message }` body it refuses with. */
function refusalMessage(err: ApiError): string {
  try {
    const parsed = JSON.parse(err.body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message !== '') return parsed.message;
  } catch {
    // not JSON — the body itself is the reason
  }
  return err.body.trim() !== '' ? err.body : `The API answered ${String(err.status)}.`;
}

export async function retrySession(
  apiClient: Pick<ApiClient, 'post'>,
  session: Session,
  sessionId: string,
  spaceId: string,
): Promise<McpToolResult> {
  try {
    const retried = await apiClient.post<RetryResponse>(
      session,
      `/v1/sessions/${encodeURIComponent(sessionId)}/retry?spaceId=${encodeURIComponent(spaceId)}`,
      {},
    );
    const continuation: ToolContinuation = {
      tool: 'watch_session',
      args: { session_id: sessionId, space_id: spaceId, until: 'terminal' },
    };
    return successResponse(
      {
        session_id: sessionId,
        status: retried.status,
        retry_count: retried.retryCount,
        continuation,
      },
      'Retry requested. Call the `continuation` tool with its args verbatim to follow it.',
    );
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      return errorResponse(
        'RETRY_REFUSED',
        refusalMessage(err),
        err.status === 409
          ? 'Only a FAILED session can be retried; inspect_session shows its status.'
          : undefined,
      );
    }
    throw err;
  }
}

export function registerRetrySessionTool(
  server: McpServer,
  apiClient: ApiClient,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'retry_session',
    {
      title: 'retry_session',
      description:
        'Run a FAILED session again from its failed step, or the agent turn that called it — the ' +
        'web UI’s Retry. Refused, with the ' +
        'reason, when the session is not FAILED. Read why it failed first (inspect_session ' +
        '`failure`): a retry meets the same error unless what it names has changed.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: RetrySessionInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = RetrySessionInputSchema.parse(args);

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
          tool: 'retry_session',
          session: session.id,
          space_id: spaceId,
          session_id: input.session_id,
        });

        return await retrySession(apiClient, session, input.session_id, spaceId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', { tool: 'retry_session', session: session.id, error: message });
        return errorResponse('RETRY_FAILED', message);
      }
    },
  );
}
