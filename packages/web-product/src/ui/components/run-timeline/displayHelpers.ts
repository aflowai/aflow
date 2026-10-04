import type { IconName } from '@aflow/design-system';

import { executorWaitLabel } from '../../lib/op-labels.js';
import type { StepGroup, SubflowEntry } from './types';

/** Build a concise label for a delegate event, preferring step/operation context. */
export function subflowEventLabel(entry: SubflowEntry): string {
  // For step events, prefer the human-readable step name or friendly operation label
  if (
    entry.sourceEventType === 'StepSucceeded' ||
    entry.sourceEventType === 'StepCompleted' ||
    entry.sourceEventType === 'StepFailed'
  ) {
    const failed = entry.sourceEventType === 'StepFailed';
    // Strip leading "↪ " prefix from step names if present
    const name = entry.stepName?.replace(/^↪\s*/, '');
    if (name) return failed ? `${name} failed` : name;
    if (entry.operationId) {
      const friendly = friendlyOperationLabel(entry.operationId);
      return failed ? `${friendly} failed` : friendly;
    }
    return failed ? 'Step failed' : 'Step completed';
  }
  // Terminal session events
  if (entry.sourceEventType === 'SessionCompleted' || entry.sourceEventType === 'SessionSucceeded')
    return 'Completed';
  if (entry.sourceEventType === 'SessionFailed') return 'Failed';
  return entry.sourceEventType;
}

export function subflowEventIcon(sourceEventType: string): IconName {
  if (sourceEventType.includes('Failed')) return 'x';
  if (sourceEventType.includes('Succeeded') || sourceEventType.includes('Completed'))
    return 'check-circle';
  return 'play';
}

export function subflowEventColor(sourceEventType: string): string {
  if (sourceEventType.includes('Failed')) return 'var(--color-status-failed)';
  if (sourceEventType.includes('Succeeded') || sourceEventType.includes('Completed'))
    return 'var(--color-status-succeeded)';
  return 'var(--color-text-muted)';
}
export function friendlyEventLabel(
  eventType: string,
  stepName?: string,
  pauseType?: string,
): string {
  // Interrupt override: show "interrupted" instead of "paused"
  if (eventType === 'SessionPaused' && pauseType === 'interrupted') {
    return stepName ? `Interrupted at ${stepName}` : 'Session interrupted';
  }
  const labels: Record<string, string> = {
    SessionQueued: 'Session queued',
    SessionStarted: 'Session started',
    SessionSucceeded: 'Session succeeded',
    SessionCompleted: 'Session completed',
    SessionFailed: 'Session failed',
    SessionCancelled: 'Session cancelled',
    SessionStalled: 'Session stalled',
    SessionPaused: stepName ? `Paused at ${stepName}` : 'Session paused',
    SessionResumed: 'Session resumed',
    StepScheduled: stepName ? `${stepName} scheduled` : 'Step scheduled',
    StepStarted: stepName ? `${stepName} started` : 'Step started',
    StepSucceeded: stepName ? `${stepName} succeeded` : 'Step succeeded',
    StepCompleted: stepName ? `${stepName} completed` : 'Step completed',
    StepFailed: stepName ? `${stepName} failed` : 'Step failed',
    StepPaused: stepName ? `${stepName} paused` : 'Step paused',
    StepWaitingOnExecutor: stepName
      ? `${stepName} waiting for its executor`
      : 'Step waiting for its executor',
  };
  return labels[eventType] ?? eventType;
}

export function eventIcon(eventType: string): IconName {
  if (eventType.includes('Succeeded') || eventType.includes('Completed')) return 'check-circle';
  if (eventType.includes('Failed')) return 'x';
  if (eventType.includes('Paused')) return 'pause';
  if (
    eventType.includes('Started') ||
    eventType.includes('Running') ||
    eventType.includes('Resumed')
  )
    return 'play';
  if (eventType.includes('Queued')) return 'clock';
  if (eventType.includes('Stalled')) return 'clock';
  if (eventType.includes('Cancelled')) return 'x';
  return 'info';
}

export function eventColor(eventType: string): string {
  if (eventType.includes('Succeeded') || eventType.includes('Completed'))
    return 'var(--color-status-succeeded)';
  if (eventType.includes('Failed')) return 'var(--color-status-failed)';
  if (eventType.includes('Paused')) return 'var(--color-status-paused)';
  if (
    eventType.includes('Started') ||
    eventType.includes('Running') ||
    eventType.includes('Resumed')
  )
    return 'var(--color-status-running)';
  if (eventType.includes('Stalled')) return 'var(--color-status-paused)';
  if (eventType.includes('Cancelled')) return 'var(--color-status-cancelled)';
  return 'var(--color-text-muted)';
}

export function stepStatusColor(status: StepGroup['status']): string {
  switch (status) {
    case 'succeeded':
      return 'var(--color-status-succeeded)';
    case 'failed':
      return 'var(--color-status-failed)';
    case 'running':
      return 'var(--color-status-running)';
    case 'paused':
      return 'var(--color-status-paused)';
    case 'waiting_on_child':
      return 'var(--color-status-running)';
    case 'retrying':
      return 'var(--color-status-paused)';
    case 'scheduled':
    case 'waiting_on_executor':
      return 'var(--color-status-paused)';
    default:
      return 'var(--color-text-muted)';
  }
}

export function stepStatusIcon(status: StepGroup['status']): IconName {
  switch (status) {
    case 'succeeded':
      return 'check-circle';
    case 'failed':
      return 'x';
    case 'running':
      return 'play';
    case 'paused':
      return 'pause';
    case 'waiting_on_child':
      return 'git-branch';
    case 'retrying':
      return 'sync';
    case 'waiting_on_executor':
      return 'plugs';
    case 'scheduled':
    default:
      return 'clock';
  }
}

export function stepStatusLabel(
  status: StepGroup['status'],
  pauseKind?: string,
  stepType?: string,
): string {
  switch (status) {
    case 'waiting_on_executor':
      return executorWaitLabel(stepType);
    case 'succeeded':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Running';
    case 'paused':
      return pauseKind === 'subagent_handoff' ? 'Returned to parent agent' : 'Awaiting input';
    case 'waiting_on_child':
      return 'Delegating';
    case 'retrying':
      return 'Retrying…';
    case 'scheduled':
    default:
      return 'Scheduled';
  }
}

export function formatTime(ts: string | number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Derive a descriptive label for an agent turn based on its action outcome.
 */
export function agentTurnLabel(agentAction: string | undefined, fallback: string): string {
  switch (agentAction) {
    case undefined:
      return fallback;
    case 'invoke_step':
    case 'invoke_steps':
      return 'Used tools';
    case 'complete':
      return 'Responded';
    case 'pause_for_input':
      return 'Asked for input';
    default:
      return fallback;
  }
}

/**
 * Friendly human-readable label for an operation ID.
 * E.g., "ai.agent.turn" → "Agent Turn", "ai.media.generate_image" → "Image Generate"
 */
export function friendlyOperationLabel(operationId: string): string {
  if (!operationId) return '';
  const LABELS: Record<string, string> = {
    'ai.agent.turn': 'Turn',
    'ai.text.generate': 'AI Generate',
    'ai.text.generate_json': 'AI Generate JSON',
    'ai.text.generate_stream': 'AI Generate Stream',
    'ai.generate': 'AI Generate',
    'ai.generateJson': 'AI Generate JSON',
    'ai.generateStream': 'AI Generate Stream',
    'ai.media.image': 'Image Generate',
    'ai.media.video': 'Video Generate',
    'ai.embedding.generate': 'Embed',
    'api.httpRequest': 'HTTP Request',
    'user.input': 'User Input',
    'user.approval': 'User Approval',
    'agent.control.run_step': 'Run Step',
    'agent.control.end': 'End Session',
    'agent.control.delegate': 'Delegate',
    'agent.control.dispatch': 'Dispatch',
    'agent.control.resume': 'Resume',
    'agent.control.submit_output': 'Submit Output',
    'agent.control.signal_blocked': 'Signal Blocked',
    'memory.read': 'Memory Read',
    'memory.write': 'Memory Write',
    'memory.store.query': 'Memory Query',
    'memory.store.get': 'Memory Read',
    'memory.store.put': 'Memory Write',
    'memory.store.vector_search': 'Vector Search',
    'memory.patch': 'Memory Update',
    'search.web.search': 'Web Search',
    'search.web.fetch': 'Fetch Page',
    'compute.sandbox.exec': 'Run Code',
    'api.http.call': 'API Call',
    'mcp.tool.call': 'MCP Tool Call',
    'workflow.manage.get': 'Get Workflow',
    'workflow.learn': 'Learn',
    'learner.propose.workflow_change': 'Propose Change',
  };
  if (LABELS[operationId]) return LABELS[operationId];
  // Fallback: strip common prefixes and titleCase
  const parts = operationId.split('.');
  const last = parts[parts.length - 1];
  if (last) {
    return last
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (s) => s.toUpperCase())
      .replace(/_/g, ' ')
      .trim();
  }
  return operationId;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

export function formatTimeFull(ts: string | number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCostUsd(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
