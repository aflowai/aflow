/**
 * Catalog export functions.
 *
 * Converts operation descriptors to JSON formats suitable for
 * AI agents and tool calling.
 */
import { createHash } from 'node:crypto';

import type {
  OperationCatalog,
  OperationCatalogEntry,
  ToolCatalog,
  CatalogToolDefinition,
  CatalogFilterOptions,
  JsonSchemaObject,
} from './operationCatalog.js';
import { buildGroupId } from './operationId.js';
import { getAllOperations } from './registry.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';

// ============================================================================
// Helpers
// ============================================================================

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

function deterministicJson(obj: unknown): string {
  return JSON.stringify(obj, sortedReplacer);
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ============================================================================
// Operation Catalog Export
// ============================================================================

/**
 * Generate an OperationCatalog JSON from all operations, optionally filtered.
 */
export function getOperationCatalog(options: CatalogFilterOptions = {}): OperationCatalog {
  const {
    stepTypes,
    groupIds,
    operationIds,
    tags,
    includeOutputSchema = true,
    includeUsageHints = true,
    formatVersion = 1,
  } = options;

  const allOps = getAllOperations();
  const entries: OperationCatalogEntry[] = [];

  for (const [operationId, descriptor] of allOps.entries()) {
    if (descriptor.internal) continue;

    if (operationIds && operationIds.length > 0 && !operationIds.includes(operationId)) {
      continue;
    }

    if (stepTypes && stepTypes.length > 0 && !stepTypes.includes(descriptor.stepType)) {
      continue;
    }

    if (groupIds && groupIds.length > 0) {
      const descGroupId = buildGroupId(descriptor.stepType, descriptor.group);
      if (!groupIds.includes(descGroupId)) {
        continue;
      }
    }

    if (tags && tags.length > 0 && descriptor.tags) {
      const hasMatchingTag = tags.some((tag) => descriptor.tags?.includes(tag));
      if (!hasMatchingTag) {
        continue;
      }
    }

    const inputSchema = toJsonSchemaSync(descriptor.inputZod, {
      draft: 'draft-2020-12',
    }) as JsonSchemaObject;

    let outputSchema: JsonSchemaObject | undefined;
    if (includeOutputSchema && descriptor.outputZod) {
      // Output schemas are informational (shown to agents / UI, never sent to a
      // provider as a strict tool schema), so `$ref` is safe here. Enabling it
      // lets a recursive schema (e.g. a self-referential outline tree) emit a
      // `$ref` instead of collapsing the recursive node to `any` — which is what
      // `$refStrategy: 'none'` does, with a console warning. Input schemas stay
      // ref-free below because those DO reach providers that reject `$ref`.
      outputSchema = toJsonSchemaSync(descriptor.outputZod, {
        draft: 'draft-2020-12',
        definitions: true,
      }) as JsonSchemaObject;
    }

    let stepConfigSchema: JsonSchemaObject | undefined;
    if (descriptor.stepConfigZod) {
      stepConfigSchema = toJsonSchemaSync(descriptor.stepConfigZod, {
        draft: 'draft-2020-12',
      }) as JsonSchemaObject;
    }

    const inputSchemaHash = sha256(deterministicJson(inputSchema));

    const entry: OperationCatalogEntry = {
      operationId,
      stepType: descriptor.stepType,
      group: descriptor.group,
      groupId: buildGroupId(descriptor.stepType, descriptor.group),
      verb: descriptor.verb,
      name: descriptor.name,
      ...(descriptor.actionLabel && { actionLabel: descriptor.actionLabel }),
      semanticDescription: descriptor.semanticDescription,
      inputSchema,
      ...(outputSchema && { outputSchema }),
      ...(stepConfigSchema && { stepConfigSchema }),
      ...(descriptor.tags &&
        descriptor.tags.length > 0 && {
          tags: descriptor.tags,
        }),
      ...(descriptor.crudView && {
        crudView: descriptor.crudView,
      }),
      ...(descriptor.internalFields && {
        internalFields: descriptor.internalFields,
      }),
      idempotency: descriptor.idempotency,
      ...(includeUsageHints ? { usage: descriptor.usage } : { usage: descriptor.usage }),
      inputSchemaHash,
      ...(outputSchema && {
        outputSchemaHash: sha256(deterministicJson(outputSchema)),
      }),
    };

    entries.push(entry);
  }

  entries.sort((a, b) => a.operationId.localeCompare(b.operationId));

  return {
    catalogVersion: formatVersion,
    generatedAt: new Date().toISOString(),
    operations: entries,
  };
}

/**
 * Serialize OperationCatalog to JSON string (deterministic).
 */
export function serializeOperationCatalog(catalog: OperationCatalog): string {
  const sorted = JSON.parse(JSON.stringify(catalog, sortedReplacer)) as OperationCatalog;
  return JSON.stringify(sorted, null, 2);
}

// ============================================================================
// Tool Catalog Export
// ============================================================================

export type ToolCatalogStrictness = 'lenient' | 'strictTopLevel' | 'strictAll';

export interface ToolCatalogOptions extends CatalogFilterOptions {
  strictness?: ToolCatalogStrictness;
}

/**
 * Generate a ToolCatalog JSON from operations (for AI tool calling).
 */
export function getToolCatalog(options: ToolCatalogOptions = {}): ToolCatalog {
  const {
    stepTypes,
    groupIds,
    operationIds,
    tags,
    strictness = 'lenient',
    formatVersion = 1,
  } = options;

  const allOps = getAllOperations();
  const tools: CatalogToolDefinition[] = [];

  for (const [operationId, descriptor] of allOps.entries()) {
    if (descriptor.internal) continue;

    if (operationIds && operationIds.length > 0 && !operationIds.includes(operationId)) {
      continue;
    }

    if (stepTypes && stepTypes.length > 0 && !stepTypes.includes(descriptor.stepType)) {
      continue;
    }

    if (groupIds && groupIds.length > 0) {
      const descGroupId = buildGroupId(descriptor.stepType, descriptor.group);
      if (!groupIds.includes(descGroupId)) {
        continue;
      }
    }

    if (tags && tags.length > 0 && descriptor.tags) {
      const hasMatchingTag = tags.some((tag) => descriptor.tags?.includes(tag));
      if (!hasMatchingTag) {
        continue;
      }
    }

    let inputSchema = toJsonSchemaSync(descriptor.inputZod, {
      draft: 'draft-2020-12',
    }) as JsonSchemaObject;

    if (strictness === 'strictTopLevel' && inputSchema.type === 'object') {
      inputSchema = {
        ...inputSchema,
        additionalProperties: false,
      };
    }

    const description = `${descriptor.semanticDescription} (${descriptor.stepType} operation)`;

    tools.push({
      name: operationId,
      description,
      parameters: inputSchema,
    });
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    catalogVersion: formatVersion,
    generatedAt: new Date().toISOString(),
    tools,
  };
}

/**
 * Serialize ToolCatalog to JSON string (deterministic).
 */
export function serializeToolCatalog(catalog: ToolCatalog): string {
  const sorted = JSON.parse(JSON.stringify(catalog, sortedReplacer)) as ToolCatalog;
  return JSON.stringify(sorted, null, 2);
}
