import type { RunViewState } from '@aflow/run-view';
import type {
  ConversationItem,
  Message,
  SessionSeed,
  WorkflowSurfaceItemEntry,
} from '../../lib/types.js';

/** Reducer fields needed to assemble chat conversation items. */
export type ConversationReducerSlice = Pick<
  RunViewState,
  'messages' | 'errorMessage' | 'errorDetail' | 'workflowSurfaceItems' | 'inlineItems'
>;

function itemTimestampMs(item: ConversationItem): number {
  if (item.kind === 'message') return Date.parse(item.message.timestamp);
  if (item.kind === 'run-separator') return Date.parse(item.timestamp);
  if (item.kind === 'workflow_run_surface') return item.createdAtMs ?? Number.NaN;
  return item.createdAtMs;
}

function insertAtChronologicalSlot(
  items: ConversationItem[],
  item: ConversationItem,
  createdAtMs: number,
): void {
  let insertAt = items.length;
  for (let i = 0; i < items.length; i++) {
    const candidate = items[i];
    if (candidate === undefined) continue;
    const ts = itemTimestampMs(candidate);
    if (!Number.isNaN(ts) && ts > createdAtMs) {
      insertAt = i;
      break;
    }
  }
  items.splice(insertAt, 0, item);
}

function insertAfterMessageAnchor(
  items: ConversationItem[],
  item: ConversationItem,
  anchorStepExecutionId: string,
  createdAtMs: number,
): void {
  const anchorIdx = items.findIndex(
    (it) => it.kind === 'message' && it.message.stepExecutionId === anchorStepExecutionId,
  );
  if (anchorIdx >= 0) {
    items.splice(anchorIdx + 1, 0, item);
    return;
  }
  insertAtChronologicalSlot(items, item, createdAtMs);
}

function workflowSurfaceToItem(surfaceEntry: WorkflowSurfaceItemEntry): ConversationItem {
  return {
    kind: 'workflow_run_surface',
    runId: surfaceEntry.runId,
    revision: surfaceEntry.revision,
    anchorStepExecutionId: surfaceEntry.anchorStepExecutionId,
    createdAtMs: surfaceEntry.createdAtMs,
    ...(surfaceEntry.frozenSnapshot ? { frozenSnapshot: surfaceEntry.frozenSnapshot } : {}),
    ...(surfaceEntry.displaySource ? { displaySource: surfaceEntry.displaySource } : {}),
  };
}

export function appendWorkflowSurfaces(
  items: ConversationItem[],
  workflowSurfaceItems: WorkflowSurfaceItemEntry[],
): void {
  for (const surfaceEntry of workflowSurfaceItems) {
    insertAfterMessageAnchor(
      items,
      workflowSurfaceToItem(surfaceEntry),
      surfaceEntry.anchorStepExecutionId,
      surfaceEntry.createdAtMs,
    );
  }
}

export function appendInlineUiItems(
  items: ConversationItem[],
  inlineItems: RunViewState['inlineItems'],
): void {
  for (const inline of Object.values(inlineItems)) {
    if (inline.workflowRunId !== undefined) {
      const surfaceIdx = items.findIndex(
        (it) => it.kind === 'workflow_run_surface' && it.runId === inline.workflowRunId,
      );
      if (surfaceIdx >= 0) {
        items.splice(surfaceIdx + 1, 0, inline);
        continue;
      }
    }
    const anchorIdx = items.findIndex(
      (it) => it.kind === 'message' && it.message.stepExecutionId === inline.anchorStepExecutionId,
    );
    if (anchorIdx >= 0) {
      items.splice(anchorIdx + 1, 0, inline);
      continue;
    }
    // Both lookups missed — e.g. a session-scoped render whose step
    // emitted no anchor message. Without a chronological fallback,
    // `items.push` would land the item at the bottom of the array,
    // which on a later turn sinks it below new workflow surfaces and
    // new messages from that turn. Use the same `createdAtMs`-based
    // slot that `appendWorkflowSurfaces` falls back to.
    insertAtChronologicalSlot(items, inline, inline.createdAtMs);
  }
}

function appendLiveMessages(
  items: ConversationItem[],
  pastItems: ConversationItem[],
  messages: Message[],
): void {
  const pastIds = new Set<string>();
  for (const item of pastItems) {
    if (item.kind === 'message') pastIds.add(item.message.id);
  }

  for (const m of messages) {
    if (pastIds.has(m.id)) continue;
    items.push({ kind: 'message', message: m });
  }
}

export interface BuildLiveConversationItemsParams {
  pastItems: ConversationItem[];
  reducer: ConversationReducerSlice;
  isTerminalStatus: boolean;
  currentRun: SessionSeed | null;
  effectiveStatus: string | null;
}

/** Merge past items, live reducer messages, surfaces, inline UI, and terminal separator. */
export function buildLiveConversationItems({
  pastItems,
  reducer,
  isTerminalStatus,
  currentRun,
  effectiveStatus,
}: BuildLiveConversationItemsParams): ConversationItem[] {
  const items: ConversationItem[] = [...pastItems];
  appendLiveMessages(items, pastItems, reducer.messages);

  if (isTerminalStatus && currentRun && effectiveStatus != null) {
    const sepId = `sep-${currentRun.sessionId}`;
    if (!items.some((item) => item.kind === 'run-separator' && item.id === sepId)) {
      items.push({
        kind: 'run-separator',
        id: sepId,
        status: effectiveStatus,
        ...(effectiveStatus !== 'FAILED'
          ? {
              errorMessage: reducer.errorMessage,
              ...(reducer.errorDetail ? { errorDetail: reducer.errorDetail } : {}),
            }
          : {}),
        timestamp: new Date().toISOString(),
      });
    }
  }

  appendWorkflowSurfaces(items, reducer.workflowSurfaceItems);
  appendInlineUiItems(items, reducer.inlineItems);
  return items;
}

export interface SnapshotTerminalSegmentParams {
  reducer: ConversationReducerSlice;
  currentRun: SessionSeed;
  effectiveStatus: string;
  userMsg: Message;
  alreadySnapshotted: boolean;
  /** Existing past items — used to skip messages already snapshotted. */
  pastItems: ConversationItem[];
}

/**
 * Build conversation items to append when the user sends a message on a
 * terminal run and starts a new session segment.
 */
export function snapshotTerminalSegmentItems({
  reducer,
  currentRun,
  effectiveStatus,
  userMsg,
  alreadySnapshotted,
  pastItems,
}: SnapshotTerminalSegmentParams): ConversationItem[] {
  const additions: ConversationItem[] = [];
  if (!alreadySnapshotted) {
    const pastIds = new Set<string>();
    for (const item of pastItems) {
      if (item.kind === 'message') pastIds.add(item.message.id);
    }
    const segmentMessages: ConversationItem[] = [];
    for (const m of reducer.messages) {
      if (!pastIds.has(m.id)) {
        segmentMessages.push({ kind: 'message', message: m });
      }
    }
    appendWorkflowSurfaces(segmentMessages, reducer.workflowSurfaceItems);
    appendInlineUiItems(segmentMessages, reducer.inlineItems);
    additions.push(...segmentMessages);
    additions.push({
      kind: 'run-separator',
      id: `sep-${currentRun.sessionId}`,
      status: effectiveStatus,
      errorMessage: reducer.errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
  additions.push({ kind: 'message', message: userMsg });
  return additions;
}
