import {
  ContractErrorSchema,
  getOperation,
  inferTaskType,
  toJsonSchemaSync,
  type WorkflowTask,
  type WorkflowTaskInputBinding,
} from '@aflow/schemas';
import { parseOutputPath } from './outputPath.js';

// ============================================================================
// Types
// ============================================================================

export type BindingStaticSchemaStatus = 'known' | 'undeclared_producer' | 'runtime_untyped';

export interface BindingStaticSchemaResult {
  /** The resolved static JSON Schema. `{}` (accept-all) when not `known`. */
  schema: Record<string, unknown>;
  /**
   * - `known`              — a concrete static shape was resolved.
   * - `undeclared_producer` — a `task_output` binding's producer declares no
   *                           shape for the bound port (the "loose lane").
   * - `runtime_untyped`     — the platform has no static contract for this
   *                           binding (`run_input`) or the producer's output
   *                           can't be statically resolved (op without
   *                           `outputZod`, a path landing on a non-traversable
   *                           node). Presence-checkable, type-unchecked.
   */
  status: BindingStaticSchemaStatus;
}

// ============================================================================
// system_feedback ContractError schema (shared with the assembler)
// ============================================================================

let _contractErrorJsonSchema: Record<string, unknown> | undefined;

/**
 * Lazy JSON Schema for the platform-injected `system_feedback` payload —
 * the SAME `toJsonSchemaSync(ContractErrorSchema)` the assembler computes
 * locally (`assembleWorkflow.contractErrorJsonSchema`). Exported so both the
 * validator and the contract test can reference one copy.
 */
export function contractErrorJsonSchema(): Record<string, unknown> {
  if (!_contractErrorJsonSchema) {
    _contractErrorJsonSchema = toJsonSchemaSync(ContractErrorSchema) as Record<string, unknown>;
  }
  return _contractErrorJsonSchema;
}

// ============================================================================
// Dotted-path traversal (§5.3)
// ============================================================================

export function traverseJsonSchemaPath(
  schema: Record<string, unknown> | undefined,
  path: string,
): Record<string, unknown> | null {
  if (!isSchemaObject(schema)) return null;
  const segments = parseOutputPath(path);
  if (!segments) return null;
  let node: Record<string, unknown> = schema;
  for (const segment of segments) {
    if (segment.kind === 'index') {
      // `[n]` — every element shares the (homogeneous) `items` schema.
      if (!typeIncludes(node, 'array')) return null;
      const items = node['items'];
      if (!isSchemaObject(items)) return null;
      node = items;
      continue;
    }
    // Descend into array items first if the node is an array.
    let container = node;
    if (typeIncludes(node, 'array')) {
      const items = node['items'];
      if (!isSchemaObject(items)) return null;
      container = items;
    }
    const props = container['properties'];
    if (!isSchemaObject(props)) return null;
    const child = props[segment.key];
    if (!isSchemaObject(child)) return null;
    node = child;
  }
  return node;
}

// ============================================================================
// bindingStaticSchema
// ============================================================================

/**
 * Resolve the static JSON Schema a binding yields, per §5.1.
 *
 * @param binding  - the consumer's `inputBindings[field]` entry.
 * @param producer - the producer task for `task_output` bindings (looked up by
 *   the caller via `taskById.get(binding.taskId)`). Ignored for other kinds.
 */
export function bindingStaticSchema(
  binding: WorkflowTaskInputBinding,
  producer?: WorkflowTask,
): BindingStaticSchemaResult {
  switch (binding.kind) {
    case 'run_input':
      // No run-input contract exists yet (`assembleWorkflow` emits `{}`).
      // Platform-side undecidability (§2.5) — presence-only.
      return { schema: {}, status: 'runtime_untyped' };
    case 'campaign_input':
      return { schema: {}, status: 'runtime_untyped' };
    case 'task_summary':
      return { schema: { type: 'string' }, status: 'known' };
    case 'system_feedback':
      return { schema: contractErrorJsonSchema(), status: 'known' };
    case 'connection_binding':
      // Resolved at dispatch from the run's pinned GitHub connection — a
      // binding-id string the platform supplies, with no static contract (like
      // run_input). Presence-checkable, type-unchecked: never narrow it to
      // `{type:'string'}`, which would false-reject the op `bindingId` field's
      // own length bound.
      return { schema: {}, status: 'runtime_untyped' };
    case 'learning_set':
      // Platform-rendered text block. Deliberately `known` as a bare string:
      // the read-time budget bounds ENTRIES, not characters, so a target with
      // its own length bound is genuinely not guaranteed — rejecting it is
      // sound, unlike the presence-only kinds above.
      return { schema: { type: 'string' }, status: 'known' };
    case 'artifact_binding':
      return { schema: { type: 'string', format: 'uuid' }, status: 'known' };
    case 'task_output':
      return resolveTaskOutputSchema(binding, producer);
  }
}

function resolveTaskOutputSchema(
  binding: Extract<WorkflowTaskInputBinding, { kind: 'task_output' }>,
  producer: WorkflowTask | undefined,
): BindingStaticSchemaResult {
  if (!producer) return { schema: {}, status: 'undeclared_producer' };

  const family = safeInferFamily(producer);
  const path = binding.path;

  // A projected op task's stored output is the projected object declared by its
  if (family === 'operation' && producer.operation && producer.outputProjection === undefined) {
    // op→op residual — the producer's output is its fixed `outputZod`.
    const op = getOperation(producer.operation);
    if (!op?.outputZod) return { schema: {}, status: 'runtime_untyped' };
    const outputSchema = toJsonSchemaSync(op.outputZod) as Record<string, unknown>;
    if (!path) return { schema: outputSchema, status: 'known' };
    const traversed = traverseJsonSchemaPath(outputSchema, path);
    if (!traversed) return { schema: {}, status: 'runtime_untyped' };
    return { schema: traversed, status: 'known' };
  }

  // Agent / human producer — resolve from the platform-fillable
  // `produces[]` ports or the persisted `outputContract.schema`.
  if (path) {
    const port = producer.produces?.find((p) => p.key === path);
    if (port) return { schema: port.shape, status: 'known' };
    const contractSchema = producer.outputContract?.schema;
    const traversed = traverseJsonSchemaPath(contractSchema, path);
    if (traversed) return { schema: traversed, status: 'known' };
    // A nested path into an authored contract that doesn't statically resolve
    // (e.g. a non-traversable node) is runtime_untyped, not author-blamed —
    // but a *flat* path (single key segment) with no port and no matching
    // top-level property is an undeclared producer port (the loose lane).
    if (contractSchema && isSchemaObject(contractSchema) && isFlatKeyPath(path)) {
      const props = contractSchema['properties'];
      if (!(isSchemaObject(props) && path in props)) {
        return { schema: {}, status: 'undeclared_producer' };
      }
    }
    if (!contractSchema) return { schema: {}, status: 'undeclared_producer' };
    return { schema: {}, status: 'runtime_untyped' };
  }

  // Whole-output binding (no path).
  const contractSchema = producer.outputContract?.schema;
  if (isSchemaObject(contractSchema)) {
    return { schema: contractSchema, status: 'known' };
  }
  const synthesized = synthesizeWholeOutputFromPorts(producer);
  if (synthesized) return { schema: synthesized, status: 'known' };
  return { schema: {}, status: 'undeclared_producer' };
}

/**
 * Build the strict whole-output object schema from a producer's declared
 * `produces[]` ports — mirrors `assembleWorkflow.buildOutputContract`.
 */
function synthesizeWholeOutputFromPorts(
  producer: WorkflowTask,
): Record<string, unknown> | undefined {
  const ports = producer.produces ?? [];
  if (ports.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const port of ports) {
    properties[port.key] = port.shape;
    required.push(port.key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function safeInferFamily(task: WorkflowTask): 'agent' | 'operation' | 'human' {
  try {
    return inferTaskType(task);
  } catch {
    // Unvalidated/malformed producer — treat as agent so resolution falls to
    // the declared-output path rather than throwing.
    return 'agent';
  }
}

// ============================================================================
// Small schema helpers
// ============================================================================

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A "flat" binding path = exactly one key segment under the shared dialect. */
function isFlatKeyPath(path: string): boolean {
  const segments = parseOutputPath(path);
  return segments !== null && segments.length === 1 && segments[0]!.kind === 'key';
}

function typeIncludes(schema: Record<string, unknown>, t: string): boolean {
  const ty = schema['type'];
  if (typeof ty === 'string') return ty === t;
  if (Array.isArray(ty)) return ty.includes(t);
  return false;
}
