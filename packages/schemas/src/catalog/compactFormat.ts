import type { JsonSchemaObject, OperationCatalogEntry } from './operationCatalog.js';
import { getStepTypeDescription } from './stepTypeDescriptions.js';

// ============================================================================
// Schema Pruning (Phase 0 — remove agent-irrelevant boilerplate)
// ============================================================================

/**
 * Strip boilerplate from a JSON Schema for agent consumption.
 * Removes $schema URI, additionalProperties, and redundant leaf descriptions.
 */
export function pruneSchemaForAgent(schema: JsonSchemaObject): JsonSchemaObject {
  const result: JsonSchemaObject = {};

  for (const [key, value] of Object.entries(schema)) {
    // Strip $schema URI — agent doesn't need meta-schema identifier
    if (key === '$schema') continue;
    // Strip additionalProperties — validation constraint, not agent-relevant
    if (key === 'additionalProperties') continue;

    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props = value as Record<string, JsonSchemaObject>;
      const pruned: Record<string, JsonSchemaObject> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        pruned[propName] = prunePropertySchema(propName, propSchema);
      }
      result.properties = pruned;
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      result.items = pruneSchemaForAgent(value as JsonSchemaObject);
    } else if ((key === 'allOf' || key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      result[key] = (value as JsonSchemaObject[]).map((s) => pruneSchemaForAgent(s));
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Prune a single property schema — remove description if it just
 * restates the property name, remove defaults.
 */
function prunePropertySchema(propName: string, schema: JsonSchemaObject): JsonSchemaObject {
  const result = pruneSchemaForAgent(schema);

  // Remove description if it's just restating the property name
  if (result.description && isRedundantDescription(propName, result.description)) {
    delete result.description;
  }

  return result;
}

/**
 * Check if a property description is redundant given the property name.
 * E.g., "model" with description "The AI model to use" is redundant.
 */
function isRedundantDescription(propName: string, description: string): boolean {
  const lower = description.toLowerCase();
  const nameLower = propName.toLowerCase();

  // Short descriptions that just restate the name
  if (lower.length < 40) {
    // "The model", "Model to use", "The model identifier"
    const nameWords = nameLower.replace(/([A-Z])/g, ' $1').split(/[_\s]+/);
    const descWords = lower.split(/\s+/);
    const nameWordsInDesc = nameWords.filter((w) =>
      descWords.some((d) => d.includes(w) || w.includes(d)),
    );
    // If most name words appear in the description and it's short, it's redundant
    if (nameWordsInDesc.length >= nameWords.length * 0.5 && descWords.length <= 8) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Compact Format (Phase 1 — markdown-based, ~30-50 tokens per operation)
// ============================================================================

/**
 * Build a TypeScript-like parameter signature from a JSON Schema.
 * E.g., "model (string), messages (array, required), temperature? (number, 0-2)"
 *
 * @param excludeFields - field names to omit (e.g., orchestrator-managed internal fields)
 */
export function buildParamSignature(
  inputSchema: JsonSchemaObject,
  excludeFields?: Set<string>,
): string {
  const properties = inputSchema.properties;
  if (!properties) return '';

  const required = new Set(inputSchema.required ?? []);
  const params: string[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    if (excludeFields?.has(name)) continue;

    const isRequired = required.has(name);
    const parts: string[] = [];

    // Parameter name (with ? for optional)
    parts.push(isRequired ? name : `${name}?`);

    // Type info
    const typeStr = getCompactType(prop);
    if (typeStr) {
      parts.push(`(${typeStr})`);
    }

    params.push(parts.join(' '));
  }

  return params.join(', ');
}

/**
 * Expand a union (anyOf/oneOf) into a readable type string.
 * For discriminated unions (each variant has a `type` const), show the discriminator values.
 * For small unions, show each variant's structure.
 */
function expandUnionType(variants: JsonSchemaObject[]): string {
  // Check if it's a discriminated union on `type` field
  const discriminatorValues: string[] = [];
  for (const v of variants) {
    const typeConst = v.properties?.['type']?.const;
    if (typeof typeConst === 'string') {
      discriminatorValues.push(typeConst);
    }
  }

  // Discriminated union — show each variant with its key fields
  if (discriminatorValues.length === variants.length && discriminatorValues.length > 0) {
    const parts = variants.map((v) => {
      const typeConstRaw = v.properties?.['type']?.const;
      const typeConst = typeof typeConstRaw === 'string' ? typeConstRaw : '';
      const otherKeys = Object.keys(v.properties ?? {}).filter((k) => k !== 'type');
      if (otherKeys.length > 0 && otherKeys.length <= 4) {
        return `{type: "${typeConst}", ${otherKeys.join(', ')}}`;
      }
      return `{type: "${typeConst}"}`;
    });
    return parts.join(' | ');
  }

  // Simple type union — show types inline
  const typeStrings = variants.map((v) => getCompactType(v)).filter(Boolean);
  if (typeStrings.length > 0 && typeStrings.length <= 4) {
    return typeStrings.join(' | ');
  }

  return 'union';
}

/**
 * Build a compact type representation from a JSON Schema.
 *
 * @param depth - Current recursion depth. Controls how much detail is shown:
 *   - depth 0 (top-level params): show typed fields `{key: type, key?: type}`
 *   - depth 1 (nested objects): show required fields with types, optional as names only
 *   - depth ≥2: show key names only `{key, key}` to bound output size
 *   Discriminated unions and enums are always expanded regardless of depth.
 */
function getCompactType(schema: JsonSchemaObject, depth = 0): string {
  // Enum values — always show all values so agents never hallucinate invalid ones
  if (schema.enum && Array.isArray(schema.enum)) {
    return schema.enum.map((v) => String(v)).join('|');
  }

  const type = schema.type as string | undefined;
  if (!type) {
    // Union types — expand discriminated unions to show variant structures
    const variants = schema.anyOf ?? schema.oneOf;
    if (variants && Array.isArray(variants)) {
      return expandUnionType(variants);
    }
    if (schema.allOf) return 'object';
    return '';
  }

  if (type === 'object') {
    const props = schema.properties;
    if (!props) return 'object';

    const keys = Object.keys(props);
    if (keys.length === 0) return 'object';

    const requiredSet = new Set(schema.required ?? []);
    const requiredKeys = keys.filter((k) => requiredSet.has(k));
    const optionalKeys = keys.filter((k) => !requiredSet.has(k));

    // depth 0: show all fields with types {name: string, items: {id: string, ...}[]}
    if (depth === 0 && keys.length <= 8) {
      const fields = keys.map((k) => {
        const suffix = requiredSet.has(k) ? '' : '?';
        const propType = getCompactType(props[k]!, depth + 1);
        return propType ? `${k}${suffix}: ${propType}` : `${k}${suffix}`;
      });
      return `{${fields.join(', ')}}`;
    }

    // depth 0, many keys: show required fields with types, then summarize optional count
    if (depth === 0 && requiredKeys.length > 0) {
      const reqFields = requiredKeys.map((k) => {
        const propType = getCompactType(props[k]!, depth + 1);
        return propType ? `${k}: ${propType}` : k;
      });
      const optSuffix = optionalKeys.length > 0 ? `, +${String(optionalKeys.length)} optional` : '';
      return `{${reqFields.join(', ')}${optSuffix}}`;
    }

    // depth 1: show required fields with types, optional as key names only.
    // This is the key improvement — nested object[] items now reveal their structure
    // (e.g., endpoints: {endpointId: string, name: string, method: enum, ...}[])
    if (depth === 1) {
      if (requiredKeys.length > 0 && keys.length <= 10) {
        const fields = keys.map((k) => {
          const propSchema = props[k]!;
          const suffix = requiredSet.has(k) ? '' : '?';
          // Required fields and enums/unions get types; optional fields get names only
          if (requiredSet.has(k) || propSchema.enum || propSchema.anyOf || propSchema.oneOf) {
            const propType = getCompactType(propSchema, depth + 1);
            return propType ? `${k}${suffix}: ${propType}` : `${k}${suffix}`;
          }
          return `${k}${suffix}`;
        });
        return `{${fields.join(', ')}}`;
      }
      // Many keys at depth 1: show required with types + optional count
      if (requiredKeys.length > 0) {
        const reqFields = requiredKeys.map((k) => {
          const propType = getCompactType(props[k]!, depth + 1);
          return propType ? `${k}: ${propType}` : k;
        });
        const optSuffix =
          optionalKeys.length > 0 ? `, +${String(optionalKeys.length)} optional` : '';
        return `{${reqFields.join(', ')}${optSuffix}}`;
      }
    }

    // depth ≥2 or no required keys: show key names with ? for optional,
    // but still expand discriminated unions and enums since those are critical
    if (keys.length <= 6) {
      const fields = keys.map((k) => {
        const propSchema = props[k]!;
        const suffix = requiredSet.has(k) ? '' : '?';
        // Always expand enums and discriminated unions — they're the most error-prone
        const variants = propSchema.anyOf ?? propSchema.oneOf;
        const hasEnum = propSchema.enum && Array.isArray(propSchema.enum);
        if (variants || hasEnum) {
          const propType = getCompactType(propSchema, depth + 1);
          return propType ? `${k}${suffix}: ${propType}` : `${k}${suffix}`;
        }
        return `${k}${suffix}`;
      });
      return `{${fields.join(', ')}}`;
    }

    return 'object';
  }
  if (type === 'array') {
    const items = schema.items;
    if (items) {
      const itemType = getCompactType(items, depth + 1);
      return itemType ? `${itemType}[]` : 'array';
    }
    return 'array';
  }
  if (type === 'integer' || type === 'number') {
    const constraints: string[] = [type === 'integer' ? 'int' : 'number'];
    if (schema.minimum !== undefined && schema.maximum !== undefined) {
      constraints.push(`${String(schema.minimum)}-${String(schema.maximum)}`);
    }
    return constraints.length > 1 ? constraints.join(', ') : constraints[0]!;
  }
  if (type === 'string') {
    if (typeof schema.maxLength === 'number') {
      return `string ≤${String(schema.maxLength)}`;
    }
    return 'string';
  }

  return type;
}

/**
 * Build a single compact catalog entry as markdown text.
 */
export function buildCompactEntry(op: OperationCatalogEntry): string {
  // Description: oneLine, or first whenToUse if available
  const desc = op.usage.oneLine;

  // Params — exclude internal fields (orchestrator-managed)
  const excludeFields = op.internalFields?.input ? new Set(op.internalFields.input) : undefined;
  const params = buildParamSignature(op.inputSchema, excludeFields);

  // Example input (from existing minimalExampleInput on every operation)
  const hasExample =
    op.usage.minimalExampleInput && Object.keys(op.usage.minimalExampleInput).length > 0;

  // Base line: when example is present, put example + params on indented lines
  let line: string;
  if (hasExample) {
    const exampleJson = JSON.stringify(op.usage.minimalExampleInput);
    line = `- **${op.operationId}** — ${desc}\n  Example: ${exampleJson}${params ? `\n  Params: ${params}` : ''}`;
  } else {
    line = `- **${op.operationId}** — ${desc}${params ? ` Params: ${params}` : ''}`;
  }

  // Critical pitfall (only the first one, if it exists)
  if (op.usage.pitfalls && op.usage.pitfalls.length > 0) {
    const topPitfall = op.usage.pitfalls[0]!;
    // Only include if it's genuinely important (not just "see docs")
    if (topPitfall.length > 10) {
      line += `\n  ⚠️ ${topPitfall}`;
    }
  }

  // Non-idempotent warning for destructive ops
  if (op.idempotency === 'non_idempotent' && !line.includes('idempotent')) {
    // Only add if not already mentioned in pitfalls
    const hasDeleteVerb = op.verb === 'delete' || op.verb === 'remove';
    if (hasDeleteVerb) {
      line += ' (not idempotent)';
    }
  }

  return line;
}

/**
 * Build the full compact catalog as markdown text, grouped by step type.
 */
export function buildCompactCatalog(operations: OperationCatalogEntry[]): string {
  // Group by stepType
  const groups = new Map<string, OperationCatalogEntry[]>();
  for (const op of operations) {
    const existing = groups.get(op.stepType);
    if (existing) {
      existing.push(op);
    } else {
      groups.set(op.stepType, [op]);
    }
  }

  // Count step types for header
  const stepTypeNames = [...groups.keys()].sort();
  const header = `## Available Operations (${String(operations.length)} operations across ${stepTypeNames.join(', ')})`;

  const sections: string[] = [header, ''];

  for (const stepType of stepTypeNames) {
    const ops = groups.get(stepType)!;
    sections.push(`### ${stepType}`);
    for (const op of ops) {
      sections.push(buildCompactEntry(op));
    }
    sections.push('');
  }

  // Add usage guidance
  sections.push(
    '> **Param notation**: `name` = required, `name?` = optional, `(a|b|c)` = enum values.',
    '> To get full input schemas: call `catalog.tool.list` with specific `operationIds`.',
    '> To discover other step types: call `catalog.tool.list` with no filters.',
  );

  return sections.join('\n');
}

// ============================================================================
// Detailed catalog format (full pruned JSON schemas per operation)
// ============================================================================

/**
 * Strip internal (orchestrator-managed) fields from an operation's input schema.
 */
function stripInternalFields(schema: JsonSchemaObject, internalFields: string[]): JsonSchemaObject {
  const properties = schema.properties;
  if (!properties) return schema;

  const filtered = { ...properties };
  for (const field of internalFields) {
    delete filtered[field];
  }
  const originalRequired = schema.required ?? [];
  const filteredRequired = originalRequired.filter((r) => !internalFields.includes(r));

  return {
    ...schema,
    properties: filtered,
    ...(filteredRequired.length > 0 ? { required: filteredRequired } : {}),
  } as JsonSchemaObject;
}

/**
 * Build a detailed catalog entry as markdown with full pruned JSON schema.
 */
function buildDetailedEntry(op: OperationCatalogEntry): string {
  let inputSchema = op.inputSchema;

  // Strip internal fields
  if (op.internalFields?.input) {
    inputSchema = stripInternalFields(inputSchema, op.internalFields.input);
  }

  // Prune boilerplate
  inputSchema = pruneSchemaForAgent(inputSchema);

  const lines: string[] = [];
  lines.push(`#### \`${op.operationId}\``);
  lines.push(op.semanticDescription);

  // Usage hints
  if (op.usage.whenToUse.length > 0) {
    lines.push(`**When to use:** ${op.usage.whenToUse.join('; ')}`);
  }
  if (op.usage.pitfalls && op.usage.pitfalls.length > 0) {
    for (const pitfall of op.usage.pitfalls) {
      if (pitfall.length > 10) {
        lines.push(`⚠️ ${pitfall}`);
      }
    }
  }
  if (op.idempotency === 'non_idempotent') {
    lines.push('⚠️ Not idempotent — calling this twice may produce duplicate effects.');
  }

  // Example input (from minimalExampleInput on every operation)
  if (op.usage.minimalExampleInput && Object.keys(op.usage.minimalExampleInput).length > 0) {
    lines.push(`**Example:** \`${JSON.stringify(op.usage.minimalExampleInput)}\``);
  }

  // Input schema as JSON
  lines.push('**Input schema:**');
  lines.push('```json');
  lines.push(JSON.stringify(inputSchema, null, 2));
  lines.push('```');

  return lines.join('\n');
}

/**
 * Build a detailed catalog as markdown, with full pruned JSON schemas per operation.
 * More expensive on tokens than compact (~200-500 tokens/op) but eliminates
 * the need for agents to call `catalog.tool.list` for schema details.
 */
export function buildDetailedCatalog(operations: OperationCatalogEntry[]): string {
  // Group by stepType
  const groups = new Map<string, OperationCatalogEntry[]>();
  for (const op of operations) {
    const existing = groups.get(op.stepType);
    if (existing) {
      existing.push(op);
    } else {
      groups.set(op.stepType, [op]);
    }
  }

  const stepTypeNames = [...groups.keys()].sort();
  const header = `## Available Operations — Detailed (${String(operations.length)} operations across ${stepTypeNames.join(', ')})`;

  const sections: string[] = [header, ''];

  for (const stepType of stepTypeNames) {
    const ops = groups.get(stepType)!;
    sections.push(`### ${stepType}`);
    for (const op of ops) {
      sections.push(buildDetailedEntry(op));
      sections.push('');
    }
  }

  sections.push(
    '> Full input schemas are shown above. For more operations: `catalog.tool.search` (intent) or `catalog.tool.list` (filters).',
  );

  return sections.join('\n');
}

// ============================================================================
// Summary catalog format (operation IDs + one-liners, agent pulls details on-demand)
// ============================================================================

/**
 * Build a summary catalog: operation IDs + one-line descriptions, grouped by stepType.
 * Lightweight menu (~2K tokens for 100 ops) that tells the agent what's available.
 *
 * When `getSchemaEntry` is set, it should be `catalog.tool.search` or
 * `catalog.tool.list` in detailed form — so the agent sees how to fetch
 * full schemas or run intent search for operations not yet loaded as direct tools.
 */
export function buildSummaryCatalog(
  operations: OperationCatalogEntry[],
  getSchemaEntry?: OperationCatalogEntry,
): string {
  // Group by stepType, then by groupId within each stepType
  const stepTypeGroups = new Map<string, Map<string, OperationCatalogEntry[]>>();
  for (const op of operations) {
    let groups = stepTypeGroups.get(op.stepType);
    if (!groups) {
      groups = new Map();
      stepTypeGroups.set(op.stepType, groups);
    }
    const existing = groups.get(op.groupId);
    if (existing) {
      existing.push(op);
    } else {
      groups.set(op.groupId, [op]);
    }
  }

  const stepTypeNames = [...stepTypeGroups.keys()].sort();

  const sections: string[] = [];

  // Lead with discovery / schema guidance BEFORE the operation list.
  if (getSchemaEntry) {
    sections.push(
      '## How to use operations',
      '',
      '**Core operations** are usually available as direct callable tools (see your tool list).',
      'For operations you have not loaded yet: use **`catalog.tool.search`** with a natural-language `query`, or **`catalog.tool.list`** with filters to get full input schemas before calling.',
      'The menu below is an awareness surface — prefer calling loaded tools directly rather than re-fetching schemas for those.',
      '',
      buildDetailedEntry(getSchemaEntry),
      '',
      '---',
      '',
    );
  }

  // Operation menu
  sections.push(
    `## Available Operations (${String(operations.length)} operations across ${stepTypeNames.join(', ')})`,
    '',
  );

  for (const stepType of stepTypeNames) {
    const groups = stepTypeGroups.get(stepType)!;
    sections.push(`### ${stepType}`);
    for (const [, ops] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const op of ops) {
        // One-liner: operationId + semantic description only
        sections.push(`- **${op.operationId}** — ${op.usage.oneLine ?? op.semanticDescription}`);
      }
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ============================================================================

/**
 * Build an ultra-compact awareness block (~150-200 tokens) for agents that
 * already have coreOperations loaded as native callable tools.
 *
 * Instead of listing every operation one-liner (~2K tokens), this summarizes
 * at the step-type level so the agent knows what's discoverable without
 * wasting context on details it can fetch via `discover`.
 *
 * @param operations - Operations remaining after filtering (excludes core ops)
 * @param coreToolCount - Number of core tools already loaded
 */
export function buildCompactAwareness(
  operations: OperationCatalogEntry[],
  coreToolCount: number,
): string {
  if (operations.length === 0) return '';

  // Group by step type and count
  const byStepType = new Map<string, number>();
  for (const op of operations) {
    byStepType.set(op.stepType, (byStepType.get(op.stepType) ?? 0) + 1);
  }

  const sections: string[] = [];

  sections.push('## Available for Discovery');
  sections.push('');
  sections.push(
    `You have ${String(coreToolCount)} core tool${coreToolCount !== 1 ? 's' : ''} loaded. ` +
      'Additional tools can be discovered:',
  );

  // Sort by step type name for stable output
  const stepTypes = [...byStepType.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [stepType, count] of stepTypes) {
    const desc = getStepTypeDescription(stepType);
    sections.push(`- **${stepType}** (${String(count)} ops): ${desc}`);
  }

  sections.push('');
  sections.push(
    'Search by intent: `catalog.tool.search({ query: "your intent" })`. ' +
      'Browse by type: `catalog.tool.list({ stepTypes: ["<type>"] })`. ' +
      "Both are read-only. Pass the result's `suggestedPromoteCall` to " +
      '`catalog.tool.promote` to add the discovered toolIds to your active toolbox; ' +
      'they then become callable by their `callName` on your next turn.',
  );
  sections.push(
    'Bound integration tools (API endpoints + MCP tools) live alongside platform ' +
      'operations in the unified search — see `SpaceContext.integrations` for the ' +
      'inventory.',
  );

  return sections.join('\n');
}
