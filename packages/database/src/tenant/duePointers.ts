/**
 * Every public due pointer, and the tenant predicates each one stands for.
 *
 * The mechanics live in `tenantDue.ts`; this file is only the declarations, so
 * a reader can see in one place what background work discovers through a
 * pointer and exactly which rows count as due.
 */
import type { TenantDuePointer } from './tenantDue.js';

/**
 * Workflow runs the reconciler must converge — completion-pending rows, runs
 * left past their scheduler deadline, and terminal runs still owed an
 * evaluation envelope.
 *
 * The envelope source is the terminal write itself, because that write is the
 * last thing that happens to a crashed run: the in-process post-run hook is the
 * only other writer, and a worker that dies between the two leaves a terminal
 * run nothing else ever revisits. Its due time is `completed_at`, so a run
 * arrives due immediately and the repair's own grace window — not the pointer —
 * decides when it is safe to act; the cost is a wasted claim per completion,
 * which is the direction a pointer is allowed to be wrong in.
 *
 * The cybernetic gate reaches the `spaces` row, so it can only be a recompute
 * condition. Without it the pointer would never drain: a run in a space with no
 * directives is one the hook deliberately skips, so its `evaluation_json` stays
 * NULL forever and the tenant would be claimed every cycle for work no one
 * intends to do.
 */
export const WORKFLOW_RUN_DUE_POINTER: TenantDuePointer = {
  table: 'public.workflow_run_due',
  trigger: 'arm_workflow_run_due',
  sources: [
    {
      table: 'workflow_run_completion_pending',
      dueColumn: 'due_at',
      writtenBy: ['due_at'],
      reconcilable: (ref) => `${ref('due_at')} IS NOT NULL`,
    },
    {
      table: 'workflow_runs',
      dueColumn: 'scheduler_cursor_deadline',
      writtenBy: ['status', 'scheduler_cursor_deadline'],
      reconcilable: (ref) =>
        `${ref('status')} = 'running' AND ${ref('scheduler_cursor_deadline')} IS NOT NULL`,
    },
    {
      table: 'workflow_runs',
      triggerSuffix: 'evaluation',
      dueColumn: 'completed_at',
      writtenBy: ['status', 'completed_at', 'evaluation_json'],
      reconcilable: (ref) =>
        `${ref('status')} IN ('completed', 'failed', 'cancelled') ` +
        `AND ${ref('evaluation_json')} IS NULL AND ${ref('completed_at')} IS NOT NULL`,
      recomputeOnly: (qualify) =>
        `EXISTS (SELECT 1 FROM ${qualify('spaces')} sp ` +
        `WHERE sp.id = workflow_runs.space_id AND sp.directives IS NOT NULL)`,
    },
  ],
};

/**
 * Time schedules whose next occurrence has arrived.
 *
 * `status` and `kind` are arming writes even though neither is a due time: an
 * unpause moves a schedule into the predicate while touching no timestamp at
 * all, and a pointer that only watched `next_fire_at` would never hear about it.
 */
export const SCHEDULE_DUE_POINTER: TenantDuePointer = {
  table: 'public.schedule_due',
  trigger: 'arm_schedule_due',
  sources: [
    {
      table: 'agent_schedules',
      dueColumn: 'next_fire_at',
      writtenBy: ['status', 'kind', 'next_fire_at'],
      reconcilable: (ref) =>
        `${ref('status')} = 'active' AND ${ref('kind')} IN ('cron', 'one_shot') ` +
        `AND ${ref('next_fire_at')} IS NOT NULL`,
    },
  ],
};

/**
 * OAuth consent state rows past their expiry.
 *
 * The table is cross-kind since the connector/MCP unification — API connector
 * consents and MCP server consents are the same rows — so the pointer covers
 * both and the reaper that reads it is not an MCP-specific concern.
 */
export const OAUTH_STATE_DUE_POINTER: TenantDuePointer = {
  table: 'public.oauth_state_due',
  trigger: 'arm_oauth_state_due',
  sources: [
    {
      table: 'oauth_state',
      dueColumn: 'expires_at',
      writtenBy: ['expires_at'],
      reconcilable: (ref) => `${ref('expires_at')} IS NOT NULL`,
    },
  ],
};

/**
 * Memory documents marked for embedding whose job was lost or never enqueued.
 *
 * The due time is `updated_at` — the moment the document was marked — so a
 * pending document is due immediately and the pointer orders tenants by how
 * long they have been waiting.
 */
export const MEMORY_EMBED_DUE_POINTER: TenantDuePointer = {
  table: 'public.memory_embed_due',
  trigger: 'arm_memory_embed_due',
  sources: [
    {
      table: 'memory_docs',
      dueColumn: 'updated_at',
      writtenBy: ['embedding_status', 'indexing_mode', 'deleted_at', 'updated_at'],
      reconcilable: (ref) =>
        `${ref('deleted_at')} IS NULL AND ${ref('embedding_status')} = 'pending' ` +
        `AND ${ref('indexing_mode')} <> 'disabled'`,
    },
  ],
};

/**
 * Eval batches the durable engine still owes work, and the ephemeral fixture
 * spaces its trials leave behind.
 *
 * A batch in a non-terminal status always owes the engine something — promote,
 * dispatch, observe, renew a trial lease, terminalize — so the head's status IS
 * the claimable-work predicate, and `created_at` makes a live batch due
 * immediately while ordering tenants by how long their oldest one has waited.
 * Trial rows are deliberately not a source: a claimable trial always sits under
 * a non-terminal head, which already nominates the tenant, so arming on trial
 * writes would fire once per lease renewal per trial and discover nothing.
 *
 * Fixture spaces outlive the batch that created them, so they are their own
 * source: only eval-created spaces ever carry `expires_at`, and a tenant whose
 * batches are all terminal is nominated again exactly when one comes up for
 * collection.
 */
export const EVAL_BATCH_DUE_POINTER: TenantDuePointer = {
  table: 'public.eval_batch_due',
  trigger: 'arm_eval_batch_due',
  sources: [
    {
      table: 'eval_batches',
      dueColumn: 'created_at',
      writtenBy: ['status', 'created_at'],
      reconcilable: (ref) => `${ref('status')} IN ('queued', 'running', 'cancelling')`,
    },
    {
      table: 'spaces',
      dueColumn: 'expires_at',
      writtenBy: ['expires_at'],
      reconcilable: (ref) => `${ref('expires_at')} IS NOT NULL`,
    },
  ],
};

/** Every pointer, for the migrations that install and seed them. */
export const TENANT_DUE_POINTERS: readonly TenantDuePointer[] = [
  WORKFLOW_RUN_DUE_POINTER,
  SCHEDULE_DUE_POINTER,
  OAUTH_STATE_DUE_POINTER,
  MEMORY_EMBED_DUE_POINTER,
  EVAL_BATCH_DUE_POINTER,
];
