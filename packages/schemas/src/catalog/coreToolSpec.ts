import { getOperation } from './registry.js';
import { pruneSchemaForAgent } from './compactFormat.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';
import { buildVirtualToolSpec } from '../runtime/agentTurn.js';
import type { AgentToolSpec } from '../runtime/agentTurn.js';

/**
 * Build the `AgentToolSpec` for one core platform operation, exactly as the
 * turn assembler does.
 *
 * Shared rather than inlined at the call site: the context-budget scanner has
 * to report what actually goes on the wire, and a second copy of the
 * internal-field strip or the prune step would let the reported figure drift
 * from the emitted one — which is the single failure the scanner exists to
 * prevent.
 *
 * Returns `undefined` for an operation that is unknown, internal, or not
 * exposed as an agent tool; callers skip those.
 */
export function buildCoreToolSpec(operationId: string): AgentToolSpec | undefined {
  const op = getOperation(operationId);
  if (!op || op.internal || !op.agentTool) return undefined;

  const fullSchema = toJsonSchemaSync(op.inputZod) as Record<string, unknown>;

  // Internal inputs are resolved by the platform and never composed by the
  // model, so they come out before pruning rather than after — leaving them in
  // would price fields the model never sees.
  if (op.internalFields?.input) {
    const internal = op.internalFields.input;
    const props = fullSchema['properties'] as Record<string, unknown> | undefined;
    if (props) {
      for (const field of internal) delete props[field];
    }
    const required = fullSchema['required'] as string[] | undefined;
    if (required) {
      fullSchema['required'] = required.filter((r) => !internal.includes(r));
    }
  }

  // Rare sub-objects are collapsed to a described `object`, which keeps the
  // argument sendable while dropping the nested shape from every turn. Safe
  // because `pruneSchemaForAgent` strips `additionalProperties` at every level,
  // so an emitted schema that omits a property still ACCEPTS it, and dispatch
  // validates against `inputZod` regardless. The full shape stays one
  // `catalog.tool.list` call away.
  if (op.agentCollapsedFields) {
    const props = fullSchema['properties'] as Record<string, unknown> | undefined;
    if (props) {
      for (const [field, replacement] of Object.entries(op.agentCollapsedFields)) {
        if (props[field] === undefined) {
          // A typo here used to vanish: the field stayed fully expanded and the
          // budget silently kept paying for it. Throwing makes a rename in the
          // Zod schema fail loudly at the first scan or turn assembly instead.
          throw new Error(
            `agentCollapsedFields names "${field}" on ${operationId}, which is not a property of its input schema`,
          );
        }
        props[field] =
          typeof replacement === 'string'
            ? { type: 'object', description: replacement }
            : replacement;
      }
    }
  }

  return buildVirtualToolSpec({
    operationId,
    stepType: op.stepType,
    name: op.name,
    description: op.semanticDescription,
    inputSchema: pruneSchemaForAgent(fullSchema),
    source: 'core',
  });
}
