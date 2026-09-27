/**
 * Space tools — discover spaces.
 *
 * - space_list: discover accessible spaces. Every space-scoped tool then takes an
 *   explicit space_id (there is no session default and no set_space).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import type { ApiClient } from '../client/ApiClient.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { successResponse, errorResponse } from '../util/envelope.js';

type SessionResolver = () => Session;

interface SpaceResponse {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  description: string | null;
  myRole?: string | null;
}

interface SpacesListResponse {
  spaces: SpaceResponse[];
}

const SpaceListInputSchema = z.object({
  include_archived: z.boolean().optional().describe('Include archived spaces (default: false)'),
});

export function registerSpaceTools(
  server: McpServer,
  client: ApiClient,
  authManager: AuthManager,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'space_list',
    {
      title: 'space_list',
      description:
        'List spaces you can access. Returns space details including name, member count, and your ' +
        'role. Call this first to discover available space IDs — every space-scoped tool ' +
        'requires an explicit space_id. If unsure which space to use, ask the user.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: SpaceListInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      try {
        const session = getSession();

        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = SpaceListInputSchema.parse(args);
        const params = new URLSearchParams();
        if (input.include_archived) params.set('status', 'all');

        const query = params.toString();
        const path = query ? `/v1/spaces?${query}` : '/v1/spaces';
        const result = await client.get<SpacesListResponse>(session, path);

        const spaces = result.spaces.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          member_count: s.memberCount,
          description: s.description,
          my_role: s.myRole ?? null,
        }));

        return successResponse({ spaces });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse('INTERNAL_ERROR', message);
      }
    },
  );
}
