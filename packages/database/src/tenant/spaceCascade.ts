import type postgres from 'postgres';

/** Per-table counts (delete returning rowCount). Tables that don't
 *  apply (no rows for this space) don't appear. */
export type CascadeCounts = Record<string, number>;

const DIRECT_SPACE_ID_TABLES = [
  'sessions',
  'memory_docs',
  'memory_dirs',
  'memory_entries',
  'workflow_runs',
  'agent_schedules',
  'webhook_endpoints',
  'ui_artifacts',
  'ui_artifact_drafts',
  'eval_labels',
  'eval_label_queue',
  'eval_rejudge_verdicts',
  'golden_case_revisions',
  'golden_datasets',
  'eval_baselines',
  'eval_batches',
  'user_feedback',
  'causal_measurements',
  'guardrail_policies',
  'agents',
  'api_definitions',
  'mcp_server_definitions',
  'api_bindings',
  'api_credentials',
  'mcp_server_bindings',
  'simulations',
  'simulation_baselines',
  'simulation_entities',
  'simulation_call_records',
  'simulation_run_contexts',
  'coach_activity',
  'attention_items',
  'action_center_items_projection',
  'hitl_action_audit',
  'space_capability_assignments',
  'entity_event_log',
  'tenant_audit_log',
  'campaigns',
  'coach_candidate_learnings',
  'coach_learnings',
  'repo_bindings',
  'store_installs',
  'store_install_artifacts',
  'store_install_claims',
] as const;

/**
 * Run the full cascade for a single space inside the caller's tx. The
 * `tx` here is a postgres-js tagged-template instance scoped to the
 * caller's transaction (`sql.begin(async (tx) => { ... })` semantics).
 *
 * Order rationale:
 *   1. Cascading-via-parent rows first (chunks, versions, tasks,
 *      step_executions, event_log) — these reference space-scoped
 *      parents, not space_id directly.
 *   2. Direct space_id rows (memory_docs, sessions, workflow_runs,
 *      schedules, webhooks, ui_artifacts, …) in any order — they don't
 *      reference each other.
 *   3. Cross-schema (`public.space_memberships`, `public.tenants`).
 *   4. The spaces row itself. Always last.
 *
 * @param sqlTx postgres-js client already inside a tx (`sql.begin`). Typed
 *   as `postgres.Sql` rather than `postgres.TransactionSql` because the
 *   latter's `Omit` strips the anonymous call signatures, leaving the
 *   tagged-template / identifier helpers untyped. Callers pass their tx
 *   handle cast to `Sql` — it is callable at runtime.
 * @param schemaName Tenant schema (`t_<hex>`). MUST be pre-validated.
 * @param spaceId Space UUID.
 * @returns Per-table delete counts.
 */
export async function cascadeDeleteSpace(
  sqlTx: postgres.Sql,
  schemaName: string,
  spaceId: string,
): Promise<CascadeCounts> {
  const counts: CascadeCounts = {};

  /** Helper: run a DELETE and capture rowCount under a label. */
  const del = async (label: string, q: postgres.PendingQuery<postgres.Row[]>): Promise<void> => {
    const result = await q;
    const rowCount = (result as unknown as { count?: number }).count ?? result.length;
    if (rowCount > 0) counts[label] = rowCount;
  };

  // --------------------------------------------------------------------------
  // 1. Cascading-via-parent rows.
  //    These reference space-scoped parents (sessions, memory_docs,
  //    workflow_runs, ui_artifacts). Delete children first.
  // --------------------------------------------------------------------------

  // idempotency_keys ← sessions. This API-boundary dedup table (resume_run /
  // retry_run, sessions.ts) has NO space_id and NO FK, so the sessions delete
  // below would leave its rows dangling — a forget-me purge must clear them,
  // and the audit/preview must count them. Both writers always set session_id
  // (the row also carries a nullable step_execution_id, but never without a
  // session_id), so scoping by the space's sessions is complete. session_id is
  // UUID, matching sessions.session_id — no cast. Must run BEFORE the sessions
  // delete so the subquery still resolves. If a step-only idempotency writer is
  // ever added to this generic table, add a step_execution_id sweep here.
  await del(
    'idempotency_keys',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.idempotency_keys
        WHERE session_id IN (
          SELECT session_id FROM ${sqlTx(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );

  // step_executions ← sessions (no FK with CASCADE, must be explicit)
  await del(
    'step_executions',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.step_executions
        WHERE session_id IN (
          SELECT session_id FROM ${sqlTx(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );

  // async_jobs ← sessions. Rows carry a provider job id and a cost, so leaving
  // them behind orphans billing evidence for a space that no longer exists.
  await del(
    'async_jobs',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.async_jobs
        WHERE run_id IN (
          SELECT session_id::text FROM ${sqlTx(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );

  // event_log ← sessions
  await del(
    'event_log',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.event_log
        WHERE session_id IN (
          SELECT session_id FROM ${sqlTx(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );

  // Memory invariant: every memory writer scopes by space_id (the put/mkdir
  // handler sets `scope = { spaceId }`; the entityBootstrap / consolidator /
  // baseline / evalRunner inserts all set spaceId; the v1 memory_entries
  // `upsert` has no row-creating callers). memory_docs/dirs/entries DO carry

  // memory_links carries its own space_id (FK from_doc_id → memory_docs is ON
  // DELETE CASCADE, but we delete explicitly before memory_docs for the audit
  // count and to keep dependency order deterministic).
  await del(
    'memory_links',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.memory_links WHERE space_id = ${spaceId}`,
  );

  // memory_chunks ← memory_docs
  await del(
    'memory_chunks',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_chunks
        WHERE doc_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_docs WHERE space_id = ${spaceId}
        )
    `,
  );

  // memory_doc_versions ← memory_docs
  await del(
    'memory_doc_versions',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_doc_versions
        WHERE doc_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_docs WHERE space_id = ${spaceId}
        )
    `,
  );

  // memory_entry_embeddings ← memory_entries (v1 vectors, written by the memory
  // repo's upsertEmbedding). entry_id REFERENCES memory_entries(id) ON DELETE
  // CASCADE (migration 004/006/148), so the memory_entries delete in the §2 loop
  // would clear these anyway — but a cascade-only delete returns no rowCount, so
  // we delete explicitly (before that loop) for the audit + preview counts.
  // entry_id is UUID, matching memory_entries.id — no cast. The table is
  // pgvector-gated: migration148 guarantees it exists on any tenant where
  // pgvector is enabled (repairing migration004/006's swallowed HNSW
  // failures); an environment without pgvector genuinely has neither this
  // table nor memory_chunks' vector columns.
  await del(
    'memory_entry_embeddings',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.memory_entry_embeddings
        WHERE entry_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.memory_entries WHERE space_id = ${spaceId}
        )
    `,
  );

  // workflow_run_tasks ← workflow_runs
  await del(
    'workflow_run_tasks',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.workflow_run_tasks
        WHERE run_id IN (
          SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE space_id = ${spaceId}
        )
    `,
  );

  // workflow_run_waiters + workflow_run_completion_pending ← workflow_runs.
  // Both have `run_id ... REFERENCES workflow_runs(run_id) ON DELETE CASCADE`
  // (migration 071), so the workflow_runs delete below would clear them anyway
  // — there is no orphan risk. We delete explicitly only so the audit log and
  await del(
    'workflow_run_waiters',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.workflow_run_waiters
        WHERE run_id IN (
          SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE space_id = ${spaceId}
        )
    `,
  );
  await del(
    'workflow_run_completion_pending',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.workflow_run_completion_pending
        WHERE run_id IN (
          SELECT run_id FROM ${sqlTx(schemaName)}.workflow_runs WHERE space_id = ${spaceId}
        )
    `,
  );

  // eval_batch_members + eval_case_results ← eval_batches (no space_id of
  // their own — children go before the §2 eval_batches delete).
  await del(
    'eval_batch_members',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.eval_batch_members
        WHERE batch_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.eval_batches WHERE space_id = ${spaceId}
        )
    `,
  );
  await del(
    'eval_case_results',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.eval_case_results
        WHERE batch_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.eval_batches WHERE space_id = ${spaceId}
        )
    `,
  );

  // applet_action_events + applet_role_bindings ← applet_instances (no ON
  // DELETE CASCADE — children must go first). applet_instances itself carries
  // space_id but is deleted here rather than in the §2 loop because its
  // artifact_version_id FK-references ui_artifact_versions, which the next
  // block deletes.
  await del(
    'applet_action_events',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.applet_action_events
        WHERE instance_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.applet_instances WHERE space_id = ${spaceId}
        )
    `,
  );
  await del(
    'applet_role_bindings',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.applet_role_bindings
        WHERE instance_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.applet_instances WHERE space_id = ${spaceId}
        )
    `,
  );
  await del(
    'applet_instances',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.applet_instances WHERE space_id = ${spaceId}`,
  );

  // ui_artifact_versions ← ui_artifacts
  await del(
    'ui_artifact_versions',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.ui_artifact_versions
        WHERE artifact_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.ui_artifacts WHERE space_id = ${spaceId}
        )
    `,
  );

  // artifact_bindings ← ui_artifacts. `artifact_id REFERENCES ui_artifacts(id)`
  // has NO ON DELETE CASCADE (migration 93), so the section-2 ui_artifacts
  // delete would FK-fail for any space with bundle-shipped artifacts unless we
  // clear the bindings first. artifact_bindings carries its own space_id, so
  // delete by space (simpler than the artifact_id subquery).
  await del(
    'artifact_bindings',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.artifact_bindings WHERE space_id = ${spaceId}`,
  );

  // guardrail_violations ← sessions
  // NOTE: guardrail_violations.session_id is TEXT (schema/tenant.ts), not UUID
  // like sessions.session_id. Cast the subquery to text so the IN comparison
  // resolves; without this Postgres errors with `operator does not exist: text = uuid`.
  await del(
    'guardrail_violations',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.guardrail_violations
        WHERE session_id IN (
          SELECT session_id::text FROM ${sqlTx(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );

  // guardrail_checks ← sessions (same text-vs-uuid mismatch — cast subquery)
  await del(
    'guardrail_checks',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.guardrail_checks
        WHERE session_id IN (
          SELECT session_id::text FROM ${sqlTx(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );

  // agent_versions ← agents; agent_slug_history ← agents + spaces;
  // space_slug_history ← spaces. All three declare ON DELETE CASCADE
  // (migration 098), so the agents delete (§2 loop) and the final spaces delete
  // would clear them anyway — no orphan risk. We delete explicitly, BEFORE
  // those parents, only so the audit log + purge-preview counts reflect them:
  // the operator confirm dialog sums per-table counts into the irreversible
  // blast radius, and a cascade-only delete returns no rowCount. agent_versions
  // has no space_id of its own (scoped via agents); both history tables carry
  // space_id, so a plain space_id clause suffices there.
  await del(
    'agent_versions',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.agent_versions
        WHERE agent_id IN (
          SELECT id FROM ${sqlTx(schemaName)}.agents WHERE space_id = ${spaceId}
        )
    `,
  );
  await del(
    'agent_slug_history',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.agent_slug_history WHERE space_id = ${spaceId}`,
  );
  await del(
    'space_slug_history',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.space_slug_history WHERE space_id = ${spaceId}`,
  );

  // --------------------------------------------------------------------------
  // 2. Direct space_id rows.
  //    A plain `WHERE space_id = $space` clears each; order within the set is
  //    free (children were cleared in §1). Driven by the shared
  //    DIRECT_SPACE_ID_TABLES list so the dry-run preview counts exactly what
  //    this deletes — see that const for the integration-secret / no-FK and
  //    tenant_audit_log rationale.
  // --------------------------------------------------------------------------

  for (const table of DIRECT_SPACE_ID_TABLES) {
    await del(
      table,
      sqlTx`DELETE FROM ${sqlTx(schemaName)}.${sqlTx(table)} WHERE space_id = ${spaceId}`,
    );
  }

  // provider_credentials uses scope='space', scope_id=<spaceId>.
  await del(
    'provider_credentials',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.provider_credentials
        WHERE scope = 'space' AND scope_id = ${spaceId}
    `,
  );

  // oauth_clients uses scope='space', scope_id=<spaceId> — same shape as
  // provider_credentials. Holds encrypted_client_secret; leaving a space-scoped
  // row behind after purge is a credential leak, not just an orphaned row.
  await del(
    'oauth_clients',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.oauth_clients
        WHERE scope = 'space' AND scope_id = ${spaceId}
    `,
  );

  // oauth_tokens has no space_id — a space-scoped token is owner_scope='space'
  // with owner_id = the spaceId (text). User/tenant tokens survive a single-
  // space archive (Plan 185 O2). owner_id is text; spaceId is a uuid string.
  await del(
    'oauth_tokens',
    sqlTx`
      DELETE FROM ${sqlTx(schemaName)}.oauth_tokens
        WHERE owner_scope = 'space' AND owner_id = ${spaceId}
    `,
  );

  // oauth_state carries space_id directly — clear transient consent state for
  // any in-flight flow scoped to this space, regardless of owner_scope.
  await del(
    'oauth_state',
    sqlTx`DELETE FROM ${sqlTx(schemaName)}.oauth_state WHERE space_id = ${spaceId}`,
  );

  // memory_embed_config is deliberately NOT swept. It's a scoped config table
  // (scope_type 'global'|'space'|'flow'|'path_prefix', scope_value text) with
  // no space_id and no FK — so a space-scoped row (scope_type='space',
  // scope_value=<spaceId>) or a per-agent override (scope_type='flow',
  // scope_value=<agentId>) WOULD orphan on purge. But its only writer,
  // memoryDocs.setEmbedConfig, has zero production callers — no operation,
  // route, or handler wires it — so no such rows exist to orphan. Adding a
  // speculative delete (esp. the flow case, a text-cast subquery over agents)
  // would be untested SQL guarding impossible rows. If setEmbedConfig is ever
  // wired to a real surface, add deletes/counts here AND in
  // previewCascadeForSpace for scope_type='space' AND scope_value=<spaceId>,
  // and scope_type='flow' AND scope_value IN (space's agent ids, ::text-cast).

  // --------------------------------------------------------------------------
  // 3. Cross-schema (public).
  // --------------------------------------------------------------------------

  await del(
    'public.space_memberships',
    sqlTx`DELETE FROM public.space_memberships WHERE space_id = ${spaceId}`,
  );
  await del(
    'public.space_grants',
    sqlTx`DELETE FROM public.space_grants WHERE space_id = ${spaceId}`,
  );

  // public.egress_approval_requests has a NULLABLE space_id.
  await del(
    'public.egress_approval_requests',
    sqlTx`DELETE FROM public.egress_approval_requests WHERE space_id = ${spaceId}`,
  );

  // If this space was a tenant default, NULL it out before the spaces row
  // delete (FK is informal — public.tenants references the tenant schema's
  // spaces.id, no DB-enforced constraint, so this is just hygiene).
  await sqlTx`
    UPDATE public.tenants SET default_space_id = NULL WHERE default_space_id = ${spaceId}
  `;

  // --------------------------------------------------------------------------
  // 4. The spaces row itself. Always last.
  // --------------------------------------------------------------------------

  await del('spaces', sqlTx`DELETE FROM ${sqlTx(schemaName)}.spaces WHERE id = ${spaceId}`);

  return counts;
}

// ============================================================================
// Dry-run probe — count rows per table without deleting.
// ============================================================================

/**
 * Mirror of `cascadeDeleteSpace` that COUNTs instead of DELETEs. Used by
 * the CLI's `--dry-run` mode and the operator purge-preview. Same FK shape;
 * same labels.
 */
export async function previewCascadeForSpace(
  sqlClient: postgres.Sql,
  schemaName: string,
  spaceId: string,
): Promise<CascadeCounts> {
  const counts: CascadeCounts = {};

  const count = async (label: string, q: postgres.PendingQuery<postgres.Row[]>): Promise<void> => {
    const result = (await q) as unknown as Array<{ c: number }>;
    const c = result[0]?.c ?? 0;
    if (c > 0) counts[label] = c;
  };

  // Cascading-via-parent (mirror of cascadeDeleteSpace §1). The preview must
  // count EVERY table the purge deletes — the operator confirm dialog presents
  // the summed totalRows as the complete blast radius, so any omission here
  await count(
    'idempotency_keys',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.idempotency_keys
        WHERE session_id IN (
          SELECT session_id FROM ${sqlClient(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'step_executions',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.step_executions
        WHERE session_id IN (
          SELECT session_id FROM ${sqlClient(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'async_jobs',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.async_jobs
        WHERE run_id IN (
          SELECT session_id::text FROM ${sqlClient(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'event_log',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.event_log
        WHERE session_id IN (
          SELECT session_id FROM ${sqlClient(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'memory_links',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.memory_links WHERE space_id = ${spaceId}`,
  );
  await count(
    'memory_chunks',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.memory_chunks
        WHERE doc_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.memory_docs WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'memory_doc_versions',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.memory_doc_versions
        WHERE doc_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.memory_docs WHERE space_id = ${spaceId}
        )
    `,
  );
  // memory_entry_embeddings cascade-deletes via FK when memory_entries go; the
  // purge clears them explicitly in §1 for counting — mirror that here.
  await count(
    'memory_entry_embeddings',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.memory_entry_embeddings
        WHERE entry_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.memory_entries WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'workflow_run_tasks',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.workflow_run_tasks
        WHERE run_id IN (
          SELECT run_id FROM ${sqlClient(schemaName)}.workflow_runs WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'workflow_run_waiters',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.workflow_run_waiters
        WHERE run_id IN (
          SELECT run_id FROM ${sqlClient(schemaName)}.workflow_runs WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'workflow_run_completion_pending',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.workflow_run_completion_pending
        WHERE run_id IN (
          SELECT run_id FROM ${sqlClient(schemaName)}.workflow_runs WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'eval_batch_members',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.eval_batch_members
        WHERE batch_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.eval_batches WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'eval_case_results',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.eval_case_results
        WHERE batch_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.eval_batches WHERE space_id = ${spaceId}
        )
    `,
  );
  // applet tables are deleted in §1 (FK ordering vs ui_artifact_versions) —
  // count them here alongside the other children.
  await count(
    'applet_action_events',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.applet_action_events
        WHERE instance_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.applet_instances WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'applet_role_bindings',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.applet_role_bindings
        WHERE instance_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.applet_instances WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'applet_instances',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.applet_instances WHERE space_id = ${spaceId}`,
  );
  await count(
    'ui_artifact_versions',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.ui_artifact_versions
        WHERE artifact_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.ui_artifacts WHERE space_id = ${spaceId}
        )
    `,
  );
  // artifact_bindings carries its own space_id (direct), but the purge deletes
  // it in §1 for FK ordering — count it here alongside the other children.
  await count(
    'artifact_bindings',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.artifact_bindings WHERE space_id = ${spaceId}`,
  );
  // guardrail_*.session_id is TEXT (not the sessions UUID) — cast the subquery.
  await count(
    'guardrail_violations',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.guardrail_violations
        WHERE session_id IN (
          SELECT session_id::text FROM ${sqlClient(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'guardrail_checks',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.guardrail_checks
        WHERE session_id IN (
          SELECT session_id::text FROM ${sqlClient(schemaName)}.sessions WHERE space_id = ${spaceId}
        )
    `,
  );
  // agent_versions / agent_slug_history / space_slug_history cascade-delete via
  // FK when agents + spaces go (migration 098); the purge deletes them
  // explicitly in §1 for counting — mirror those counts here so the preview's
  // totalRows matches the actual blast radius. See cascadeDeleteSpace.
  await count(
    'agent_versions',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.agent_versions
        WHERE agent_id IN (
          SELECT id FROM ${sqlClient(schemaName)}.agents WHERE space_id = ${spaceId}
        )
    `,
  );
  await count(
    'agent_slug_history',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.agent_slug_history WHERE space_id = ${spaceId}`,
  );
  await count(
    'space_slug_history',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.space_slug_history WHERE space_id = ${spaceId}`,
  );

  // Direct space_id — same shared list the purge iterates (no drift).
  for (const t of DIRECT_SPACE_ID_TABLES) {
    await count(
      t,
      sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.${sqlClient(t)} WHERE space_id = ${spaceId}`,
    );
  }

  // Scoped + cross-schema (mirror of cascadeDeleteSpace §2 tail and §3).
  await count(
    'provider_credentials',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.provider_credentials
        WHERE scope = 'space' AND scope_id = ${spaceId}
    `,
  );
  await count(
    'oauth_clients',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.oauth_clients
        WHERE scope = 'space' AND scope_id = ${spaceId}
    `,
  );
  // oauth_tokens: space-scoped rows only (owner_scope='space', owner_id=spaceId).
  await count(
    'oauth_tokens',
    sqlClient`
      SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.oauth_tokens
        WHERE owner_scope = 'space' AND owner_id = ${spaceId}
    `,
  );
  // oauth_state: all transient consent rows for this space (has space_id).
  await count(
    'oauth_state',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.oauth_state WHERE space_id = ${spaceId}`,
  );
  await count(
    'public.space_memberships',
    sqlClient`SELECT COUNT(*)::int AS c FROM public.space_memberships WHERE space_id = ${spaceId}`,
  );
  await count(
    'public.space_grants',
    sqlClient`SELECT COUNT(*)::int AS c FROM public.space_grants WHERE space_id = ${spaceId}`,
  );
  await count(
    'public.egress_approval_requests',
    sqlClient`SELECT COUNT(*)::int AS c FROM public.egress_approval_requests WHERE space_id = ${spaceId}`,
  );
  // The spaces row itself (purge counts it as 1) — included for total parity.
  await count(
    'spaces',
    sqlClient`SELECT COUNT(*)::int AS c FROM ${sqlClient(schemaName)}.spaces WHERE id = ${spaceId}`,
  );

  return counts;
}
