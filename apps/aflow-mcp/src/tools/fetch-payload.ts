/**
 * fetch_payload tool — resolve a payload reference and return its content.
 *
 * Used when start_session returns lazy payload handles ({ _ref, _hint }).
 * The agent calls this tool to fetch the actual data on demand.
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

const FetchPayloadInputSchema = z.object({
  ref: z
    .string()
    .describe(
      'The payload reference string (e.g., gs://... or inline:...). ' +
        'This is the _ref value from a lazy payload handle returned by start_session.',
    ),
  space_id: z.string().min(1).describe('Space ID (required). Call space_list to discover spaces.'),
});

export function registerFetchPayloadTool(
  server: McpServer,
  sessionRunner: SessionRunner,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'fetch_payload',
    {
      title: 'fetch_payload',
      description:
        'Fetch the content of a payload reference. Use this when start_session returns a ' +
        'lazy handle ({ _ref, _hint }) instead of inline data. Returns the actual ' +
        'payload content (JSON, text, etc.).',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: FetchPayloadInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      try {
        const session = getSession();

        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = FetchPayloadInputSchema.parse(args);

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
          tool: 'fetch_payload',
          session: session.id,
          ref: input.ref.slice(0, 80),
        });

        const data = await sessionRunner.fetchPayload(session, input.ref, spaceId);

        return successResponse(data);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', { tool: 'fetch_payload', error: message });
        return errorResponse('FETCH_FAILED', message);
      }
    },
  );
}
