/**
 * Schema-directed seeding of an applet's initial state so a materialized
 * template patch is applicable.
 *
 * A template that writes into a dynamically-keyed member —
 * `/state/shots/<id>/prompt` — never applies to the state an instance is born
 * with, because the room mints that key at runtime. Replaying it against
 * `initialState` alone can only fail, so the gate grows a state in which the
 * key exists, synthesizing every missing member from `stateSchema`.
 *
 * Seeding is licensed by the key being actor-minted, never by convenience:
 * only segments at or below the first input-derived segment of a path may be
 * grown. A wholly literal path stays exactly as strict as it was — it must
 * resolve against the state an instance is born with, or the replay fails.
 *
 * `test` operations assert domain facts the platform cannot know, so replay
 * re-points each one at the value the seeded state actually holds. What replay
 * proves about a `test` is that its path resolves; whether the asserted value
 * can ever appear there is a separate, static question the caller answers
 * against `schemaAtAppletStatePath`.
 */
import {
  APPLET_JSON_MAX_DEPTH,
  APPLET_STATE_POINTER_PREFIX,
  type AppletStatePatchOp,
} from '@aflow/schemas';
import { AppletRuntimeError } from './errors.js';
import { applyAppletStatePatch } from './applyStatePatch.js';
import { isJsonRecord } from './json.js';
import { resolveJsonPointer, splitJsonPointer } from './pointer.js';
import { synthesizeMinimalAppletValue, UnsatisfiableSampleError } from './sampleValue.js';

const CANONICAL_ARRAY_INDEX_RE = /^(0|[1-9][0-9]*)$/;

export type AppletStateSeedCode =
  | 'member_not_in_schema'
  | 'member_not_synthesizable'
  | 'array_growth_unbounded'
  | 'traversal_through_scalar';

/** The state an actor-minted key needs cannot be built from the declared stateSchema. */
export class AppletStateSeedError extends AppletRuntimeError {
  declare readonly code: AppletStateSeedCode;
  readonly pointer: string;

  constructor(code: AppletStateSeedCode, message: string, pointer: string) {
    super(code, message);
    this.name = 'AppletStateSeedError';
    this.pointer = pointer;
  }
}

/** One materialized operation and where its path stops being knowable. */
export interface AppletSeedableOp {
  op: AppletStatePatchOp;
  /**
   * Index of the first input-derived segment of the path, counted from the
   * state root. Omitted when every segment is literal — nothing is seedable.
   */
  seedableFrom?: number;
}

export interface AppletStateSeedResult {
  /** `initialState` grown with the actor-minted members the patch needs. */
  initialState: Record<string, unknown>;
  /** The patch as replay runs it — `test` values re-pointed at the seeded state. */
  patch: AppletStatePatchOp[];
}

interface RecordedSeed {
  segments: string[];
  value: unknown;
}

/**
 * Grow `initialState` until `ops` are applicable, and return it alongside the
 * patch replay will run. Throws AppletStateSeedError when an actor-minted path
 * is outside anything `stateSchema` describes, and AppletPatchApplyError when
 * an operation still fails against the grown state.
 */
export function seedAppletStateForPatch(params: {
  initialState: Record<string, unknown>;
  stateSchema: Record<string, unknown>;
  ops: readonly AppletSeedableOp[];
}): AppletStateSeedResult {
  const { stateSchema } = params;
  let working: Record<string, unknown> = structuredClone(params.initialState);
  const seeds: RecordedSeed[] = [];
  const patch: AppletStatePatchOp[] = [];

  for (const { op, seedableFrom } of params.ops) {
    const segments = splitJsonPointer(op.path).slice(1);
    const needed = op.op === 'add' ? segments.slice(0, -1) : segments;
    seeds.push(...growAppletState(working, stateSchema, needed, seedableFrom ?? Infinity));

    let replayed = op;
    if (op.op === 'test') {
      const current = resolveJsonPointer({ state: working }, op.path);
      if (current.found) replayed = { op: 'test', path: op.path, value: current.value };
    }
    patch.push(replayed);
    working = applyAppletStatePatch(working, [replayed]);
  }

  const initialState = structuredClone(params.initialState);
  for (const seed of seeds) plantSeed(initialState, seed);
  return { initialState, patch };
}

/**
 * Add every seedable member along `segments` that `state` lacks, synthesizing
 * each from the schema that describes it. Mutates `state` and returns what it
 * added; a missing member above `seedableFrom` ends the walk untouched, so the
 * caller's apply reports it.
 */
function growAppletState(
  state: Record<string, unknown>,
  stateSchema: Record<string, unknown>,
  segments: readonly string[],
  seedableFrom: number,
): RecordedSeed[] {
  const seeds: RecordedSeed[] = [];
  let node: unknown = state;
  let schema: unknown = stateSchema;
  const walked: string[] = [];

  for (const [index, segment] of segments.entries()) {
    const pointer = pointerOf([...walked, segment]);
    if (Array.isArray(node)) {
      const arrayIndex = arrayIndexOf(segment, pointer, index >= seedableFrom);
      if (arrayIndex === undefined) return seeds;
      if (arrayIndex >= node.length) {
        if (index < seedableFrom) return seeds;
        growArray(node, arrayIndex, schema, stateSchema, pointer, walked, seeds);
      }
      node = node[arrayIndex];
    } else if (isJsonRecord(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) {
        if (index < seedableFrom) return seeds;
        const childSchema = memberSchemaFor(schema, segment, stateSchema, pointer);
        node[segment] = synthesizeMember(childSchema, stateSchema, pointer);
        seeds.push({ segments: [...walked, segment], value: structuredClone(node[segment]) });
      }
      node = node[segment];
    } else {
      if (index < seedableFrom) return seeds;
      throw new AppletStateSeedError(
        'traversal_through_scalar',
        `'${pointer}' reads through a value that holds no members`,
        pointer,
      );
    }
    schema = memberSchemaOf(schema, segment, stateSchema);
    walked.push(segment);
  }
  return seeds;
}

function growArray(
  node: unknown[],
  index: number,
  schema: unknown,
  root: Record<string, unknown>,
  pointer: string,
  walked: readonly string[],
  seeds: RecordedSeed[],
): void {
  const maxItems = declaredMaxItems(schema, root);
  if (maxItems === undefined || index >= maxItems) {
    throw new AppletStateSeedError(
      'array_growth_unbounded',
      `'${pointer}' indexes past the end of an array whose reachable length no schema bounds — ` +
        'declare maxItems, or index only what initialState already holds',
      pointer,
    );
  }
  const itemSchema = memberSchemaFor(schema, String(index), root, pointer);
  while (node.length <= index) {
    node.push(synthesizeMember(itemSchema, root, pointer));
    seeds.push({
      segments: [...walked, String(node.length - 1)],
      value: structuredClone(node[node.length - 1]),
    });
  }
}

function synthesizeMember(
  schema: unknown,
  root: Record<string, unknown>,
  pointer: string,
): unknown {
  try {
    return synthesizeMinimalAppletValue(schema, root);
  } catch (err) {
    if (!(err instanceof UnsatisfiableSampleError)) throw err;
    throw new AppletStateSeedError(
      'member_not_synthesizable',
      `stateSchema describes '${pointer}' but admits no value there, so no state the template can write into exists`,
      pointer,
    );
  }
}

/** Replay a recorded seed onto a document the operations have not touched. */
function plantSeed(state: Record<string, unknown>, seed: RecordedSeed): void {
  let node: unknown = state;
  for (const segment of seed.segments.slice(0, -1)) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!CANONICAL_ARRAY_INDEX_RE.test(segment) || index >= node.length) return;
      node = node[index];
    } else if (isJsonRecord(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) return;
      node = node[segment];
    } else {
      return;
    }
  }
  const last = seed.segments[seed.segments.length - 1];
  if (last === undefined) return;
  if (Array.isArray(node)) {
    if (Number(last) === node.length) node.push(structuredClone(seed.value));
    return;
  }
  if (isJsonRecord(node) && !Object.prototype.hasOwnProperty.call(node, last)) {
    node[last] = structuredClone(seed.value);
  }
}

function arrayIndexOf(segment: string, pointer: string, seedable: boolean): number | undefined {
  if (CANONICAL_ARRAY_INDEX_RE.test(segment)) return Number(segment);
  if (!seedable) return undefined;
  throw new AppletStateSeedError(
    'member_not_in_schema',
    `'${pointer}' addresses an array member by '${segment}', which is not an array index`,
    pointer,
  );
}

// ============================================================================
// Schema navigation
// ============================================================================

/**
 * The concrete schema nodes a declared node stands for — `$ref` dereferenced,
 * `allOf` merged, one candidate per `oneOf`/`anyOf` branch.
 */
function candidateNodes(node: unknown, root: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > APPLET_JSON_MAX_DEPTH) return [];
  if (node === true || node === undefined) return [{ additionalProperties: true }];
  if (!isJsonRecord(node)) return [];

  const ref = node['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#')) {
    const resolved = resolveJsonPointer(root, ref.slice(1));
    return resolved.found ? candidateNodes(resolved.value, root, depth + 1) : [];
  }

  const allOf = Array.isArray(node['allOf']) ? (node['allOf'] as unknown[]) : undefined;
  const anyOf = Array.isArray(node['anyOf']) ? (node['anyOf'] as unknown[]) : undefined;
  const oneOf = Array.isArray(node['oneOf']) ? (node['oneOf'] as unknown[]) : undefined;
  if (allOf === undefined && anyOf === undefined && oneOf === undefined) return [node];

  const base: Record<string, unknown> = { ...node };
  delete base['allOf'];
  delete base['anyOf'];
  delete base['oneOf'];
  let merged: Array<Record<string, unknown>> = [base];
  for (const part of allOf ?? []) {
    const parts = candidateNodes(part, root, depth + 1);
    merged = merged.flatMap((carried) => parts.map((entry) => ({ ...carried, ...entry })));
  }
  const branches = [...(anyOf ?? []), ...(oneOf ?? [])];
  if (branches.length === 0) return merged;
  return branches.flatMap((branch) =>
    candidateNodes(branch, root, depth + 1).flatMap((entry) =>
      merged.map((carried) => ({ ...carried, ...entry })),
    ),
  );
}

function memberSchemasOf(schema: unknown, segment: string, root: unknown): unknown[] {
  const members: unknown[] = [];
  for (const candidate of candidateNodes(schema, root)) {
    const member = memberOfCandidate(candidate, segment);
    if (member !== undefined) members.push(member);
  }
  return members;
}

function memberSchemaOf(schema: unknown, segment: string, root: unknown): unknown {
  return memberSchemasOf(schema, segment, root)[0];
}

function memberSchemaFor(
  schema: unknown,
  segment: string,
  root: Record<string, unknown>,
  pointer: string,
): unknown {
  const member = memberSchemaOf(schema, segment, root);
  if (member !== undefined) return member;
  throw new AppletStateSeedError(
    'member_not_in_schema',
    `stateSchema describes no member at '${pointer}', so no state an instance can reach holds one`,
    pointer,
  );
}

function memberOfCandidate(candidate: Record<string, unknown>, segment: string): unknown {
  const properties = candidate['properties'];
  if (isJsonRecord(properties) && Object.prototype.hasOwnProperty.call(properties, segment)) {
    return properties[segment];
  }
  if (CANONICAL_ARRAY_INDEX_RE.test(segment)) {
    const prefixItems = candidate['prefixItems'];
    if (Array.isArray(prefixItems)) {
      const entry = (prefixItems as unknown[])[Number(segment)];
      if (entry !== undefined) return entry;
    }
    if ('items' in candidate) return candidate['items'];
  }
  const additional = candidate['additionalProperties'];
  if (additional === false) return undefined;
  if (additional !== undefined) return additional;
  // An object that constrains no additional member admits any — a template
  // writing there resolves at runtime, whatever `properties` happens to list.
  const objectShaped =
    isJsonRecord(properties) ||
    candidate['type'] === 'object' ||
    'required' in candidate ||
    'propertyNames' in candidate;
  return objectShaped ? true : undefined;
}

function declaredMaxItems(schema: unknown, root: unknown): number | undefined {
  for (const candidate of candidateNodes(schema, root)) {
    const maxItems = candidate['maxItems'];
    if (typeof maxItems === 'number') return maxItems;
  }
  return undefined;
}

function pointerOf(segments: readonly string[]): string {
  return [APPLET_STATE_POINTER_PREFIX, ...segments].join('/');
}

/**
 * The schema node describing state at `pointer`, or undefined when the
 * declared schema describes nothing there. A pointer crossing a `oneOf` keeps
 * every branch that describes the member: a value only has to be admissible
 * under one of them.
 */
export function schemaAtAppletStatePath(
  stateSchema: Record<string, unknown>,
  pointer: string,
): unknown {
  let schema: unknown = stateSchema;
  for (const segment of splitJsonPointer(pointer).slice(1)) {
    const members = memberSchemasOf(schema, segment, stateSchema);
    if (members.length === 0) return undefined;
    schema = members.length === 1 ? members[0] : { anyOf: members };
  }
  return schema;
}
