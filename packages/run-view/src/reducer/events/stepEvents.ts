import type {
  InlineAppletItem,
  InlineArtifactItem,
  InlineHitlPayload,
  InlineSurfaceItem,
  Message,
  SessionEvent,
  StateValueRef,
} from '../../types.js';
import { extractDisplayContent } from '../../content-extraction.js';
import type { RunViewState } from '../state.js';
import {
  toISOTimestamp,
  extractSessionSurfaceMutations,
  decodeInlineOutput,
  placeAppletCard,
  isInternalVariable,
} from '../helpers.js';

import type { SseEventContext } from './sessionLifecycle.js';

export function applyStepEvents(
  state: RunViewState,
  event: SessionEvent,
  ctx: SseEventContext,
): RunViewState {
  const { stepSenderName, stepDetail, eventTimestampMs } = ctx;
  let next = state;
  // Stamped by the orchestrator from the step's own resolved fulfillment. The
  // run banner needs the binding to name what is being rehearsed; the timeline
  // badge needs the flag to say which of a mixed run's facts were fabricated.
  const simulatedStep = event.metadata?.simulated === true;
  if (simulatedStep) {
    const bindingId = event.metadata?.simulatedBindingId;
    if (typeof bindingId === 'string' && !next.simulatedBindings.includes(bindingId)) {
      next = { ...next, simulatedBindings: [...next.simulatedBindings, bindingId] };
    }
  }
  const simulatedMark = simulatedStep ? { simulated: true as const } : {};
  if (event.eventType === 'StepSucceeded') {
    if (event.metadata?.operationId === 'human.action_center.focus') {
      const decoded = decodeInlineOutput(event.data.payloadRef);
      if (decoded && typeof decoded === 'object') {
        const obj = decoded as Record<string, unknown>;
        const itemId = typeof obj.itemId === 'string' ? obj.itemId : null;
        if (itemId) {
          const focusMsgId = `inline-focus-${itemId}`;
          if (!next.messages.some((m) => m.id === focusMsgId)) {
            const focusMsg: Message = {
              id: focusMsgId,
              role: 'assistant',
              content: '',
              semanticType: 'inline_proposal_focus',
              richContent: {
                itemId,
                ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
              },
              timestamp: toISOTimestamp(event.timestamp),
            };
            next = { ...next, messages: [...next.messages, focusMsg] };
          }
        }
      }
    }

    const presentation = event.data.presentation;
    if (presentation?.mode === 'rendered_inline' && event.stepExecutionId !== undefined) {
      if (presentation.substrate === 'workflow_run') {
        const runId = presentation.runId;
        const anchor = event.stepExecutionId;
        const withoutPriorDisplay = next.workflowSurfaceItems.filter(
          (it) => !(it.runId === runId && it.displaySource === 'op'),
        );
        const alreadyAtAnchor = withoutPriorDisplay.some(
          (it) => it.runId === runId && it.anchorStepExecutionId === anchor,
        );
        next = {
          ...next,
          workflowSurfaceItems: alreadyAtAnchor
            ? withoutPriorDisplay
            : [
                ...withoutPriorDisplay,
                {
                  runId,
                  anchorStepExecutionId: anchor,
                  revision: 0,
                  createdAtMs: eventTimestampMs,
                  displaySource: 'op',
                },
              ],
        };
      } else if (presentation.substrate === 'applet') {
        // A re-reference moves the one card for this instance to the new
        // anchor — the board follows what the agent last did with it, rather
        // than a copy of it being left behind at every step that touched it.
        const instanceId = presentation.instanceId;
        const anchor = event.stepExecutionId;
        const inlineItem: InlineAppletItem = {
          kind: 'inline_applet',
          itemId: `session:${anchor}`,
          anchorStepExecutionId: anchor,
          instanceId,
          createdAtMs: eventTimestampMs,
        };
        next = { ...next, inlineItems: placeAppletCard(next.inlineItems, inlineItem) };
      } else {
        const inlineId = `session:${event.stepExecutionId}`;
        const inlineItem =
          presentation.substrate === 'artifact'
            ? ({
                kind: 'inline_artifact',
                itemId: inlineId,
                anchorStepExecutionId: event.stepExecutionId,
                artifactId: presentation.artifactId,
                versionId: presentation.versionId,
                ...(presentation.data !== undefined ? { data: presentation.data } : {}),
                createdAtMs: eventTimestampMs,
              } satisfies InlineArtifactItem)
            : ({
                kind: 'inline_surface',
                itemId: inlineId,
                anchorStepExecutionId: event.stepExecutionId,
                surfaceId: presentation.surfaceId,
                // Session-scoped surfaces complete with the step; the
                // streaming path (live mutations) flows through
                // `SurfaceUpdate` events which the existing handler
                // accumulates into a `surface-{surfaceId}` message
                // (`richContent.mutations`). When this terminal
                // StepSucceeded lands, hoist those mutations onto
                // the inline item — Phase 3 review fix. Without this,
                // the inline card mounts empty even though mutations
                // were streamed earlier in the run.
                isStreaming: false,
                mutations: extractSessionSurfaceMutations(next, presentation.surfaceId, inlineId),
                createdAtMs: eventTimestampMs,
              } satisfies InlineSurfaceItem);
        next = {
          ...next,
          inlineItems: { ...next.inlineItems, [inlineId]: inlineItem },
        };
        // Phase 3 review fix — drop the `surface-{surfaceId}` message
        // now that its mutations have been hoisted onto the inline
        // card. Leaving both would render the surface twice (once as
        // a chat bubble, once as an inline card).
        if (presentation.substrate === 'surface') {
          const surfaceMessageId = `surface-${presentation.surfaceId}`;
          if (next.messages.some((m) => m.id === surfaceMessageId)) {
            next = {
              ...next,
              messages: next.messages.filter((m) => m.id !== surfaceMessageId),
            };
          }
        }
      }
    }

    const inlineHitlMsgId = `inline-hitl-${event.stepExecutionId ?? ''}`;
    const inlineHitlIdx = next.messages.findIndex((m) => m.id === inlineHitlMsgId);
    if (inlineHitlIdx >= 0) {
      const prev = next.messages[inlineHitlIdx].richContent as InlineHitlPayload | undefined;
      if (prev?.status === 'open') {
        // The resolved user.interaction.* step's output is the resume
        // payload itself (`{input, providedAt, providedBy}` or
        // `{decision, decidedBy, comment, decidedAt}`), which the
        // orchestrator stores as `inline:<base64-json>` because resume
        // payloads are small. The canonical API event carries it on
        // `data.payloadRef` (see `ApiSessionEventDataSchema` in
        // `packages/schemas/src/runtime/apiEvents.ts`) — NOT on
        // `data.output` (which doesn't exist on the wire). Decode the
        // inline ref synchronously here; non-inline GCS refs are
        // skipped and the resolution falls back to a kind-only badge
        // without a value (would need an async fetch we don't do in
        // a pure reducer). For user.interaction.* this is fine —
        // those payloads are always inline.
        const out =
          (decodeInlineOutput(event.data.payloadRef) as
            Record<string, unknown> | null | undefined) ?? undefined;
        let resolution: InlineHitlPayload['resolution'];
        if (prev.hitlKind === 'human_approval') {
          const decisionRaw = out?.decision;
          const decision: 'approved' | 'rejected' =
            decisionRaw === 'rejected' ? 'rejected' : 'approved';
          resolution = {
            kind: 'approval',
            decision,
            ...(typeof out?.comment === 'string' ? { comment: out.comment } : {}),
            decidedAt:
              typeof out?.decidedAt === 'string' ? out.decidedAt : toISOTimestamp(event.timestamp),
            ...(typeof out?.decidedBy === 'string' ? { decidedBy: out.decidedBy } : {}),
          };
        } else {
          resolution = {
            kind: 'input',
            value: out?.input,
            providedAt:
              typeof out?.providedAt === 'string'
                ? out.providedAt
                : toISOTimestamp(event.timestamp),
            ...(typeof out?.providedBy === 'string' ? { providedBy: out.providedBy } : {}),
          };
        }
        const msgs = [...next.messages];
        msgs[inlineHitlIdx] = {
          ...msgs[inlineHitlIdx],
          richContent: { ...prev, status: 'resolved', resolution },
        };
        next = { ...next, messages: msgs };
      }
    }

    const agentMsg = (event.data.agentMessage ?? event.metadata?.agentMessage) as
      string | undefined;

    // Promote streaming text placeholder in-place
    let streamPromoted = false;
    if (next.streamingStepExecutionId === event.stepExecutionId) {
      const streamMsgId = `streaming-${event.stepExecutionId}`;
      const idx = next.messages.findIndex((m) => m.id === streamMsgId);
      if (idx >= 0) {
        const msgs = [...next.messages];
        const { semanticType: _semType, ...kept } = msgs[idx];
        // If agentMessage is present, prefer it as the canonical persisted text.
        // Otherwise keep the streamed text (it's the only record we have).
        const finalContent = agentMsg ?? kept.content;
        msgs[idx] = {
          ...kept,
          content: finalContent,
          senderName: stepSenderName ?? kept.senderName,
          ...(stepDetail ? { stepDetail } : {}),
          ...(agentMsg ? { isInterim: true } : {}),
        };
        next = { ...next, streamingStepExecutionId: null, messages: msgs };
        streamPromoted = true;
      } else {
        next = { ...next, streamingStepExecutionId: null };
      }
    }

    // Clear thinking placeholder — ephemeral, not persisted
    const thinkingMsgId = `thinking-${event.stepExecutionId}`;
    if (next.messages.some((m) => m.id === thinkingMsgId)) {
      next = { ...next, messages: next.messages.filter((m) => m.id !== thinkingMsgId) };
    }

    // Add a separate interim message only if there was no streaming msg
    // to promote (otherwise the promoted msg already carries agentMessage).
    if (agentMsg && !streamPromoted) {
      const interimMsg: Message = {
        id: `agent-msg-${event.eventId}`,
        role: 'assistant',
        content: agentMsg,
        timestamp: toISOTimestamp(event.timestamp),
        senderName: stepSenderName,
        ...(stepDetail ? { stepDetail } : {}),
        isInterim: true,
        ...(event.stepExecutionId ? { stepExecutionId: event.stepExecutionId } : {}),
      };
      if (!next.messages.some((m) => m.id === interimMsg.id)) {
        next = { ...next, messages: [...next.messages, interimMsg] };
      }
    }
  }

  // Step output with runtime state patch → assistant message
  // displayOutput in event metadata is set by the orchestrator when the step
  // definition has outputOptions.displayToUser: true. Default is hidden
  // (agent processes the output further before presenting results).
  // Session-terminal events (SessionSucceeded) always show output regardless.
  //
  const hasSurfaceMessage = next.messages.some(
    (m) => m.semanticType === 'surface' || m.semanticType === 'streamable_surface',
  );
  const stepOperationId = (event.metadata?.operationId ?? event.data.operationId) as
    string | undefined;
  const isWorkflowRunCarrierStep =
    stepOperationId === 'workflow.run.start' || stepOperationId === 'workflow.run.resume';
  if (
    (event.eventType === 'StepSucceeded' || event.eventType === 'StepCompleted') &&
    !hasSurfaceMessage &&
    !isWorkflowRunCarrierStep
  ) {
    const shouldDisplay =
      event.metadata?.displayOutput === true || event.data.displayOutput === true;
    const patch = event.data.runtimeStatePatch as
      | {
          changed?: Array<{
            key: string;
            value?: { ref?: StateValueRef };
          }>;
        }
      | undefined;

    // Track whether any user-facing content was actually rendered from the patch.
    let renderedFromPatch = false;

    if (patch?.changed && patch.changed.length > 0 && shouldDisplay) {
      for (const change of patch.changed) {
        // Skip internal tracking variables — they're not user-facing output
        if (isInternalVariable(change.key)) continue;

        const extracted = extractDisplayContent(change.value?.ref);
        if (extracted) {
          renderedFromPatch = true;
          const newMsg: Message = {
            id: `${event.eventId}-${change.key}`,
            role: 'assistant',
            content: extracted.text,
            richContent: extracted.richData,
            mediaItems: extracted.mediaItems,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: stepSenderName,
            ...(stepDetail ? { stepDetail } : {}),
            isInterim: true,
            ...simulatedMark,
            ...(extracted.payloadRef ? { payloadRef: extracted.payloadRef } : {}),
            ...(extracted.semanticType ? { semanticType: extracted.semanticType } : {}),
          };
          if (!next.messages.some((m) => m.id === newMsg.id)) {
            next = { ...next, messages: [...next.messages, newMsg] };
          }
        }
      }
    }

    if (!renderedFromPatch && shouldDisplay) {
      // No user-facing state patch — check for direct output.
      // This covers: (a) steps with no patch at all, (b) virtual tools
      // whose patch only contains internal variables (_tool_outputs).
      // The orchestrator includes resolvedOutput in metadata for displayable
      const resolvedOutput = (event.metadata?.resolvedOutput ?? event.data.resolvedOutput) as
        | {
            kind?: string;
            value?: unknown;
            preview?: { text?: string; json?: unknown };
          }
        | undefined;

      if (resolvedOutput) {
        const extracted = extractDisplayContent(resolvedOutput as StateValueRef);
        if (extracted) {
          const newMsg: Message = {
            id: event.eventId,
            role: 'assistant',
            content: extracted.text,
            richContent: extracted.richData,
            mediaItems: extracted.mediaItems,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: stepSenderName,
            ...(stepDetail ? { stepDetail } : {}),
            isInterim: true,
            ...simulatedMark,
            // A tool's displayed result names its step, so a card reading the
            // step's live feed folds that feed above the result.
            ...(event.stepExecutionId ? { stepExecutionId: event.stepExecutionId } : {}),
            ...(extracted.semanticType ? { semanticType: extracted.semanticType } : {}),
          };
          if (!next.messages.some((m) => m.id === newMsg.id)) {
            next = { ...next, messages: [...next.messages, newMsg] };
          }
        }
      } else {
        const content =
          typeof event.data.displayOutput === 'string'
            ? event.data.displayOutput
            : typeof event.data.output === 'string'
              ? event.data.output
              : null;
        if (content) {
          const newMsg: Message = {
            id: event.eventId,
            role: 'assistant',
            content,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: stepSenderName,
            ...(stepDetail ? { stepDetail } : {}),
            isInterim: true,
            ...simulatedMark,
          };
          if (!next.messages.some((m) => m.id === newMsg.id)) {
            next = { ...next, messages: [...next.messages, newMsg] };
          }
        }
      }
    }
  }

  return next;
}
