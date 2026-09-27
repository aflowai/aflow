import { and, eq } from 'drizzle-orm';
import type { McpBindingGetOutput, McpBindingListOutput, McpServerBinding } from '@aflow/schemas';
import {
  createTenantContext,
  getDatabase,
  mcpServerBindings,
  withTenantSchema,
} from '@aflow/database';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

/**
 * Project a tenant-DB row into the public `McpServerBinding` shape. The DB
 * row stores `scopeJson` as a json blob and timestamps as Date; the schema
 * expects `scope: { tenantId, spaceId?, flowId? }` and ISO strings.
 */
function rowToBinding(row: typeof mcpServerBindings.$inferSelect): McpServerBinding {
  const scope = (row.scopeJson ?? {}) as Record<string, unknown>;
  const tenantId = typeof scope['tenantId'] === 'string' ? scope['tenantId'] : '';
  const spaceIdInScope = typeof scope['spaceId'] === 'string' ? scope['spaceId'] : undefined;
  const flowId = typeof scope['flowId'] === 'string' ? scope['flowId'] : undefined;
  const cachedTools = Array.isArray(row.cachedTools)
    ? (row.cachedTools as McpServerBinding['cachedTools'])
    : undefined;
  const sessionMetadata =
    row.sessionMetadataJson && typeof row.sessionMetadataJson === 'object'
      ? (row.sessionMetadataJson as McpServerBinding['sessionMetadata'])
      : undefined;
  return {
    bindingId: row.bindingId,
    serverId: row.serverId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    scope: {
      tenantId,
      ...(spaceIdInScope ? { spaceId: spaceIdInScope } : {}),
      ...(flowId ? { flowId } : {}),
    },
    auth: row.authJson as McpServerBinding['auth'],
    connectionPolicy:
      (row.connectionPolicyJson as McpServerBinding['connectionPolicy'] | undefined) ??
      ({} as McpServerBinding['connectionPolicy']),
    ...(row.pinnedOrigin ? { pinnedOrigin: row.pinnedOrigin } : {}),
    ...(cachedTools ? { cachedTools } : {}),
    ...(row.cachedToolsAt ? { cachedToolsAt: new Date(row.cachedToolsAt).toISOString() } : {}),
    subscribeListChanged: row.subscribeListChanged === 1,
    samplingPolicy: row.samplingPolicy as McpServerBinding['samplingPolicy'],
    ownerScope: row.ownerScope as McpServerBinding['ownerScope'],
    clientScope: row.clientScope as McpServerBinding['clientScope'],
    ...(sessionMetadata ? { sessionMetadata } : {}),
    enabled: row.enabled === 1,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function handleMcpBindingAdminInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();
  const op = args.stepDef.operation;

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;
    const input = ((await readInlineOpInput(args)) ?? {}) as Record<string, unknown>;

    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);

    if (op === 'mcp.binding.get') {
      const bindingId = input['bindingId'];
      if (typeof bindingId !== 'string' || bindingId.length === 0) {
        await emitStepError(
          args,
          'MCP_BINDING_GET_INVALID_INPUT',
          'mcp.binding.get requires { bindingId: string }',
          startTime,
          'validation',
        );
        return;
      }

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(mcpServerBindings)
          .where(
            and(eq(mcpServerBindings.bindingId, bindingId), eq(mcpServerBindings.spaceId, spaceId)),
          )
          .limit(1);
      });

      // Strict space-only — defense-in-depth on top of the composite-PK SQL
      // filter, mirroring api.binding.get.
      const row = rows.find((r) => {
        const scope = (r.scopeJson ?? {}) as Record<string, unknown>;
        return (scope['spaceId'] as string | undefined) === spaceId;
      });

      const output: McpBindingGetOutput = {
        binding: row ? rowToBinding(row) : null,
      };
      logger.info(`[mcp.binding.get] bindingId="${bindingId}" found=${String(row !== undefined)}`);
      await emitStepSuccess(args, output, startTime);
      return;
    }

    if (op === 'mcp.binding.list') {
      const filterServerId = typeof input['serverId'] === 'string' ? input['serverId'] : undefined;
      const filterEnabled = typeof input['enabled'] === 'boolean' ? input['enabled'] : undefined;

      const allRows = await withTenantSchema(db, tenantCtx, async (tx) => {
        const conditions = [eq(mcpServerBindings.spaceId, spaceId)];
        if (filterServerId) conditions.push(eq(mcpServerBindings.serverId, filterServerId));
        if (filterEnabled !== undefined) {
          conditions.push(eq(mcpServerBindings.enabled, filterEnabled ? 1 : 0));
        }
        return tx
          .select()
          .from(mcpServerBindings)
          .where(and(...conditions));
      });

      // Strict space-only filter (mirrors api.binding.list).
      const rows = allRows.filter((r) => {
        const scope = (r.scopeJson ?? {}) as Record<string, unknown>;
        return (scope['spaceId'] as string | undefined) === spaceId;
      });

      const output: McpBindingListOutput = {
        bindings: rows.map(rowToBinding),
      };
      logger.info(`[mcp.binding.list] count=${String(rows.length)}`);
      await emitStepSuccess(args, output, startTime);
      return;
    }

    await emitStepError(
      args,
      'MCP_BINDING_ADMIN_UNROUTED',
      `mcpBindingAdmin handler invoked with unsupported op "${op}"`,
      startTime,
      'internal',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(
      args,
      'MCP_BINDING_ADMIN_FAILED',
      `${op} failed: ${message}`,
      startTime,
      'internal',
    );
  }
}
