import { pgTable, uuid, text, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

// ============================================================================
// Store install provenance (space-scoped records of catalog installations)
// ============================================================================

/**
 * One active installation of a catalog listing in a space.
 * `installedVersion` + `installedContentHash` capture what was installed —
 * update badges compare the catalog version against `installedVersion`, and
 * customized detection compares an artifact's current hash against its
 * installed hash. `skippedVersion` records a "Keep mine" choice and suppresses
 * the update badge until the catalog moves past that version.
 */
export const storeInstalls = pgTable(
  'store_installs',
  {
    catalogId: text('catalog_id').notNull(),

    /** Owning space — part of the composite PK. */
    spaceId: uuid('space_id').notNull(),

    /** Listing kind: 'skill' | 'bundle' | 'connector'. */
    kind: text('kind').notNull(),

    installedVersion: integer('installed_version').notNull(),

    installedContentHash: text('installed_content_hash').notNull(),

    skippedVersion: integer('skipped_version'),

    /** Lifecycle state: 'installed' | 'removing'. */
    state: text('state').notNull().default('installed'),

    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),

    installedBy: uuid('installed_by').notNull(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    updatedBy: uuid('updated_by').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogId, table.spaceId] }),
    index('idx_store_installs_space').on(table.spaceId),
  ],
);

export type StoreInstallRow = typeof storeInstalls.$inferSelect;
export type NewStoreInstallRow = typeof storeInstalls.$inferInsert;

/**
 * Queryable inventory of the artifacts an installation created — what update
 * may replace and what uninstall owns.
 */
export const storeInstallArtifacts = pgTable(
  'store_install_artifacts',
  {
    catalogId: text('catalog_id').notNull(),

    spaceId: uuid('space_id').notNull(),

    artifactType: text('artifact_type').notNull(),

    artifactKey: text('artifact_key').notNull(),

    artifactId: text('artifact_id').notNull(),

    installedContentHash: text('installed_content_hash').notNull(),

    /**
     * 'replace_on_update' | 'user_data_keep' — 'user_data_keep' artifacts may
     * hold user data by install time and are never replaced by update.
     */
    preservation: text('preservation').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.catalogId, table.spaceId, table.artifactType, table.artifactKey],
    }),
    index('idx_store_install_artifacts_space').on(table.spaceId, table.catalogId),
  ],
);

export type StoreInstallArtifactRow = typeof storeInstallArtifacts.$inferSelect;
export type NewStoreInstallArtifactRow = typeof storeInstallArtifacts.$inferInsert;

/**
 * Who holds an installation in place: 'direct' (installed from its own
 * listing) and/or one row per claiming bundle ('bundle:<catalogId>').
 * Uninstall releases a claim; artifacts go only when the last claim does.
 */
export const storeInstallClaims = pgTable(
  'store_install_claims',
  {
    catalogId: text('catalog_id').notNull(),

    spaceId: uuid('space_id').notNull(),

    /** 'direct' | 'bundle:<catalogId>'. */
    claimedBy: text('claimed_by').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogId, table.spaceId, table.claimedBy] }),
    index('idx_store_install_claims_space').on(table.spaceId, table.catalogId),
  ],
);

export type StoreInstallClaimRow = typeof storeInstallClaims.$inferSelect;
export type NewStoreInstallClaimRow = typeof storeInstallClaims.$inferInsert;
