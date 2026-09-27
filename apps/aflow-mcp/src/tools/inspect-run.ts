/**
 * inspect_session tool — fetch a structured debug summary for any session.
 *
 * Calls GET /v1/sessions/:id/debug and formats the response into a
 * concise, agent-friendly summary with step traces, errors, and token usage.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import type { ApiClient } from '../client/ApiClient.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { type SpaceGate, SpaceRequiredError } from '../middleware/spaceGate.js';
import { buildStepSummaries, type SessionDebugResponse } from '../client/sessionViews.js';
import { successResponse, errorResponse } from '../util/envelope.js';
import { log } from '../util/logger.js';

type SessionResolver = () => Session;

const InspectSessionInputSchema = z.object({
  session_id: z.string().describe('The session ID to inspect.'),
  space_id: z
    .string()
    .min(1)
    .describe('Space ID the session belongs to (required). Call space_list to discover spaces.'),
});

// ---------------------------------------------------------------------------
// Compute token usage from events if not in debug view
// ---------------------------------------------------------------------------

function extractTokenUsage(
  debug: SessionDebugResponse,
): { prompt: number; completion: number; total: number } | undefined {
  // Check runtimeState for token accumulators
  if (debug.recentEvents) {
    let prompt = 0;
    let completion = 0;
    for (const evt of debug.recentEvents) {
      const meta = evt.metadata;
      if (!meta) continue;
      const p = meta['promptTokens'] as number | undefined;
      const c = meta['completionTokens'] as number | undefined;
      if (typeof p === 'number') prompt += p;
      if (typeof c === 'number') completion += c;
    }
    if (prompt > 0 || completion > 0) {
      return { prompt, completion, total: prompt + completion };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

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
        'Inspect a session for debugging. Returns a structured summary with step traces, ' +
        'errors, token usage, and runtime state. Use this to troubleshoot failed sessions ' +
        'without needing the web UI.',
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

        const sq = `spaceId=${encodeURIComponent(spaceId)}`;
        const debug = await apiClient.get<SessionDebugResponse>(
          session,
          `/v1/sessions/${input.session_id}/debug?${sq}`,
        );

        const steps = buildStepSummaries(debug);
        const tokenUsage = extractTokenUsage(debug);

        const summary: Record<string, unknown> = {
          session_id: debug.session.sessionId,
          status: debug.session.status,
        };

        if (debug.session.target) summary['target'] = debug.session.target;
        if (debug.session.durationMs !== undefined)
          summary['duration_ms'] = debug.session.durationMs;
        if (steps.length > 0) summary['steps'] = steps;
        if (tokenUsage) summary['token_usage'] = tokenUsage;

        // Include agent decisions if present
        if (debug.agent) {
          const agentSummary: Record<string, unknown> = {};
          for (const [stepId, info] of Object.entries(debug.agent)) {
            if (info.lastDecision) {
              agentSummary[stepId] = info.lastDecision;
            }
          }
          if (Object.keys(agentSummary).length > 0) {
            summary['agent_decisions'] = agentSummary;
          }
        }

        if (debug.warnings && debug.warnings.length > 0) {
          summary['warnings'] = debug.warnings;
        }

        // Include error refs for reference (even if not resolved)
        if (debug.refs?.['errorRef']) {
          summary['error_ref'] = debug.refs['errorRef'];
        }

        log('info', 'tool_complete', {
          tool: 'inspect_session',
          session: session.id,
          session_id: input.session_id,
          status: debug.session.status,
        });

        return successResponse(summary);
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
