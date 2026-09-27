import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as tenantSchema from '../schema/tenant/index.js';

/**
 * How the session-granular purge must treat one column that can hold a
 * session id.
 *
 * `cascade` rows are removed by {@link cascadeDeleteSession} — the row exists
 * because of the session (its steps, events, guardrail records, session-scoped
 * memory, artifacts it authored). `preserve` rows deliberately survive: they
 * belong to a space-owned record (a workflow run's task bookkeeping, Coach
 * evidence, audit provenance) where the session id is a pointer, and deleting
 * the row would destroy shared history that outlives any one session.
 */
export type SessionReferencePolicy = { kind: 'cascade' } | { kind: 'preserve'; reason: string };

/**
 * Every column that can hold a session id, keyed `table.column`.
 *
 * The column universe is derived from the drizzle schema at runtime
 * ({@link deriveSessionReferenceColumns}); this map only supplies the policy,
 * which cannot be inferred. A column present in the schema but absent here
 * fails `sessionCascade.contract.test.ts`, so a new session reference cannot
 * silently escape the purge.
 */
export const SESSION_REFERENCE_POLICY: Readonly<Record<string, SessionReferencePolicy>> = {
  // The session's own record and its direct children.
  'sessions.session_id': { kind: 'cascade' },
  'session_participants.session_id': { kind: 'cascade' },
  'step_executions.session_id': { kind: 'cascade' },
  'event_log.session_id': { kind: 'cascade' },
  'idempotency_keys.session_id': { kind: 'cascade' },
  'guardrail_violations.session_id': { kind: 'cascade' },
  'guardrail_checks.session_id': { kind: 'cascade' },

  // Session-scoped resources the session brought into being.
  'workflow_runs.session_id': { kind: 'cascade' },
  'workflow_run_waiters.waiter_session_id': { kind: 'cascade' },
  'memory_entries.session_id': { kind: 'cascade' },
  'memory_docs.session_id': { kind: 'cascade' },
  'memory_dirs.session_id': { kind: 'cascade' },
  'applet_instances.bound_session_id': { kind: 'cascade' },
  'ui_artifacts.created_by_session_id': { kind: 'cascade' },
  'ui_artifact_versions.created_by_session_id': { kind: 'cascade' },
  'ui_artifact_drafts.created_by_session_id': { kind: 'cascade' },
  'async_jobs.run_id': { kind: 'cascade' },
  'simulation_call_records.run_id': { kind: 'cascade' },
  'simulation_run_contexts.run_id': { kind: 'cascade' },

  // Public-schema rows keyed by the run id itself.
  'recoverable_runs.run_id': { kind: 'cascade' },
  'error_reports.run_id': { kind: 'cascade' },

  // Deliberate survivors — the row belongs to something that outlives the
  // session; the id is a pointer, not scope.
  'sessions.parent_session_id': {
    kind: 'preserve',
    reason: 'Delegated children are independent sessions on their own retention clock',
  },
  'workflow_run_tasks.session_id': {
    kind: 'preserve',
    reason: 'Task rows belong to their workflow run; runs the session started go via run linkage',
  },
  'workflow_run_tasks.worker_session_id': {
    kind: 'preserve',
    reason: 'The run outlives its worker sessions; deleting the task would corrupt the run',
  },
  'workflow_run_completion_pending.worker_session_id': {
    kind: 'preserve',
    reason: 'Completion bookkeeping drives the run, not the worker session',
  },
  'attention_items.consumed_by_session': {
    kind: 'preserve',
    reason: 'Consumption provenance on an item addressed to the space',
  },
  'memory_docs.created_by_session_id': {
    kind: 'preserve',
    reason:
      'Authorship provenance on a space-owned doc; session-scoped docs cascade via session_id',
  },
  'memory_doc_versions.created_by_session_id': {
    kind: 'preserve',
    reason: 'Version-history provenance; versions of session-scoped docs go with their doc',
  },
  'agent_schedules.target_session_id': {
    kind: 'preserve',
    reason: 'Schedules are operator-owned; a dangling target simply stops resolving',
  },
  'agent_schedules.last_session_id': {
    kind: 'preserve',
    reason: 'Last-fire provenance on an operator-owned schedule',
  },
  'agent_schedules.created_by_session_id': {
    kind: 'preserve',
    reason: 'Authorship provenance on an operator-owned schedule',
  },
  'coach_activity.coach_session_id': {
    kind: 'preserve',
    reason: 'Operator timeline provenance — audit surface, not session scope',
  },
  'coach_candidate_learnings.coach_session_id': {
    kind: 'preserve',
    reason: 'Learning-evidence provenance',
  },
  'coach_learnings.coach_session_id': {
    kind: 'preserve',
    reason: 'Learning-evidence provenance',
  },
  'coach_learnings.run_id': {
    kind: 'preserve',
    reason: 'Learning-evidence provenance',
  },
  'entity_event_log.caused_by_session_id': {
    kind: 'preserve',
    reason: 'Space-history causation provenance — audit surface',
  },
};

/**
 * Columns that match the name pattern but hold an id from a different domain
 * (workflow-run business keys, eval-run keys), never a session id.
 */
const NOT_A_SESSION_REFERENCE = new Set([
  'workflow_runs.run_id',
  'workflow_run_tasks.run_id',
  'workflow_run_waiters.run_id',
  'workflow_run_completion_pending.run_id',
  'attention_items.related_run_id',
  'coach_candidate_learnings.run_id',
  'eval_labels.run_id',
  'eval_case_results.run_id',
  'eval_label_queue.run_id',
  'eval_rejudge_verdicts.run_id',
  'entity_event_log.workflow_run_id',
]);

/**
 * How the purge must treat one `*_ref` column on a table the cascade deletes
 * rows from. `collected` columns are gathered by `collectSessionPayloadRefs`
 * before the deletes make them unrecoverable; `not_payload` columns hold
 * something other than a payload-store object and need no collection.
 */
export type PayloadRefPolicy = { kind: 'collected' } | { kind: 'not_payload'; reason: string };

/**
 * Every `*_ref` column on the tables {@link cascadeDeleteSession} deletes rows
 * from, keyed `table.column`. The column universe is derived at runtime
 * ({@link derivePayloadRefColumns}); this map only supplies the policy. A ref
 * column present in the schema but absent here fails
 * `sessionCascade.contract.test.ts`, so a payload reference on a purged row
 * cannot silently start leaking its object.
 */
export const PAYLOAD_REF_POLICY: Readonly<Record<string, PayloadRefPolicy>> = {
  'sessions.final_output_ref': { kind: 'collected' },
  'sessions.error_ref': { kind: 'collected' },
  'sessions.requested_input_ref': { kind: 'collected' },
  'sessions.target_inline_def_ref': { kind: 'collected' },
  'step_executions.input_ref': { kind: 'collected' },
  'step_executions.output_ref': { kind: 'collected' },
  'step_executions.error_ref': { kind: 'collected' },
  'event_log.payload_ref': { kind: 'collected' },
  'event_log.error_ref': { kind: 'collected' },
  'event_log.requested_input_ref': { kind: 'collected' },
  'idempotency_keys.result_ref': { kind: 'collected' },
  'workflow_runs.paused_payload_ref': { kind: 'collected' },
  'workflow_run_tasks.input_ref': { kind: 'collected' },
  'workflow_run_tasks.output_ref': { kind: 'collected' },
  'workflow_run_tasks.human_task_hydration_ref': { kind: 'collected' },
  'ui_artifact_versions.source_ref': { kind: 'collected' },
  'ui_artifact_versions.compiled_ref': { kind: 'collected' },
  'ui_artifact_versions.html_ref': { kind: 'collected' },
  'ui_artifact_versions.sample_data_payload_ref': { kind: 'collected' },
  'ui_artifact_drafts.source_ref': { kind: 'collected' },
  'ui_artifact_drafts.compiled_ref': { kind: 'collected' },
  'ui_artifact_drafts.html_ref': { kind: 'collected' },
  'memory_entries.content_ref': { kind: 'collected' },
  'memory_docs.payload_ref': { kind: 'collected' },
  'memory_doc_versions.payload_ref': { kind: 'collected' },
  'recoverable_runs.latest_snapshot_ref': { kind: 'collected' },
  'simulation_call_records.response_ref': { kind: 'collected' },
  'simulation_call_records.delta_ref': { kind: 'collected' },
  'simulation_run_contexts.snapshot_ref': { kind: 'collected' },
};

/**
 * Tables {@link cascadeDeleteSession} deletes rows from: every `cascade`
 * policy entry above contributes its table, plus the tables whose rows go
 * through a parent's linkage rather than an own session-id column.
 */
const CASCADE_DELETED_TABLES: ReadonlySet<string> = new Set([
  ...Object.entries(SESSION_REFERENCE_POLICY)
    .filter(([, policy]) => policy.kind === 'cascade')
    .map(([key]) => key.slice(0, key.indexOf('.'))),
  'workflow_run_tasks',
  'workflow_run_completion_pending',
  'applet_action_events',
  'applet_role_bindings',
  'artifact_bindings',
  'memory_chunks',
  'memory_doc_versions',
  'memory_links',
  'memory_entry_embeddings',
]);

export interface DerivedSessionColumn {
  table: string;
  column: string;
}

/**
 * Column names that can carry a session id. Matched broadly — a false positive
 * costs one policy line, a false negative leaves visitor data behind after a
 * purge.
 */
const SESSION_COLUMN_PATTERN = /(session|run)_id|_session$/;

/**
 * Enumerate the session-referencing columns the schema actually declares by
 * introspecting the drizzle tables rather than mirroring a hand-written list.
 */
export function deriveSessionReferenceColumns(
  tables: Record<string, unknown> = tenantSchema as unknown as Record<string, unknown>,
): DerivedSessionColumn[] {
  const found: DerivedSessionColumn[] = [];
  for (const value of Object.values(tables)) {
    if (!is(value, PgTable)) continue;
    const table = getTableName(value);
    for (const column of Object.values(getTableColumns(value))) {
      const col = column as unknown as { name: string };
      const key = `${table}.${col.name}`;
      if (!SESSION_COLUMN_PATTERN.test(col.name)) continue;
      if (NOT_A_SESSION_REFERENCE.has(key)) continue;
      found.push({ table, column: col.name });
    }
  }
  return found.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

/**
 * Enumerate the `*_ref` columns declared on the tables the session cascade
 * deletes rows from, by introspecting the drizzle tables rather than mirroring
 * a hand-written list.
 */
export function derivePayloadRefColumns(
  tables: Record<string, unknown> = tenantSchema as unknown as Record<string, unknown>,
): DerivedSessionColumn[] {
  const found: DerivedSessionColumn[] = [];
  for (const value of Object.values(tables)) {
    if (!is(value, PgTable)) continue;
    const table = getTableName(value);
    if (!CASCADE_DELETED_TABLES.has(table)) continue;
    for (const column of Object.values(getTableColumns(value))) {
      const col = column as unknown as { name: string };
      if (!col.name.endsWith('_ref')) continue;
      found.push({ table, column: col.name });
    }
  }
  return found.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}
