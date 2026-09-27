import type { getFailedRunFallbackMessage } from '@aflow/schemas';
import type {
  InlineAppletItem,
  SessionEvent,
  UserFacingError,
  WorkflowSurfaceTaskState,
  WorkflowSurfaceTaskStatus,
  WorkflowSurfaceRunStatus,
  WorkflowSurfaceItemEntry,
  WorkflowRunSurfaceState,
} from '../types.js';
import type { RunViewState } from './state.js';

/** Convert epoch ms or ISO string to ISO string */
export function toISOTimestamp(ts: string): string {
  return ts;
}

// ---------------------------------------------------------------------------

/**
 * Terminal run statuses — once reached, the surface card freezes and
 * further updates for the run are ignored. `paused` is NOT terminal;
 * the run can resume.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowSurfaceRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Numeric ranks for task-status regression checks. Higher rank wins on
 * conflict EXCEPT when a higher `attempt` arrives (which always wins —
 * a retry can legitimately transition `succeeded → running`).
 */
export const TASK_STATUS_RANK: Readonly<Record<WorkflowSurfaceTaskStatus, number>> = {
  scheduled: 0,
  blocked: 0,
  running: 1,
  paused: 2,
  // Terminal states.
  succeeded: 3,
  failed: 3,
  cancelled: 3,
  skipped: 3,
};

export const TERMINAL_TASK_STATUSES: ReadonlySet<WorkflowSurfaceTaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

export function shouldAcceptTaskUpdate(
  prev: WorkflowSurfaceTaskState | undefined,
  next: WorkflowSurfaceTaskState,
): boolean {
  if (!prev) return true;
  if (next.attempt > prev.attempt) return true;
  if (next.attempt < prev.attempt) return false;
  return TASK_STATUS_RANK[next.status] >= TASK_STATUS_RANK[prev.status];
}

export function extractSessionSurfaceMutations(
  state: RunViewState,
  surfaceId: string,
  inlineId: string,
): Array<Record<string, unknown>> {
  const messageId = `surface-${surfaceId}`;
  const surfaceMessage = state.messages.find((m) => m.id === messageId);
  const messageMutations =
    (surfaceMessage?.richContent as { mutations?: Array<Record<string, unknown>> } | undefined)
      ?.mutations ?? [];
  const existingInline = state.inlineItems[inlineId];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- inline item may not exist yet
  const inlineMutations = existingInline?.kind === 'inline_surface' ? existingInline.mutations : [];
  // Concat preserves order. `surface-` message accumulates from
  // SurfaceUpdate events in arrival order; `inlineItems` entries arrive
  // from `WorkflowTaskSurfaceUpdate` (workflow-scoped) — which doesn't
  // apply to session-scoped renders, so this fallback is effectively
  // unused today but kept for forward compatibility with hybrid paths.
  return messageMutations.length > 0 ? messageMutations : inlineMutations;
}

/**
 * Bump the revision for the named run in `workflowSurfaceItems`. If no
 * entry exists for the run (mount hasn't happened yet), returns the
 * array unchanged — mount rules A/B will insert it.
 */
export function bumpSurfaceRevision(
  items: WorkflowSurfaceItemEntry[],
  runId: string,
): WorkflowSurfaceItemEntry[] {
  if (!items.some((it) => it.runId === runId)) return items;
  return items.map((it) => (it.runId === runId ? { ...it, revision: it.revision + 1 } : it));
}

/**
 * Insert a mount entry for the runId. Idempotent: if the runId is
 * already mounted, the existing entry is preserved (its anchor stays
 * pinned to the first event that mounted it).
 */
export function ensureSurfaceMounted(
  items: WorkflowSurfaceItemEntry[],
  runId: string,
  anchorStepExecutionId: string,
  createdAtMs: number,
): WorkflowSurfaceItemEntry[] {
  if (
    items.some((it) => it.runId === runId && it.anchorStepExecutionId === anchorStepExecutionId)
  ) {
    return items;
  }
  return [...items, { runId, anchorStepExecutionId, revision: 0, createdAtMs }];
}

/**
 * The applet counterpart of `freezePreviousSurfaceForRun`: when a
 * re-reference mounts a fresh live card at a new anchor, every prior live
 * card for the instance freezes in place as a read-only snapshot instead of
 * suppressing the new mount — each agent read brings the board to the reader.
 */
/**
 * Keep exactly one card per applet instance, at the anchor that last referenced it.
 *
 * An applet is not a message. The board is a single live object the room is
 * gathered around — the stage derives from this card — and an agent reading or
 * acting on it is not a new object to show, it is the same one being used
 * again. Mounting a card per reference stacked a session's whole history of
 * boards into the transcript: measured at 25 on one chess session, of which 24
 * were read-only copies of the same current state, each in its own sandboxed
 * iframe.
 *
 * The card moves instead. Re-delivery at the anchor it already occupies is a
 * no-op, so a replayed event does not churn the item.
 */
export function placeAppletCard(
  inlineItems: RunViewState['inlineItems'],
  item: InlineAppletItem,
): RunViewState['inlineItems'] {
  let movedFrom: string | null = null;
  for (const [inlineId, existing] of Object.entries(inlineItems)) {
    if (existing.kind === 'inline_applet' && existing.instanceId === item.instanceId) {
      movedFrom = inlineId;
      break;
    }
  }
  if (movedFrom === item.itemId) return inlineItems;
  const next: RunViewState['inlineItems'] = {};
  for (const [inlineId, existing] of Object.entries(inlineItems)) {
    if (inlineId === movedFrom) continue;
    next[inlineId] = existing;
  }
  next[item.itemId] = item;
  return next;
}

export function freezePreviousSurfaceForRun(
  items: WorkflowSurfaceItemEntry[],
  runId: string,
  liveState: WorkflowRunSurfaceState | undefined,
): WorkflowSurfaceItemEntry[] {
  if (liveState === undefined) return items;
  // Find the LATEST (last) live entry for runId — walk from the end so we
  // pick the most-recently-mounted card.
  let targetIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].runId === runId && items[i].frozenSnapshot === undefined) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) return items;
  const target = items[targetIdx];
  const frozen: WorkflowRunSurfaceState = { ...liveState, isFrozen: true };
  return items.map((it, i) => (i === targetIdx ? { ...target, frozenSnapshot: frozen } : it));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefixes for orchestrator-managed internal variables (not user-facing output). */
const INTERNAL_VARIABLE_PREFIXES = ['ai.', 'chat.', 'flow.', '_'];

/**
 * Decode an `inline:<base64-json>` outputRef. Returns the parsed object
 * or `null` for non-inline refs / malformed payloads. Used by the
 * `human.action_center.focus` StepSucceeded handler — the orchestrator
 * always emits inline outputs for that op (small, structured).
 */
export function decodeInlineOutput(outputRef: unknown): unknown {
  if (typeof outputRef !== 'string') return null;
  if (!outputRef.startsWith('inline:')) return null;
  try {
    const decoded = atob(outputRef.slice('inline:'.length));
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
}

export function isInternalVariable(key: string): boolean {
  return INTERNAL_VARIABLE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Extract a human-readable error message from a run event.
 * Looks in: metadata.errorMessage, metadata.error, errorRef (inline decoded).
 */
export function extractErrorMessage(event: SessionEvent): string | null {
  // 1. Check metadata for direct error strings
  if (event.metadata) {
    const meta = event.metadata;
    if (typeof meta.errorMessage === 'string' && meta.errorMessage) {
      return meta.errorMessage;
    }
    if (typeof meta.error === 'string' && meta.error) {
      return meta.error;
    }
  }

  // 2. Check data for error fields
  if (typeof event.data.errorMessage === 'string' && event.data.errorMessage) {
    return event.data.errorMessage;
  }
  if (typeof event.data.error === 'string' && event.data.error) {
    return event.data.error;
  }
  // Error might be an object { message, code }
  const errObj = event.data.error as { message?: string; code?: string } | undefined;
  if (errObj && typeof errObj === 'object' && typeof errObj.message === 'string') {
    return errObj.code ? `[${errObj.code}] ${errObj.message}` : errObj.message;
  }

  // 3. Try decoding errorRef (inline:error:base64 or inline:base64)
  const errorRef = event.data.errorRef;
  if (errorRef) {
    try {
      let encoded = errorRef;
      if (encoded.startsWith('inline:error:')) {
        encoded = encoded.slice('inline:error:'.length);
      } else if (encoded.startsWith('inline:')) {
        encoded = encoded.slice('inline:'.length);
      } else {
        return null; // Not an inline ref — can't decode
      }
      const decoded = atob(encoded);
      // Try parsing as JSON
      try {
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        if (typeof parsed.message === 'string') return parsed.message;
        if (typeof parsed.error === 'string') return parsed.error;
        return decoded;
      } catch {
        // Not JSON — use the raw string
        return decoded;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function extractErrorClassification(
  event: SessionEvent,
): Parameters<typeof getFailedRunFallbackMessage>[0] {
  const metaClassification = event.metadata?.errorClassification ?? event.metadata?.classification;
  if (typeof metaClassification === 'string') {
    return metaClassification as Parameters<typeof getFailedRunFallbackMessage>[0];
  }

  const dataClassification = event.data.errorClassification ?? event.data.classification;
  if (typeof dataClassification === 'string') {
    return dataClassification as Parameters<typeof getFailedRunFallbackMessage>[0];
  }

  return undefined;
}

export function extractUserError(event: SessionEvent): UserFacingError | null {
  const ue = event.metadata?.userError as Record<string, unknown> | undefined;
  if (!ue || typeof ue !== 'object') return null;
  if (typeof ue.title !== 'string' || typeof ue.message !== 'string') return null;
  return ue as unknown as UserFacingError;
}
