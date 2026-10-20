import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, sql, and, isNull, inArray } from 'drizzle-orm';
import type { TenantId, SpaceContextIndexNote } from '@aflow/schemas';
import {
  SPACE_CONTEXT_LIMITS,
  SpaceContextSchema,
  INSTALLED_SKILLS_GUIDANCE,
  SPACE_CONTEXT_TTL_MS,
  SpaceComputePolicySchema,
  buildSpaceContextNavigation,
  idleMergePostureReason,
  type SpaceContext,
} from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  memoryDirs,
  memoryDocs,
  repoBindings,
  hostBindings,
  agentSchedules,
  webhookEndpoints,
  type MemoryDerivation,
} from '@aflow/database';
import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import {
  readSpaceContextGen,
  bumpSpaceContextGen,
  readLiveHostInventories,
  publishingFoldersForSpace,
  type HostInventory,
  type PublishingFolder,
  getRedisConnection,
} from '@aflow/redis';
import { buildInstalledSkillAwareness } from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { readIntegrations } from './integrationReader.js';
import { buildSpaceContextAppletsSection } from './spaceContextApplets.js';
import { resolveWebBaseUrlOrNull } from '@aflow/lib';
import { readPreferredHarness } from '../../hostHarnessPreference.js';

/** Canonical path of a space's memory-map note. */
const INDEX_NOTE_PATH = '/index.md';

// ============================================================================
// Guidance strings — kept as constants for simplicity and stability
// ============================================================================

export const MEMORY_GUIDANCE =
  'To manage memories use memory.store.* operations (query, get, put, patch, delete, mkdir). ' +
  'Documents reference each other with wikilinks ([[/path/doc.md]]) — links are indexed: reads ' +
  'show backlinks, and query mode="links" with unresolvedOnly lists referenced-but-unwritten ' +
  "notes. /index.md is this space's memory map: a SHORT curated list of the most important " +
  'documents and child maps ("- [[/path]] — what it holds"), not a full listing. Add a line when ' +
  'a durable document is worth finding again; keep entries to one line; updating it requires ' +
  'expectedHash (read it first).';

/**
 * What the inventory below means, and the two paths that are NOT the ordinary
 * discover → promote → call flow.
 *
 * That flow is deliberately absent: the Helmsman prompt teaches it in full
 * ("Using bound APIs and MCP servers ad-hoc"), and stating it again beside the
 * data made it the third carrier of the same three sentences. What stays is what
 * only makes sense next to these items — which statuses are callable — plus the
 * two departures a reader cannot infer from the flow itself.
 */
export const INTEGRATIONS_GUIDANCE =
  'These external services (APIs + MCP servers) are configured in this space. ' +
  'Only items with status="bound" are callable today — items with status="needs_credentials" ' +
  'or "disabled" require operator action first. ' +
  'To inspect or edit an integration ITSELF (its definition, bindings, or webhooks — e.g. ' +
  'api.definition.patch, api.binding.upsert, mcp.server.upsert), promote the api.* / mcp.* ' +
  'management op via catalog.tool.promote if it is not already in your toolbox. ' +
  'To acquire a service this space lacks, check the store first (promote store.listing.search; ' +
  'store.listing.install stages an operator-ratified proposal) — prefer installing a curated ' +
  'listing over authoring a definition from scratch.';

export const REPOSITORIES_GUIDANCE =
  'Coding repos ready for the coding lane. When a coding skill (open-pr-from-request, ' +
  'review-pull-request, pr-shepherd) needs a repo, pass one of these `repo` values EXACTLY ' +
  'as listed (the host-qualified coordinate, e.g. github.com/owner/repo) as its ' +
  'campaignConfig.repo — these are the coding-lane authority, not an API binding ' +
  '(github-default is for api.http.call only).';

export const TRIGGERS_GUIDANCE =
  'Everything armed to start work in this space without anybody asking — a clock, or an ' +
  'inbound call somebody else makes. A scheduled run reaches exactly ' +
  'what an interactive one reaches — same folders, same grants, same boundary — so the thing ' +
  'worth saying is that it exists and when it next fires, not that it is dangerous. Say so ' +
  'unprompted when the operator asks what happens here, and check this before offering to set ' +
  'up something that already runs. `agent.schedule.get` reads one in full; ' +
  '`agent.schedule.delete` stops a scheduled one; `api.webhook.delete` stops an event one.';

export const HOST_FOLDERS_GUIDANCE =
  'Folders on the operator machine this space can reach, through the host lane. Read them ' +
  'with host.file.list and host.file.get; write with host.file.put where access is ' +
  'read_write. These are live files on their computer, not Memory documents. A folder not ' +
  'listed here is not reachable — asking for one is refused rather than resolved. ' +
  'Where a folder lists mcpServers, those run on their machine inside that folder: ask one ' +
  'what it offers with host.mcp.list_tools, then call it with host.mcp.call.';

export interface HostFolderRow {
  readonly hostBindingId: string;
  readonly label: string;
  readonly root: string;
  readonly writable: boolean;
  readonly allowsExecution: boolean;
  readonly branchPrefix: string | null;
  readonly mcpServers: ReadonlyArray<{ id: string; label: string }>;
}

/**
 * What one connected folder looks like to the agent: what it allows, and
 * nothing that would have to be asked for separately.
 *
 * `branchPrefix` is here so a publication can be offered or declined before it
 * is attempted. A folder that pushes nothing is the default, and reading the
 * prefix is how the agent knows which folders can publish and under what name.
 * `pushApproval`, `mergePosture` and `checks` come from the machine rather than the row,
 * because the operator changes them there; they are absent while no machine
 * holding the folder is running.
 */
function idleMergePosture(publishing: PublishingFolder): { mergePostureIdleReason?: string } {
  const reason = idleMergePostureReason(publishing);
  return reason !== undefined ? { mergePostureIdleReason: reason } : {};
}

export function hostFolderEntry(
  row: HostFolderRow,
  publishing?: PublishingFolder,
): NonNullable<SpaceContext['hostFolders']>['items'][number] {
  return {
    id: row.hostBindingId,
    label: row.label,
    root: row.root,
    access: row.writable ? ('read_write' as const) : ('read' as const),
    canRunCommands: row.allowsExecution,
    ...(row.branchPrefix !== null ? { branchPrefix: row.branchPrefix } : {}),
    ...(row.branchPrefix !== null && publishing !== undefined
      ? {
          pushApproval: publishing.pushApproval,
          mergePosture: publishing.mergePosture,
          ...idleMergePosture(publishing),
          ...(publishing.checks !== undefined ? { checks: { ...publishing.checks } } : {}),
        }
      : {}),

    // Name and label only. The stored entry carries each server's full tool
    // schemas, and passing it through would put every local tool's arguments
    // into every turn — which is the cost `host.mcp.list_tools` exists to
    // avoid, paid whether or not the agent ever asks.
    ...(row.mcpServers.length > 0
      ? { mcpServers: row.mcpServers.map(({ id, label }) => ({ id, label })) }
      : {}),
  };
}

/**
 * One list of harnesses from however many machines are publishing.
 *
 * A machine is what offers a harness, and two machines can offer the same id;
 * the id is what a run addresses, so it is the identity here and the first label
 * seen for it is the name. Installed where any machine has it installed, since
 * a run that names none lands on a machine that does. Sorted by id, because the
 * list is read by an agent and a stable order is one fewer difference between
 * two otherwise equal turns.
 */
export function mergeHostHarnesses(
  inventories: ReadonlyArray<Pick<HostInventory, 'harnesses'>>,
): HostInventory['harnesses'] {
  const byId = new Map<string, HostInventory['harnesses'][number]>();
  for (const machine of inventories) {
    for (const harness of machine.harnesses) {
      const known = byId.get(harness.id);
      if (known === undefined) {
        byId.set(harness.id, {
          id: harness.id,
          ...(harness.label !== undefined ? { label: harness.label } : {}),
          installed: harness.installed,
        });
      } else {
        if (known.label === undefined && harness.label !== undefined) known.label = harness.label;
        known.installed ||= harness.installed;
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const SKILLS_GUIDANCE = INSTALLED_SKILLS_GUIDANCE;

export const COMPUTE_GUIDANCE =
  'To execute code use compute.sandbox.exec (promote it via catalog.tool.promote if it is not ' +
  'already in your toolbox — a planner usually delegates code work to a Runner skill instead) ' +
  'with runtime (python3, python3-ml, nodejs, bash, deno) and code string. ' +
  'For file I/O over Memory data, use the workspace field — the canonical model: ' +
  'workspace: {inputs: ["/data/project/"], outputs: ["/data/project/submission.csv"]}. ' +
  'Memory mounts as a real filesystem at /workspace/; read /workspace/<path> and write /workspace/<path>. ' +
  'Writes flush back to Memory automatically (text or binary) and are reported in workspaceFlush; ' +
  'a declared file output that the run does not produce fails the step. ' +
  'For multi-turn workflows (data analysis, ML), add session: {enabled: true} — variables, DataFrames, models persist. ' +
  'Presets: runtimePreset "quick" (60s/256MB), "standard" (3min/512MB), "ml-training" (30min/4GB/2cpu). ' +
  'No network access — download data via api.http.call first, save to memory, then declare it in workspace.inputs. ' +
  '(Legacy escape hatch, avoid for data work: inputPaths → /tmp/input, /tmp/output → outputFiles.)';

// ============================================================================
// Pure helpers (extracted for unit testing)
// ============================================================================

/** The persisted `/index.md` projection: the derivation column + freshness. */
export interface IndexNoteRow {
  derivation: MemoryDerivation | null;
  updatedAt: Date;
}

/**
 * Assemble the SpaceContext index-note projection from the persisted derivation
 * ONLY — never the note body. The entries + hooks are already sanitized and
 * capped by the write-path parser (control/bidi stripped, hook ≤160 units,
 * ≤50 entries); this builder only marks each entry `resolved` against the live
 * doc set and stamps `updatedAt`. Returns undefined when the note is absent or
 * carries no projection (written before the projection existed — the next write
 * repopulates it), so no partial/unsanitized shape is ever emitted.
 */
export function buildIndexNoteSection(
  row: IndexNoteRow | undefined,
  livePaths: ReadonlySet<string>,
): SpaceContextIndexNote | undefined {
  const entries = row?.derivation?.indexEntries;
  if (!row || !entries || entries.length === 0) return undefined;
  const projected = entries.map((e) => ({
    path: e.path,
    hook: e.hook,
    resolved: livePaths.has(e.path),
  }));
  const omitted = row.derivation?.omittedEntries ?? 0;
  return {
    path: INDEX_NOTE_PATH,
    entries: projected,
    ...(omitted > 0 ? { omittedEntries: omitted } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ============================================================================
// Builder
// ============================================================================

/**
 * Build a SpaceContext from Postgres data.
 * Queries space details, memory root directories, and API definitions
 * in a single withTenantSchema call to minimize round trips.
 */
export async function buildSpaceContext(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<SpaceContext | undefined> {
  try {
    const tenantContext = createTenantContext(tenantId as TenantId);

    const result = await withTenantSchema(db, tenantContext, async (tx) => {
      // Run all queries in parallel within the same tenant schema context
      const [spaceRows, rootDirRows, docCountRows, dirCountRows, indexNoteRows] = await Promise.all(
        [
          // 1. Space details (slug, name, description, rules, compute policy)
          tx
            .select({
              slug: spaces.slug,
              name: spaces.name,
              description: spaces.description,
              rules: spaces.rules,
              computePolicy: spaces.computePolicy,
              directives: spaces.directives,
            })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1),

          // 2. Top-level memory directories (children of root '/', not deleted, scoped to space)
          // Root '/' always exists and is uninformative — show its children instead.
          tx
            .select({
              path: memoryDirs.path,
              name: memoryDirs.name,
              description: memoryDirs.description,
            })
            .from(memoryDirs)
            .where(
              and(
                eq(memoryDirs.spaceId, spaceId),
                eq(memoryDirs.parentPath, '/'),
                isNull(memoryDirs.deletedAt),
              ),
            )
            .limit(SPACE_CONTEXT_LIMITS.memoryDirectories + 1), // +1 to detect truncation

          // 3. Total document count for the space
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(memoryDocs)
            .where(and(eq(memoryDocs.spaceId, spaceId), isNull(memoryDocs.deletedAt))),

          // 4. Total directory count for the space
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(memoryDirs)
            .where(and(eq(memoryDirs.spaceId, spaceId), isNull(memoryDirs.deletedAt))),

          // The memory-map note's PROJECTION column only — never its body. The
          // parsed, bounded, sanitized entries live in derivation.indexEntries
          // (persisted at write). Reading content here would breach the
          // injection boundary; reading the projection cannot.
          tx
            .select({
              derivation: memoryDocs.derivation,
              updatedAt: memoryDocs.updatedAt,
            })
            .from(memoryDocs)
            .where(
              and(
                eq(memoryDocs.spaceId, spaceId),
                eq(memoryDocs.path, INDEX_NOTE_PATH),
                isNull(memoryDocs.deletedAt),
              ),
            )
            .limit(1),
        ],
      );

      return {
        spaceRows,
        rootDirRows,
        docCountRows,
        dirCountRows,
        indexNoteRows,
      };
    });

    const spaceRow = result.spaceRows[0];
    if (!spaceRow) {
      getOrchestratorLogger().warn(
        `spaceContext: space not found for spaceId=${spaceId}, tenantId=${tenantId}`,
      );
      return undefined;
    }

    // Build space section with rules (capped)
    const rawRules = Array.isArray(spaceRow.rules) ? spaceRow.rules : [];
    const rules = rawRules.slice(0, SPACE_CONTEXT_LIMITS.rules) as Array<{ text: string }>;

    const context: SpaceContext = {
      version: 1,
      space: {
        id: spaceId,
        slug: spaceRow.slug,
        name: spaceRow.name,
        ...(spaceRow.description ? { description: spaceRow.description } : {}),
        // Rules are a lightweight operator surface injected alongside the
        // directives-driven executive prompt.
        ...(rules.length > 0 ? { rules } : {}),
        ...(spaceRow.directives != null ? { directives: spaceRow.directives } : {}),
      },
    };

    const webBaseUrl = resolveWebBaseUrlOrNull();
    if (webBaseUrl) {
      context.navigation = buildSpaceContextNavigation(webBaseUrl, spaceRow.slug);
    }

    // Build memory section
    const totalDocuments = result.docCountRows[0]?.count ?? 0;
    const totalDirectories = result.dirCountRows[0]?.count ?? 0;

    if (totalDirectories > 0 || totalDocuments > 0) {
      const memoryTruncated = result.rootDirRows.length > SPACE_CONTEXT_LIMITS.memoryDirectories;
      const rootDirs = result.rootDirRows
        .slice(0, SPACE_CONTEXT_LIMITS.memoryDirectories)
        .map((d) => ({
          path: d.path,
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
        }));

      // Memory-map projection: read the persisted /index.md derivation ONLY, then
      // batch-resolve its entry paths against live docs in one query. The note
      // body is never read — the injection boundary is the projection column.
      const indexNoteRow = result.indexNoteRows[0];
      const indexEntryPaths = indexNoteRow?.derivation?.indexEntries?.map((e) => e.path) ?? [];
      let livePaths: ReadonlySet<string> = new Set();
      if (indexEntryPaths.length > 0) {
        const liveRows = await withTenantSchema(db, tenantContext, async (tx) =>
          tx
            .select({ path: memoryDocs.path })
            .from(memoryDocs)
            .where(
              and(
                eq(memoryDocs.spaceId, spaceId),
                inArray(memoryDocs.path, [...new Set(indexEntryPaths)]),
                isNull(memoryDocs.deletedAt),
                sql`(${memoryDocs.expiresAt} IS NULL OR ${memoryDocs.expiresAt} > NOW())`,
              ),
            ),
        );
        livePaths = new Set(liveRows.map((r) => r.path));
      }
      const indexNote = buildIndexNoteSection(indexNoteRow, livePaths);

      context.memories = {
        rootDirectories: rootDirs,
        totalDocuments,
        totalDirectories,
        ...(memoryTruncated ? { truncated: true } : {}),
        ...(indexNote ? { indexNote } : {}),
        guidance: memoryTruncated
          ? `${MEMORY_GUIDANCE} ${totalDirectories - SPACE_CONTEXT_LIMITS.memoryDirectories} more directories not shown — use memory.store.query to list all.`
          : MEMORY_GUIDANCE,
      };
    }

    try {
      const { descriptors, definitionOnlyCount } = await readIntegrations(
        tenantId as TenantId,
        spaceId,
      );
      // Drop disabled entries from the visible list — they're configured but
      // operator-suppressed and have no callable tools; the bound/needs_setup
      // signal is what the Helmsman acts on. We still surface them via the
      // operator UI / integration.registry.list when explicitly requested.
      const visible = descriptors.filter(
        (d) => d.status === 'bound' || d.status === 'needs_credentials' || d.status === 'disabled',
      );
      if (visible.length > 0 || definitionOnlyCount > 0) {
        const truncated = visible.length > SPACE_CONTEXT_LIMITS.integrations;
        const items = visible.slice(0, SPACE_CONTEXT_LIMITS.integrations).map((d) => ({
          sourceKind: d.sourceKind,
          integrationId: d.integrationId,
          ...(d.bindingId ? { bindingId: d.bindingId } : {}),
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
          status: d.status as 'bound' | 'needs_credentials' | 'disabled',
          toolCount: d.toolCount,
          ...(d.credentialStatus ? { credentialStatus: d.credentialStatus } : {}),
        }));
        const total = visible.length;
        const guidance = truncated
          ? `${INTEGRATIONS_GUIDANCE} ${total - SPACE_CONTEXT_LIMITS.integrations} more not shown — promote integration.registry.list to see all.`
          : INTEGRATIONS_GUIDANCE;
        context.integrations = {
          items,
          total,
          definitionOnlyCount,
          ...(truncated ? { truncated: true } : {}),
          guidance,
        };
      }
    } catch (err) {
      getOrchestratorLogger().warn(
        `[spaceContext] integrations section failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Ready coding repos — the agent's picking surface for the `repo` coordinate a
    // coding skill's campaign needs (Plan 222 P2). Only status='ready' rows: the
    // `code_repo` capability gate (skills.needsSetup) handles "no ready repo", and
    // not-ready repos live on the operator's Integrations → Repositories cards.
    try {
      // Repo designations are operator-created and few — fetch all ready ones so
      // `total` is exact (the display list is capped separately, with a truncated flag).
      const repoRows = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({
            coordinate: repoBindings.coordinate,
            defaultBranch: repoBindings.defaultBranch,
          })
          .from(repoBindings)
          .where(and(eq(repoBindings.spaceId, spaceId), eq(repoBindings.status, 'ready'))),
      );
      if (repoRows.length > 0) {
        const truncated = repoRows.length > SPACE_CONTEXT_LIMITS.repositories;
        const items = repoRows.slice(0, SPACE_CONTEXT_LIMITS.repositories).map((r) => ({
          repo: r.coordinate,
          defaultBranch: r.defaultBranch,
        }));
        context.repositories = {
          items,
          total: repoRows.length,
          ...(truncated ? { truncated: true } : {}),
          guidance: REPOSITORIES_GUIDANCE,
        };
      }
    } catch (err) {
      getOrchestratorLogger().warn(
        `[spaceContext] repositories section failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Folders on the operator's own machine, as context rather than tools. The
    // agent needs to know one exists to answer whether it can reach it, while the
    // operations that read it stay on demand and cost nothing until used.
    try {
      const folderRows = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({
            hostBindingId: hostBindings.hostBindingId,
            label: hostBindings.label,
            root: hostBindings.root,
            writable: hostBindings.writable,
            allowsExecution: hostBindings.allowsExecution,
            branchPrefix: hostBindings.branchPrefix,
            mcpServers: hostBindings.mcpServers,
          })
          .from(hostBindings)
          .where(eq(hostBindings.spaceId, spaceId)),
      );
      if (folderRows.length > 0) {
        const limit = SPACE_CONTEXT_LIMITS.repositories;
        const truncated = folderRows.length > limit;
        // Asked only once a folder exists, and only of the machines currently
        // publishing: which harnesses can be addressed is a fact about a
        // running executor, and the agent otherwise has to ask the operator for
        // an id nothing it reads names.
        const inventories = await readLiveHostInventories(getRedisConnection());
        const harnesses = mergeHostHarnesses(inventories);
        const preferredHarness = await readPreferredHarness(db, tenantId, spaceId);
        const publishing = publishingFoldersForSpace(inventories, spaceId);
        context.hostFolders = {
          items: folderRows
            .slice(0, limit)
            .map((row) => hostFolderEntry(row, publishing.get(row.hostBindingId))),
          harnesses,
          ...(preferredHarness !== undefined ? { preferredHarness } : {}),
          total: folderRows.length,
          ...(truncated ? { truncated: true } : {}),
          guidance: HOST_FOLDERS_GUIDANCE,
        };
      }
    } catch (err) {
      getOrchestratorLogger().warn(
        `[spaceContext] host folders section failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The only things in a space that act on their own. Nothing surfaced them
    // anywhere — not this context and not any page — so a daily job could run
    // commands on the operator's machine and be discoverable only by thinking
    // to ask. The authority is ordinary; the invisibility was the problem.
    try {
      const scheduleRows = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({
            id: agentSchedules.id,
            name: agentSchedules.name,
            kind: agentSchedules.kind,
            cronExpression: agentSchedules.cronExpression,
            timezone: agentSchedules.timezone,
            scheduledAt: agentSchedules.scheduledAt,
            nextFireAt: agentSchedules.nextFireAt,
            lastFiredAt: agentSchedules.lastFiredAt,
            status: agentSchedules.status,
            targetSystemRole: agentSchedules.targetSystemRole,
            targetAgentId: agentSchedules.targetAgentId,
            createdBySessionId: agentSchedules.createdBySessionId,
          })
          .from(agentSchedules)
          .where(and(eq(agentSchedules.spaceId, spaceId), eq(agentSchedules.status, 'active'))),
      );
      // Both kinds in one list, because the operator's question is "what runs
      // here on its own" and the answer does not divide by what starts it.
      const hookRows = await withTenantSchema(db, tenantContext, async (tx) =>
        tx
          .select({
            id: webhookEndpoints.id,
            name: webhookEndpoints.name,
            status: webhookEndpoints.status,
            lastReceivedAt: webhookEndpoints.lastReceivedAt,
            targetSystemRole: webhookEndpoints.targetSystemRole,
            targetAgentId: webhookEndpoints.targetAgentId,
          })
          .from(webhookEndpoints)
          .where(and(eq(webhookEndpoints.spaceId, spaceId), eq(webhookEndpoints.status, 'active'))),
      );

      const triggerItems = [
        ...scheduleRows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: 'schedule' as const,
          recurrence:
            row.kind === 'cron' && row.cronExpression !== null
              ? `${row.cronExpression} (${row.timezone})`
              : 'once',
          ...(row.nextFireAt ? { nextFireAt: row.nextFireAt.toISOString() } : {}),
          ...(row.lastFiredAt ? { lastFiredAt: row.lastFiredAt.toISOString() } : {}),
          target: row.targetSystemRole ?? row.targetAgentId ?? 'unknown',
          createdByAgent: row.createdBySessionId !== null,
          status: row.status,
        })),
        ...hookRows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: 'webhook' as const,
          recurrence: 'when called',
          ...(row.lastReceivedAt ? { lastFiredAt: row.lastReceivedAt.toISOString() } : {}),
          target: row.targetSystemRole ?? row.targetAgentId ?? 'unknown',
          // No session is recorded against an endpoint, so this cannot be
          // claimed for one — and `false` would assert the operator created it,
          // which is the same guess in the other direction. Omitted instead, so
          // a reader sees provenance is unknown rather than being told wrongly.
          status: row.status,
        })),
      ];

      if (triggerItems.length > 0) {
        const limit = SPACE_CONTEXT_LIMITS.repositories;
        const truncated = triggerItems.length > limit;
        context.triggers = {
          items: triggerItems.slice(0, limit),
          total: triggerItems.length,
          ...(truncated ? { truncated: true } : {}),
          guidance: TRIGGERS_GUIDANCE,
        };
      }
    } catch (err) {
      getOrchestratorLogger().warn(
        `[spaceContext] triggers section failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (spaceRow.computePolicy) {
      const parsed = SpaceComputePolicySchema.safeParse(spaceRow.computePolicy);
      if (parsed.success && parsed.data.enabled) {
        const policy = parsed.data;
        context.compute = {
          enabled: true,
          runtimes: ['python3', 'python3-ml', 'nodejs', 'bash', 'deno'],
          networkEgress: policy.networkEgress.mode,
          maxExecutionSeconds: policy.resources?.maxExecutionSeconds ?? 60,
          sessionsEnabled: policy.sessions?.enabled ?? false,
          guidance: COMPUTE_GUIDANCE,
        };
      }
    }

    const skillPlacements = (
      spaceRow.directives as {
        capabilityDiscovery?: { skillPlacements?: Record<string, string> };
      } | null
    )?.capabilityDiscovery?.skillPlacements;
    context.skills = await buildInstalledSkillAwareness({ db, tenantId, spaceId }, skillPlacements);

    const appletsSection = await buildSpaceContextAppletsSection(db, tenantId, spaceId);
    if (appletsSection) {
      context.applets = appletsSection;
    }

    return context;
  } catch (error) {
    getOrchestratorLogger().warn(
      `spaceContext: failed to build for spaceId=${spaceId}, tenantId=${tenantId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// ============================================================================
// Cache helpers
// ============================================================================

// The per-space generation counter lives in @aflow/redis so every mutation
// surface (orchestrator result path + REST memory writes) bumps the same key.
export { readSpaceContextGen, bumpSpaceContextGen };

/**
 * Read cached SpaceContext from SessionHotState.
 * Returns undefined if not cached, expired (TTL 1 hour), or built at a stale
 * generation (a space-visible mutation bumped the gen since the build).
 */
export function readCachedSpaceContext(
  runState:
    | {
        spaceContextJson?: string | undefined;
        spaceContextBuiltAt?: number | undefined;
        spaceContextGen?: number | undefined;
      }
    | undefined,
  currentGen?: number,
): SpaceContext | undefined {
  if (!runState?.spaceContextJson || !runState.spaceContextBuiltAt) return undefined;

  const age = Date.now() - runState.spaceContextBuiltAt;
  if (age > SPACE_CONTEXT_TTL_MS) return undefined;

  // A mutation since the build bumped the space gen — the cache is stale. A
  // cached context with no recorded gen predates freshness tracking; treat its
  // gen as 0 so it stays reusable only while the live gen is also 0.
  if (currentGen !== undefined && (runState.spaceContextGen ?? 0) !== currentGen) {
    return undefined;
  }

  try {
    const parsed = SpaceContextSchema.safeParse(JSON.parse(runState.spaceContextJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store SpaceContext in SessionHotState cache, stamped with the space
 * generation it was built at so a later mutation invalidates it.
 */
export async function cacheSpaceContext(
  redis: Redis,
  tenantId: string,
  runId: string,
  context: SpaceContext,
  gen: number,
): Promise<void> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  await redis.hset(key, {
    spaceContextJson: JSON.stringify(context),
    spaceContextBuiltAt: String(Date.now()),
    spaceContextGen: String(gen),
  });
}

/**
 * Step types whose SUCCEEDED result can mutate space-visible state and so must
 * invalidate SpaceContext (clear this run's cache + bump the per-space gen for
 * peers). `compute` is included because a workspace flush writes memory docs
 * (possibly /index.md) yet completes as stepType `compute`. `ui` is included
 * because publish/instantiate/act change the applets section (installed set,
 * live-instance counts) — a stale count reads as authoritative.
 */
const SPACE_CONTEXT_INVALIDATING_STEP_TYPES: ReadonlySet<string> = new Set([
  'memory',
  'api',
  'workflow',
  'compute',
  'ui',
]);

export function stepTypeInvalidatesSpaceContext(stepType: string): boolean {
  return SPACE_CONTEXT_INVALIDATING_STEP_TYPES.has(stepType);
}

/**
 * Clear cached SpaceContext from SessionHotState.
 * Called when a memory or API step completes, so the next agent turn rebuilds.
 */
export async function clearSpaceContextCache(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  await redis.hdel(key, 'spaceContextJson', 'spaceContextBuiltAt', 'spaceContextGen');
}
