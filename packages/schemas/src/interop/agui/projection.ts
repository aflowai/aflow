export interface AguiProjectionInput {
  eventId: string;
  eventType: string;
  timestamp: number;
  runId: string;
  stepId?: string;
  stepExecutionId?: string;
  stepType?: string;
  metadata?: Record<string, unknown>;
  runtimeStatePatch?: {
    version: number;
    changed: Array<{ key: string; value?: unknown }>;
  };
}

import {
  AguiEventType,
  type AguiEvent,
  type AguiRunStarted,
  type AguiRunFinished,
  type AguiRunError,
  type AguiStepStarted,
  type AguiStepFinished,
  type AguiToolCallStart,
  type AguiToolCallEnd,
  type AguiTextMessageStart,
  type AguiTextMessageContent,
  type AguiTextMessageEnd,
  type AguiCustom,
  type AguiStateDelta,
} from './types.js';

/**
 * Project a Phoenix SessionEvent to one or more AG-UI events.
 *
 * @returns AguiEvent, AguiEvent[] for multi-event mappings, or null to skip.
 */
export function projectRunEventToAgui(event: AguiProjectionInput): AguiEvent | AguiEvent[] | null {
  const ts = event.timestamp;
  const meta = event.metadata ?? {};

  switch (event.eventType) {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    case 'FlowRunStarted': {
      const e: AguiRunStarted = {
        type: AguiEventType.RunStarted,
        timestamp: ts,
        threadId: event.runId,
        runId: event.runId,
      };
      return e;
    }

    case 'FlowRunSucceeded':
    case 'FlowRunCompleted': {
      const e: AguiRunFinished = {
        type: AguiEventType.RunFinished,
        timestamp: ts,
        threadId: event.runId,
        runId: event.runId,
      };
      return e;
    }

    case 'FlowRunFailed': {
      const e: AguiRunError = {
        type: AguiEventType.RunError,
        timestamp: ts,
        message: (meta['errorMessage'] as string) ?? 'Unknown error',
        code: (meta['errorCode'] as string) ?? 'UNKNOWN',
      };
      return e;
    }

    // ── Step events ───────────────────────────────────────────────────────
    case 'StepScheduled': {
      const parentId = meta['parentStepExecutionId'] as string | undefined;
      // Agent tool steps → ToolCallStart; other steps → StepStarted
      if (!parentId) {
        const e: AguiStepStarted = {
          type: AguiEventType.StepStarted,
          timestamp: ts,
          stepName: (meta['stepName'] as string) ?? event.stepId ?? 'unknown',
        };
        return e;
      }
      const e: AguiToolCallStart = {
        type: AguiEventType.ToolCallStart,
        timestamp: ts,
        toolCallId: event.stepExecutionId ?? 'unknown',
        toolCallName: (meta['stepName'] as string) ?? event.stepId ?? 'unknown',
      };
      return e;
    }

    case 'StepSucceeded': {
      const results: AguiEvent[] = [];
      const parentId = meta['parentStepExecutionId'] as string | undefined;

      // Tool result for agent tool steps
      if (parentId) {
        const toolEnd: AguiToolCallEnd = {
          type: AguiEventType.ToolCallEnd,
          timestamp: ts,
          toolCallId: event.stepExecutionId ?? 'unknown',
          result: (meta['summary'] as string) ?? '',
        };
        results.push(toolEnd);
      } else {
        const stepFinished: AguiStepFinished = {
          type: AguiEventType.StepFinished,
          timestamp: ts,
          stepName: (meta['stepName'] as string) ?? event.stepId ?? 'unknown',
        };
        results.push(stepFinished);
      }

      // Agent message as text
      const agentMessage = meta['agentMessage'] as string | undefined;
      if (agentMessage) {
        const msgId = `msg-${event.eventId}`;
        const start: AguiTextMessageStart = {
          type: AguiEventType.TextMessageStart,
          timestamp: ts,
          messageId: msgId,
          role: 'assistant',
        };
        const content: AguiTextMessageContent = {
          type: AguiEventType.TextMessageContent,
          timestamp: ts,
          messageId: msgId,
          delta: agentMessage,
        };
        const end: AguiTextMessageEnd = {
          type: AguiEventType.TextMessageEnd,
          timestamp: ts,
          messageId: msgId,
        };
        results.push(start, content, end);
      }

      return results.length === 1 ? results[0]! : results;
    }

    // ── Pause (HITL) ──────────────────────────────────────────────────────
    case 'FlowRunPaused': {
      const results: AguiEvent[] = [];
      const prompt = (meta['agentResponse'] as string) ?? (meta['prompt'] as string);

      if (prompt) {
        const msgId = `msg-${event.eventId}`;
        const start: AguiTextMessageStart = {
          type: AguiEventType.TextMessageStart,
          timestamp: ts,
          messageId: msgId,
          role: 'assistant',
        };
        const content: AguiTextMessageContent = {
          type: AguiEventType.TextMessageContent,
          timestamp: ts,
          messageId: msgId,
          delta: prompt,
        };
        const end: AguiTextMessageEnd = {
          type: AguiEventType.TextMessageEnd,
          timestamp: ts,
          messageId: msgId,
        };
        results.push(start, content, end);
      }

      const custom: AguiCustom = {
        type: AguiEventType.Custom,
        timestamp: ts,
        name: 'input_required',
        value: {
          pauseType: meta['pauseType'],
          resumeSchema: meta['resumeSchema'],
        },
      };
      results.push(custom);

      return results;
    }

    // ── Subflow forwarding ────────────────────────────────────────────────
    case 'SubflowEventForwarded': {
      const e: AguiCustom = {
        type: AguiEventType.Custom,
        timestamp: ts,
        name: 'subflow_event',
        value: meta,
      };
      return e;
    }

    // ── Guardrail events ──────────────────────────────────────────────────
    case 'GuardrailViolation': {
      const e: AguiCustom = {
        type: AguiEventType.Custom,
        timestamp: ts,
        name: 'guardrail_violation',
        value: meta,
      };
      return e;
    }

    // ── Runtime state patches → StateDelta ─────────────────────────────────
    default: {
      // Check for runtime state patch on any event
      if (event.runtimeStatePatch) {
        const delta: AguiStateDelta = {
          type: AguiEventType.StateDelta,
          timestamp: ts,
          delta: event.runtimeStatePatch.changed.map((c) => ({
            op: 'replace',
            path: `/${c.key}`,
            value: c.value,
          })),
        };
        return delta;
      }

      // Phoenix-specific events with no AG-UI equivalent
      return null;
    }
  }
}
