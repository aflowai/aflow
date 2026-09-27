/**
 * Read-side projections — the bounded view the agent perceives. The platform
 * reads declared pointers without understanding them; projection never
 * aliases the source document.
 */
import {
  APPLET_RECENT_ACTIONS_DEFAULT,
  APPLET_RECENT_ACTIONS_MAX,
  AppletAttentionSchema,
  type AppletActionReceipt,
  type AppletAttention,
  type AppletAttentionProjection,
} from '@aflow/schemas';
import { isJsonRecord } from './json.js';
import { resolveJsonPointer, splitJsonPointer } from './pointer.js';

/**
 * Bound `state` to the declared `agentProjection` pointers, rebuilding the
 * projected subtrees in place within a fresh document (arrays stay arrays —
 * unprojected indices are holes). No projection, or a whole-document pointer
 * (''), yields the full state. Unresolvable pointers are omitted, never an
 * error — a projection is a bound, not an assertion.
 */
export function projectAppletState(
  state: Record<string, unknown>,
  agentProjection?: readonly string[],
): Record<string, unknown> {
  if (agentProjection === undefined || agentProjection.length === 0) {
    return structuredClone(state);
  }
  const projected: Record<string, unknown> = {};
  for (const pointer of agentProjection) {
    const segments = splitJsonPointer(pointer);
    if (segments.length === 0) return structuredClone(state);
    const resolved = resolveJsonPointer(state, pointer);
    if (!resolved.found) continue;
    setProjectedValue(projected, state, segments, resolved.value);
  }
  return projected;
}

function setProjectedValue(
  target: Record<string, unknown>,
  sourceRoot: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let sourceNode: unknown = sourceRoot;
  let targetNode: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    sourceNode = childOf(sourceNode, segment);
    let child = childOf(targetNode, segment);
    if (!isJsonRecord(child) && !Array.isArray(child)) {
      child = Array.isArray(sourceNode) ? [] : {};
      assignChild(targetNode, segment, child);
    }
    targetNode = child as Record<string, unknown> | unknown[];
  }
  assignChild(targetNode, segments[segments.length - 1]!, structuredClone(value));
}

function childOf(node: unknown, segment: string): unknown {
  if (Array.isArray(node)) return node[Number(segment)];
  if (isJsonRecord(node)) return node[segment];
  return undefined;
}

function assignChild(
  container: Record<string, unknown> | unknown[],
  segment: string,
  value: unknown,
): void {
  if (Array.isArray(container)) {
    container[Number(segment)] = value;
  } else {
    container[segment] = value;
  }
}

/**
 * The last N receipts, oldest first — the shape `ui.applet.get` returns.
 * Input order is irrelevant; `seq` is the journal's total order.
 */
export function projectRecentReceipts(
  receipts: readonly AppletActionReceipt[],
  recentActionsLimit?: number,
): AppletActionReceipt[] {
  const limit = Math.min(
    recentActionsLimit ?? APPLET_RECENT_ACTIONS_DEFAULT,
    APPLET_RECENT_ACTIONS_MAX,
  );
  if (limit <= 0) return [];
  return [...receipts].sort((a, b) => a.seq - b.seq).slice(-limit);
}

const ATTENTION_VALUE_MAX_LENGTH =
  AppletAttentionSchema.shape.title.unwrap().maxLength ?? Number.POSITIVE_INFINITY;

/**
 * Read the declared attention pointers out of state — stringified, truncated,
 * never interpreted. `null` reads as absent (an empty `waitingOn` means
 * nobody). Returns undefined when the definition declares no projection —
 * the caller falls back to the generic line.
 */
export function projectAppletAttention(
  state: Record<string, unknown>,
  attentionProjection?: AppletAttentionProjection,
): AppletAttention | undefined {
  if (attentionProjection === undefined) return undefined;
  const attention: AppletAttention = {};
  for (const field of ['title', 'status', 'waitingOn'] as const) {
    const pointer = attentionProjection[field];
    if (pointer === undefined) continue;
    const resolved = resolveJsonPointer(state, pointer);
    if (!resolved.found || resolved.value === null) continue;
    attention[field] = stringifyAttentionValue(resolved.value);
  }
  return attention;
}

function stringifyAttentionValue(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  return text.slice(0, ATTENTION_VALUE_MAX_LENGTH);
}
