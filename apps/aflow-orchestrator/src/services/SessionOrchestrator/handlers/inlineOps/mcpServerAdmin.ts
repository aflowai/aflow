import type { z } from 'zod';
import {
  McpBindingDeleteInputSchema,
  McpBindingUpsertInputSchema,
  McpServerDeleteInputSchema,
  McpServerGetInputSchema,
  McpServerListInputSchema,
  McpServerUpsertInputSchema,
  type McpBindingDeleteOutput,
  type McpBindingUpsertOutput,
  type McpServerDeleteOutput,
  type McpServerGetOutput,
  type McpServerListOutput,
  type McpServerUpsertOutput,
} from '@aflow/schemas';
import { getDatabase } from '@aflow/database';
import {
  deleteMcpServerBinding,
  deleteMcpServerDefinition,
  getMcpServerDefinitionRow,
  IntegrationHostPolicyError,
  listMcpServerDefinitionRows,
  McpBindingOriginNotPinnedError,
  mcpServerDefinitionFromRow,
  upsertMcpServerBinding,
  upsertMcpServerDefinition,
  type McpIntegrationAdminScope,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError, emitStepSuccess } from './helpers.js';
import { readInlineInput } from './readInlineInput.js';
import { requireSpaceId } from './spaceScope.js';
import { logOrchestratorError } from '../../../../lib/orchestratorLogger.js';

/** The operations this handler runs; `mcp.binding.get` / `list` are `mcpBindingAdmin.ts`'s. */
export const MCP_SERVER_ADMIN_OPERATION_IDS: readonly string[] = [
  'mcp.server.upsert',
  'mcp.server.get',
  'mcp.server.list',
  'mcp.server.delete',
  'mcp.binding.upsert',
  'mcp.binding.delete',
];

class McpAdminInputError extends Error {}

function parseInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  op: string,
  input: Record<string, unknown>,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new McpAdminInputError(
      `Invalid ${op} input: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

function statedKeysOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/**
 * The fields of `parsed` the caller sent, read off the raw input. Parsing
 * fills every omitted field with its schema default — right for a new row,
 * wrong for an existing one — so an update writes only these. The upserts are
 * registered `inputAsSent`, which is what keeps step input resolution from
 * handing this handler the default-filled value in place of the raw one.
 */
function statedFieldsOf<T extends object>(raw: unknown, parsed: T): ReadonlySet<keyof T> {
  return new Set(statedKeysOf(raw).filter((key) => key in parsed) as Array<keyof T>);
}

/**
 * The fields to write: the ones sent, plus the ones named in `clear`. A
 * cleared field is absent from the written value, so stating it makes the
 * update remove what is stored. Giving a field a value and clearing it in the
 * same call is refused, since it cannot do both.
 */
function statedWithCleared<T extends object, F extends keyof T & string>(
  op: string,
  raw: Record<string, unknown>,
  parsed: T,
  clear: readonly F[] | undefined,
): { fields: ReadonlySet<keyof T>; cleared: F[] } {
  const cleared = [...new Set(clear ?? [])];
  const conflicting = cleared.filter((field) => parsed[field] !== undefined);
  if (conflicting.length > 0) {
    throw new McpAdminInputError(
      `${op} was given a value for ${conflicting.join(', ')} and also named it in clear. ` +
        'Send the value to replace the stored one, or name the field in clear to remove it — not both.',
    );
  }
  return { fields: new Set([...statedFieldsOf(raw, parsed), ...cleared]), cleared };
}

/** A delete naming a row the space does not hold — a failure, so agent loop guards count a repeat. */
class McpAdminNotFoundError extends Error {
  constructor(
    readonly code: 'MCP_SERVER_NOT_FOUND' | 'MCP_BINDING_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The run's space is the authority for where a row lives. A stated `spaceId`
 * naming another space is refused rather than silently written here.
 */
function assertRunSpace(stated: string | undefined, spaceId: string, op: string): void {
  if (stated !== undefined && stated !== spaceId) {
    throw new McpAdminInputError(
      `${op} was given spaceId "${stated}", but this run belongs to space "${spaceId}". ` +
        `MCP servers and bindings are written to the run's own space — pass that spaceId.`,
    );
  }
}

async function runOp(
  op: string,
  input: Record<string, unknown>,
  scope: McpIntegrationAdminScope,
): Promise<Record<string, unknown>> {
  const { spaceId, tenantId } = scope;
  switch (op) {
    case 'mcp.server.upsert': {
      const {
        spaceId: statedSpaceId,
        clear,
        ...definition
      } = parseInput(McpServerUpsertInputSchema, op, input);
      assertRunSpace(statedSpaceId, spaceId, op);
      const { fields, cleared } = statedWithCleared(op, input, definition, clear);
      const { created } = await upsertMcpServerDefinition({
        ...scope,
        definition,
        statedFields: fields,
      });
      const output: McpServerUpsertOutput = {
        serverId: definition.serverId,
        spaceId,
        created,
        cleared,
      };
      return output;
    }
    case 'mcp.server.get': {
      const parsed = parseInput(McpServerGetInputSchema, op, input);
      assertRunSpace(parsed.spaceId, spaceId, op);
      const row = await getMcpServerDefinitionRow({ ...scope, serverId: parsed.serverId });
      const output: McpServerGetOutput = {
        definition: row ? mcpServerDefinitionFromRow(row) : null,
      };
      return output;
    }
    case 'mcp.server.list': {
      const parsed = parseInput(McpServerListInputSchema, op, input);
      assertRunSpace(parsed.spaceId, spaceId, op);
      const rows = await listMcpServerDefinitionRows({
        ...scope,
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      });
      const output: McpServerListOutput = { definitions: rows.map(mcpServerDefinitionFromRow) };
      return output;
    }
    case 'mcp.server.delete': {
      const parsed = parseInput(McpServerDeleteInputSchema, op, input);
      assertRunSpace(parsed.spaceId, spaceId, op);
      // Checked first so a wrong id deletes nothing: the cascade would still
      // sweep bindings and tokens left keyed to a serverId with no definition.
      if ((await getMcpServerDefinitionRow({ ...scope, serverId: parsed.serverId })) === null) {
        throw new McpAdminNotFoundError(
          'MCP_SERVER_NOT_FOUND',
          `mcp.server.delete found no MCP server "${parsed.serverId}" in space "${spaceId}"; ` +
            'nothing was deleted. List the servers with mcp.server.list to find the serverId.',
        );
      }
      await deleteMcpServerDefinition({ ...scope, serverId: parsed.serverId });
      const output: McpServerDeleteOutput = { deleted: true };
      return output;
    }
    case 'mcp.binding.upsert': {
      const {
        scope: statedScope = {},
        clear,
        ...binding
      } = parseInput(McpBindingUpsertInputSchema, op, input);
      assertRunSpace(statedScope.spaceId, spaceId, op);
      const { fields, cleared } = statedWithCleared(op, input, binding, clear);
      const statedPolicyKeys = new Set(statedKeysOf(input['connectionPolicy']));
      const connectionPolicy = Object.fromEntries(
        Object.entries(binding.connectionPolicy).filter(([key]) => statedPolicyKeys.has(key)),
      );
      // The tenant and space come from the run; `flowId` is the one narrowing
      // the caller owns, and only a stated one (a flow, or null for space-wide)
      // replaces what an existing row stores.
      const identity = { tenantId, spaceId };
      const {
        created,
        scope: storedScope,
        enabled,
      } = await upsertMcpServerBinding({
        ...scope,
        binding,
        stated: { fields, connectionPolicy },
        scope: statedScope.flowId ? { flowId: statedScope.flowId, ...identity } : identity,
        scopeOnUpdate:
          statedScope.flowId === undefined
            ? null
            : statedScope.flowId === null
              ? identity
              : { flowId: statedScope.flowId, ...identity },
      });
      const storedFlowId = storedScope['flowId'];
      const output: McpBindingUpsertOutput = {
        bindingId: binding.bindingId,
        created,
        scope: {
          ...identity,
          ...(typeof storedFlowId === 'string' && storedFlowId ? { flowId: storedFlowId } : {}),
        },
        enabled,
        cleared,
      };
      return output;
    }
    case 'mcp.binding.delete': {
      const parsed = parseInput(McpBindingDeleteInputSchema, op, input);
      const deleted = await deleteMcpServerBinding({ ...scope, bindingId: parsed.bindingId });
      if (deleted === null) {
        throw new McpAdminNotFoundError(
          'MCP_BINDING_NOT_FOUND',
          `mcp.binding.delete found no MCP binding "${parsed.bindingId}" in space "${spaceId}"; ` +
            'nothing was deleted. List the bindings with mcp.binding.list to find the bindingId.',
        );
      }
      const output: McpBindingDeleteOutput = { deleted: true };
      return output;
    }
    default:
      throw new Error(`mcpServerAdmin handler invoked with unsupported op "${op}"`);
  }
}

export async function handleMcpServerAdminInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const op = args.stepDef.operation;

  try {
    const spaceId = requireSpaceId(args.context);
    const input = await readInlineInput(args, startTime);
    if (!input) return;

    const output = await runOp(op, input, {
      db: getDatabase(),
      tenantId: args.context.tenantId as string,
      spaceId,
      redis: args.redis,
    });
    await emitStepSuccess(args, output, startTime);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof IntegrationHostPolicyError) {
      await emitStepError(
        args,
        'INTEGRATION_HOST_NOT_ALLOWED',
        message,
        startTime,
        'validation',
        false,
        { deniedHosts: err.denial.deniedHosts },
      );
      return;
    }
    if (err instanceof McpBindingOriginNotPinnedError) {
      await emitStepError(args, 'MCP_BINDING_ORIGIN_NOT_PINNED', message, startTime, 'validation');
      return;
    }
    if (err instanceof McpAdminNotFoundError) {
      await emitStepError(args, err.code, message, startTime, 'validation', false);
      return;
    }
    if (err instanceof McpAdminInputError) {
      await emitStepError(args, 'MCP_ADMIN_INVALID_INPUT', message, startTime, 'validation');
      return;
    }
    logOrchestratorError(`[${op}] failed`, err, {
      operationId: op,
      tenantId: args.context.tenantId,
    });
    await emitStepError(args, 'MCP_ADMIN_OP_FAILED', `${op} failed: ${message}`, startTime);
  }
}
