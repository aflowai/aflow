import {
  getFailedRunFallbackMessage,
  SessionBlockedOnSchema,
  shouldExposeFailedRunUserError,
} from '@aflow/schemas';
import type { SessionBlockedOn } from '@aflow/schemas';
import type {
  InlineHitlPayload,
  Message,
  RunErrorDetail,
  SessionEvent,
  StateValueRef,
} from '../../types.js';
import { extractDisplayContent } from '../../content-extraction.js';
import type { RunViewState } from '../state.js';
import {
  toISOTimestamp,
  extractErrorMessage,
  extractErrorClassification,
  extractUserError,
} from '../helpers.js';

export interface SseEventContext {
  flowName?: string;
  eventTimestampMs: number;
  stepSenderName: string | undefined;
  stepDetail: string | undefined;
  stepDetailCacheNext: Record<string, string>;
}

function readBlockedOnMetadata(event: SessionEvent): SessionBlockedOn | undefined {
  const raw = event.metadata?.blockedOn ?? event.data.blockedOn;
  if (raw == null) return undefined;
  const parsed = SessionBlockedOnSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Server-stamped authorship. A client-supplied author would be a forgery. */
function readAuthor(event: SessionEvent): Pick<Message, 'authorUserId' | 'authorDisplayName'> {
  const actorUserId = (event.data.actorUserId ?? event.metadata?.actorUserId) as string | undefined;
  const displayName = (event.data.actorDisplayName ?? event.metadata?.actorDisplayName) as
    string | undefined;
  return {
    ...(actorUserId ? { authorUserId: actorUserId } : {}),
    ...(displayName ? { authorDisplayName: displayName } : {}),
  };
}

function foldEchoedUserMessage(
  messages: Message[],
  id: string,
  content: string,
  timestamp: string,
  author: Pick<Message, 'authorUserId' | 'authorDisplayName' | 'messageSeq'> = {},
): Message[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) {
    return [...messages, { id, role: 'user', content, timestamp, ...author }];
  }
  const existing = messages[idx];
  // Only an un-acked local echo may be merged into. A settled message is
  // never rewritten: the id comes from the client, so adopting an existing
  // entry would let anyone restamp someone else's line with their own name.
  if (!existing.deliveryState) return messages;
  const msgs = [...messages];
  const { deliveryState: _delivered, ...kept } = existing;
  msgs[idx] = { ...kept, ...author };
  return msgs;
}

export function applySessionLifecycleEvents(
  state: RunViewState,
  event: SessionEvent,
  ctx: SseEventContext,
): RunViewState {
  const { stepSenderName, flowName } = ctx;
  let next = { ...state, _stepDetailCache: ctx.stepDetailCacheNext };
  if (event.eventType === 'SessionQueued') {
    next = { ...next, status: 'QUEUED' };
  }

  // Someone talking in the room. Carries no status change by construction —
  // posting a message is the one write to a session that does not advance it.
  const readMessageSeq = (): number | undefined => {
    const raw = event.data.messageSeq ?? event.metadata?.messageSeq;
    return typeof raw === 'number' ? raw : undefined;
  };

  if (event.eventType === 'RoomMessage') {
    const body = (event.data.body ?? event.metadata?.body) as string | undefined;
    if (body) {
      const clientMessageId = (event.data.clientMessageId ?? event.metadata?.clientMessageId) as
        string | undefined;
      const messageSeq = readMessageSeq();
      const id = clientMessageId ?? `room-${event.eventId}`;
      const folded = foldEchoedUserMessage(
        next.messages,
        id,
        body,
        toISOTimestamp(event.timestamp),
        {
          ...readAuthor(event),
          ...(typeof messageSeq === 'number' ? { messageSeq } : {}),
        },
      );
      if (folded !== next.messages) next = { ...next, messages: folded };
    }
  }

  if (event.eventType === 'SessionStarted') {
    next = { ...next, status: 'RUNNING', blockedOn: null };

    // Reconstruct user message from event metadata (for chat history).
    const startUserMsg = (event.data.userMessage ?? event.metadata?.userMessage) as
      string | undefined;
    if (startUserMsg) {
      const clientMessageId = (event.data.clientMessageId ?? event.metadata?.clientMessageId) as
        string | undefined;
      const id = clientMessageId ?? `user-${event.eventId}`;
      const messageSeq = readMessageSeq();
      const folded = foldEchoedUserMessage(
        next.messages,
        id,
        startUserMsg,
        toISOTimestamp(event.timestamp),
        {
          ...readAuthor(event),
          ...(messageSeq !== undefined ? { messageSeq } : {}),
        },
      );
      if (folded !== next.messages) next = { ...next, messages: folded };
    }
  }

  if (event.eventType === 'SessionResumed') {
    // When resume was rerouted to a child (child-input relay), the parent
    // transitions to WAITING_ON_CHILD, not RUNNING.
    const routedToChildId = event.metadata?.routedToChildRun ?? event.data.routedToChildRun;
    const routedToChild = routedToChildId != null;
    next = {
      ...next,
      status: routedToChild ? 'WAITING_ON_CHILD' : 'RUNNING',
      requiredInput: null,
      blockedOn: routedToChild
        ? {
            kind: 'child_session',
            sessionIds: typeof routedToChildId === 'string' ? [routedToChildId] : [],
          }
        : null,
    };

    // Reconstruct user message from event metadata (for chat history).
    const resumeUserMsg = (event.data.userMessage ?? event.metadata?.userMessage) as
      string | undefined;
    if (resumeUserMsg) {
      const clientMessageId = (event.data.clientMessageId ?? event.metadata?.clientMessageId) as
        string | undefined;
      const id = clientMessageId ?? `user-${event.eventId}`;
      const messageSeq = readMessageSeq();
      const folded = foldEchoedUserMessage(
        next.messages,
        id,
        resumeUserMsg,
        toISOTimestamp(event.timestamp),
        {
          ...readAuthor(event),
          ...(messageSeq !== undefined ? { messageSeq } : {}),
        },
      );
      if (folded !== next.messages) next = { ...next, messages: folded };
    }
  }

  if (
    event.eventType === 'SessionSucceeded' ||
    event.eventType === 'SessionCompleted' ||
    event.eventType === 'SessionFailed' ||
    event.eventType === 'SessionCancelled'
  ) {
    const newStatus =
      event.eventType === 'SessionSucceeded' || event.eventType === 'SessionCompleted'
        ? 'SUCCEEDED'
        : event.eventType === 'SessionFailed'
          ? 'FAILED'
          : 'CANCELLED';
    next = { ...next, status: newStatus, requiredInput: null, blockedOn: null };

    // Extract error details for failed runs (state only — no chat message).
    // The run separator line renders the error info above the "Failed" divider.
    if (event.eventType === 'SessionFailed') {
      const ue = extractUserError(event);
      const classification = extractErrorClassification(event);
      const errorText =
        ue?.message ??
        (classification && !shouldExposeFailedRunUserError(classification)
          ? getFailedRunFallbackMessage(classification)
          : extractErrorMessage(event));
      const detail: RunErrorDetail = {
        stepName:
          (event.metadata?.stepName as string | undefined) ??
          (event.data.stepName as string | undefined),
        errorCode:
          (event.metadata?.errorCode as string | undefined) ??
          (event.data.errorCode as string | undefined),
        operationId:
          (event.metadata?.operationId as string | undefined) ??
          (event.data.operationId as string | undefined),
      };
      if (ue) {
        next = { ...next, userError: ue, errorMessage: ue.message, errorDetail: detail };
      } else if (errorText) {
        next = { ...next, errorMessage: errorText, errorDetail: detail };
      }
    }
  }

  // Step failures are not shown in the chat — they're traceable in the
  // run inspector. Only session-level failures surface in the chat via the
  // run separator line (which carries errorMessage from SessionFailed).

  if (event.eventType === 'SessionRetried') {
    next = {
      ...next,
      status: 'RUNNING',
      errorMessage: null,
      errorDetail: null,
      userError: null,
      requiredInput: null,
      blockedOn: null,
    };
  }

  if (event.eventType === 'SessionStalled') {
    // STALLED is gating-terminal (composer re-opens) — a lingering
    // descriptor from a prior pause must not survive it.
    next = { ...next, status: 'STALLED', blockedOn: null };
    const reason =
      (event.data.pauseReason as string | undefined) ??
      'Flow engine is not running. The run was queued but never started.';
    const stalledMsg: Message = {
      id: `stalled-${event.eventId}`,
      role: 'system',
      content: reason,
      timestamp: toISOTimestamp(event.timestamp),
    };
    if (!next.messages.some((m) => m.id === stalledMsg.id)) {
      next = { ...next, messages: [...next.messages, stalledMsg] };
    }
  }

  if (event.eventType === 'SessionPaused') {
    let streamPromoted = false;
    if (next.streamingStepExecutionId) {
      const streamMsgId = `streaming-${next.streamingStepExecutionId}`;
      const idx = next.messages.findIndex((m) => m.id === streamMsgId);
      if (idx >= 0) {
        const msgs = [...next.messages];
        const { semanticType: _, ...kept } = msgs[idx];
        msgs[idx] = kept;
        next = { ...next, streamingStepExecutionId: null, messages: msgs };
        streamPromoted = true;
      } else {
        next = { ...next, streamingStepExecutionId: null };
      }
    }

    const isSubflowWaiting =
      event.metadata?.subflowWaiting === true || event.data.subflowWaiting === true;

    // Extract pauseType early — needed for interrupt check before the else branch
    const pauseType = (event.metadata?.pauseType ?? event.data.pauseType) as string | undefined;

    const explicitBlockedOn = readBlockedOnMetadata(event);
    const pausedStepExecutionId =
      (event.data.stepExecutionId as string | undefined) ?? event.stepExecutionId ?? '';
    const derivedUserInputBlockedOn: SessionBlockedOn | null = pausedStepExecutionId
      ? { kind: 'user_input', stepExecutionId: pausedStepExecutionId }
      : null;

    if (isSubflowWaiting) {
      // Parent is waiting for a child subflow — use the first-class status
      next = {
        ...next,
        status: 'WAITING_ON_CHILD',
        blockedOn: explicitBlockedOn ?? { kind: 'child_session', sessionIds: [] },
      };
    } else if (pauseType === 'interrupted') {
      const interruptMsg: Message = {
        id: `interrupt-${event.eventId}`,
        role: 'system',
        content: 'Session interrupted',
        timestamp: toISOTimestamp(event.timestamp),
      };
      if (!next.messages.some((m) => m.id === interruptMsg.id)) {
        next = { ...next, messages: [...next.messages, interruptMsg] };
      }
      next = {
        ...next,
        status: 'PAUSED',
        blockedOn: explicitBlockedOn ?? derivedUserInputBlockedOn,
        requiredInput: {
          stepExecutionId: pausedStepExecutionId,
          pauseType: 'interrupted',
        },
      };
    } else {
      const agentResponse = (event.metadata?.agentResponse ?? event.data.agentResponse) as
        string | undefined;
      const pausePrompt = agentResponse
        ? undefined // Agent response = reply is shown; no explicit prompt needed
        : ((event.metadata?.prompt ?? event.data.prompt) as string | undefined);

      const isChildPauseBubble =
        event.metadata?.subflowPause === true || event.data.subflowPause === true;

      // Extract missing variables from state variable gating (Phase B)
      const missingVariables = (event.metadata?.missingVariables ?? event.data.missingVariables) as
        | Array<{
            variableId: string;
            name?: string;
            description?: string;
            typeSchema?: Record<string, unknown>;
            semanticType?: string;
            required?: boolean;
            placeholder?: string;
          }>
        | undefined;

      const subflowStepName = isChildPauseBubble
        ? ((event.metadata?.subflowStepName ?? event.data.subflowStepName) as string | undefined)
        : undefined;

      // Extract responseOptions — check event metadata first, then first missingVariable
      interface RespOpts {
        type: 'single' | 'multi';
        options: Array<{ value: string; label?: string }>;
      }
      const responseOptions =
        ((event.metadata?.responseOptions ?? event.data.responseOptions) as RespOpts | undefined) ??
        (missingVariables?.[0] as { responseOptions?: RespOpts } | undefined)?.responseOptions;

      const placement = (event.metadata?.placement ?? event.data.placement) as string | undefined;
      const isInlineHitl =
        placement === 'chat_inline' && !isChildPauseBubble && pauseType !== 'interrupted';

      next = {
        ...next,
        status: 'PAUSED',
        blockedOn: explicitBlockedOn ?? derivedUserInputBlockedOn,
        requiredInput: {
          stepExecutionId: pausedStepExecutionId,
          // When the pause is inline-HITL the prompt lives on the
          // inline message; clear `requiredInput.prompt` so the
          // legacy `<ChatMessage senderName="System">` fallback in
          // `ChatMessages.tsx` doesn't double up.
          ...(isInlineHitl ? {} : { prompt: pausePrompt }),
          ...(pauseType ? { pauseType } : {}),
          ...(missingVariables && missingVariables.length > 0 ? { missingVariables } : {}),
          ...(isChildPauseBubble ? { subflowPause: true } : {}),
          ...(subflowStepName ? { subflowStepName } : {}),
          ...(responseOptions ? { responseOptions } : {}),
          ...(isInlineHitl ? { placement: 'chat_inline' as const } : {}),
        },
      };

      if (isInlineHitl) {
        const stepExecutionId = pausedStepExecutionId;
        const kindRaw = (event.metadata?.kind ?? event.data.kind) as string | undefined;
        const hitlKind: 'human_input' | 'human_approval' =
          kindRaw === 'approval' ? 'human_approval' : 'human_input';
        const title = (event.metadata?.title ?? event.data.title) as string | undefined;
        const body =
          hitlKind === 'human_input'
            ? (((event.metadata?.prompt ?? event.data.prompt) as string | undefined) ?? '')
            : (((event.metadata?.description ?? event.data.description) as string | undefined) ??
              '');
        const reviewData = event.metadata?.reviewData ?? event.data.reviewData;
        const inputSchema = (event.metadata?.inputSchema ?? event.data.inputSchema) as
          Record<string, unknown> | undefined;
        const uiHints = (event.metadata?.uiHints ?? event.data.uiHints) as
          InlineHitlPayload['uiHints'] | undefined;

        const payload: InlineHitlPayload = {
          itemId: `step:${stepExecutionId}`,
          stepExecutionId,
          hitlKind,
          ...(title ? { title } : {}),
          body,
          ...(reviewData !== undefined ? { reviewData } : {}),
          ...(inputSchema ? { inputSchema } : {}),
          ...(uiHints ? { uiHints } : {}),
          status: 'open',
        };

        const hitlMsg: Message = {
          id: `inline-hitl-${stepExecutionId}`,
          role: 'assistant',
          content: title ?? body.slice(0, 200),
          richContent: payload,
          semanticType: 'inline_hitl',
          timestamp: toISOTimestamp(event.timestamp),
          ...(stepExecutionId ? { stepExecutionId } : {}),
        };
        if (!next.messages.some((m) => m.id === hitlMsg.id)) {
          next = { ...next, messages: [...next.messages, hitlMsg] };
        }
      }

      // Show agent response.
      // Skip if streaming was promoted (content already visible).
      // If a prior message already carries this content, upgrade it in
      // place instead of appending a duplicate. Two strata only:
      //
      // 1. Anchor by step — the StepSucceeded handler for this same step
      //    promotes the `streaming-${stepExecutionId}` msg in place
      //    (keeping its id, clearing `streamingStepExecutionId`), so the
      //    msg is findable BY ID even when `agentResponse` diverges
      //    byte-wise from the streamed text (whitespace, markdown
      //    formatting, narration+prompt merge).
      // 2. Exact-content interim from StepSucceeded.
      //
      if (agentResponse && !streamPromoted) {
        let existingIdx = -1;
        if (event.stepExecutionId) {
          const streamMsgId = `streaming-${event.stepExecutionId}`;
          existingIdx = next.messages.findIndex((m) => m.id === streamMsgId);
        }
        if (existingIdx < 0) {
          existingIdx = next.messages.findIndex((m) => m.content === agentResponse && m.isInterim);
        }
        if (existingIdx >= 0) {
          const msgs = [...next.messages];
          const { isInterim: _, semanticType: _semType, ...kept } = msgs[existingIdx];
          msgs[existingIdx] = { ...kept, content: agentResponse, senderName: stepSenderName };
          next = { ...next, messages: msgs };
        } else {
          const responseMsg: Message = {
            id: `agent-resp-${event.eventId}`,
            role: 'assistant',
            content: agentResponse,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: stepSenderName,
            ...(event.stepExecutionId ? { stepExecutionId: event.stepExecutionId } : {}),
          };
          if (!next.messages.some((m) => m.id === responseMsg.id)) {
            next = { ...next, messages: [...next.messages, responseMsg] };
          }
        }
      }
    }
  }

  // Session completed with output variables → assistant message
  if (event.eventType === 'SessionSucceeded' || event.eventType === 'SessionCompleted') {
    const outputVars = event.data.outputVariables as
      | Array<{
          key: string;
          name?: string;
          value?: StateValueRef;
          semanticType?: string;
        }>
      | undefined;

    if (outputVars && outputVars.length > 0) {
      next = { ...next, outputVariables: outputVars };
      for (const v of outputVars) {
        const extracted = extractDisplayContent(v.value);
        if (extracted) {
          // Prefer semanticType from the extracted content (from StateValueRef),
          // fall back to the output variable's own semanticType declaration.
          const semType = extracted.semanticType ?? v.semanticType;
          const newMsg: Message = {
            id: `${event.eventId}-${v.key}`,
            role: 'assistant',
            content: extracted.text,
            richContent: extracted.richData,
            mediaItems: extracted.mediaItems,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: flowName,
            ...(extracted.payloadRef ? { payloadRef: extracted.payloadRef } : {}),
            ...(semType ? { semanticType: semType } : {}),
          };
          if (!next.messages.some((m) => m.id === newMsg.id)) {
            next = { ...next, messages: [...next.messages, newMsg] };
          }
        }
      }
    }

    const completionAgentMsg = (event.metadata?.agentMessage ?? event.data.agentMessage) as
      string | undefined;
    if (completionAgentMsg) {
      const stepExecId = event.stepExecutionId;

      // Promote a leftover streaming placeholder for this step in-place
      // (live mode: StepSucceeded "promoted" the streaming msg keeping
      // streamed content because no agentMessage was on StepSucceeded;
      // the canonical text arrives here on SessionCompleted).
      let promoted = false;
      if (stepExecId) {
        const streamMsgId = `streaming-${stepExecId}`;
        const idx = next.messages.findIndex((m) => m.id === streamMsgId);
        if (idx >= 0) {
          const msgs = [...next.messages];
          const { semanticType: _semType, ...kept } = msgs[idx];
          msgs[idx] = {
            ...kept,
            content: completionAgentMsg,
            senderName: stepSenderName ?? kept.senderName,
          };
          next = { ...next, messages: msgs };
          promoted = true;
        }
      }

      // No streaming placeholder to promote (snapshot fold path post-Plan
      // 154, or a turn that never emitted deltas) → add a fresh message.
      //
      // Dedup target: the SAME turn already rendered the same text via a
      // different path. Two cases to catch:
      //   1. Same event's `outputVariables` path (above) wrote a message
      //      `${event.eventId}-${v.key}` carrying identical content.
      //   2. The matching `StepSucceeded` (same `stepExecutionId`) earlier
      //      in the fold already produced an assistant message — typical
      //      shape: `streaming-${stepExecutionId}` promoted in place by
      //      the StepSucceeded handler. Without this, the snapshot fold
      //      renders the same agent text twice: once from the promoted
      //      streaming msg (StepSucceeded path) and once from the
      //      agentMessage fallback (this block).
      //
      // Scoping to the same `stepExecutionId` keeps the dedup narrow —
      // later turns with the same content still render because they have
      // a distinct stepExecutionId.
      if (!promoted) {
        const outputVarPrefix = `${event.eventId}-`;
        const alreadyRenderedForThisTurn = next.messages.some((m) => {
          if (m.role !== 'assistant') return false;
          // Case 1: same-event outputVariables match.
          if (m.id.startsWith(outputVarPrefix) && m.content === completionAgentMsg) {
            return true;
          }
          // Case 2: an assistant message already anchored to this step.
          if (stepExecId && m.stepExecutionId === stepExecId) {
            return true;
          }
          return false;
        });
        if (!alreadyRenderedForThisTurn) {
          const completionMsg: Message = {
            id: `agent-msg-${event.eventId}`,
            role: 'assistant',
            content: completionAgentMsg,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: stepSenderName,
            ...(stepExecId ? { stepExecutionId: stepExecId } : {}),
          };
          if (!next.messages.some((m) => m.id === completionMsg.id)) {
            next = { ...next, messages: [...next.messages, completionMsg] };
          }
        }
      }
    }
  }

  return next;
}
