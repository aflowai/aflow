import { detectGuardrailContent } from '../guardrail/detectGuardrailContent.js';
import { isComputeResult } from '../compute/ComputeResultCard.js';
import type { ConversationItem, Message, RunSeparatorItem } from '../../lib/types.js';
import type { WorkflowRunSurfaceState } from '../../lib/types.js';

/** Semantic types that have dedicated rich renderers — never collapse these. */
const SPECIAL_SEMANTIC_TYPES = new Set([
  'guardrail_policy',
  'guardrail_violations',
  'surface',
  'streamable_surface',
  'ui_artifact',
  'compute_result',
  'workflow_run_status',
  'workflow_evaluation',
  'workflow_ledger',
  'inline_hitl',
  'inline_proposal_focus',
]);

/** `workflow.run.detail` DTO — not a start/resume/cancel status card. */
function isWorkflowRunDetailOutput(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj['run'] === 'object' &&
    obj['run'] !== null &&
    Array.isArray(obj['tasks']) &&
    Array.isArray(obj['activeWaiters'])
  );
}

/** Check whether a message tagged `isInterim` is actually safe to collapse. */
function isCollapsibleInterim(msg: Message): boolean {
  if (!msg.isInterim) return false;
  // Agent messages communicate progress/pivots — always show inline.
  if (msg.id.startsWith('agent-msg-')) return false;
  // Subflow agent messages likewise — show inline (indented under the subflow label).
  if (msg.id.startsWith('subflow-msg-')) return false;
  // Promoted streaming text retains its `streaming-…` id but is the agent's voice.
  if (msg.id.startsWith('streaming-')) return false;
  if (msg.mediaItems && msg.mediaItems.length > 0) return false;
  if (msg.semanticType && SPECIAL_SEMANTIC_TYPES.has(msg.semanticType)) {
    // Detail output was mis-tagged `workflow_run_status` before the catalog
    // fix; WorkflowRunStatusCard never matched this shape anyway. Collapse it
    // like list_attention and other generic interim tool output.
    if (!(
      msg.semanticType === 'workflow_run_status' && isWorkflowRunDetailOutput(msg.richContent)
    )) {
      return false;
    }
  }
  if (msg.richContent) {
    if (detectGuardrailContent(msg.richContent)) return false;
    if (isComputeResult(msg.richContent)) return false;
    const obj = msg.richContent as Record<string, unknown>;
    if (typeof obj['html'] === 'string' && obj['rendererMetadata'] != null) return false;
  }
  return true;
}

export type RenderItem =
  | { kind: 'message'; message: Message; showSubflowHeader: boolean }
  | { kind: 'run-separator'; item: RunSeparatorItem }
  | {
      kind: 'workflow_run_surface';
      runId: string;
      revision: number;
      anchorStepExecutionId?: string;
      frozenSnapshot?: WorkflowRunSurfaceState;
      displaySource?: 'op';
    }
  | {
      kind: 'inline_artifact';
      itemId: string;
      anchorStepExecutionId: string;
      artifactId: string;
      versionId: string;
      data?: unknown;
      workflowRunId?: string;
    }
  | {
      kind: 'inline_surface';
      itemId: string;
      anchorStepExecutionId: string;
      surfaceId: string;
      isStreaming: boolean;
      mutations: Array<Record<string, unknown>>;
      workflowRunId?: string;
    }
  | {
      kind: 'inline_applet';
      itemId: string;
      anchorStepExecutionId: string;
      instanceId: string;
      frozen?: true;
      workflowRunId?: string;
    }
  | {
      kind: 'interim-group';
      id: string;
      messages: Message[];
      subflowSource?: string;
      subflowLabel?: string;
      showSubflowHeader: boolean;
      /** This group immediately follows another same-subflow group (only interim agent messages between them). */
      continuesFrom?: boolean;
      /** Another same-subflow group immediately follows this one. */
      continuedBy?: boolean;
    };

export function groupConversationItems(items: ConversationItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  let interimBatch: Message[] = [];

  const flushBatch = () => {
    const first = interimBatch[0];
    if (first === undefined) return;
    const subflowSource = first.subflowSource;
    const subflowLabel = first.subflowLabel;
    result.push({
      kind: 'interim-group',
      id: `interim-${first.id}`,
      messages: interimBatch,
      ...(subflowSource ? { subflowSource } : {}),
      ...(subflowLabel ? { subflowLabel } : {}),
      showSubflowHeader: false, // filled in by annotateClusters
    });
    interimBatch = [];
  };

  for (const item of items) {
    if (item.kind === 'run-separator') {
      flushBatch();
      result.push({ kind: 'run-separator', item });
    } else if (item.kind === 'workflow_run_surface') {
      flushBatch();
      result.push({
        kind: 'workflow_run_surface',
        runId: item.runId,
        revision: item.revision,
        ...(item.anchorStepExecutionId
          ? { anchorStepExecutionId: item.anchorStepExecutionId }
          : {}),
        ...(item.frozenSnapshot ? { frozenSnapshot: item.frozenSnapshot } : {}),
        ...(item.displaySource ? { displaySource: item.displaySource } : {}),
      });
    } else if (item.kind === 'inline_artifact') {
      flushBatch();
      result.push({
        kind: 'inline_artifact',
        itemId: item.itemId,
        anchorStepExecutionId: item.anchorStepExecutionId,
        artifactId: item.artifactId,
        versionId: item.versionId,
        ...(item.data !== undefined ? { data: item.data } : {}),
        ...(item.workflowRunId ? { workflowRunId: item.workflowRunId } : {}),
      });
    } else if (item.kind === 'inline_surface') {
      flushBatch();
      result.push({
        kind: 'inline_surface',
        itemId: item.itemId,
        anchorStepExecutionId: item.anchorStepExecutionId,
        surfaceId: item.surfaceId,
        isStreaming: item.isStreaming,
        mutations: item.mutations,
        ...(item.workflowRunId ? { workflowRunId: item.workflowRunId } : {}),
      });
    } else if (item.kind === 'inline_applet') {
      flushBatch();
      result.push({
        kind: 'inline_applet',
        itemId: item.itemId,
        anchorStepExecutionId: item.anchorStepExecutionId,
        instanceId: item.instanceId,
        ...(item.workflowRunId ? { workflowRunId: item.workflowRunId } : {}),
      });
    } else if (item.message.id.startsWith('surface-action-')) {
      // Surface action chips pass through as regular messages
      flushBatch();
      result.push({ kind: 'message', message: item.message, showSubflowHeader: false });
    } else if (isCollapsibleInterim(item.message)) {
      // Flush when switching between subflow/main or between different subflows
      const batchSource = interimBatch[0]?.subflowSource;
      if (interimBatch.length > 0 && batchSource !== item.message.subflowSource) {
        flushBatch();
      }
      interimBatch.push(item.message);
    } else {
      flushBatch();
      result.push({ kind: 'message', message: item.message, showSubflowHeader: false });
    }
  }
  flushBatch();
  return annotateGroupContinuations(annotateClusters(result));
}

/**
 * Identify runs of same-subflow interim-groups separated only by interim agent
 * messages, and annotate them as visual chains: `continuesFrom` on the follower,
 * `continuedBy` on the leader. The CSS then removes the shared border-radius and
 * collapses the margin so the boxes read as one connected cluster rather than
 * independent cards.
 */
function annotateGroupContinuations(items: RenderItem[]): RenderItem[] {
  const out = items.slice();
  let prevGroupIdx: number | null = null;
  let prevSubflow: string | undefined;

  for (let i = 0; i < out.length; i++) {
    const ri = out[i];
    if (ri === undefined) continue;
    if (ri.kind === 'interim-group') {
      if (prevGroupIdx !== null && ri.subflowSource === prevSubflow) {
        const leader = out[prevGroupIdx];
        if (leader?.kind === 'interim-group') {
          out[prevGroupIdx] = { ...leader, continuedBy: true };
        }
        out[i] = { ...ri, continuesFrom: true };
      }
      prevGroupIdx = i;
      prevSubflow = ri.subflowSource;
    } else if (
      ri.kind === 'message' &&
      ri.message.isInterim === true &&
      (ri.message.id.startsWith('agent-msg-') || ri.message.id.startsWith('streaming-'))
    ) {
      // Bridge message — keep the chain open, don't reset prevGroupIdx
    } else {
      prevGroupIdx = null;
      prevSubflow = undefined;
    }
  }

  return out;
}

/**
 * Mark each render item as the start of a subflow cluster (showSubflowHeader=true)
 * when its `subflowSource` differs from the previous item's. Run separators and
 * main-thread (non-subflow) items reset the cluster, so the next subflow message
 * gets a fresh header — including for parallel/interleaved subflows.
 */
function annotateClusters(items: RenderItem[]): RenderItem[] {
  let lastSubflowSource: string | undefined;
  return items.map((ri) => {
    if (ri.kind === 'run-separator') {
      lastSubflowSource = undefined;
      return ri;
    }
    if (ri.kind === 'workflow_run_surface') {
      lastSubflowSource = undefined;
      return ri;
    }
    if (
      ri.kind === 'inline_artifact' ||
      ri.kind === 'inline_surface' ||
      ri.kind === 'inline_applet'
    ) {
      lastSubflowSource = undefined;
      return ri;
    }
    const src = ri.kind === 'message' ? ri.message.subflowSource : ri.subflowSource;
    const showSubflowHeader = Boolean(src) && src !== lastSubflowSource;
    lastSubflowSource = src;
    return { ...ri, showSubflowHeader };
  });
}
