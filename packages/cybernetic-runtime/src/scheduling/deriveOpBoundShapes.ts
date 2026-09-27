import {
  deepEqual,
  getOperation,
  inferTaskType,
  isCampaignFieldConsume,
  isUsableJsonSchema,
  toJsonSchemaSync,
  type TaskGraphDraftTask,
  type WorkflowTask,
} from '@aflow/schemas';

// ============================================================================
// Persisted WorkflowTask[] path
// ============================================================================

/**
 * Derive op-bound producer output shapes for a persisted task list. Returns a
 * new array with the affected agent producers' `outputContract.schema`
 * augmented; unaffected tasks are returned by reference. Never mutates the
 * input (seeds are shared consts).
 *
 * @throws when one producer port is consumed by two operation inputs that
 *   require structurally different schemas (the multi-consumer conflict case).
 */
export function deriveOpBoundProducerShapes(tasks: WorkflowTask[]): WorkflowTask[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t] as const));
  // producerId → (portKey → derived JSON Schema)
  const derivations = new Map<string, Map<string, Record<string, unknown>>>();

  for (const task of tasks) {
    if (safeFamily(task) !== 'operation' || !task.operation) continue;
    if (task.inputTemplate !== undefined) continue;
    const opProps = opInputProps(task.operation);
    if (!opProps) continue;
    const bindings = task.inputBindings ?? {};
    for (const [field, binding] of Object.entries(bindings)) {
      if (binding.kind !== 'task_output') continue;
      const path = binding.path;
      if (!path) continue; // whole-output bindings have no port to fill
      const producer = byId.get(binding.taskId);
      if (!producer || safeFamily(producer) !== 'agent') continue;
      const opFieldSchema = opProps[field];
      // Record any USABLE op field (primitives/format/bounds included, review
      // Finding 2). Whether to actually write it is decided per-port at apply
      // time (fill-if-absent; overwrite an authored shape only when the op
      // field imposes a constraint, so a loose op field never loosens an
      // author-declared shape).
      if (!isSchemaObject(opFieldSchema) || !isUsableJsonSchema(opFieldSchema)) continue;
      recordDerivation(derivations, producer.taskId, path, opFieldSchema, task.taskId);
    }
  }

  if (derivations.size === 0) return tasks;

  return tasks.map((t) => {
    const ports = derivations.get(t.taskId);
    if (!ports) return t;
    return applyDerivationsToTask(t, ports);
  });
}

// ============================================================================
// Compose IR TaskGraphDraftTask[] path
// ============================================================================

/**
 * Fill op-bound produces[] port shapes on a compose IR draft, IN PLACE. Run
 * this over `draft.tasks` BEFORE `buildProducerPortIndex` (the assembler reads
 * `produces[].shape`). The draft is owned by the caller (a freshly parsed
 * input), so mutation is safe.
 *
 * @throws on a multi-consumer conflict (same producer port, two ops requiring
 *   structurally different schemas).
 */
export function deriveOpBoundDraftPortShapes(draftTasks: TaskGraphDraftTask[]): void {
  const byId = new Map(draftTasks.map((t) => [t.taskId, t] as const));
  // producerId → (portKey → derived JSON Schema) — collected first so the
  // conflict check sees all consumers before any write.
  const derivations = new Map<string, Map<string, Record<string, unknown>>>();

  for (const task of draftTasks) {
    if (task.type !== 'operation') continue;
    if (task.inputTemplate !== undefined) continue;
    const opProps = opInputProps(task.operationId);
    if (!opProps) continue;
    for (const c of task.consumes) {
      if (isCampaignFieldConsume(c)) continue;
      const opFieldSchema = opProps[c.bindAs];
      // Record any USABLE op field (review Finding 2 — a primitive op field
      // like `{type:'string',format:'uuid'}` must still fill an omitted port,
      // else `buildProducerPortIndex` rejects the omitted shape).
      if (!isSchemaObject(opFieldSchema) || !isUsableJsonSchema(opFieldSchema)) continue;
      const producer = byId.get(c.taskId);
      if (producer?.type !== 'agent') continue;
      const port = producer.produces.find((p) => p.key === c.outputKey);
      if (!port) continue;
      recordDerivation(derivations, producer.taskId, c.outputKey, opFieldSchema, task.taskId);
    }
  }

  for (const task of draftTasks) {
    if (task.type !== 'agent') continue;
    const ports = derivations.get(task.taskId);
    if (!ports) continue;
    for (const port of task.produces) {
      const derived = ports.get(port.key);
      if (!derived) continue;
      // Fill an omitted port shape unconditionally; overwrite an author-
      // declared shape only when the op field imposes a constraint (so a loose
      // op field never loosens an authored shape — the render-card `data` case).
      const authored = port.shape !== undefined;
      if (!authored || opFieldImposesConstraint(derived)) {
        port.shape = clone(derived); // derivation wins
      }
    }
  }
}

// ============================================================================
// Shared helpers
// ============================================================================

function recordDerivation(
  derivations: Map<string, Map<string, Record<string, unknown>>>,
  producerId: string,
  portKey: string,
  opFieldSchema: Record<string, unknown>,
  consumerId: string,
): void {
  let ports = derivations.get(producerId);
  if (!ports) {
    ports = new Map();
    derivations.set(producerId, ports);
  }
  const prior = ports.get(portKey);
  if (prior && !deepEqual(prior, opFieldSchema)) {
    throw new Error(
      `deriveOpBoundProducerShapes: producer "${producerId}" port "${portKey}" is consumed by ` +
        `operation inputs with conflicting required schemas (one via "${consumerId}"). ` +
        `A multi-consumer op-bound port must have a single consistent shape.`,
    );
  }
  ports.set(portKey, clone(opFieldSchema));
}

/**
 * Apply derivations to one producer task, returning a NEW task (never mutates
 * the input). Decides per port whether to derive:
 *   - the producer does NOT declare the field (no produces[] port, no
 *     outputContract property) → FILL it (any usable op field);
 *   - the producer DOES declare it → OVERWRITE only when the op field imposes
 *     a constraint (derivation wins, one source of truth), else keep the
 *     authored shape so a loose op field can't loosen it.
 * Updates BOTH `outputContract.schema` and the matching `produces[]` port
 * (review Finding 1: `bindingStaticSchema` + the assembler's inputContract
 * derivation prefer `produces[]`, so the two must stay consistent).
 */
function applyDerivationsToTask(
  task: WorkflowTask,
  ports: Map<string, Record<string, unknown>>,
): WorkflowTask {
  const existingSchema = task.outputContract?.schema;
  const unionVariants = getUnionVariants(existingSchema);
  if (unionVariants) {
    return applyDerivationsToUnionTask(task, ports, existingSchema!, unionVariants);
  }

  const existingProps =
    isSchemaObject(existingSchema) && isSchemaObject(existingSchema['properties'])
      ? existingSchema['properties']
      : {};
  const producesByKey = new Map((task.produces ?? []).map((p) => [p.key, p] as const));

  const toApply = new Map<string, Record<string, unknown>>();
  for (const [path, derived] of ports) {
    const authored = path in existingProps || producesByKey.get(path)?.shape !== undefined;
    if (!authored || opFieldImposesConstraint(derived)) {
      toApply.set(path, derived);
    }
  }
  if (toApply.size === 0) return task;

  const schema = mergeDerivedIntoSchema(existingSchema, toApply);
  const updated: WorkflowTask = {
    ...task,
    outputContract: { ...(task.outputContract ?? {}), schema },
  };
  if (task.produces && task.produces.length > 0) {
    updated.produces = task.produces.map((p) => {
      const derived = toApply.get(p.key);
      return derived ? { ...p, shape: clone(derived) } : p;
    });
  }
  return updated;
}

/**
 * The variant list when a schema root is a PURE union (`anyOf`/`oneOf` with no
 * root-level properties), else undefined. A root that declares its own
 * properties (the at-least-one-of idiom: `{properties: {...}, anyOf:
 * [{required: ['a']}, {required: ['b']}]}`) keeps the non-union path — its
 * ports live at the root and the in-place overwrite there is correct.
 */
function getUnionVariants(
  schema: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!isSchemaObject(schema)) return undefined;
  const rootProps = schema['properties'];
  if (isSchemaObject(rootProps) && Object.keys(rootProps).length > 0) return undefined;
  const variants = schema['anyOf'] ?? schema['oneOf'];
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  return variants.filter(isSchemaObject);
}

/**
 * Union-rooted producer contract: a bound port is branch-conditional, so the
 * derived shape overwrites the property INSIDE each variant that declares it —
 * never grafted onto the root. Root-level `properties`/`required` on a union
 * whose variants are `additionalProperties: false` would make every variant
 * that omits the field unsatisfiable, forcing the runner into whichever branch
 * carries it regardless of its actual classification.
 *
 * A flat port that no variant declares while EVERY variant is closed
 * (`additionalProperties: false`) is a real authoring error — the bound op
 * input can never be produced on any branch — so throw, and the validity plane
 * surfaces it as a blocking diagnostic instead of the contract corrupting
 * silently. A nested (dotted/indexed) path or an open variant is skipped
 * instead: derivation cannot write nested shapes, and an open variant can
 * legitimately carry the key at runtime (`bindingStaticSchema` treats both as
 * runtime-typed, not as errors).
 */
function applyDerivationsToUnionTask(
  task: WorkflowTask,
  ports: Map<string, Record<string, unknown>>,
  existingSchema: Record<string, unknown>,
  variants: Array<Record<string, unknown>>,
): WorkflowTask {
  const toApply = new Map<string, Record<string, unknown>>();
  for (const [path, derived] of ports) {
    if (path.includes('.') || path.includes('[')) continue;
    const declaringVariants = variants.filter(
      (v) => isSchemaObject(v['properties']) && path in v['properties'],
    );
    if (declaringVariants.length === 0) {
      const everyVariantClosed = variants.every((v) => v['additionalProperties'] === false);
      if (!everyVariantClosed) continue;
      throw new Error(
        `deriveOpBoundProducerShapes: producer "${task.taskId}" has a union output contract, ` +
          `but bound port "${path}" appears in no variant's properties and every variant is ` +
          `closed — the consuming op's input can never be produced on any branch. Declare ` +
          `"${path}" on the variant(s) that produce it.`,
      );
    }
    if (opFieldImposesConstraint(derived)) toApply.set(path, derived);
  }
  if (toApply.size === 0) return task;

  const unionKey = Array.isArray(existingSchema['anyOf']) ? 'anyOf' : 'oneOf';
  const rewrittenVariants = (existingSchema[unionKey] as unknown[]).map((variant) => {
    if (!isSchemaObject(variant) || !isSchemaObject(variant['properties'])) return variant;
    const props = variant['properties'];
    let changed = false;
    const nextProps: Record<string, unknown> = { ...props };
    for (const [path, derived] of toApply) {
      if (path in props) {
        nextProps[path] = clone(derived);
        changed = true;
      }
    }
    return changed ? { ...variant, properties: nextProps } : variant;
  });

  const updated: WorkflowTask = {
    ...task,
    outputContract: {
      ...(task.outputContract ?? {}),
      schema: { ...existingSchema, [unionKey]: rewrittenVariants },
    },
  };
  if (task.produces && task.produces.length > 0) {
    updated.produces = task.produces.map((p) => {
      const derived = toApply.get(p.key);
      return derived ? { ...p, shape: clone(derived) } : p;
    });
  }
  return updated;
}

/**
 * Merge derived port shapes into a producer's `outputContract.schema`,
 * returning a NEW schema object. Creates a strict object schema if the
 * producer had none. Derivation overwrites any author-declared shape for the
 * same port (one source of truth), and the port is added to `required` so the
 * agent cannot omit the field (review High-1: an omitted required field would
 * resolve ABSENT and still fail the op at runtime).
 */
function mergeDerivedIntoSchema(
  existing: Record<string, unknown> | undefined,
  ports: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const schema: Record<string, unknown> = isSchemaObject(existing)
    ? clone(existing)
    : { type: 'object', properties: {}, required: [], additionalProperties: false };

  if (schema['type'] === undefined) schema['type'] = 'object';
  const properties: Record<string, unknown> = isSchemaObject(schema['properties'])
    ? schema['properties']
    : {};
  const required: string[] = Array.isArray(schema['required'])
    ? schema['required'].filter((r): r is string => typeof r === 'string')
    : [];

  for (const [path, derived] of ports) {
    properties[path] = derived; // derivation wins
    if (!required.includes(path)) required.push(path);
  }

  schema['properties'] = properties;
  schema['required'] = required;
  return schema;
}

/** Resolve `toJsonSchemaSync(op.inputZod).properties` for a registered op. */
function opInputProps(operationId: string): Record<string, unknown> | undefined {
  const op = getOperation(operationId);
  if (!op || op.skipInputValidation) return undefined;
  const json = toJsonSchemaSync(op.inputZod) as Record<string, unknown>;
  const props = json['properties'];
  return isSchemaObject(props) ? props : undefined;
}

/**
 * Whether an op input field imposes a constraint worth deriving onto (and
 * overwriting) an author-declared shape. Per §6 "derivation wins", the ONLY
 * reason to preserve an authored shape is when the op field is genuinely loose
 * (`z.record(z.unknown())` → `{type:'object'}` with no properties/required;
 * `z.unknown()` → `{}`) — overwriting that would only LOOSEN the authored shape
 * (§6 locked decision 3: untyped op input → no-op; the Alpaca render-card
 * `data` case). Any real constraint — structural (properties/required/items/
 * enum/const/combinators) OR scalar (format/pattern/length/range/array bounds,
 * which an authored bare `{type:...}` would otherwise be left looser than) —
 * means the op field is the source of truth and should overwrite.
 */
function opFieldImposesConstraint(schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema['required']) && schema['required'].length > 0) return true;
  if (Array.isArray(schema['enum'])) return true;
  if ('const' in schema) return true;
  if (isSchemaObject(schema['items'])) return true;
  if (
    Array.isArray(schema['anyOf']) ||
    Array.isArray(schema['allOf']) ||
    Array.isArray(schema['oneOf'])
  ) {
    return true;
  }
  const props = schema['properties'];
  if (isSchemaObject(props) && Object.keys(props).length > 0) return true;
  // Scalar / array bounds + format/pattern are real constraints too (review):
  // an authored `{type:'string'}` feeding `{type:'string',format:'uuid'}` must
  // be corrected, not preserved.
  if (SCALAR_CONSTRAINT_KEYWORDS.some((k) => k in schema)) return true;
  return false;
}

const SCALAR_CONSTRAINT_KEYWORDS = [
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

function safeFamily(task: WorkflowTask): 'agent' | 'operation' | 'human' {
  try {
    return inferTaskType(task);
  } catch {
    return 'agent';
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
