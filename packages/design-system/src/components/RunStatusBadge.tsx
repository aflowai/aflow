import { Badge, type BadgeVariant } from '../primitives/Badge.js';

export type RunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING_ON_CHILD'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'STALLED'
  | 'PENDING';

/** Pause type from typed interrupts — used to derive context-aware labels for PAUSED status. */
export type PauseType =
  | 'user_input'
  | 'approval'
  | 'external_dependency'
  | 'budget_exceeded'
  | 'subflow_waiting'
  | 'guardrail_escalation'
  | 'external_callback';

export interface RunStatusBadgeProps {
  /** Run status */
  status: RunStatus;
  /** Pause type for context-aware labelling when status is PAUSED */
  pauseType?: PauseType;
  /** Show icon */
  showIcon?: boolean;
}

const statusVariantMap: Record<RunStatus, BadgeVariant> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_ON_CHILD: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  CANCELLING: 'cancelled',
  STALLED: 'stalled',
  PENDING: 'neutral',
};

const statusLabelMap: Record<RunStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  PAUSED: 'Idle',
  WAITING_ON_CHILD: 'Running Subflow',
  SUCCEEDED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  CANCELLING: 'Cancelling',
  STALLED: 'Stalled',
  PENDING: 'Pending',
};

/** Context-aware label for PAUSED status based on typed interrupt pauseType. */
const pauseTypeLabelMap: Partial<Record<PauseType, string>> = {
  user_input: 'Awaiting Input',
  approval: 'Awaiting Approval',
  external_dependency: 'Awaiting Dependency',
  budget_exceeded: 'Budget Exceeded',
  subflow_waiting: 'Running Subflow',
  guardrail_escalation: 'Guardrail Review',
  external_callback: 'Awaiting Callback',
};

export function RunStatusBadge({ status, pauseType, showIcon = true }: RunStatusBadgeProps) {
  const label =
    status === 'PAUSED' && pauseType
      ? (pauseTypeLabelMap[pauseType] ?? statusLabelMap[status])
      : statusLabelMap[status];

  return (
    <Badge
      variant={statusVariantMap[status]}
      icon={showIcon ? <StatusIcon status={status} /> : undefined}
    >
      {label}
    </Badge>
  );
}

function StatusIcon({ status }: { status: RunStatus }) {
  const size = 12;

  switch (status) {
    case 'QUEUED':
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
          <circle cx="6" cy="6" r="3" opacity="0.6">
            <animate
              attributeName="opacity"
              values="0.3;0.8;0.3"
              dur="1.5s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
      );
    case 'RUNNING':
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
          <circle cx="6" cy="6" r="3">
            <animate attributeName="r" values="3;4;3" dur="1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.5;1" dur="1s" repeatCount="indefinite" />
          </circle>
        </svg>
      );
    case 'PAUSED':
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
          <rect x="2" y="2" width="3" height="8" rx="1" />
          <rect x="7" y="2" width="3" height="8" rx="1" />
        </svg>
      );
    case 'WAITING_ON_CHILD':
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
          <circle cx="6" cy="6" r="3">
            <animate attributeName="r" values="3;4;3" dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
          </circle>
        </svg>
      );
    case 'SUCCEEDED':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M2 6l3 3 5-6" />
        </svg>
      );
    case 'FAILED':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      );
    case 'CANCELLED':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="6" cy="6" r="4" />
          <path d="M4 6h4" />
        </svg>
      );
    case 'CANCELLING':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="6" cy="6" r="4" />
          <path d="M4 6h4" />
        </svg>
      );
    case 'STALLED':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 2v4l2 2" />
          <circle cx="6" cy="6" r="5" />
        </svg>
      );
    case 'PENDING':
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
          <circle cx="2" cy="6" r="1.5" />
          <circle cx="6" cy="6" r="1.5" />
          <circle cx="10" cy="6" r="1.5" />
        </svg>
      );
    default:
      return null;
  }
}
