/**
 * The publish core shared by ui.artifact.publish and the applet
 * publish-on-instantiate path: load + gate the draft, resolve artifact
 * identity, insert the immutable version (pinning the applet definition and
 * its hash when the draft carries one), and delete the draft — one
 * transaction for the durable writes.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  AppletDefinitionSchema,
  type AflowError,
  type AppletAssetsManifest,
  type AppletDefinition,
} from '@aflow/schemas';
import { validationError } from '@aflow/executor-runtime';
import { computeAppletDefinitionHash } from '@aflow/applet-runtime';
import type { HermeticCaptureResult } from './appletHermeticPublish.js';

export interface DraftRow {
  id: string;
  artifact_id: string | null;
  kind: string;
  space_id: string;
  prompt: string;
  source_ref: string;
  compiled_ref: string | null;
  html_ref: string | null;
  data_schema: unknown;
  validation_report: unknown;
  catalog_id: string;
  catalog_version: string;
  catalog_hash: string;
  status: string;
  applet_definition: unknown;
  expires_at: string;
  created_at: string;
}

export interface PublishCoreDeps {
  withSchema<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T>;
  loadBlob(ref: string): Promise<string>;
  /** Applet-kind publishes must capture library assets; absent = applet publish refused. */
  captureHermeticApplet?: (draftHtml: string) => Promise<HermeticCaptureResult>;
}

export interface PublishDraftParams {
  spaceId: string;
  draftId: string;
  artifactId?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  runId: string;
  stepExecutionId: string;
  /** The applet path — refuse (without mutating) a draft that carries no definition. */
  requireAppletDefinition?: boolean;
}

export type PublishDraftCoreResult =
  | {
      ok: true;
      artifactId: string;
      versionId: string;
      version: number;
      parentVersionId: string | null;
      draft: DraftRow;
      sourceContent: string;
      /** For applet-kind drafts this is the hermetic (asset-inlined) HTML. */
      htmlContent: string;
      resolvedName: string;
      appletDefinition?: AppletDefinition;
      definitionHash?: string;
      assetsManifest?: AppletAssetsManifest;
    }
  | { ok: false; error: AflowError };

export async function publishDraftCore(
  deps: PublishCoreDeps,
  params: PublishDraftParams,
): Promise<PublishDraftCoreResult> {
  const { spaceId, draftId, description, tags, runId, stepExecutionId } = params;

  const draftRows = (await deps.withSchema(async (sql) => {
    return await sql`SELECT * FROM ui_artifact_drafts
      WHERE id = ${draftId}::uuid AND space_id = ${spaceId}::uuid LIMIT 1`;
  })) as DraftRow[];
  const draft = draftRows[0];
  if (!draft) {
    return { ok: false, error: validationError(`Draft not found: ${draftId}`) };
  }
  if (draft.status === 'failed') {
    return {
      ok: false,
      error: validationError('Cannot publish a failed draft. Fix validation errors first.'),
    };
  }
  if (!draft.html_ref) {
    return {
      ok: false,
      error: validationError('Draft has no rendered HTML. Re-generate first.'),
    };
  }

  let appletDefinition: AppletDefinition | undefined;
  let definitionHash: string | undefined;
  if (draft.applet_definition != null) {
    const parsed = AppletDefinitionSchema.safeParse(draft.applet_definition);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return {
        ok: false,
        error: validationError(`Draft's applet definition does not parse: ${detail}`),
      };
    }
    appletDefinition = parsed.data;
    definitionHash = computeAppletDefinitionHash(parsed.data);
  } else if (params.requireAppletDefinition) {
    return {
      ok: false,
      error: validationError(
        'Draft carries no applet definition — generate with applet: true, then instantiate that draft.',
      ),
    };
  }

  const resolvedName = params.name ?? appletDefinition?.name ?? 'Untitled Artifact';
  const sourceContent = await deps.loadBlob(draft.source_ref);
  let htmlContent = await deps.loadBlob(draft.html_ref);
  const contentHash = createHash('sha256').update(sourceContent).digest('hex');

  let versionHtmlRef: string = draft.html_ref;
  let assetsManifest: AppletAssetsManifest | undefined;
  if (draft.kind === 'applet') {
    if (!deps.captureHermeticApplet) {
      return {
        ok: false,
        error: validationError(
          'applet publish requires hermetic asset capture and none is wired (platform bug)',
        ),
      };
    }
    const captureResult = await deps.captureHermeticApplet(htmlContent);
    if (!captureResult.ok) {
      return captureResult;
    }
    versionHtmlRef = captureResult.hermetic.htmlRef;
    htmlContent = captureResult.hermetic.html;
    assetsManifest = captureResult.hermetic.manifest;
  }

  let artifactId = params.artifactId;
  const result = await deps.withSchema(async (sql) => {
    if (!artifactId && draft.artifact_id) {
      artifactId = draft.artifact_id;
    }

    let resolvedArtifactId: string;
    let parentVersionId: string | null = null;
    let nextVersion: number;

    if (artifactId) {
      const existing = (await sql`SELECT current_version FROM ui_artifacts
          WHERE id = ${artifactId}::uuid AND space_id = ${spaceId}::uuid LIMIT 1`) as Array<{
        current_version: number;
      }>;
      const head = existing[0];
      if (head) {
        nextVersion = head.current_version + 1;
        resolvedArtifactId = artifactId;

        if (head.current_version > 0) {
          const parentRows = (await sql`
            SELECT id FROM ui_artifact_versions
            WHERE artifact_id = ${artifactId}::uuid AND version = ${head.current_version} LIMIT 1
          `) as Array<{ id: string }>;
          parentVersionId = parentRows[0]?.id ?? null;
        }

        await sql`
          UPDATE ui_artifacts SET
            name = ${resolvedName},
            description = ${description ?? null},
            current_version = ${nextVersion},
            tags = ${JSON.stringify(tags ?? [])}::jsonb,
            catalog_id = ${draft.catalog_id},
            catalog_version = ${draft.catalog_version},
            catalog_hash = ${draft.catalog_hash},
            updated_at = NOW()
          WHERE id = ${artifactId}::uuid
        `;
      } else {
        nextVersion = 1;
        const newRows = (await sql`
          INSERT INTO ui_artifacts (id, name, description, kind, space_id, current_version,
            catalog_id, catalog_version, catalog_hash, tags,
            created_by_session_id, created_by_step_execution_id)
          VALUES (${artifactId}::uuid, ${resolvedName}, ${description ?? null}, ${draft.kind},
            ${draft.space_id}::uuid, 1,
            ${draft.catalog_id}, ${draft.catalog_version}, ${draft.catalog_hash},
            ${JSON.stringify(tags ?? [])}::jsonb,
            ${runId}::uuid, ${stepExecutionId}::uuid)
          RETURNING id
        `) as Array<{ id: string }>;
        resolvedArtifactId = newRows[0]!.id;
      }
    } else {
      nextVersion = 1;
      const newRows = (await sql`
        INSERT INTO ui_artifacts (name, description, kind, space_id, current_version,
          catalog_id, catalog_version, catalog_hash, tags,
          created_by_session_id, created_by_step_execution_id)
        VALUES (${resolvedName}, ${description ?? null}, ${draft.kind},
          ${draft.space_id}::uuid, 1,
          ${draft.catalog_id}, ${draft.catalog_version}, ${draft.catalog_hash},
          ${JSON.stringify(tags ?? [])}::jsonb,
          ${runId}::uuid, ${stepExecutionId}::uuid)
        RETURNING id
      `) as Array<{ id: string }>;
      resolvedArtifactId = newRows[0]!.id;
    }

    // Code deploys ahead of migrations here: naming the applet columns in
    // every INSERT would fail ALL publishes in a pre-152/153 window. Plain
    // artifact publishes take the legacy column list and survive it; applet
    // publishes genuinely need the columns and fail loudly until migrated.
    const versionRows = (
      appletDefinition === undefined && assetsManifest === undefined
        ? await sql`
      INSERT INTO ui_artifact_versions (
        artifact_id, version, source_ref, compiled_ref, html_ref,
        content_hash, prompt, data_schema, validation_report,
        parent_version_id, created_by_session_id, created_by_step_execution_id
      ) VALUES (
        ${resolvedArtifactId}::uuid, ${nextVersion}, ${draft.source_ref},
        ${draft.compiled_ref}, ${versionHtmlRef}, ${contentHash},
        ${draft.prompt}, ${JSON.stringify(draft.data_schema ?? null)}::jsonb,
        ${JSON.stringify(draft.validation_report ?? null)}::jsonb,
        ${parentVersionId}::uuid, ${runId}::uuid, ${stepExecutionId}::uuid
      ) RETURNING id
    `
        : await sql`
      INSERT INTO ui_artifact_versions (
        artifact_id, version, source_ref, compiled_ref, html_ref,
        content_hash, prompt, data_schema, validation_report,
        applet_definition, definition_hash, assets_manifest,
        parent_version_id, created_by_session_id, created_by_step_execution_id
      ) VALUES (
        ${resolvedArtifactId}::uuid, ${nextVersion}, ${draft.source_ref},
        ${draft.compiled_ref}, ${versionHtmlRef}, ${contentHash},
        ${draft.prompt}, ${JSON.stringify(draft.data_schema ?? null)}::jsonb,
        ${JSON.stringify(draft.validation_report ?? null)}::jsonb,
        ${appletDefinition !== undefined ? JSON.stringify(appletDefinition) : null}::jsonb,
        ${definitionHash ?? null},
        ${assetsManifest !== undefined ? JSON.stringify(assetsManifest) : null}::jsonb,
        ${parentVersionId}::uuid, ${runId}::uuid, ${stepExecutionId}::uuid
      ) RETURNING id
    `
    ) as Array<{ id: string }>;

    await sql`DELETE FROM ui_artifact_drafts WHERE id = ${draftId}::uuid`;

    return {
      artifactId: resolvedArtifactId,
      versionId: versionRows[0]!.id,
      version: nextVersion,
      parentVersionId,
    };
  });

  return {
    ok: true,
    ...result,
    draft,
    sourceContent,
    htmlContent,
    resolvedName,
    ...(appletDefinition !== undefined && definitionHash !== undefined
      ? { appletDefinition, definitionHash }
      : {}),
    ...(assetsManifest !== undefined ? { assetsManifest } : {}),
  };
}
