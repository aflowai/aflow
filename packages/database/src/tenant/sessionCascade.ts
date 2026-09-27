import type postgres from 'postgres';
import type { CascadeCounts } from './spaceCascade.js';

export interface SessionCascadeResult {
  deleted: CascadeCounts;
  /** Non-inline payload refs the session's rows pointed at, gathered before deletion. */
  payloadRefs: string[];
}

/**
 * Gather every non-inline payload ref the session's durable rows point at.
 * Must run BEFORE {@link cascadeDeleteSession} — after the deletes the refs
 * are unrecoverable and the payload objects would leak forever.
 *
 * Which `*_ref` columns must appear here is governed by `PAYLOAD_REF_POLICY`
 * (contract-tested against the drizzle schema): every ref column on a table
 * the cascade deletes rows from is either `collected` below — with the same
 * row scoping as the cascade's delete — or `not_payload` with a reason.
 */
export async function collectSessionPayloadRefs(
  sqlTx: postgres.Sql,
  schemaName: string,
  sessionId: string,
): Promise<string[]> {
  const refs = new Set<string>();
  const add = (rows: postgres.Row[]): void => {
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.length > 0 && !value.startsWith('inline:')) {
          refs.add(value);
        }
      }
    }
  };

  add(
    await sqlTx`
      SELECT final_output_ref, error_ref, requested_input_ref, target_inline_def_ref
        FROM ${sqlTx(schemaName)}.sessions WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT input_ref, output_ref, error_ref
        FROM ${sqlTx(schemaName)}.step_executions WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT payload_ref, error_ref, requested_input_ref
        FROM ${sqlTx(schemaName)}.event_log WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT result_ref
        FROM ${sqlTx(schemaName)}.idempotency_keys WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT paused_payload_ref
        FROM ${sqlTx(schemaName)}.workflow_runs WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT input_ref, output_ref, human_task_hydration_ref
        FROM ${sqlTx(schemaName)}.workflow_run_tasks
        WHERE run_id IN (
          SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE session_id = ${sessionId}
        )
    `,
  );
  add(
    await sqlTx`
      SELECT source_ref, compiled_ref, html_ref, sample_data_payload_ref
        FROM ${sqlTx(schemaName)}.ui_artifact_versions
        WHERE created_by_session_id = ${sessionId}
          OR artifact_id IN (
            SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts WHERE created_by_session_id = ${sessionId}
          )
    `,
  );
  add(
    await sqlTx`
      SELECT source_ref, compiled_ref, html_ref
        FROM ${sqlTx(schemaName)}.ui_artifact_drafts WHERE created_by_session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT content_ref
        FROM ${sqlTx(schemaName)}.memory_entries WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT payload_ref
        FROM ${sqlTx(schemaName)}.memory_docs WHERE session_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT payload_ref
        FROM ${sqlTx(schemaName)}.memory_doc_versions
        WHERE doc_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_docs WHERE session_id = ${sessionId}
        )
    `,
  );
  add(
    await sqlTx`
      SELECT latest_snapshot_ref
        FROM public.recoverable_runs WHERE run_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT response_ref, delta_ref
        FROM ${sqlTx(schemaName)}.simulation_call_records WHERE run_id = ${sessionId}
    `,
  );
  add(
    await sqlTx`
      SELECT snapshot_ref
        FROM ${sqlTx(schemaName)}.simulation_run_contexts WHERE run_id = ${sessionId}
    `,
  );

  return [...refs];
}

/**
 * Hard-delete one session and everything that exists because of it, inside the
 * caller's tx. Sibling of `cascadeDeleteSpace` — same FK-ordering discipline,
 * narrowed to a single session. Which columns cascade vs survive is governed
 * by `SESSION_REFERENCE_POLICY` (contract-tested against the drizzle schema).
 *
 * Idempotent: every delete is WHERE-scoped, so a rerun after a partial failure
 * deletes nothing twice and finishes the remainder.
 *
 * @param sqlTx postgres-js client already inside a tx (`sql.begin`). Typed as
 *   `postgres.Sql` for the same reason as `cascadeDeleteSpace`.
 * @param schemaName Tenant schema (`t_<hex>`). MUST be pre-validated.
 * @param sessionId Session UUID.
 */
export async function cascadeDeleteSession(
  sqlTx: postgres.Sql,
  schemaName: string,
  sessionId: string,
): Promise<SessionCascadeResult> {
  const payloadRefs = await collectSessionPayloadRefs(sqlTx, schemaName, sessionId);
  const counts: CascadeCounts = {};

  const del = async (label: string, q: postgres.PendingQuery<postgres.Row[]>): Promise<void> => {
    const result = await q;
    const rowCount = (result as unknown as { count?: number }).count ?? result.length;
    if (rowCount > 0) counts[label] = rowCount;
  };

  // guardrail_*.session_id is TEXT (schema/tenant.ts) — the string param
  // compares directly, no cast needed.
  await del(
    'guardrail_violations',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.guardrail_violations WHERE session_id = ${sessionId}`,
  );
  await del(
    'guardrail_checks',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.guardrail_checks WHERE session_id = ${sessionId}`,
  );

  await del(
    'idempotency_keys',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.idempotency_keys WHERE session_id = ${sessionId}`,
  );

  await del(
    'async_jobs',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.async_jobs WHERE run_id = ${sessionId}`,
  );

  await del(
    'simulation_call_records',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.simulation_call_records WHERE run_id = ${sessionId}`,
  );

  await del(
    'simulation_run_contexts',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.simulation_run_contexts WHERE run_id = ${sessionId}`,
  );

  // Workflow runs the session started. Children first, keyed by the runs' text
  // run_id; the waiters delete also drops rows registering THIS session as a
  // waiter on someone else's run, which would dangle once the session is gone.
  await del(
    'workflow_run_tasks',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.workflow_run_tasks
        WHERE run_id IN (
          SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE session_id = ${sessionId}
        )
    `,
  );
  await del(
    'workflow_run_waiters',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.workflow_run_waiters
        WHERE waiter_session_id = ${sessionId}
          OR run_id IN (
            SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE session_id = ${sessionId}
          )
    `,
  );
  await del(
    'workflow_run_completion_pending',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.workflow_run_completion_pending
        WHERE run_id IN (
          SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE session_id = ${sessionId}
        )
    `,
  );
  await del(
    'workflow_runs',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.workflow_runs WHERE session_id = ${sessionId}`,
  );

  // Applet instances bound to the session, plus any instance pinned to an
  // artifact version this session authored — those versions are deleted below
  // and applet_instances.artifact_version_id has no ON DELETE CASCADE.
  await del(
    'applet_action_events',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.applet_action_events
        WHERE instance_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.applet_instances
            WHERE bound_session_id = ${sessionId}
              OR artifact_version_id IN (
                SELECT id FROM ${sqlTx(schemaName)}.ui_artifact_versions
                  WHERE created_by_session_id = ${sessionId}
                    OR artifact_id IN (
                      SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts
                        WHERE created_by_session_id = ${sessionId}
                    )
              )
        )
    `,
  );
  await del(
    'applet_role_bindings',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.applet_role_bindings
        WHERE instance_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.applet_instances
            WHERE bound_session_id = ${sessionId}
              OR artifact_version_id IN (
                SELECT id FROM ${sqlTx(schemaName)}.ui_artifact_versions
                  WHERE created_by_session_id = ${sessionId}
                    OR artifact_id IN (
                      SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts
                        WHERE created_by_session_id = ${sessionId}
                    )
              )
        )
    `,
  );
  await del(
    'applet_instances',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.applet_instances
        WHERE bound_session_id = ${sessionId}
          OR artifact_version_id IN (
            SELECT id FROM ${sqlTx(schemaName)}.ui_artifact_versions
              WHERE created_by_session_id = ${sessionId}
                OR artifact_id IN (
                  SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts
                    WHERE created_by_session_id = ${sessionId}
                )
          )
    `,
  );

  // UI artifacts the session authored. artifact_bindings has no ON DELETE
  // CASCADE (migration 93); versions cover both session-authored versions of
  // surviving artifacts and every version of session-authored artifacts.
  await del(
    'artifact_bindings',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.artifact_bindings
        WHERE artifact_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts WHERE created_by_session_id = ${sessionId}
        )
    `,
  );
  await del(
    'ui_artifact_versions',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.ui_artifact_versions
        WHERE created_by_session_id = ${sessionId}
          OR artifact_id IN (
            SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts WHERE created_by_session_id = ${sessionId}
          )
    `,
  );
  await del(
    'ui_artifact_drafts',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.ui_artifact_drafts WHERE created_by_session_id = ${sessionId}`,
  );
  await del(
    'ui_artifacts',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.ui_artifacts WHERE created_by_session_id = ${sessionId}`,
  );

  // Session-scoped memory. Children of session-scoped docs/entries first.
  await del(
    'memory_chunks',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_chunks
        WHERE doc_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_docs WHERE session_id = ${sessionId}
        )
    `,
  );
  await del(
    'memory_doc_versions',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_doc_versions
        WHERE doc_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_docs WHERE session_id = ${sessionId}
        )
    `,
  );
  await del(
    'memory_links',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_links
        WHERE from_doc_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_docs WHERE session_id = ${sessionId}
        )
    `,
  );
  await del(
    'memory_entry_embeddings',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_entry_embeddings
        WHERE entry_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_entries WHERE session_id = ${sessionId}
        )
    `,
  );
  await del(
    'memory_docs',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.memory_docs WHERE session_id = ${sessionId}`,
  );
  await del(
    'memory_dirs',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.memory_dirs WHERE session_id = ${sessionId}`,
  );
  await del(
    'memory_entries',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.memory_entries WHERE session_id = ${sessionId}`,
  );

  // Direct children of the sessions row (FK to sessions, no cascade).
  await del(
    'event_log',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.event_log WHERE session_id = ${sessionId}`,
  );
  await del(
    'step_executions',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.step_executions WHERE session_id = ${sessionId}`,
  );

  // Cross-schema (public). recoverable_runs should already be gone for a
  // terminal-flushed session; error_reports may carry run content in the
  // error detail, so residue-free means deleting them too.
  await del(
    'public.recoverable_runs',
    sqlTx`DELETE FROM public.recoverable_runs WHERE run_id = ${sessionId}`,
  );
  await del(
    'public.error_reports',
    sqlTx`DELETE FROM public.error_reports WHERE run_id = ${sessionId}`,
  );

  await del(
    'sessions',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.sessions WHERE session_id = ${sessionId}`,
  );

  return { deleted: counts, payloadRefs };
}
