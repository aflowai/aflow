import { Badge, type BadgeVariant } from '../primitives/Badge.js';

export type StepStatus =
  'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYING' | 'WAITING_INPUT' | 'CANCELLED';

export interface StepStatusPillProps {
  /** Step status */
  status: StepStatus;
  /** Optional step type */
  stepType?: string;
}

const statusVariantMap: Record<StepStatus, BadgeVariant> = {
  SCHEDULED: 'neutral',
  RUNNING: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  RETRYING: 'paused',
  WAITING_INPUT: 'paused',
  CANCELLED: 'cancelled',
};

const statusLabelMap: Record<StepStatus, string> = {
  SCHEDULED: 'Scheduled',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  RETRYING: 'Retrying',
  WAITING_INPUT: 'Awaiting Input',
  CANCELLED: 'Cancelled',
};

export function StepStatusPill({ status, stepType }: StepStatusPillProps) {
  const label = stepType ? `${stepType}: ${statusLabelMap[status]}` : statusLabelMap[status];

  return <Badge variant={statusVariantMap[status]}>{label}</Badge>;
}
