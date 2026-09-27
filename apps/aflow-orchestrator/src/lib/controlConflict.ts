import type { AuthorityLossReason, ControlConflictCode } from '@aflow/schemas';

/**
 * Thrown when a control command no longer applies because the run already
 * moved on — a second resume for a pause someone else just resolved, a
 * duplicate interrupt, a command for a run whose state is gone.
 *
 * The `ControlConsumer` treats these as benign outcomes: the run keeps
 * running and the losing actor gets a `ControlRejected` event. Any other
 * throw still fails the run.
 */
export class ControlConflictError extends Error {
  readonly conflictCode: ControlConflictCode;
  readonly observedStatus?: string;
  readonly currentStepExecutionId?: string;
  readonly requestedStepExecutionId?: string;

  constructor(
    conflictCode: ControlConflictCode,
    message: string,
    detail?: {
      observedStatus?: string;
      currentStepExecutionId?: string;
      requestedStepExecutionId?: string;
    },
  ) {
    super(message);
    this.name = 'ControlConflictError';
    this.conflictCode = conflictCode;
    if (detail?.observedStatus !== undefined) this.observedStatus = detail.observedStatus;
    if (detail?.currentStepExecutionId !== undefined) {
      this.currentStepExecutionId = detail.currentStepExecutionId;
    }
    if (detail?.requestedStepExecutionId !== undefined) {
      this.requestedStepExecutionId = detail.requestedStepExecutionId;
    }
  }
}

export function isControlConflictError(err: unknown): err is ControlConflictError {
  return err instanceof ControlConflictError;
}

/**
 * Thrown when the authority a run was established under no longer holds — the
 * principal left the space, or their role was narrowed.
 *
 * Refusing the command leaves the run paused where it was, which is the point:
 * the work is still valid and becomes resumable again the moment access is
 * restored. Failing it would discard work over an access change, and
 * continuing would execute under a principal who no longer has access.
 */
export class AuthorityLostError extends Error {
  readonly reason: AuthorityLossReason;
  readonly detail: string;

  constructor(reason: AuthorityLossReason, detail: string) {
    super(`Execution authority no longer holds: ${detail}`);
    this.name = 'AuthorityLostError';
    this.reason = reason;
    this.detail = detail;
  }
}

export function isAuthorityLostError(err: unknown): err is AuthorityLostError {
  return err instanceof AuthorityLostError;
}
