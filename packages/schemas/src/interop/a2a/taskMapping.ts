/**
 * A2A Task mapping — pure functions for Phoenix ↔ A2A state conversion.
 *
 * Maps Phoenix RunStatus to A2A TaskState and extracts messages from SessionEvents.
 */
import type { A2ATaskState, A2ATask, A2AMessage, A2AStreamEvent } from './types.js';

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map a Phoenix run status string to an A2A TaskState.
 */
export function mapTaskStateFromRunStatus(status: string): A2ATaskState {
  switch (status) {
    case 'QUEUED':
      return 'submitted';
    case 'RUNNING':
      return 'working';
    case 'SUCCEEDED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'PAUSED':
      return 'input-required';
    case 'WAITING_ON_CHILD':
      return 'working';
    case 'CANCELLED':
      return 'canceled';
    case 'CANCELLING':
      return 'working';
    case 'STALLED':
      return 'failed';
    default:
      return 'working';
  }
}

// ============================================================================
// Run Event → A2A Message extraction
// ============================================================================

interface A2AProjectionInput {
  eventType: string;
  metadata?: Record<string, unknown>;
}

/**
 * Extract A2A Messages from a sequence of Phoenix SessionEvents.
 * Picks up agent messages from step completions and user messages from resumes.
 */
export function mapRunEventsToMessages(events: A2AProjectionInput[]): A2AMessage[] {
  const messages: A2AMessage[] = [];

  for (const event of events) {
    const meta = event.metadata ?? {};

    switch (event.eventType) {
      case 'FlowRunStarted': {
        // If there's an initial user message, capture it
        const userMessage = meta['userMessage'] as string | undefined;
        if (userMessage) {
          messages.push({ role: 'user', parts: [{ type: 'text', text: userMessage }] });
        }
        break;
      }

      case 'FlowRunResumed': {
        // Resume with user input
        const resumeInput = meta['resumeInput'] as string | undefined;
        if (resumeInput) {
          messages.push({ role: 'user', parts: [{ type: 'text', text: resumeInput }] });
        }
        break;
      }

      case 'StepSucceeded': {
        // Agent message from a completed step
        const agentMessage = meta['agentMessage'] as string | undefined;
        if (agentMessage) {
          messages.push({ role: 'agent', parts: [{ type: 'text', text: agentMessage }] });
        }
        break;
      }

      case 'FlowRunPaused': {
        // Agent response when pausing for input
        const agentResponse = meta['agentResponse'] as string | undefined;
        if (agentResponse) {
          messages.push({ role: 'agent', parts: [{ type: 'text', text: agentResponse }] });
        }
        break;
      }

      case 'FlowRunSucceeded': {
        // Final output
        const output = meta['output'] as string | undefined;
        if (output) {
          messages.push({ role: 'agent', parts: [{ type: 'text', text: output }] });
        }
        break;
      }
    }
  }

  return messages;
}

// ============================================================================
// Run → A2A Task
// ============================================================================

interface RunSummary {
  runId: string;
  status: string;
  createdAt?: string;
}

/**
 * Build an A2A Task from a Phoenix run summary and events.
 */
export function mapRunToTask(run: RunSummary, events: A2AProjectionInput[]): A2ATask {
  const state = mapTaskStateFromRunStatus(run.status);
  const messages = mapRunEventsToMessages(events);
  const lastAgentMessage = messages.filter((m) => m.role === 'agent').pop();

  const task: A2ATask = {
    id: run.runId,
    status: {
      state,
      ...(lastAgentMessage ? { message: lastAgentMessage } : {}),
      ...(run.createdAt ? { timestamp: run.createdAt } : {}),
    },
    ...(messages.length > 0 ? { history: messages } : {}),
    metadata: {
      _phoenix: { runId: run.runId, status: run.status },
    },
  };

  return task;
}

// ============================================================================
// Run Event → A2A Stream Event
// ============================================================================

/**
 * Project a single Phoenix SessionEvent to an A2A SSE stream event.
 * Returns null if the event has no A2A representation.
 */
export function projectRunEventToA2A(
  taskId: string,
  event: A2AProjectionInput,
): A2AStreamEvent | null {
  const meta = event.metadata ?? {};

  switch (event.eventType) {
    case 'FlowRunStarted':
      return {
        type: 'task-status-update',
        taskId,
        status: { state: 'working' },
        final: false,
      };

    case 'FlowRunSucceeded': {
      const output = meta['output'] as string | undefined;
      return {
        type: 'task-status-update',
        taskId,
        status: {
          state: 'completed',
          ...(output
            ? {
                message: {
                  role: 'agent' as const,
                  parts: [{ type: 'text' as const, text: output }],
                },
              }
            : {}),
        },
        final: true,
      };
    }

    case 'FlowRunFailed':
      return {
        type: 'task-status-update',
        taskId,
        status: {
          state: 'failed',
          message: {
            role: 'agent',
            parts: [
              {
                type: 'text',
                text: (meta['errorMessage'] as string) ?? 'Run failed',
              },
            ],
          },
        },
        final: true,
      };

    case 'FlowRunPaused': {
      const agentResponse = meta['agentResponse'] as string | undefined;
      return {
        type: 'task-status-update',
        taskId,
        status: {
          state: 'input-required',
          ...(agentResponse
            ? {
                message: {
                  role: 'agent' as const,
                  parts: [{ type: 'text' as const, text: agentResponse }],
                },
              }
            : {}),
        },
        final: false,
      };
    }

    case 'FlowRunCancelled':
      return {
        type: 'task-status-update',
        taskId,
        status: { state: 'canceled' },
        final: true,
      };

    case 'StepSucceeded': {
      const agentMessage = meta['agentMessage'] as string | undefined;
      if (!agentMessage) return null;
      return {
        type: 'task-status-update',
        taskId,
        status: {
          state: 'working',
          message: { role: 'agent', parts: [{ type: 'text', text: agentMessage }] },
        },
        final: false,
      };
    }

    default:
      return null;
  }
}
