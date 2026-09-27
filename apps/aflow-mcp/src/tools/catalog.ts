/**
 * catalog tool — two-phase operation discovery.
 *
 * Phase 1 (no step_types): lightweight overview of available step types.
 * Phase 2 (step_types provided): detailed operation schemas for selected types.
 *
 * Internally runs `catalog.tool.list` through the mcp-runner agent.
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

/**
 * Coerce a stringified JSON array into an actual array.
 * LLMs frequently pass `"[\"ai\"]"` instead of `["ai"]` for array params.
 */
function coerceStringArray(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      const parsed: unknown = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON — fall through to normal validation
    }
  }
  return val;
}

const CatalogInputSchema = z.object({
  space_id: z
    .string()
    .min(1)
    .describe('Space ID to operate in (required). Call space_list to discover spaces.'),
  step_types: z
    .preprocess(coerceStringArray, z.array(z.string()))
    .optional()
    .describe(
      'Step types to get detailed schemas for (e.g. ["ai", "memory"]). ' +
        'Omit for a lightweight overview of all available step types.',
    ),
});

export function registerCatalogTool(
  server: McpServer,
  sessionRunner: SessionRunner,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
): void {
  server.registerTool(
    'catalog',
    {
      title: 'catalog',
      description:
        'Discover available operations on the Aflow platform. ' +
        'Call with no arguments to see an overview of step types. ' +
        'Call with step_types to get detailed operation schemas (inputs, outputs, usage hints). ' +
        'Use this before run_operation or start_session to understand what operations exist.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: CatalogInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = CatalogInputSchema.parse(args);

        let spaceId: string;
        try {
          spaceId = spaceGate.resolve(input.space_id);
        } catch (err) {
          if (err instanceof SpaceRequiredError) {
            return errorResponse(err.code, err.message, err.hint);
          }
          throw err;
        }

        const isPhase2 = input.step_types && input.step_types.length > 0;

        log('info', 'tool_call', {
          tool: 'catalog',
          session: session.id,
          space_id: spaceId,
          phase: isPhase2 ? 2 : 1,
          step_types: input.step_types,
        });

        const operationInput: Record<string, unknown> = isPhase2
          ? { stepTypes: input.step_types, includeUsageHints: true }
          : { summaryOnly: true };

        const startTime = Date.now();

        const result = await sessionRunner.run(session, {
          spaceId,
          operationId: 'catalog.tool.list',
          input: operationInput,
        });

        log('info', 'tool_complete', {
          tool: 'catalog',
          session: session.id,
          session_id: result.sessionId,
          status: result.status,
          duration_ms: Date.now() - startTime,
        });

        if (result.status !== 'SUCCEEDED') {
          return errorResponse(
            'CATALOG_FAILED',
            result.error ?? `Catalog lookup failed with status ${result.status}`,
            'The catalog.tool.list operation failed. Check that the platform is running.',
          );
        }

        if (!isPhase2) {
          return successResponse(
            {
              ...formatPhase1(result.output),
              session_id: result.sessionId,
            },
            'Call catalog with step_types to get detailed operation schemas.',
          );
        }

        return successResponse({
          ...(result.output as Record<string, unknown>),
          session_id: result.sessionId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', { tool: 'catalog', session: session.id, error: message });
        return errorResponse('CATALOG_ERROR', message);
      }
    },
  );
}

/**
 * Transform full catalog output into a lightweight Phase 1 overview
 * showing step types with operation counts and descriptions.
 */
function formatPhase1(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object') {
    return { step_types: [], hint: 'Call catalog with step_types for details.' };
  }

  const catalog = output as Record<string, unknown>;

  // The catalog.tool.list response may already have stepTypes summary or raw operations.
  // If it has a `stepTypes` array, pass through. Otherwise aggregate from operations.
  if (Array.isArray(catalog['stepTypes'])) {
    return {
      step_types: catalog['stepTypes'],
      hint: 'Call catalog with step_types to get detailed operation schemas.',
    };
  }

  // Aggregate from operations array if present
  const operations = catalog['operations'];
  if (Array.isArray(operations)) {
    const groups = new Map<string, { count: number; description: string }>();

    for (const op of operations) {
      const o = op as Record<string, unknown>;
      const stepType = (o['stepType'] as string) ?? 'unknown';
      const existing = groups.get(stepType);
      if (existing) {
        existing.count++;
      } else {
        groups.set(stepType, {
          count: 1,
          description: (o['groupDescription'] as string) ?? stepType,
        });
      }
    }

    const stepTypes = [...groups.entries()].map(([stepType, info]) => ({
      step_type: stepType,
      description: info.description,
      operation_count: info.count,
    }));

    return {
      step_types: stepTypes,
      hint: 'Call catalog with step_types to get detailed operation schemas.',
    };
  }

  return {
    ...catalog,
    hint: 'Call catalog with step_types to get detailed operation schemas.',
  };
}
