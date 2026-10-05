import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as tenantSchema from '../schema/tenant/index.js';

/**
 * How erasure must treat one column that can hold a user id.
 *
 * The distinction between `scoped` and `provenance` is the load-bearing one: a
 * scope-narrowing column restricts a row to that user inside a broader space
 * (personal memory, a personal attention item, a user-scoped credential), so
 * erasure must DELETE the row — NULLing it would widen a private row to
 * space-wide visibility for the remaining members. A provenance column only
 * records who made a row that belongs to the space itself, where clearing the
 * identifier is correct and keeps shared history coherent.
 *
 * `reassign` exists because a provenance column can be NOT NULL. Those rows
 * belong to a space that survives, so neither NULL (constraint violation) nor
 * deletion (destroys a collaborator's row) is right; authorship moves to the
 * tenant successor instead.
 */
export type UserReferencePolicy =
  | { kind: 'scoped'; scopeColumn?: string; scopeValue?: string }
  | { kind: 'provenance' }
  | { kind: 'reassign' }
  | { kind: 'jsonb-actor'; jsonPath: string }
  | { kind: 'disposition' }
  | { kind: 'global' };

/**
 * Every tenant-schema column that can hold a user id, keyed `table.column`.
 *
 * The column universe is derived from the drizzle schema at runtime
 * ({@link deriveUserReferenceColumns}); this map only supplies the policy,
 * which cannot be inferred. A column present in the schema but absent here
 * fails `accountCascade.contract.test.ts`, so a new user reference cannot
 * silently escape erasure.
 */
export const USER_REFERENCE_POLICY: Readonly<Record<string, UserReferencePolicy>> = {
  // Scope-narrowing: the row is the user's own, inside a space that survives.
  'memory_docs.user_id': { kind: 'scoped' },
  'memory_dirs.user_id': { kind: 'scoped' },
  'memory_entries.user_id': { kind: 'scoped' },
  'attention_items.user_id': { kind: 'scoped' },
  // An assignment or a notification addressed to an erased person is about
  // nobody — the row goes with them, and the request returns to untargeted.
  'action_item_assignments.assignee_user_id': { kind: 'scoped' },
  'notification_outbox.recipient_user_id': { kind: 'scoped' },
  // A role binding is the user's seat at the applet — erasing them removes
  // the seat, never the instance.
  'applet_role_bindings.user_id': { kind: 'scoped' },
  // A session membership is the user's seat in the room — same treatment.
  'session_participants.user_id': { kind: 'scoped' },
  'session_participants.invited_by': { kind: 'provenance' },
  'provider_credentials.scope_id': { kind: 'scoped', scopeColumn: 'scope', scopeValue: 'user' },
  'oauth_clients.scope_id': { kind: 'scoped', scopeColumn: 'scope', scopeValue: 'user' },
  'oauth_tokens.owner_id': { kind: 'scoped', scopeColumn: 'owner_scope', scopeValue: 'user' },
  'oauth_state.owner_id': { kind: 'scoped', scopeColumn: 'owner_scope', scopeValue: 'user' },

  // Provenance on nullable columns — clear the identifier, keep the row.
  'sessions.created_by': { kind: 'provenance' },
  // A session belongs to its space, not to whoever opened or is steering it,
  // so clearing the identifier keeps the shared thread coherent for everyone
  // still in the space.
  'sessions.initiated_by': { kind: 'provenance' },
  'sessions.current_driver_user_id': { kind: 'provenance' },
  // Who named the conversation. The name they gave it stays — it is how
  // everyone still in the space finds the thread — and only the attribution
  // goes with them.
  'sessions.metadata_edited_by': { kind: 'provenance' },
  'agent_versions.created_by': { kind: 'provenance' },
  'agent_schedules.created_by': { kind: 'provenance' },
  'agent_schedules.creator_user_id': { kind: 'provenance' },
  'agent_slug_history.renamed_by': { kind: 'provenance' },
  'space_slug_history.renamed_by': { kind: 'provenance' },
  'golden_case_revisions.created_by_user_id': { kind: 'provenance' },
  'eval_batches.created_by_user_id': { kind: 'provenance' },
  'eval_baselines.pinned_by_user_id': { kind: 'provenance' },
  'guardrail_policies.created_by': { kind: 'provenance' },
  'webhook_endpoints.created_by': { kind: 'provenance' },
  'webhook_endpoints.creator_user_id': { kind: 'provenance' },
  'workflow_runs.initiated_by_user_id': { kind: 'provenance' },
  'workflow_runs.cancelled_by': { kind: 'provenance' },
  'coach_learnings.resolved_by': { kind: 'provenance' },
  'causal_measurements.recorded_by_user_id': { kind: 'provenance' },
  'space_capability_assignments.assigned_by': { kind: 'provenance' },
  'action_item_assignments.assigned_by': { kind: 'provenance' },
  'action_center_items_projection.resolved_by': { kind: 'provenance' },
  'tenant_audit_log.actor_id': { kind: 'provenance' },
  'spaces.created_by': { kind: 'provenance' },
  'plan_nodes.created_by': { kind: 'provenance' },
  'applet_instances.created_by': { kind: 'provenance' },
  // The receipt belongs to the instance's shared history; who acted is
  // provenance on it, not scope.
  'applet_action_events.actor_user_id': { kind: 'provenance' },
  // `created_by_actor` is a free-text actor string, usually `system:<name>` but
  // a bare user id when a human operator is the author (entityBootstrap).
  'memory_docs.created_by_actor': { kind: 'provenance' },
  'memory_dirs.created_by_actor': { kind: 'provenance' },
  'memory_doc_versions.created_by_actor': { kind: 'provenance' },
  'ui_artifacts.created_by_actor': { kind: 'provenance' },
  'ui_artifact_versions.created_by_actor': { kind: 'provenance' },
  'ui_artifact_drafts.created_by_actor': { kind: 'provenance' },

  // NOT NULL provenance — authorship moves to the tenant successor.
  'provider_credentials.created_by': { kind: 'reassign' },
  'oauth_clients.created_by': { kind: 'reassign' },
  'repo_bindings.created_by': { kind: 'reassign' },
  'store_installs.installed_by': { kind: 'reassign' },
  'store_installs.updated_by': { kind: 'reassign' },
  'store_install_claims.claimed_by': { kind: 'reassign' },
  'user_feedback.created_by_user_id': { kind: 'reassign' },
  'eval_labels.labeled_by_user_id': { kind: 'reassign' },
  'hitl_action_audit.resolver_user_id': { kind: 'reassign' },

  // The identifier is inside a JSONB document rather than a scalar column.
  'action_center_items_projection.requested_by': { kind: 'jsonb-actor', jsonPath: 'userId' },

  // Space ownership drives the purge/transfer decision itself; the generic
  // sweep must not rewrite it.
  'spaces.owner_id': { kind: 'disposition' },

  // Public-schema columns reached explicitly by the global phase, listed so the
  // guard accounts for every derived column in one place.
  'users.id': { kind: 'global' },
  'api_keys.user_id': { kind: 'global' },
  'user_identities.user_id': { kind: 'global' },
  'terms_acceptances.user_id': { kind: 'global' },
  'tenant_memberships.user_id': { kind: 'global' },
  'tenant_memberships.invited_by': { kind: 'global' },
  'space_memberships.user_id': { kind: 'global' },
  'tenant_capability_grants.user_id': { kind: 'global' },
  'tenant_capability_grants.granted_by': { kind: 'global' },
  'invites.invited_by': { kind: 'global' },
  'invites.accepted_by_user_id': { kind: 'global' },
  'space_grants.granted_by': { kind: 'global' },
  'space_grants.redeemed_by_user_id': { kind: 'global' },
  'invite_requests.decided_by': { kind: 'global' },
  'tenant_integration_allowlist.added_by': { kind: 'global' },
  'platform_audit_log.actor_id': { kind: 'global' },
  'egress_approval_requests.requested_by': { kind: 'global' },
  'egress_approval_requests.reviewed_by': { kind: 'global' },
};

export interface DerivedUserColumn {
  table: string;
  column: string;
  notNull: boolean;
}

/**
 * Column names that carry a user id. Matched broadly and by suffix — a false
 * positive costs one line of policy, a false negative leaves personal data
 * behind after erasure.
 */
const USER_COLUMN_PATTERN =
  /(^|_)(user_id|actor_id|owner_id|scope_id|created_by|created_by_actor)$|_user_id$|_by$/;

/** Columns that match the name pattern but never hold a user id. */
const NOT_A_USER_REFERENCE = new Set([
  // Polymorphic owner of an MCP server binding, never a user (tenant | space).
  'mcp_server_bindings.owner_id',
]);

/**
 * Enumerate the user-referencing columns the schema actually declares, with
 * their nullability, by introspecting the drizzle tables rather than mirroring
 * a hand-written list. Nullability is what tells `provenance` from `reassign`,
 * and it is only knowable from the schema.
 */
export function deriveUserReferenceColumns(
  tables: Record<string, unknown> = tenantSchema as unknown as Record<string, unknown>,
): DerivedUserColumn[] {
  const found: DerivedUserColumn[] = [];
  for (const value of Object.values(tables)) {
    if (!is(value, PgTable)) continue;
    const table = getTableName(value);
    for (const column of Object.values(getTableColumns(value))) {
      const col = column as unknown as { name: string; notNull: boolean };
      const key = `${table}.${col.name}`;
      if (!USER_COLUMN_PATTERN.test(col.name)) continue;
      if (NOT_A_USER_REFERENCE.has(key)) continue;
      found.push({ table, column: col.name, notNull: col.notNull });
    }
  }
  return found.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}
