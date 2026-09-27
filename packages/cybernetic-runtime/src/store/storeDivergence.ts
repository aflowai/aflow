/**
 * Customized detection — recompute-at-read comparison of each
 * replace_on_update artifact's CURRENT space content against the
 * `installedContentHash` the last install/update stamped. Uses the same
 * hashing authority the stamps use (`artifactContent.ts`), so pristine means
 * "byte-identical to what the store last wrote", modified means someone
 * edited it, missing means it is gone (or archived). user_data_keep
 * artifacts are excluded — they are expected to change.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import type {
  StoreArtifactDivergence,
  StoreInstallArtifact,
  StoreInstallDivergence,
  TenantId,
} from '@aflow/schemas';
import { workflowDocPath } from '../stagedChange/skillComposeApply.js';
import {
  apiDefinitionRowContentHash,
  jsonContentHash,
  mcpDefinitionRowContentHash,
  skillDocContent,
} from './artifactContent.js';
import { currentAppletArtifactState } from './appletInstall.js';
import { listStoreInstallArtifacts } from './storeInstallProvenance.js';
import { provenanceArtifactKey } from './storeDerivations.js';
import type { PayloadStore } from '@aflow/payload-store';

export interface StoreDivergenceContext {
  tenantId: TenantId;
  spaceId: string;
  /** Reconstructs a content-addressed applet source for the Mine-vs-Store payload. */
  payloadStore?: PayloadStore | undefined;
}

export interface ComputeInstallDivergenceOptions {
  /**
   * The registry-side content per replace_on_update artifact key
   * (`deriveRegistryArtifactContents`); when present, modified artifacts carry
   * Mine-vs-Store content payloads.
   */
  registryContents?: ReadonlyMap<string, unknown>;
}

interface CurrentArtifactState {
  hash: string | null;
  content?: unknown;
}

async function currentArtifactState(
  tx: PostgresJsDatabase,
  ctx: StoreDivergenceContext,
  artifact: StoreInstallArtifact,
): Promise<CurrentArtifactState> {
  switch (artifact.artifactType) {
    case 'skill': {
      const repo = createMemoryDocRepository(tx, createTenantContext(ctx.tenantId), {
        inTransaction: true,
      });
      const doc = await repo.getByPath(workflowDocPath(artifact.artifactKey), ctx.spaceId);
      if (!doc?.inlineContent) return { hash: null };
      let parsed: unknown;
      try {
        parsed = JSON.parse(doc.inlineContent);
      } catch {
        return { hash: '<unparseable>' };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { hash: '<unparseable>' };
      }
      const content = skillDocContent(parsed as Record<string, unknown>);
      return { hash: jsonContentHash(content), content };
    }
    case 'api_definition': {
      const rows = await tx.execute<{ definition_json: unknown }>(sql`
        SELECT definition_json FROM api_definitions
        WHERE api_id = ${artifact.artifactKey} AND space_id = ${ctx.spaceId}::uuid
        LIMIT 1
      `);
      const row = rows[0];
      return row === undefined
        ? { hash: null }
        : { hash: apiDefinitionRowContentHash(row.definition_json), content: row.definition_json };
    }
    case 'mcp_definition': {
      const rows = await tx.execute<{ definition_json: Record<string, unknown> }>(sql`
        SELECT definition_json FROM mcp_server_definitions
        WHERE server_id = ${artifact.artifactKey} AND space_id = ${ctx.spaceId}::uuid
        LIMIT 1
      `);
      const row = rows[0];
      if (row === undefined) return { hash: null };
      const { source: _source, ...content } = row.definition_json;
      return { hash: mcpDefinitionRowContentHash(row.definition_json), content };
    }
    // Applet listings own their ui_artifact as replace_on_update content;
    // bundle-seeded ui_artifacts are user_data_keep and never reach here.
    case 'ui_artifact':
      return currentAppletArtifactState(tx, ctx.spaceId, artifact.artifactKey, ctx.payloadStore);
    // No remaining type can carry replace_on_update today; an unexpected one
    // fails closed as modified rather than silently pristine.
    case 'api_binding':
    case 'mcp_binding':
    case 'memory_doc':
      return { hash: '<unknown-artifact-type>' };
  }
}

const CONTENT_PAYLOAD_CAP_BYTES = 256 * 1024;

function renderContentPayload(value: unknown): string | null {
  const json = JSON.stringify(JSON.parse(JSON.stringify(value)), null, 2);
  return Buffer.byteLength(json, 'utf8') > CONTENT_PAYLOAD_CAP_BYTES ? null : json;
}

function diffContents(
  current: CurrentArtifactState,
  registryContent: unknown,
): Pick<StoreArtifactDivergence, 'contents' | 'contentsTruncated'> {
  if (current.content === undefined || registryContent === undefined) return {};
  const mine = renderContentPayload(current.content);
  const store = renderContentPayload(registryContent);
  if (mine === null || store === null) return { contentsTruncated: true };
  return { contents: { mine, store } };
}

export async function computeInstallDivergence(
  tx: PostgresJsDatabase,
  ctx: StoreDivergenceContext,
  catalogId: string,
  opts: ComputeInstallDivergenceOptions = {},
): Promise<StoreInstallDivergence> {
  const rows = await listStoreInstallArtifacts(tx, ctx.spaceId, catalogId);
  const artifacts: StoreArtifactDivergence[] = [];
  for (const artifact of rows) {
    if (artifact.preservation !== 'replace_on_update') continue;
    const current = await currentArtifactState(tx, ctx, artifact);
    const state: StoreArtifactDivergence['state'] =
      current.hash === null
        ? 'missing'
        : current.hash === artifact.installedContentHash
          ? 'pristine'
          : 'modified';
    artifacts.push({
      artifactType: artifact.artifactType,
      artifactKey: artifact.artifactKey,
      state,
      ...(state === 'modified' && opts.registryContents !== undefined
        ? diffContents(current, opts.registryContents.get(provenanceArtifactKey(artifact)))
        : {}),
    });
  }
  return {
    customized: artifacts.some((artifact) => artifact.state !== 'pristine'),
    artifacts,
  };
}
