import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  primaryKey,
} from 'drizzle-orm/pg-core';
import type { AppletAssetsManifest, AppletDefinition } from '@aflow/schemas';

// ============================================================================

/**
 * UI artifacts — head pointer (one row per artifact, latest version).
 */
export const uiArtifacts = pgTable('ui_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull(),
  spaceId: uuid('space_id').notNull(),
  currentVersion: integer('current_version').notNull().default(0),
  catalogId: text('catalog_id').notNull(),
  catalogVersion: text('catalog_version').notNull(),
  catalogHash: text('catalog_hash').notNull(),
  tags: jsonb('tags').notNull().default([]).$type<string[]>(),
  bundleArtifactKey: text('bundle_artifact_key'),
  createdByActor: text('created_by_actor'),
  createdBySessionId: uuid('created_by_session_id'),
  createdByStepExecutionId: uuid('created_by_step_execution_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UiArtifactRow = typeof uiArtifacts.$inferSelect;
export type NewUiArtifactRow = typeof uiArtifacts.$inferInsert;

/**
 * UI artifact versions — immutable published versions.
 */
export const uiArtifactVersions = pgTable('ui_artifact_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactId: uuid('artifact_id')
    .notNull()
    .references(() => uiArtifacts.id),
  version: integer('version').notNull(),
  sourceRef: text('source_ref').notNull(),
  compiledRef: text('compiled_ref'),
  htmlRef: text('html_ref'),
  contentHash: text('content_hash').notNull(),
  prompt: text('prompt').notNull(),
  dataSchema: jsonb('data_schema'),
  validationReport: jsonb('validation_report'),
  parentVersionId: uuid('parent_version_id'),
  sampleData: jsonb('sample_data'),
  /** PayloadRef URI overflow path when the encoded `sampleData` exceeds
   *  the 64 KB inline cap. NULL otherwise. */
  sampleDataPayloadRef: text('sample_data_payload_ref'),
  /** Canonical validated applet definition — colocated so contract and view
   *  advance together. NULL for non-applet artifacts. */
  appletDefinition: jsonb('applet_definition').$type<AppletDefinition>(),
  /** Platform-computed hash over `appletDefinition`. NULL when it is. */
  definitionHash: text('definition_hash'),
  /** Library assets captured at publish for applet-kind versions — the record
   *  that `html_ref` was rewritten to render with no external fetch. NULL for
   *  non-applet artifacts. */
  assetsManifest: jsonb('assets_manifest').$type<AppletAssetsManifest>(),
  createdByActor: text('created_by_actor'),
  createdBySessionId: uuid('created_by_session_id'),
  createdByStepExecutionId: uuid('created_by_step_execution_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UiArtifactVersionRow = typeof uiArtifactVersions.$inferSelect;
export type NewUiArtifactVersionRow = typeof uiArtifactVersions.$inferInsert;

/**
 * UI artifact drafts — ephemeral drafts (TTL 24h).
 */
export const uiArtifactDrafts = pgTable('ui_artifact_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactId: uuid('artifact_id'),
  kind: text('kind').notNull(),
  spaceId: uuid('space_id').notNull(),
  prompt: text('prompt').notNull(),
  sourceRef: text('source_ref').notNull(),
  compiledRef: text('compiled_ref'),
  htmlRef: text('html_ref'),
  dataSchema: jsonb('data_schema'),
  validationReport: jsonb('validation_report'),
  catalogId: text('catalog_id').notNull(),
  catalogVersion: text('catalog_version').notNull(),
  catalogHash: text('catalog_hash').notNull(),
  status: text('status').notNull().default('draft'),
  /** Parsed applet definition emitted at generation; publish pins it (plus
   *  its hash) on the version row. NULL for non-applet drafts. */
  appletDefinition: jsonb('applet_definition').$type<AppletDefinition>(),
  createdByActor: text('created_by_actor'),
  createdBySessionId: uuid('created_by_session_id'),
  createdByStepExecutionId: uuid('created_by_step_execution_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UiArtifactDraftRow = typeof uiArtifactDrafts.$inferSelect;
export type NewUiArtifactDraftRow = typeof uiArtifactDrafts.$inferInsert;

export const artifactBindings = pgTable(
  'artifact_bindings',
  {
    spaceId: uuid('space_id').notNull(),
    bundleId: text('bundle_id').notNull(),
    bindingId: text('binding_id').notNull(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => uiArtifacts.id),
    /** Mirrors `ui_artifacts.bundle_artifact_key`. Denormalized here so
     *  operator UI can show the bundle handle without a join. */
    bundleArtifactKey: text('bundle_artifact_key').notNull(),
    installedContentHash: text('installed_content_hash'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.bundleId, table.bindingId] })],
);

export type ArtifactBindingRow = typeof artifactBindings.$inferSelect;
export type NewArtifactBindingRow = typeof artifactBindings.$inferInsert;
