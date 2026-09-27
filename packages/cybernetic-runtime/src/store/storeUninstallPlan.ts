/**
 * Store uninstall plan — the one read-only authority behind both the
 * blast-radius preview and the uninstall execution, so what the user was
 * shown is exactly what runs. Provenance-driven end to end (no registry
 * entry needed — a delisted listing stays uninstallable): claims decide
 * whether the entry or a bundle member is fully released or merely loses one
 * claim; released inventories map to per-kind actions — skill → reversible
 * archive, integration → delete only when no remaining skill or coding repo
 * references it (else disable, with the dependents named), user-data →
 * keep by default, deletable only when explicitly unchecked AND pristine.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { countActiveAppletInstancesForArtifact } from '@aflow/database';
import {
  buildBundleClaimant,
  type StoreInstall,
  type StoreInstallArtifact,
  type StoreUninstallArtifactPlan,
  type StoreUninstallMemberPlan,
  type StoreUninstallPlan,
  type TenantId,
} from '@aflow/schemas';
import { collectCapabilityReferences } from '../scheduling/capabilityReferencesValidator.js';
import { collectOperationTaskApiRefs, type OperationTaskLike } from '../operationTaskApiRefs.js';
import { readAppletArtifactHead, type AppletTeardownTarget } from './appletInstall.js';
import { countActiveRepoDependents } from './connectorUninstall.js';
import { jsonContentHash } from './artifactContent.js';
import {
  getStoreInstall,
  listStoreInstallArtifacts,
  listStoreInstallArtifactsBySpace,
  listStoreInstallClaims,
  listStoreInstallClaimsByClaimant,
} from './storeInstallProvenance.js';
import { provenanceArtifactKey } from './storeDerivations.js';

export interface StoreUninstallPlanContext {
  tenantId: TenantId;
  spaceId: string;
}

export interface StoreUninstallPlanOptions {
  /** Artifact keys of user-data artifacts to keep; null keeps all. */
  keepUserData: ReadonlySet<string> | null;
}

export interface PlannedSkillArchive {
  skillId: string;
  slug: string;
  activeRunIds: string[];
}

export interface PlannedIntegrationTeardown {
  sourceKind: 'api' | 'mcp';
  integrationId: string;
  deletable: boolean;
  /** In-scope bindings — disabled when the integration must stay. */
  bindingIds: string[];
}

export interface StoreUninstallExecutionPlan {
  install: StoreInstall;
  response: StoreUninstallPlan;
  /** Entries fully released — their provenance rows go with the uninstall. */
  removedEntries: string[];
  /** Claims to drop for members that stay installed. */
  releasedMemberClaims: Array<{ catalogId: string; claimedBy: string }>;
  skillsToArchive: PlannedSkillArchive[];
  integrations: PlannedIntegrationTeardown[];
  /** In-scope bindings whose integration is not part of this uninstall. */
  standaloneBindingDisables: Array<{
    sourceKind: 'api' | 'mcp';
    integrationId: string;
    bindingId: string;
  }>;
  memoryDocsToDelete: Array<{ docId: string; path: string }>;
  uiArtifactsToDelete: Array<{ artifactRowId: string; bindingId: string }>;
  /** Applet-listing artifacts — removal archives their live instances first. */
  appletArtifactsToRemove: AppletTeardownTarget[];
}

interface InstalledSkillDoc {
  slug: string;
  name: string;
  referencedIntegrationIds: ReadonlySet<string>;
}

async function loadInstalledSkillDocs(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<Map<string, InstalledSkillDoc>> {
  const rows = (await tx.execute(sql`
    SELECT path, inline_content FROM memory_docs
    WHERE space_id = ${spaceId}::uuid
      AND deleted_at IS NULL
      AND path LIKE '/workflows/%/workflow.json'
  `)) as unknown as Array<{ path: string; inline_content: string | null }>;
  const docs = new Map<string, InstalledSkillDoc>();
  for (const row of rows) {
    const slug = row.path.split('/')[2];
    if (!slug || !row.inline_content) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.inline_content);
    } catch {
      continue;
    }
    const name =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? typeof (parsed as Record<string, unknown>)['name'] === 'string'
          ? ((parsed as Record<string, unknown>)['name'] as string)
          : slug
        : slug;
    // Operation-grant refs carry the integration prefix as their identifier
    // (platform prefixes are already excluded by the collector); op-task
    // inputTemplate refs are the second reference channel the grants miss.
    const referencedIntegrationIds = new Set(
      collectCapabilityReferences(parsed).map((ref) => ref.identifier),
    );
    const tasks =
      parsed !== null && typeof parsed === 'object' ? (parsed as { tasks?: unknown }).tasks : null;
    const taskLikes = Array.isArray(tasks)
      ? (tasks.filter((task) => task !== null && typeof task === 'object') as OperationTaskLike[])
      : [];
    for (const ref of collectOperationTaskApiRefs(taskLikes)) {
      referencedIntegrationIds.add(ref.apiId);
    }
    docs.set(slug, { slug, name, referencedIntegrationIds });
  }
  return docs;
}

async function listActiveRunIds(
  tx: PostgresJsDatabase,
  spaceId: string,
  workflowSlug: string,
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT run_id FROM workflow_runs
    WHERE space_id = ${spaceId}::uuid
      AND workflow_slug = ${workflowSlug}
      AND status IN ('running', 'paused')
  `)) as unknown as Array<{ run_id: string }>;
  return rows.map((row) => row.run_id);
}

async function apiDefinitionExists(
  tx: PostgresJsDatabase,
  spaceId: string,
  apiId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT api_id FROM api_definitions
    WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ api_id: string }>;
  return rows.length > 0;
}

async function mcpDefinitionExists(
  tx: PostgresJsDatabase,
  spaceId: string,
  serverId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT server_id FROM mcp_server_definitions
    WHERE server_id = ${serverId} AND space_id = ${spaceId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ server_id: string }>;
  return rows.length > 0;
}

async function readApiBindingIntegration(
  tx: PostgresJsDatabase,
  spaceId: string,
  bindingId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT api_id FROM api_bindings
    WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ api_id: string }>;
  return rows[0]?.api_id ?? null;
}

async function readMcpBindingIntegration(
  tx: PostgresJsDatabase,
  spaceId: string,
  bindingId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT server_id FROM mcp_server_bindings
    WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ server_id: string }>;
  return rows[0]?.server_id ?? null;
}

async function readMemoryDoc(
  tx: PostgresJsDatabase,
  spaceId: string,
  path: string,
): Promise<{ id: string; inlineContent: string | null } | null> {
  const rows = (await tx.execute(sql`
    SELECT id, inline_content FROM memory_docs
    WHERE path = ${path} AND space_id = ${spaceId}::uuid AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{ id: string; inline_content: string | null }>;
  const row = rows[0];
  return row === undefined ? null : { id: row.id, inlineContent: row.inline_content };
}

async function readUiArtifactHead(
  tx: PostgresJsDatabase,
  spaceId: string,
  bundleArtifactKey: string,
): Promise<{ id: string; contentHash: string | null } | null> {
  const rows = (await tx.execute(sql`
    SELECT a.id AS id, v.content_hash AS content_hash
    FROM ui_artifacts a
    LEFT JOIN ui_artifact_versions v
      ON v.artifact_id = a.id AND v.version = a.current_version
    WHERE a.space_id = ${spaceId}::uuid
      AND a.bundle_artifact_key = ${bundleArtifactKey}
      AND a.deleted_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{ id: string; content_hash: string | null }>;
  const row = rows[0];
  return row === undefined ? null : { id: row.id, contentHash: row.content_hash };
}

export async function buildStoreUninstallPlan(
  tx: PostgresJsDatabase,
  ctx: StoreUninstallPlanContext,
  catalogId: string,
  opts: StoreUninstallPlanOptions,
): Promise<StoreUninstallExecutionPlan | null> {
  const install = await getStoreInstall(tx, ctx.spaceId, catalogId);
  if (!install) return null;

  const claims = await listStoreInstallClaims(tx, ctx.spaceId, catalogId);
  const remainingClaims = claims
    .map((claim) => claim.claimedBy)
    .filter((claimedBy) => claimedBy !== 'direct')
    .sort();
  const action: StoreUninstallPlan['action'] =
    remainingClaims.length === 0 ? 'remove' : 'release_claim';

  const members: StoreUninstallMemberPlan[] = [];
  const removedEntries: string[] = [];
  const releasedMemberClaims: Array<{ catalogId: string; claimedBy: string }> = [];
  const stayingArtifactKeys = new Set<string>();

  if (action === 'remove') {
    removedEntries.push(catalogId);
    if (install.kind === 'bundle') {
      const claimant = buildBundleClaimant(catalogId);
      const memberClaims = await listStoreInstallClaimsByClaimant(tx, ctx.spaceId, claimant);
      for (const memberClaim of memberClaims) {
        const memberId = memberClaim.catalogId;
        if (memberId === catalogId) continue;
        const memberInstall = await getStoreInstall(tx, ctx.spaceId, memberId);
        if (!memberInstall) {
          releasedMemberClaims.push({ catalogId: memberId, claimedBy: claimant });
          continue;
        }
        const memberAllClaims = await listStoreInstallClaims(tx, ctx.spaceId, memberId);
        const memberRemaining = memberAllClaims
          .map((claim) => claim.claimedBy)
          .filter((claimedBy) => claimedBy !== claimant)
          .sort();
        if (memberRemaining.length === 0) {
          members.push({ catalogId: memberId, action: 'remove', remainingClaims: [] });
          removedEntries.push(memberId);
        } else {
          members.push({ catalogId: memberId, action: 'stays', remainingClaims: memberRemaining });
          releasedMemberClaims.push({ catalogId: memberId, claimedBy: claimant });
        }
      }
    }
  }

  // Artifacts any entry OUTSIDE this uninstall still claims (a standalone
  // connector sharing a bundle's definition, another bundle's member) are
  // excluded from teardown — their bindings fall back to the disable path.
  if (removedEntries.length > 0) {
    const removedSet = new Set(removedEntries);
    for (const artifact of await listStoreInstallArtifactsBySpace(tx, ctx.spaceId)) {
      if (removedSet.has(artifact.catalogId)) continue;
      stayingArtifactKeys.add(provenanceArtifactKey(artifact));
    }
  }

  const inventory: StoreInstallArtifact[] = [];
  const seenKeys = new Set<string>();
  for (const entry of removedEntries) {
    for (const artifact of await listStoreInstallArtifacts(tx, ctx.spaceId, entry)) {
      const key = provenanceArtifactKey(artifact);
      if (seenKeys.has(key) || stayingArtifactKeys.has(key)) continue;
      seenKeys.add(key);
      inventory.push(artifact);
    }
  }

  const installedSkills =
    inventory.length > 0
      ? await loadInstalledSkillDocs(tx, ctx.spaceId)
      : new Map<string, InstalledSkillDoc>();

  const skillArtifacts = inventory.filter((artifact) => artifact.artifactType === 'skill');
  const slugsToArchive = new Set(
    skillArtifacts
      .filter((artifact) => installedSkills.has(artifact.artifactKey))
      .map((artifact) => artifact.artifactKey),
  );

  const dependentSkillNamesFor = (integrationId: string): string[] => {
    const names: string[] = [];
    for (const doc of installedSkills.values()) {
      if (slugsToArchive.has(doc.slug)) continue;
      if (doc.referencedIntegrationIds.has(integrationId)) names.push(doc.name);
    }
    return names.sort();
  };

  const artifacts: StoreUninstallArtifactPlan[] = [];
  const skillsToArchive: PlannedSkillArchive[] = [];
  const integrations: PlannedIntegrationTeardown[] = [];
  const integrationByKey = new Map<string, PlannedIntegrationTeardown>();
  const standaloneBindingDisables: StoreUninstallExecutionPlan['standaloneBindingDisables'] = [];
  const memoryDocsToDelete: StoreUninstallExecutionPlan['memoryDocsToDelete'] = [];
  const uiArtifactsToDelete: StoreUninstallExecutionPlan['uiArtifactsToDelete'] = [];
  const appletArtifactsToRemove: StoreUninstallExecutionPlan['appletArtifactsToRemove'] = [];

  for (const artifact of skillArtifacts) {
    if (!slugsToArchive.has(artifact.artifactKey)) {
      artifacts.push({
        artifactType: 'skill',
        artifactKey: artifact.artifactKey,
        action: 'missing',
      });
      continue;
    }
    const activeRunIds = await listActiveRunIds(tx, ctx.spaceId, artifact.artifactKey);
    artifacts.push({
      artifactType: 'skill',
      artifactKey: artifact.artifactKey,
      action: 'archive',
      activeRunCount: activeRunIds.length,
    });
    skillsToArchive.push({
      skillId: artifact.artifactId,
      slug: artifact.artifactKey,
      activeRunIds,
    });
  }

  for (const artifact of inventory) {
    if (artifact.artifactType !== 'api_definition' && artifact.artifactType !== 'mcp_definition') {
      continue;
    }
    const sourceKind = artifact.artifactType === 'api_definition' ? 'api' : 'mcp';
    const integrationId = artifact.artifactKey;
    const exists =
      sourceKind === 'api'
        ? await apiDefinitionExists(tx, ctx.spaceId, integrationId)
        : await mcpDefinitionExists(tx, ctx.spaceId, integrationId);
    if (!exists) {
      artifacts.push({
        artifactType: artifact.artifactType,
        artifactKey: integrationId,
        action: 'missing',
      });
      continue;
    }
    const dependentSkills = dependentSkillNamesFor(integrationId);
    const dependentRepoCount =
      sourceKind === 'api' ? await countActiveRepoDependents(tx, ctx.spaceId, integrationId) : 0;
    const deletable = dependentSkills.length === 0 && dependentRepoCount === 0;
    const teardown: PlannedIntegrationTeardown = {
      sourceKind,
      integrationId,
      deletable,
      bindingIds: [],
    };
    integrations.push(teardown);
    integrationByKey.set(`${sourceKind}:${integrationId}`, teardown);
    artifacts.push({
      artifactType: artifact.artifactType,
      artifactKey: integrationId,
      action: deletable ? 'delete' : 'disable',
      ...(dependentSkills.length > 0 ? { dependentSkills } : {}),
      ...(dependentRepoCount > 0 ? { dependentRepoCount } : {}),
    });
  }

  for (const artifact of inventory) {
    if (artifact.artifactType !== 'api_binding' && artifact.artifactType !== 'mcp_binding') {
      continue;
    }
    const sourceKind = artifact.artifactType === 'api_binding' ? 'api' : 'mcp';
    const bindingId = artifact.artifactKey;
    const integrationId =
      sourceKind === 'api'
        ? await readApiBindingIntegration(tx, ctx.spaceId, bindingId)
        : await readMcpBindingIntegration(tx, ctx.spaceId, bindingId);
    if (integrationId === null) {
      artifacts.push({
        artifactType: artifact.artifactType,
        artifactKey: bindingId,
        action: 'missing',
      });
      continue;
    }
    const teardown = integrationByKey.get(`${sourceKind}:${integrationId}`);
    if (teardown) {
      teardown.bindingIds.push(bindingId);
      artifacts.push({
        artifactType: artifact.artifactType,
        artifactKey: bindingId,
        action: teardown.deletable ? 'delete' : 'disable',
      });
    } else {
      standaloneBindingDisables.push({ sourceKind, integrationId, bindingId });
      artifacts.push({
        artifactType: artifact.artifactType,
        artifactKey: bindingId,
        action: 'disable',
      });
    }
  }

  for (const artifact of inventory) {
    if (artifact.artifactType !== 'memory_doc' && artifact.artifactType !== 'ui_artifact') {
      continue;
    }
    const key = artifact.artifactKey;
    const kept = opts.keepUserData === null || opts.keepUserData.has(key);
    if (artifact.artifactType === 'memory_doc') {
      const doc = await readMemoryDoc(tx, ctx.spaceId, key);
      if (!doc) {
        artifacts.push({ artifactType: 'memory_doc', artifactKey: key, action: 'missing' });
        continue;
      }
      const pristine =
        doc.inlineContent !== null &&
        jsonContentHash(doc.inlineContent) === artifact.installedContentHash;
      const remove = !kept && pristine;
      if (remove) memoryDocsToDelete.push({ docId: doc.id, path: key });
      artifacts.push({
        artifactType: 'memory_doc',
        artifactKey: key,
        action: remove ? 'delete' : 'keep',
        userDataRemovable: pristine,
      });
    } else if (artifact.preservation === 'replace_on_update') {
      // An applet listing's own artifact: definitional, always removed with
      // the listing — archive-first over its live instances, never kept as
      // user data.
      const head = await readAppletArtifactHead(tx, ctx.spaceId, key);
      if (!head) {
        artifacts.push({ artifactType: 'ui_artifact', artifactKey: key, action: 'missing' });
        continue;
      }
      const activeInstanceCount = await countActiveAppletInstancesForArtifact(
        tx,
        head.artifactRowId,
      );
      appletArtifactsToRemove.push({
        artifactRowId: head.artifactRowId,
        bindingId: artifact.artifactId,
        artifactKey: key,
      });
      artifacts.push({
        artifactType: 'ui_artifact',
        artifactKey: key,
        action: 'delete',
        ...(activeInstanceCount > 0 ? { activeInstanceCount } : {}),
      });
    } else {
      const head = await readUiArtifactHead(tx, ctx.spaceId, key);
      if (!head) {
        artifacts.push({ artifactType: 'ui_artifact', artifactKey: key, action: 'missing' });
        continue;
      }
      const pristine = head.contentHash === artifact.installedContentHash;
      const remove = !kept && pristine;
      if (remove) {
        uiArtifactsToDelete.push({ artifactRowId: head.id, bindingId: artifact.artifactId });
      }
      artifacts.push({
        artifactType: 'ui_artifact',
        artifactKey: key,
        action: remove ? 'delete' : 'keep',
        userDataRemovable: pristine,
      });
    }
  }

  return {
    install,
    response: {
      catalogId,
      kind: install.kind,
      installedVersion: install.installedVersion,
      action,
      remainingClaims,
      members,
      artifacts,
    },
    removedEntries,
    releasedMemberClaims,
    skillsToArchive,
    integrations,
    standaloneBindingDisables,
    memoryDocsToDelete,
    uiArtifactsToDelete,
    appletArtifactsToRemove,
  };
}
