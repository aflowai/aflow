import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Workflow, WorkflowRunResumeInput } from '@aflow/schemas';
import type {
  WorkflowRunDetail,
  surfaceWorkflowResumeContract,
  loadRunById,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';

export interface ApplyReplaceOutputResolutionArgs {
  args: InlineHandlerArgs;
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  surfaced: Awaited<ReturnType<typeof surfaceWorkflowResumeContract>>;
  output: unknown;
  claimToken: string;
}

export type ApplyReplaceOutputResult =
  { ok: true; succeededTaskId: string } | { ok: false; error: { code: string; message: string } };

export interface ApplyProvideInputResolutionArgs {
  args: InlineHandlerArgs;
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  taskId: string;
  inputs: Record<string, unknown>;
  claimToken: string;
}

export type ApplyProvideInputResult =
  { ok: true } | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface ApplyFailTaskResolutionArgs {
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  workflow: Workflow;
  surfaced: Awaited<ReturnType<typeof surfaceWorkflowResumeContract>>;
  reason: string;
  claimToken: string;
}

export type ApplyFailTaskResult =
  | { ok: true; failedTaskId: string; taskId: string; workflow: Workflow }
  | { ok: false; error: { code: string; message: string } };

export interface ApplyHumanReplaceOutputArgs extends ApplyReplaceOutputResolutionArgs {
  workflow: Workflow;
  actorUserId: string;
}

export interface ApplyRejectResolutionArgs {
  args: InlineHandlerArgs;
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  workflow: Workflow;
  surfaced: Awaited<ReturnType<typeof surfaceWorkflowResumeContract>>;
  comment?: string;
  claimToken: string;
  actorUserId: string;
}

export type ApplyRejectResult =
  | { ok: true; skippedTaskId: string; skippedDescendantTaskIds: string[] }
  | { ok: false; error: { code: string; message: string } };

export interface HandleRetryFailedTaskCtx {
  args: InlineHandlerArgs;
  input: WorkflowRunResumeInput;
  startTime: number;
  db: PostgresJsDatabase;
  tenantIdStr: string;
  spaceId: string;
  run: Awaited<ReturnType<typeof loadRunById>>;
  workflow: Workflow;
}

export interface ApplyReExecuteResolutionArgs {
  args: InlineHandlerArgs;
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  workflow: Workflow;
  surfaced: Awaited<ReturnType<typeof surfaceWorkflowResumeContract>>;
  /**
   * Free-text retry guidance — `TaskTargetedInstructions` union shape:
   * either a single string (run-level) or `Array<{ taskId, text }>`
   * (per-task targeted). Surfaces in the new Runner's prompt as the
   * "PRIOR FAILURE GUIDANCE" / "PARENT INSTRUCTIONS" section.
   */
  instructions?: string | Array<{ taskId: string; text: string }>;
  /** Set by Helmsman when the targeted task is `retryability: 'unsafe' | 'unknown'`. */
  remediationConfirmed?: boolean;
  claimToken: string;
  /** Inline step's calling session id — bound as the new waiter for the retried task. */
  callingSessionId: string;
}

export type ApplyReExecuteResult =
  | { ok: true; retriedTaskId: string; retriedAttempt: number }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
