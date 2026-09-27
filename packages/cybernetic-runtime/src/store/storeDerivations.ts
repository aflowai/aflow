/**
 * Pure derivations for the unified store surface: listing requirements and
 * installed-state summaries (read side), credential-slot/checklist derivation
 * for API connectors, and the provenance write plan an install persists
 * (write side). No IO — everything derives from the catalog entry, the
 * space's provenance rows, and the same placeholder-auth builders the
 * install backends use.
 */
import { z } from 'zod';
import {
  buildBundleClaimant,
  CODE_REPO_CAPABILITY_ID,
  StoreInstallStateSchema,
  type CatalogEntry,
  type ConnectorCatalogEntry,
  type ConnectorCredentialPrompt,
  type CredentialSlot,
  type CredentialSlotRole,
  type ListingRequirements,
  type McpConnectorCatalogEntry,
  type PostInstallTask,
  type SkillBundle,
  type SkillCatalogEntry,
  type SkillComposeBundle,
  type StoreInstall,
  type StoreInstallArtifact,
  type StoreInstallClaim,
  type StoreListingInstalledState,
  type StorePlannedArtifact,
} from '@aflow/schemas';
import {
  getSkillCatalogEntry,
  catalogEntryContentHash,
  searchListings,
  type StoreSearchOptions,
} from '@aflow/platform-artifacts';
import type { TenantStoreShelfPolicy } from '@aflow/database';
import {
  buildPlaceholderAuthJson,
  pinnedCredentialKeys,
} from '../stagedChange/capabilityBindingApply.js';
import { deriveRequiredCapabilities } from '../stagedChange/skillComposeApply.js';
import {
  buildDefinitionJsonForDraft,
  extractCredentialKeys,
} from '../stagedChange/apiWriteHelpers.js';
import type { InstallSkillBundleResult } from '../stagedChange/skillBundleInstall.js';
import { renderContractContent, renderContractHash } from '../stagedChange/applyArtifactSeeds.js';
import { jsonContentHash, skillBundleContentDoc } from './artifactContent.js';
import { appletSeedForEntry } from './appletArtifact.js';
import { buildPlaceholderMcpAuth, connectorDefaultBindingId } from './connectorInstall.js';

// ============================================================================
// Installed state
// ============================================================================

export const ListingInstalledStateSchema = z.object({
  installed: z.boolean(),
  installedVersion: z.number().int().optional(),
  updateAvailable: z.boolean(),
  state: StoreInstallStateSchema.optional(),
});
export type ListingInstalledState = z.infer<typeof ListingInstalledStateSchema>;

export function deriveInstalledState(
  entry: Pick<CatalogEntry, 'version'>,
  install: StoreInstall | null,
): ListingInstalledState {
  if (!install) return { installed: false, updateAvailable: false };
  const updateAvailable =
    entry.version > install.installedVersion && install.skippedVersion !== entry.version;
  return {
    installed: true,
    installedVersion: install.installedVersion,
    updateAvailable,
    state: install.state,
  };
}

/** Collapse the read-surface object onto the agent op's three-state enum. */
export function toStoreListingInstalledState(
  state: ListingInstalledState,
): StoreListingInstalledState {
  if (!state.installed) return 'not_installed';
  return state.updateAvailable ? 'update_available' : 'installed';
}

/**
 * Tenant shelf axis, orthogonal to the listing lifecycle: a listing whose
 * effective availability (override ?? tenant default) is `hidden` does not
 * exist for the tenant — except where already installed, which keeps it
 * visible/manageable exactly like a deprecated listing (new installs only
 * are blocked).
 */
export function isListingOnTenantShelf(
  entry: Pick<CatalogEntry, 'catalogId'>,
  installedCatalogIds: ReadonlySet<string>,
  shelf: TenantStoreShelfPolicy,
): boolean {
  const availability = shelf.overrides.get(entry.catalogId) ?? shelf.defaultAvailability;
  return availability === 'available' || installedCatalogIds.has(entry.catalogId);
}

/**
 * Browse visibility: `published` always; `deprecated` only for spaces that
 * installed it (update/uninstall access, never fresh discovery); `unlisted`
 * never (direct GET by id still resolves it) — composed with the tenant
 * shelf axis.
 */
export function selectListableEntries(
  entries: readonly CatalogEntry[],
  installedCatalogIds: ReadonlySet<string>,
  shelf: TenantStoreShelfPolicy,
): CatalogEntry[] {
  return entries.filter(
    (entry) =>
      (entry.status === 'published' ||
        (entry.status === 'deprecated' && installedCatalogIds.has(entry.catalogId))) &&
      isListingOnTenantShelf(entry, installedCatalogIds, shelf),
  );
}

/**
 * Search composes over browse's visibility set, plus on-shelf `unlisted`
 * entries so an exact-catalogId query still resolves them (matching the
 * direct-GET-by-id surface).
 */
export function searchListableEntries(
  entries: readonly CatalogEntry[],
  installedCatalogIds: ReadonlySet<string>,
  shelf: TenantStoreShelfPolicy,
  query: string,
  options?: StoreSearchOptions,
): CatalogEntry[] {
  const candidates = [
    ...selectListableEntries(entries, installedCatalogIds, shelf),
    ...entries.filter(
      (entry) =>
        entry.status === 'unlisted' && isListingOnTenantShelf(entry, installedCatalogIds, shelf),
    ),
  ];
  return searchListings(candidates, query, options).map((result) => result.entry);
}

// ============================================================================
// Requirements
// ============================================================================

function skillBundleRequirements(bundle: SkillComposeBundle): ListingRequirements {
  const capabilities = deriveRequiredCapabilities(bundle);
  return {
    credentialKeys: [],
    oauthIssuers: [],
    needsRepo: capabilities.includes(CODE_REPO_CAPABILITY_ID),
    needsModelKey: bundle.workflow.tasks.some(
      (task) => task.operation?.startsWith('code.agent.') === true,
    ),
  };
}

function bundleRequirements(bundle: SkillBundle): ListingRequirements {
  const credentialKeys = new Set<string>();
  for (const template of bundle.apiBindingTemplates) {
    for (const slot of template.credentialSlots) credentialKeys.add(slot.credentialKey);
  }
  for (const template of bundle.mcpBindingTemplates) {
    for (const slot of template.credentialSlots) credentialKeys.add(slot.credentialKey);
  }
  let needsRepo = false;
  let needsModelKey = false;
  for (const memberId of bundle.skillCatalogIds) {
    const member = getSkillCatalogEntry(memberId);
    if (!member) continue;
    const memberRequirements = skillBundleRequirements(member.bundle);
    needsRepo = needsRepo || memberRequirements.needsRepo;
    needsModelKey = needsModelKey || memberRequirements.needsModelKey;
  }
  return { credentialKeys: [...credentialKeys].sort(), oauthIssuers: [], needsRepo, needsModelKey };
}

function apiConnectorRequirements(payload: ConnectorCatalogEntry): ListingRequirements {
  if (payload.authKind === 'oauth2_authorization_code') {
    return {
      credentialKeys: [],
      oauthIssuers: payload.oauthIssuerKey ? [payload.oauthIssuerKey] : [],
      needsRepo: false,
      needsModelKey: false,
    };
  }
  const slots = deriveApiConnectorCredentialSlots(payload);
  return {
    credentialKeys: slots.map((slot) => slot.credentialKey),
    oauthIssuers: [],
    needsRepo: false,
    needsModelKey: false,
  };
}

function mcpConnectorRequirements(payload: McpConnectorCatalogEntry): ListingRequirements {
  const bindingId = connectorDefaultBindingId(payload.definition.serverId);
  const credentialKeys = buildPlaceholderMcpAuth(
    payload.authKind,
    bindingId,
    payload.credentialPrompts,
  ).slots.map((slot) => slot.credentialKey);
  return { credentialKeys, oauthIssuers: [], needsRepo: false, needsModelKey: false };
}

export function deriveListingRequirements(entry: CatalogEntry): ListingRequirements {
  switch (entry.kind) {
    case 'bundle':
      return bundleRequirements(entry.payload);
    case 'connector':
      return entry.sourceKind === 'api'
        ? apiConnectorRequirements(entry.payload)
        : mcpConnectorRequirements(entry.payload);
    // Applet actions flow through the platform gateway — no credentials,
    // no OAuth, no repo, no model key.
    case 'applet':
      return { credentialKeys: [], oauthIssuers: [], needsRepo: false, needsModelKey: false };
  }
}

// ============================================================================
// API connector credential slots + checklist
// ============================================================================

const AUTH_FIELD_ROLES: Record<string, CredentialSlotRole> = {
  secondaryCredentialKey: 'api_key_secondary',
  usernameCredentialKey: 'username',
  passwordCredentialKey: 'password',
  clientIdCredentialKey: 'client_id',
  clientSecretCredentialKey: 'client_secret',
};

function roleForAuthField(
  authField: string,
  authKind: ConnectorCatalogEntry['authKind'],
): CredentialSlotRole {
  if (authField === 'credentialKey') return authKind === 'bearer' ? 'token' : 'api_key';
  return AUTH_FIELD_ROLES[authField] ?? 'other';
}

function promptLabel(
  prompts: readonly ConnectorCredentialPrompt[] | undefined,
  authField: string,
  fallback: string,
): string {
  return prompts?.find((prompt) => prompt.authField === authField)?.label ?? fallback;
}

/**
 * The credential slots the connector's placeholder binding will need filled —
 * enumerated from the same placeholder auth JSON the install writes, so the
 * listing's requirements and the post-install checklist can never disagree
 * with the installed binding shape.
 */
export function deriveApiConnectorCredentialSlots(
  payload: ConnectorCatalogEntry,
): CredentialSlot[] {
  if (payload.authKind === 'oauth2_authorization_code' || payload.authKind === 'none') return [];
  const bindingId = connectorDefaultBindingId(payload.definition.apiId);
  const authJson = buildPlaceholderAuthJson(payload.authKind, bindingId, {
    apiKeyHeaderName: payload.apiKeyHeaderName,
    apiKeyQueryParamName: payload.apiKeyQueryParamName,
    apiKeyPairHeaderNames: payload.apiKeyPairHeaderNames,
    credentialKeys: pinnedCredentialKeys(payload.credentialPrompts),
  });
  const slots: CredentialSlot[] = [];
  for (const credentialKey of extractCredentialKeys(authJson)) {
    const authField = Object.entries(authJson).find(([, value]) => value === credentialKey)?.[0];
    if (!authField) continue;
    slots.push({
      authField,
      credentialKey,
      role: roleForAuthField(authField, payload.authKind),
      label: promptLabel(payload.credentialPrompts, authField, credentialKey),
    });
  }
  return slots;
}

export function deriveApiConnectorSetupChecklist(
  payload: ConnectorCatalogEntry,
  missingCredentialKeys: readonly string[],
): PostInstallTask[] {
  if (missingCredentialKeys.length === 0) return [];
  const missing = new Set(missingCredentialKeys);
  const slots = deriveApiConnectorCredentialSlots(payload).filter((slot) =>
    missing.has(slot.credentialKey),
  );
  if (slots.length === 0) return [];
  return [
    {
      kind: 'fill_credentials',
      bindingId: connectorDefaultBindingId(payload.definition.apiId),
      slots,
      description: `Add credentials for the ${payload.name} integration.`,
      required: true,
    },
  ];
}

// ============================================================================
// Provenance write plan
// ============================================================================

export interface StoreProvenancePlan {
  install: StoreInstall;
  /** Bundle members' own install rows — written insert-if-absent. */
  memberInstalls: StoreInstall[];
  artifacts: StoreInstallArtifact[];
  claims: StoreInstallClaim[];
}

interface ProvenanceActor {
  spaceId: string;
  actorUserId: string;
  now: string;
}

function baseInstall(
  entry: CatalogEntry,
  { spaceId, actorUserId, now }: ProvenanceActor,
): StoreInstall {
  return {
    spaceId,
    catalogId: entry.catalogId,
    kind: entry.kind,
    installedVersion: entry.version,
    installedContentHash: catalogEntryContentHash(entry),
    state: 'installed',
    hostManifest: entry.hostManifest,
    installedAt: now,
    installedBy: actorUserId,
    updatedAt: now,
    updatedBy: actorUserId,
  };
}

function memberInstall(
  member: SkillCatalogEntry,
  { spaceId, actorUserId, now }: ProvenanceActor,
): StoreInstall {
  return {
    spaceId,
    catalogId: member.catalogId,
    kind: 'skill',
    installedVersion: member.version,
    installedContentHash: jsonContentHash(member),
    state: 'installed',
    installedAt: now,
    installedBy: actorUserId,
    updatedAt: now,
    updatedBy: actorUserId,
  };
}

/**
 * The exact content each replace_on_update artifact's provenance hash covers,
 * keyed by {@link provenanceArtifactKey} — the shared source for the stamps
 * (hash of these values) and the Mine-vs-Store diff payloads, so the two can
 * never disagree about what "the store version" is.
 */
export function deriveRegistryArtifactContents(entry: CatalogEntry): Map<string, unknown> {
  const contents = new Map<string, unknown>();
  const put = (
    artifactType: StoreInstallArtifact['artifactType'],
    artifactKey: string,
    content: unknown,
  ): void => {
    contents.set(provenanceArtifactKey({ artifactType, artifactKey }), content);
  };
  switch (entry.kind) {
    case 'bundle': {
      for (const memberId of entry.payload.skillCatalogIds) {
        const member = getSkillCatalogEntry(memberId);
        if (!member) continue;
        put('skill', member.bundle.workflow.slug, skillBundleContentDoc(member.bundle));
      }
      for (const definition of entry.payload.apiDefinitions) {
        // The synthesized definition_json the draft write persists, so
        // divergence can compare it against the stored row directly.
        put(
          'api_definition',
          definition.apiId,
          buildDefinitionJsonForDraft(definition.apiId, definition.definition),
        );
      }
      for (const definition of entry.payload.mcpDefinitions) {
        put('mcp_definition', definition.serverId, {
          serverId: definition.serverId,
          ...definition.definition,
        });
      }
      break;
    }
    case 'connector':
      if (entry.sourceKind === 'api') {
        put('api_definition', entry.payload.definition.apiId, entry.payload.definition);
      } else {
        put('mcp_definition', entry.payload.definition.serverId, entry.payload.definition);
      }
      break;
    case 'applet': {
      const seed = appletSeedForEntry(entry);
      put('ui_artifact', seed.bundleArtifactKey, renderContractContent(seed));
      break;
    }
  }
  return contents;
}

function registryContentHash(contents: ReadonlyMap<string, unknown>, key: string): string {
  return jsonContentHash(contents.get(key));
}

function skillArtifact(
  entry: SkillCatalogEntry,
  spaceId: string,
  ownerCatalogId: string,
  contents: ReadonlyMap<string, unknown>,
): StoreInstallArtifact {
  const artifactKey = entry.bundle.workflow.slug;
  return {
    spaceId,
    catalogId: ownerCatalogId,
    artifactType: 'skill',
    artifactKey,
    artifactId: entry.bundle.manifest.skillId,
    installedContentHash: registryContentHash(
      contents,
      provenanceArtifactKey({ artifactType: 'skill', artifactKey }),
    ),
    preservation: 'replace_on_update',
  };
}

function bundleFragmentArtifacts(
  bundle: SkillBundle,
  spaceId: string,
  catalogId: string,
  contents: ReadonlyMap<string, unknown>,
): StoreInstallArtifact[] {
  const artifacts: StoreInstallArtifact[] = [];
  for (const definition of bundle.apiDefinitions) {
    artifacts.push({
      spaceId,
      catalogId,
      artifactType: 'api_definition',
      artifactKey: definition.apiId,
      artifactId: definition.apiId,
      installedContentHash: registryContentHash(
        contents,
        provenanceArtifactKey({ artifactType: 'api_definition', artifactKey: definition.apiId }),
      ),
      preservation: 'replace_on_update',
    });
  }
  for (const template of bundle.apiBindingTemplates) {
    artifacts.push({
      spaceId,
      catalogId,
      artifactType: 'api_binding',
      artifactKey: template.bindingId,
      artifactId: template.bindingId,
      installedContentHash: jsonContentHash(template),
      preservation: 'user_data_keep',
    });
  }
  for (const definition of bundle.mcpDefinitions) {
    artifacts.push({
      spaceId,
      catalogId,
      artifactType: 'mcp_definition',
      artifactKey: definition.serverId,
      artifactId: definition.serverId,
      installedContentHash: registryContentHash(
        contents,
        provenanceArtifactKey({ artifactType: 'mcp_definition', artifactKey: definition.serverId }),
      ),
      preservation: 'replace_on_update',
    });
  }
  for (const template of bundle.mcpBindingTemplates) {
    artifacts.push({
      spaceId,
      catalogId,
      artifactType: 'mcp_binding',
      artifactKey: template.bindingId,
      artifactId: template.bindingId,
      installedContentHash: jsonContentHash(template),
      preservation: 'user_data_keep',
    });
  }
  // User-data stamps must be recomputable from space state so uninstall can
  // tell pristine from modified: the doc's stored content string, and the same
  // render-contract hash the seed apply writes to ui_artifact_versions.
  for (const seed of bundle.memorySeed) {
    artifacts.push({
      spaceId,
      catalogId,
      artifactType: 'memory_doc',
      artifactKey: seed.path,
      artifactId: seed.path,
      installedContentHash: jsonContentHash(seed.content),
      preservation: 'user_data_keep',
    });
  }
  for (const seed of bundle.artifactSeed) {
    artifacts.push({
      spaceId,
      catalogId,
      artifactType: 'ui_artifact',
      artifactKey: seed.bundleArtifactKey,
      artifactId: seed.bindingId,
      installedContentHash: renderContractHash(seed),
      preservation: 'user_data_keep',
    });
  }
  return artifacts;
}

function entryArtifacts(entry: CatalogEntry, spaceId: string): StoreInstallArtifact[] {
  const contents = deriveRegistryArtifactContents(entry);
  const artifacts: StoreInstallArtifact[] = [];
  switch (entry.kind) {
    case 'bundle': {
      for (const memberId of entry.payload.skillCatalogIds) {
        const member = getSkillCatalogEntry(memberId);
        if (!member) continue;
        artifacts.push(skillArtifact(member, spaceId, entry.catalogId, contents));
        artifacts.push(skillArtifact(member, spaceId, memberId, contents));
      }
      artifacts.push(...bundleFragmentArtifacts(entry.payload, spaceId, entry.catalogId, contents));
      break;
    }
    case 'connector': {
      const entryHash = catalogEntryContentHash(entry);
      if (entry.sourceKind === 'api') {
        const apiId = entry.payload.definition.apiId;
        artifacts.push({
          spaceId,
          catalogId: entry.catalogId,
          artifactType: 'api_definition',
          artifactKey: apiId,
          artifactId: apiId,
          installedContentHash: registryContentHash(
            contents,
            provenanceArtifactKey({ artifactType: 'api_definition', artifactKey: apiId }),
          ),
          preservation: 'replace_on_update',
        });
        artifacts.push({
          spaceId,
          catalogId: entry.catalogId,
          artifactType: 'api_binding',
          artifactKey: connectorDefaultBindingId(apiId),
          artifactId: connectorDefaultBindingId(apiId),
          installedContentHash: entryHash,
          preservation: 'user_data_keep',
        });
      } else {
        const serverId = entry.payload.definition.serverId;
        artifacts.push({
          spaceId,
          catalogId: entry.catalogId,
          artifactType: 'mcp_definition',
          artifactKey: serverId,
          artifactId: serverId,
          installedContentHash: registryContentHash(
            contents,
            provenanceArtifactKey({ artifactType: 'mcp_definition', artifactKey: serverId }),
          ),
          preservation: 'replace_on_update',
        });
        artifacts.push({
          spaceId,
          catalogId: entry.catalogId,
          artifactType: 'mcp_binding',
          artifactKey: connectorDefaultBindingId(serverId),
          artifactId: connectorDefaultBindingId(serverId),
          installedContentHash: entryHash,
          preservation: 'user_data_keep',
        });
      }
      break;
    }
    case 'applet': {
      // Definitional content, unlike bundle-seeded ui_artifacts: the artifact
      // IS the listing, so update replaces it (a new head version — pinned
      // instances are untouched) and divergence watches it.
      const seed = appletSeedForEntry(entry);
      artifacts.push({
        spaceId,
        catalogId: entry.catalogId,
        artifactType: 'ui_artifact',
        artifactKey: seed.bundleArtifactKey,
        artifactId: seed.bindingId,
        installedContentHash: renderContractHash(seed),
        preservation: 'replace_on_update',
      });
      break;
    }
  }
  return artifacts;
}

/**
 * The artifacts an install of `entry` will create, as the preview surface
 * reports them — derived from the same builder the provenance write plan
 * uses, so preview and install can never disagree.
 */
export function derivePlannedArtifacts(entry: CatalogEntry): StorePlannedArtifact[] {
  const spaceIndependent = '';
  return entryArtifacts(entry, spaceIndependent)
    .filter((artifact) => artifact.catalogId === entry.catalogId)
    .map((artifact) => ({
      artifactType: artifact.artifactType,
      artifactKey: artifact.artifactKey,
    }));
}

/**
 * Everything an install of `entry` must persist as provenance: the entry's
 * own install row + 'direct' claim, its artifact inventory, and — for
 * bundles — each member skill's own install row plus a `bundle:<id>` claim,
 * so bundle uninstall can tell what it owns from what it merely shares.
 */
export function deriveInstallProvenance(
  entry: CatalogEntry,
  actor: ProvenanceActor,
): StoreProvenancePlan {
  const { spaceId } = actor;
  const install = baseInstall(entry, actor);
  const claims: StoreInstallClaim[] = [
    { spaceId, catalogId: entry.catalogId, claimedBy: 'direct' },
  ];
  const memberInstalls: StoreInstall[] = [];

  if (entry.kind === 'bundle') {
    for (const memberId of entry.payload.skillCatalogIds) {
      const member = getSkillCatalogEntry(memberId);
      if (!member) continue;
      memberInstalls.push(memberInstall(member, actor));
      claims.push({
        spaceId,
        catalogId: memberId,
        claimedBy: buildBundleClaimant(entry.catalogId),
      });
    }
  }

  return { install, memberInstalls, artifacts: entryArtifacts(entry, spaceId), claims };
}

/**
 * Keep-set from a bundle install's actual outcome: members and artifacts the
 * backend skipped (already present) must not be re-stamped with registry
 * content — their provenance rows keep whatever an earlier install recorded.
 * Installed and projection-repaired members were written at registry content,
 * so they take the replace stamp.
 */
export interface StoreProvenanceSkips {
  memberCatalogIds: ReadonlySet<string>;
  artifactKeys: ReadonlySet<string>;
}

export function provenanceArtifactKey(
  artifact: Pick<StoreInstallArtifact, 'artifactType' | 'artifactKey'>,
): string {
  return `${artifact.artifactType}:${artifact.artifactKey}`;
}

export function deriveBundleProvenanceSkips(
  bundle: SkillBundle,
  result: InstallSkillBundleResult,
): StoreProvenanceSkips {
  const artifactKeys = new Set<string>();
  const add = (artifactType: StoreInstallArtifact['artifactType'], artifactKey: string): void => {
    artifactKeys.add(provenanceArtifactKey({ artifactType, artifactKey }));
  };
  for (const memberId of result.skippedSkillCatalogIds) {
    const member = getSkillCatalogEntry(memberId);
    if (!member) continue;
    add('skill', member.bundle.workflow.slug);
  }
  for (const apiId of result.skippedApiDefinitionIds) add('api_definition', apiId);
  for (const bindingId of result.skippedBindingIds) add('api_binding', bindingId);
  for (const serverId of result.skippedMcpDefinitionIds) add('mcp_definition', serverId);
  for (const bindingId of result.skippedMcpBindingIds) add('mcp_binding', bindingId);
  for (const path of result.skippedMemoryDocPaths) add('memory_doc', path);
  const skippedSeedBindingIds = new Set(result.skippedArtifactBindings);
  for (const seed of bundle.artifactSeed) {
    if (skippedSeedBindingIds.has(seed.bindingId)) add('ui_artifact', seed.bundleArtifactKey);
  }
  return { memberCatalogIds: new Set(result.skippedSkillCatalogIds), artifactKeys };
}
