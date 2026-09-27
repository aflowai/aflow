import type { Redis } from 'ioredis';
import type { WorkflowRunCancelActor } from '@aflow/schemas';
import { WorkflowRunCancelActorSchema } from '@aflow/schemas';

export const WORKFLOW_HARNESS_ADVANCE_STREAM = 'aflow:workflow:harness-advance';
export const WORKFLOW_HARNESS_ADVANCE_GROUP = 'orchestrator-harness-advance';

export interface WorkflowHarnessAdvanceMessage {
  tenantId: string;
  workflowRunId: string;
  spaceId: string;
  failedTaskId?: string;
  action?: 'cancel' | 'retry_dispatch';
  /** Optional operator cancellation reason; recorded on the run's attention payload. */
  reason?: string;
  /**
   * Who initiated the cancel (`action: 'cancel'` only). The operator BFF
   * route stamps `'operator'`; the worker threads it into `cancelRun` so the
   * run's terminal state + waiter wake-up carry the actor. Absent values
   * fall back to the `WorkflowRunCancellationSchema` default (`'system'`).
   */
  cancelledBy?: WorkflowRunCancelActor;
  taskId?: string;
}

export function parseWorkflowHarnessAdvanceFields(
  fields: Record<string, string>,
): WorkflowHarnessAdvanceMessage | null {
  const tenantId = fields['tenantId'];
  const workflowRunId = fields['workflowRunId'];
  const spaceId = fields['spaceId'];
  if (!tenantId || !workflowRunId || !spaceId) return null;
  const failedTaskId = fields['failedTaskId'];
  const action = fields['action'];
  const reason = fields['reason'];
  const cancelledByParsed = WorkflowRunCancelActorSchema.safeParse(fields['cancelledBy']);
  const taskId = fields['taskId'];
  return {
    tenantId,
    workflowRunId,
    spaceId,
    ...(failedTaskId ? { failedTaskId } : {}),
    ...(action === 'cancel' || action === 'retry_dispatch' ? { action } : {}),
    ...(reason ? { reason } : {}),
    ...(cancelledByParsed.success ? { cancelledBy: cancelledByParsed.data } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

export async function enqueueWorkflowHarnessAdvance(
  redis: Redis,
  message: WorkflowHarnessAdvanceMessage,
): Promise<string> {
  const args: string[] = [
    'tenantId',
    message.tenantId,
    'workflowRunId',
    message.workflowRunId,
    'spaceId',
    message.spaceId,
  ];
  if (message.failedTaskId) {
    args.push('failedTaskId', message.failedTaskId);
  }
  if (message.action) {
    args.push('action', message.action);
  }
  if (message.reason) {
    args.push('reason', message.reason);
  }
  if (message.cancelledBy) {
    args.push('cancelledBy', message.cancelledBy);
  }
  if (message.taskId) {
    args.push('taskId', message.taskId);
  }
  const id = await redis.xadd(WORKFLOW_HARNESS_ADVANCE_STREAM, '*', ...args);
  if (id === null) {
    throw new Error('Failed to enqueue workflow harness advance');
  }
  return id;
}
