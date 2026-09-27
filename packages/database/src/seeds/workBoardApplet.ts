/**
 * Seed the work-board applet artifact into a space: one ui_artifacts head row
 * and one ui_artifact_versions row carrying the view source alongside the
 * pinned definition + hash. Compile is lazy — the render path compiles from
 * sourceRef on first mount, so compiledRef/htmlRef stay null here.
 */
import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { canonicalJsonStringify, computeAppletDefinitionHash } from '@aflow/applet-runtime';
import { encodeInlinePayloadRef } from '@aflow/payload-store';
import {
  WORK_BOARD_CATALOG_PIN,
  WORK_BOARD_DEFINITION,
  WORK_BOARD_VIEW_SOURCE,
} from '@aflow/platform-artifacts';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { uiArtifacts, uiArtifactVersions } from '../schema/tenant.js';

export interface WorkBoardArtifactSeedResult {
  artifactId: string;
  artifactVersionId: string;
  definitionHash: string;
}

function inlineRefForString(text: string): string {
  return encodeInlinePayloadRef(text);
}

export async function seedWorkBoardArtifact(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  spaceId: string,
): Promise<WorkBoardArtifactSeedResult> {
  const definitionHash = computeAppletDefinitionHash(WORK_BOARD_DEFINITION);
  const contentHash = createHash('sha256')
    .update(
      canonicalJsonStringify({
        source: WORK_BOARD_VIEW_SOURCE,
        kind: 'applet',
        definition: WORK_BOARD_DEFINITION,
        catalogPin: WORK_BOARD_CATALOG_PIN,
      }),
      'utf8',
    )
    .digest('hex');

  return withTenantSchema(db, tenantContext, async (tx) => {
    const [artifact] = await tx
      .insert(uiArtifacts)
      .values({
        name: WORK_BOARD_DEFINITION.name,
        description: WORK_BOARD_DEFINITION.description,
        kind: 'applet',
        spaceId,
        currentVersion: 1,
        catalogId: WORK_BOARD_CATALOG_PIN.catalogId,
        catalogVersion: WORK_BOARD_CATALOG_PIN.catalogVersion,
        catalogHash: WORK_BOARD_CATALOG_PIN.catalogHash,
      })
      .returning({ id: uiArtifacts.id });
    if (!artifact) throw new Error('work-board artifact head insert returned no row');

    const [version] = await tx
      .insert(uiArtifactVersions)
      .values({
        artifactId: artifact.id,
        version: 1,
        sourceRef: inlineRefForString(WORK_BOARD_VIEW_SOURCE),
        compiledRef: null,
        htmlRef: null,
        contentHash,
        prompt: 'platform applet fixture: work-board',
        appletDefinition: WORK_BOARD_DEFINITION,
        definitionHash,
      })
      .returning({ id: uiArtifactVersions.id });
    if (!version) throw new Error('work-board artifact version insert returned no row');

    return { artifactId: artifact.id, artifactVersionId: version.id, definitionHash };
  });
}
