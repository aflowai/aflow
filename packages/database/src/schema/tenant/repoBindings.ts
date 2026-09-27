import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Repo Bindings (coding-lane repo authority — operator-created, outside flows)
// ============================================================================

/**
 * A space-scoped repo designation fixes the authority boundary for the coding
 * lane: the repo coordinate (host-qualified, e.g. `github.com/munchist/duality`),
 * default branch, allowed push-branch patterns, egress hosts, and named operator
 * check profiles. The git credential is referenced by name (`credential_key` →
 * api_credentials within the same space) — the token itself is never stored here.
 *
 * The agent and skills reference a repo by its coordinate (Plan 222), not an
 * operator-invented id; `repo_designation_id` is an opaque surrogate used only as
 * the REST/row handle. The clone remote is derived from the coordinate
 * (`https://host/owner/repo.git`) — no raw remote string is ever stored, which
 * keeps the https-only / no-userinfo authority provable.
 */
export const repoBindings = pgTable(
  'repo_bindings',
  {
    /** Opaque surrogate — the REST/row handle. Operators and agents use `coordinate`. */
    repoDesignationId: text('repo_designation_id').notNull(),

    /** Owning space — part of the composite PK. */
    spaceId: uuid('space_id').notNull(),

    /** Canonical host-qualified coordinate, e.g. `github.com/munchist/duality`. Unique per space. */
    coordinate: text('coordinate').notNull(),

    description: text('description'),

    defaultBranch: text('default_branch').notNull(),

    allowedPushBranchPatterns: jsonb('allowed_push_branch_patterns')
      .notNull()
      .default([])
      .$type<string[]>(),

    egressHosts: jsonb('egress_hosts').notNull().default([]).$type<string[]>(),

    checkProfilesJson: jsonb('check_profiles_json')
      .notNull()
      .default([])
      .$type<Array<{ name: string; commands: string[] }>>(),

    /**
     * App-level reference to the GitHub connection (`api_bindings.binding_id`,
     * same space; no FK, mirroring `apiId`/`credentialKey`). The connection owns
     * the github API definition the coding skills call AND — on the fallback path
     * — the git credential. Plan 222 P3: required, so a designation always names
     * the connection its tasks resolve through.
     */
    connectionBindingId: text('connection_binding_id').notNull(),

    /**
     * OPTIONAL per-repo git credential override (name reference into
     * api_credentials(credential_key, space_id) — never the secret). When set it
     * takes precedence over the connection's credential for git (per-repo
     * isolation / OAuth-API + PAT-git); when NULL the git token is resolved
     * THROUGH the connection's `authJson.credentialKey`.
     */
    credentialKey: text('credential_key'),

    /** Lifecycle status: 'provisioning' | 'ready' | 'error' | 'archived'. */
    status: text('status').notNull().default('provisioning'),

    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),

    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),

    lastErrorCode: text('last_error_code'),

    createdBy: uuid('created_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.repoDesignationId, table.spaceId] }),
    uniqueIndex('uq_repo_bindings_coordinate').on(table.spaceId, table.coordinate),
    index('idx_repo_bindings_space').on(table.spaceId),
  ],
);

export type RepoBindingRow = typeof repoBindings.$inferSelect;
export type NewRepoBindingRow = typeof repoBindings.$inferInsert;
