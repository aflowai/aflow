import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { MemoryDocRepository } from '@aflow/database';
import {
  CODE_REPO_CAPABILITY_ID,
  SPACE_POLICY_OPERATION_PREFIXES,
  getPlatformOperationPrefixes,
  laneProvidersForToken,
} from '@aflow/schemas';
import type { CredentialSlot, McpAuthType, PostInstallTask, SkillBundle } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import { deriveRequiredCapabilities } from './skillComposeApply.js';
import { foldMissingCapabilitiesForAbsentCodeLane } from '@aflow/schemas';
import { loadAvailableCapabilities } from '../skillProjectionReconciler.js';

// ============================================================================
// Public generator
// ============================================================================

/**
 * Build the `postInstallManifest[]` from current DB state.
 *
 * Invoked INSIDE the install transaction (`skillBundleInstall.ts`), AFTER
 * the bundle's writes (skills, bindings, seeds) have landed in the tx —
 * so the credential/MCP/capability reads intentionally observe the
 * just-written state. Manifest entries reflect what's still outstanding
 * after this install, not what it attempted to fix; an idempotent re-call
 * (the UI's Re-check) regenerates against current state.
 */
export async function generatePostInstallManifest(opts: {
  bundle: SkillBundle;
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
  // Kept on the signature so callers can pass a repo handle without coupling
  // call sites to the current set of generators. Unused today.
  repo: MemoryDocRepository;
}): Promise<PostInstallTask[]> {
  const api = await generateFillCredentialsEntries(opts);
  const mcp = await generateMcpEntries(opts);
  const capability = await generateUnmetCapabilityEntries(opts);
  return [...api, ...mcp, ...capability];
}

// ============================================================================
// fill_credentials
// ============================================================================

async function generateFillCredentialsEntries(opts: {
  bundle: SkillBundle;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<PostInstallTask[]> {
  const { bundle, spaceId, tx } = opts;
  // Defensive `?? []` — schema defaults only fire on parse; test fixtures
  // and other direct-literal callers may leave these undefined.
  const apiBindingTemplates = bundle.apiBindingTemplates ?? [];
  if (apiBindingTemplates.length === 0) return [];

  // One indexed lookup pulls every binding the bundle declared.
  const bindingIds = apiBindingTemplates.map((t) => t.bindingId);
  const bindingRows = await tx.execute<{ binding_id: string; auth_json: Record<string, unknown> }>(
    sql`
      SELECT binding_id, auth_json FROM api_bindings
      WHERE space_id = ${spaceId}::uuid
        AND binding_id IN ${sql.raw(`(${bindingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`)}
    `,
  );
  const bindingByBindingId = new Map(bindingRows.map((r) => [r.binding_id, r.auth_json]));

  // Collect every credentialKey across all bundle templates in one pass
  // so we can resolve all api_credentials existence with a single query.
  const allCredentialKeys = new Set<string>();
  for (const tpl of apiBindingTemplates) {
    for (const slot of tpl.credentialSlots) {
      allCredentialKeys.add(slot.credentialKey);
    }
  }
  const presentCredentialKeys = await fetchPresentCredentialKeys(tx, spaceId, allCredentialKeys);

  const entries: PostInstallTask[] = [];
  for (const tpl of apiBindingTemplates) {
    const authJson = bindingByBindingId.get(tpl.bindingId);
    // If the binding wasn't installed (cross-space mismatch, manual delete),
    // skip — generating fill_credentials for a non-existent binding would
    // dead-link the UI. The validator catches this at install time.
    if (authJson === undefined) continue;

    const unfilled = tpl.credentialSlots.filter((slot) => {
      // The binding row's auth_json should carry this slot's credentialKey
      // at slot.authField. If the operator manually rewrote auth_json to a
      // different shape, fall back to the bundle's declared credentialKey —
      // that's the key the bundle author expected.
      const installedKey = authJson[slot.authField] as string | undefined;
      const credentialKey = installedKey ?? slot.credentialKey;
      return !presentCredentialKeys.has(credentialKey);
    });
    if (unfilled.length === 0) continue;

    entries.push({
      kind: 'fill_credentials',
      bindingId: tpl.bindingId,
      slots: unfilled,
      description: tpl.description ?? `Add credentials for the ${tpl.name} integration.`,
      required: true,
    });
  }
  return entries;
}

export async function fetchPresentCredentialKeys(
  tx: PostgresJsDatabase,
  spaceId: string,
  needed: Set<string>,
): Promise<Set<string>> {
  if (needed.size === 0) return new Set();
  const keys = [...needed];
  const rows = await tx.execute<{ credential_key: string }>(sql`
    SELECT credential_key FROM api_credentials
    WHERE space_id = ${spaceId}::uuid
      AND credential_key IN ${sql.raw(`(${keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ')})`)}
  `);
  return new Set(rows.map((r) => r.credential_key));
}

// ============================================================================

/**
 * Per MCP binding template, emit:
 *  - `fill_mcp_credentials` if at least one credential slot lacks a value,
 *  - else `run_mcp_binding_test` if the binding is still disabled:
 *      - public (`auth.type: 'none'`) — bundle install leaves these disabled;
 *        the operator must Save & connect to enable (origin pins on first use
 *        or via test),
 *      - credentialed — credentials are filled but `pinned_origin` is still
 *        null (handshake not verified yet).
 *  - else nothing — the connection is ready.
 *
 * Same derived-from-state semantics as the API variant: regenerate on
 * every install (and idempotent reinstall) so the operator sees the
 * checklist shrink as they complete each step.
 */
async function generateMcpEntries(opts: {
  bundle: SkillBundle;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<PostInstallTask[]> {
  const { bundle, spaceId, tx } = opts;
  const mcpBindingTemplates = bundle.mcpBindingTemplates ?? [];
  if (mcpBindingTemplates.length === 0) return [];

  const bindingIds = mcpBindingTemplates.map((t) => t.bindingId);
  const bindingRows = await tx.execute<{
    binding_id: string;
    auth_json: Record<string, unknown>;
    pinned_origin: string | null;
    enabled: number | boolean;
  }>(sql`
    SELECT binding_id, auth_json, pinned_origin, enabled FROM mcp_server_bindings
    WHERE space_id = ${spaceId}::uuid
      AND binding_id IN ${sql.raw(`(${bindingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`)}
  `);
  const rowByBindingId = new Map(
    bindingRows.map((r) => [
      r.binding_id,
      {
        authJson: r.auth_json,
        pinnedOrigin: r.pinned_origin,
        enabled: Boolean(r.enabled),
      },
    ]),
  );

  const allCredentialKeys = new Set<string>();
  for (const tpl of mcpBindingTemplates) {
    for (const slot of tpl.credentialSlots) {
      allCredentialKeys.add(slot.credentialKey);
    }
  }
  const presentCredentialKeys = await fetchPresentCredentialKeys(tx, spaceId, allCredentialKeys);

  const entries: PostInstallTask[] = [];
  for (const tpl of mcpBindingTemplates) {
    const row = rowByBindingId.get(tpl.bindingId);
    if (row === undefined) continue;

    const task = deriveMcpBindingSetupTask({
      bindingId: tpl.bindingId,
      serverId: tpl.serverId,
      name: tpl.name,
      ...(tpl.description !== undefined ? { description: tpl.description } : {}),
      authType: tpl.authShape.type,
      credentialSlots: tpl.credentialSlots,
      authJson: row.authJson,
      pinnedOrigin: row.pinnedOrigin,
      enabled: row.enabled,
      presentCredentialKeys,
    });
    if (task !== null) entries.push(task);
  }
  return entries;
}

/**
 * The per-binding `fill_mcp_credentials` / `run_mcp_binding_test` decision,
 * shared by the bundle manifest generator and the connector-catalog install.
 * Reads current state, not intent: an unfilled slot wins, then a disabled
 * public server or an unpinned credentialed one still needs Save & connect.
 */
export function deriveMcpBindingSetupTask(input: {
  bindingId: string;
  serverId: string;
  name: string;
  description?: string;
  authType: McpAuthType;
  credentialSlots: readonly CredentialSlot[];
  authJson: Record<string, unknown>;
  pinnedOrigin: string | null;
  enabled: boolean;
  presentCredentialKeys: ReadonlySet<string>;
}): PostInstallTask | null {
  const unfilled = input.credentialSlots.filter((slot) => {
    const installedKey = input.authJson[slot.authField] as string | undefined;
    const credentialKey = installedKey ?? slot.credentialKey;
    return !input.presentCredentialKeys.has(credentialKey);
  });

  if (unfilled.length > 0) {
    return {
      kind: 'fill_mcp_credentials',
      bindingId: input.bindingId,
      serverId: input.serverId,
      slots: unfilled,
      description: input.description ?? `Add credentials for the ${input.name} integration.`,
      required: true,
    };
  }

  // Install lands every binding disabled. Public (`auth.type: 'none'`)
  // servers can enable without a prior pin, but still need the operator to
  // open Save & connect so the UI runs test (optional) and flips enabled.
  if (input.authType === 'none') {
    if (!input.enabled) {
      return {
        kind: 'run_mcp_binding_test',
        bindingId: input.bindingId,
        serverId: input.serverId,
        description: `Open the ${input.name} integration and save to connect and enable.`,
        required: true,
      };
    }
    return null;
  }

  // Credentialed: credentials filled but no successful handshake yet →
  // operator must Save & connect to pin origin before enable.
  if (input.pinnedOrigin === null) {
    return {
      kind: 'run_mcp_binding_test',
      bindingId: input.bindingId,
      serverId: input.serverId,
      description: `Open the ${input.name} integration and save to verify the connection.`,
      required: true,
    };
  }
  return null;
}

// ============================================================================
// designate_repo
// ============================================================================

/**
 * Unlike the credential generators (keyed off the bundle's binding
 * templates), this one is keyed off the installed skills' REAL capability
 * state: union `deriveRequiredCapabilities` over every catalog skill the
 * bundle installs, then ask `loadAvailableCapabilities` which are unmet in
 * this space. The coding bundle ships zero binding templates, so its repo
 * requirement only surfaces here.
 *
 * A `code_repo` miss emits a single `designate_repo` row. `github` is
 * intentionally NOT emitted: a `ready` repo's connection is an enabled
 * github binding, so designating the repo subsumes it; template-backed
 * creds are already handled by the credential generators.
 *
 * A policy-gated prefix leads, because no repo or credential the operator
 * wires up can run the skill while its lane is switched off.
 */
async function generateUnmetCapabilityEntries(opts: {
  bundle: SkillBundle;
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<PostInstallTask[]> {
  const { bundle, tenantId, spaceId, tx } = opts;

  const requiredAcrossBundle = new Set<string>();
  for (const id of bundle.skillCatalogIds) {
    const entry = getSkillCatalogEntry(id);
    if (!entry) continue;
    for (const cap of deriveRequiredCapabilities(entry.bundle)) {
      requiredAcrossBundle.add(cap);
    }
  }
  if (requiredAcrossBundle.size === 0) return [];

  const platformPrefixes = getPlatformOperationPrefixes();
  const external = [...requiredAcrossBundle].filter((p) => !platformPrefixes.has(p));
  if (external.length === 0) return [];

  const { available, codeLane, withheldByProfile, withheldByCeiling, withheldByProfileAlone } =
    await loadAvailableCapabilities({
      db: tx,
      tenantId,
      spaceId,
    });
  // Where no coding lane is composed, no entry below can help: the lane token
  // folds and none of the code branches match it.
  const unmet = new Set(
    foldMissingCapabilitiesForAbsentCodeLane(
      external.filter((p) => !available.has(p)),
      codeLane,
    ),
  );
  const entries: PostInstallTask[] = [];
  for (const token of unmet) {
    if (!SPACE_POLICY_OPERATION_PREFIXES.has(token)) continue;
    const missingGroups = withheldByProfile.get(token);
    if (missingGroups && missingGroups.length > 0) {
      // A ceiling gap and a profile gap need different remedies, and naming the
      // wrong one sends the operator to a setting that cannot move: the ceiling
      // ANDs over every profile, so reassigning one changes nothing. They can
      // also hold at once over DIFFERENT groups, and then only doing both
      // unblocks the lane — reporting either alone reads as sufficient.
      // The two gates are read independently rather than by subtracting one
      // from the other: they can deny the SAME group, and a set difference
      // would then report an empty profile gap and name only the ceiling —
      // after which lifting the ceiling leaves the profile still blocking.
      const ceilingGroups = withheldByCeiling.get(token) ?? [];
      const profileGroups = withheldByProfileAlone.get(token) ?? [];
      const remedy =
        ceilingGroups.length > 0 && profileGroups.length > 0
          ? 'both'
          : ceilingGroups.length > 0
            ? 'ceiling'
            : 'profile';
      entries.push({
        kind: 'assign_capability_profile',
        policy: token,
        missingCapabilityGroups: missingGroups,
        remedy,
        description:
          remedy === 'both'
            ? `The ${token} lane is withheld twice over: the tenant capability ceiling excludes ` +
              `${ceilingGroups.join(', ')}, and this space's profile separately lacks ` +
              `${profileGroups.join(', ')}. BOTH have to change — a tenant admin lifts the ` +
              `ceiling (Settings → Capability Governance) AND assigns this space a profile that ` +
              `covers its side (Settings → Access Control → Space Assignments). Doing either ` +
              `alone leaves the lane blocked.`
            : remedy === 'ceiling'
              ? `The tenant capability ceiling excludes ${ceilingGroups.join(', ')}, so the ` +
                `${token} lane cannot run in any space here. A tenant admin lifts the ceiling or ` +
                `grants the capability to the user (Settings → Capability Governance); ` +
                `reassigning this space's profile cannot.`
              : `This space's capability profile withholds ${missingGroups.join(', ')}, so the ` +
                `${token} lane cannot run here. A tenant admin assigns this space a profile that ` +
                `includes it (Settings → Access Control → Space Assignments) or grants the ` +
                `capability to the user; no space setting or credential can.`,
        required: true,
      });
      continue;
    }
    // The host lane's grant is a paired machine and a connected folder, not a
    // space policy, so pointing the operator at space settings names a setting
    // that does not exist there.
    if (token === 'host') {
      entries.push({
        kind: 'pair_machine',
        description:
          'Pair this machine and connect the folder these skills work in, under This Computer.',
        required: true,
      });
      continue;
    }
    entries.push({
      kind: 'enable_space_policy',
      policy: token,
      description: `Turn on the ${token} lane for this space — a space admin enables it in space settings; no binding or credential can.`,
      required: true,
    });
  }
  if (unmet.has(CODE_REPO_CAPABILITY_ID)) {
    entries.push({
      kind: 'designate_repo',
      description:
        'Designate the repository the coding skills push to, and link its GitHub connection.',
      required: true,
    });
  }
  const seenLaneOptions = new Set<string>();
  for (const token of unmet) {
    const providers = laneProvidersForToken(token);
    if (!providers || providers.length === 0) continue;
    const optionsKey = [...providers].sort().join(',');
    if (seenLaneOptions.has(optionsKey)) continue;
    seenLaneOptions.add(optionsKey);
    entries.push({
      kind: 'connect_provider',
      providerOptions: [...providers],
      description: token.startsWith('code_model')
        ? `Connect a coding-lane key (${providers.join(' or ')}) so the coding skills can run.`
        : 'Connect a Brave Search key so search steps can run.',
      required: true,
    });
  }
  return entries;
}
