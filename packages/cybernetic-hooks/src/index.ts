import type { CyberneticHookName } from '@aflow/schemas';

// ============================================================================
// Hook outcome types
// ============================================================================

export type HookOutcome = { ok: true; didSchedule: boolean } | { ok: false; error: HookError };

export interface HookError {
  hookName: CyberneticHookName;
  errorMessage: string;
  errorCode?: string;
  cause?: unknown;
}

// ============================================================================
// Hook argument types
// ============================================================================

export interface BootstrapHookArgs {
  tenantId: string;
  spaceId: string;
  sessionId: string;
  workflowSlug: string;
}

export interface TaskHookArgs {
  tenantId: string;
  spaceId: string;
  sessionId: string;
  workflowSlug: string;
  taskId: string;
  runId: string;
  status: string;
}

export interface RunCompletedHookArgs {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  status: 'completed' | 'failed';
}

export interface InteractionEndedHookArgs {
  tenantId: string;
  spaceId: string;
  sessionId: string;
}

// ============================================================================
// CyberneticPostStepHooks interface
// ============================================================================

/**
 * Thin adapter surface that the orchestrator calls at lifecycle boundaries.
 *
 * Each method is best-effort: failures are caught, logged, and emitted as
 * `entity.hook.failed` events via cyberneticHookSafe.
 */
export interface CyberneticPostStepHooks {
  onWorkflowBootstrapCompleted(args: BootstrapHookArgs): Promise<HookOutcome>;
  onWorkflowTaskCompleted(args: TaskHookArgs): Promise<HookOutcome>;
  onWorkflowRunCompleted(args: RunCompletedHookArgs): Promise<HookOutcome>;
  onInteractionEnded(args: InteractionEndedHookArgs): Promise<HookOutcome>;
}
