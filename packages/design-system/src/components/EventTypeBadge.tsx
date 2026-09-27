import type { CSSProperties } from 'react';

export type EventType =
  | 'FlowRunStarted'
  | 'FlowRunResumed'
  | 'FlowRunCompleted'
  | 'FlowRunFailed'
  | 'FlowRunCancelled'
  | 'StepScheduled'
  | 'StepStarted'
  | 'StepCompleted'
  | 'StepFailed'
  | 'StepRetrying'
  | 'InputRequested'
  | 'InputReceived'
  | (string & {}); // Allow unknown event types while preserving autocomplete

export interface EventTypeBadgeProps {
  /** Event type */
  eventType: EventType;
}

type EventCategory = 'flow' | 'step' | 'input' | 'unknown';

const eventCategories: Record<string, EventCategory> = {
  FlowRunStarted: 'flow',
  FlowRunResumed: 'flow',
  FlowRunCompleted: 'flow',
  FlowRunFailed: 'flow',
  FlowRunCancelled: 'flow',
  StepScheduled: 'step',
  StepStarted: 'step',
  StepCompleted: 'step',
  StepFailed: 'step',
  StepRetrying: 'step',
  InputRequested: 'input',
  InputReceived: 'input',
};

const categoryColors: Record<EventCategory, { bg: string; text: string }> = {
  flow: { bg: 'var(--color-interactive-muted)', text: 'var(--color-interactive-default)' },
  step: { bg: 'var(--color-surface-2)', text: 'var(--color-text-secondary)' },
  input: { bg: 'var(--color-warning-bg)', text: 'var(--color-warning-default)' },
  unknown: { bg: 'var(--color-surface-2)', text: 'var(--color-text-muted)' },
};

function formatEventType(eventType: string): string {
  // Convert camelCase/PascalCase to spaced words
  return eventType.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

export function EventTypeBadge({ eventType }: EventTypeBadgeProps) {
  const category = eventCategories[eventType] ?? 'unknown';
  const colors = categoryColors[category];

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: 'var(--space-0-5) var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-medium)',
    fontFamily: 'var(--font-family-mono)',
    lineHeight: 1.4,
    borderRadius: 'var(--radius-sm)',
    backgroundColor: colors.bg,
    color: colors.text,
    whiteSpace: 'nowrap',
  };

  return <span style={style}>{formatEventType(eventType)}</span>;
}
