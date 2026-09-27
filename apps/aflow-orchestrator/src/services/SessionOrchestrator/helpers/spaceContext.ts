import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, sql, and, isNull, inArray } from 'drizzle-orm';
import type {
  TenantId,
  SkillDiagnostic,
  ActivationStatus,
  SkillValidity,
  SpaceContextIndexNote,
} from '@aflow/schemas';
import {
  SPACE_CONTEXT_LIMITS,
  SPACE_CONTEXT_TTL_MS,
  SpaceComputePolicySchema,
  SkillValiditySchema,
  buildSpaceContextNavigation,
  codeLaneComposed,
  computeSkillReadiness,
  describeMissingCapability,
  foldMissingCapabilitiesForAbsentCodeLane,
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
  type HostInventory,
  getRedisConnection,
} from '@aflow/redis';
import {
  deriveFirstTaskInputContract,
  ensureWorkflowDocValidity,
  cachedOrRecomputeValidity,
  loadAvailableCapabilitySet,
  deriveWorkflowLaneTokens,
  deriveWorkflowPolicyPrefixes,
} from '@aflow/cybernetic-runtime';
import { PLATFORM_SKILL_BUNDLES } from '@aflow/platform-artifacts';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { readIntegrations } from './integrationReader.js';
import { buildSpaceContextAppletsSection } from './spaceContextApplets.js';
import { resolveWebBaseUrlOrNull } from '@aflow/lib';

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
 */
export function hostFolderEntry(
  row: HostFolderRow,
): NonNullable<SpaceContext['hostFolders']>['items'][number] {
  return {
    id: row.hostBindingId,
    label: row.label,
    root: row.root,
    access: row.writable ? ('read_write' as const) : ('read' as const),
    canRunCommands: row.allowsExecution,
    ...(row.branchPrefix !== null ? { branchPrefix: row.branchPrefix } : {}),

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
 * seen for it is the name. Sorted by id, because the list is read by an agent
 * and a stable order is one fewer difference between two otherwise equal turns.
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
        });
      } else if (known.label === undefined && harness.label !== undefined) {
        known.label = harness.label;
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const SKILLS_GUIDANCE =
  'A skill is the user-facing word for a workflow. To start a skill run use workflow.run.start ' +
  'with the skill slug; workflow.manage.get fetches one skill’s full definition. ' +
  'Authoring or editing a skill normally runs through the compose-skill skill (which stages a ' +
  'change for operator ratification); to inspect or patch a skill DIRECTLY, or to read its deep ' +
  'run history + learnings, promote the op you need via catalog.tool.promote — ' +
  'workflow.manage.list (enumerate), workflow.manage.patch / put (edit), workflow.ledger.get ' +
  '(history). ' +
  'When the skill entry above carries `firstTaskInputContract`, read it (a JSON Schema) and ' +
  'populate `workflow.run.start.inputs` keyed by the same field names — the orchestrator ' +
  'validates the inputs and surfaces them to the Runner verbatim. When `firstTaskInputContract` ' +
  'is absent, the skill has no typed input surface — pass guidance via `instructions` instead ' +
  '(freeform string or per-task `{ taskId, text }[]`). ' +
  'A skill in needsSetup carries a `setup` line per missing capability naming what is missing ' +
  'and what closes it. Point the operator at that fix — do not attempt the run first.';

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

type SkillMode = 'optimization' | 'process' | 'project';
type SkillStatus = 'draft' | 'approved';

export interface ActiveSkillEntry {
  slug: string;
  name: string;
  description?: string;
  mode: SkillMode;
  status: SkillStatus;
  progress: string;
  bestResult?: string;
  origin: 'platform' | 'space';
  firstTaskInputContract?: Record<string, unknown>;
}

const isSkillMode = (m: string): m is SkillMode =>
  m === 'optimization' || m === 'process' || m === 'project';

/**
 * Convert PLATFORM_SKILL_BUNDLES → entry list. Stub workflows like
 * `helmsman-supervisory-sweep` are NOT included (those live in
 * `PLATFORM_SYSTEM_WORKFLOWS` and aren't user-callable yet).
 *
 * Returns [] for non-cybernetic spaces — platform skills only have meaning
 * inside the cybernetic agent loop.
 */
export function buildPlatformSkillEntries(): ActiveSkillEntry[] {
  const out: ActiveSkillEntry[] = [];
  for (const bundle of PLATFORM_SKILL_BUNDLES) {
    const wf = bundle.workflow;
    if (wf.status !== 'approved' && wf.status !== 'draft') continue;
    if (!isSkillMode(wf.mode)) continue;
    const firstTaskInputContract = deriveFirstTaskInputContract({
      slug: wf.slug,
      tasks: wf.tasks as never,
      runInputs: (wf as { runInputs?: unknown }).runInputs as never,
    });
    out.push({
      slug: wf.slug,
      name: wf.name,
      ...(wf.description ? { description: wf.description } : {}),
      mode: wf.mode,
      status: wf.status,
      progress: 'platform skill — always available',
      origin: 'platform',
      ...(firstTaskInputContract !== null ? { firstTaskInputContract } : {}),
    });
  }
  return out;
}

export interface NeedsRepairSkillEntry {
  slug: string;
  name: string;
  diagnostics: SkillDiagnostic[];
}

export interface NeedsSetupSkillEntry {
  slug: string;
  name: string;
  activationStatus: 'needs_binding' | 'degraded';
  missingCapabilities: string[];
  setup?: string[];
  missingEndpointIds?: string[];
}

export const NEEDS_REPAIR_SURFACE_LIMIT = 10;
const NEEDS_REPAIR_DIAGNOSTIC_CAP = 10;
export const NEEDS_SETUP_SURFACE_LIMIT = 10;
const NEEDS_SETUP_CAPABILITY_CAP = 20;

/**
 * Both the `/workflows/` doc scan and the `/skills/` projection scan fetch the
 * WHOLE bounded skill set, not a window sized to the surface caps. A windowed
 * scan is a single capped, unordered read — so N non-callable docs (broken,
 * unbound, dormant) could fill the window and hide callable skills behind it,
 * AND the two scans share no ordering, so a windowed projection scan could miss
 * the projection for a fetched workflow and default it to `active`. Fetching the
 * whole set sidesteps both: every skill is seen and routed, and the per-bucket
 * caps (below) decide only how many of each kind to surface.
 *
 * 200 is the platform's skill-scan bound (`listSkillsForSpace`) — spaces hold
 * tens of skills; a space beyond 200 skills truncates here exactly as it does
 * there. A guard test pins that this stays ≥ the combined surface caps.
 */
export const SKILL_DOC_SCAN_LIMIT = 200;

export function composeSkillsSection(
  entries: ActiveSkillEntry[],
  needsRepair: NeedsRepairSkillEntry[] = [],
  needsSetup: NeedsSetupSkillEntry[] = [],
):
  | {
      active: ActiveSkillEntry[];
      needsSetup?: NeedsSetupSkillEntry[];
      needsRepair?: NeedsRepairSkillEntry[];
      total: number;
      truncated?: boolean;
      guidance: string;
    }
  | undefined {
  if (entries.length === 0 && needsRepair.length === 0 && needsSetup.length === 0) return undefined;
  const cap = SPACE_CONTEXT_LIMITS.skills;
  const truncated = entries.length > cap;
  const items = truncated ? entries.slice(0, cap) : entries;
  const repair = needsRepair.slice(0, NEEDS_REPAIR_SURFACE_LIMIT);
  const setup = needsSetup.slice(0, NEEDS_SETUP_SURFACE_LIMIT);
  const setupGuidance =
    setup.length > 0
      ? ` ${String(setup.length)} skill(s) need setup (valid but a required integration is unbound) — not callable until the operator binds the missing capability.`
      : '';
  const repairGuidance =
    repair.length > 0
      ? ` ${String(repair.length)} skill(s) need repair (contract invalid) — not callable; the diagnostics name the break, and the fix is an in-place Coach patch.`
      : '';
  return {
    active: items,
    ...(setup.length > 0 ? { needsSetup: setup } : {}),
    ...(repair.length > 0 ? { needsRepair: repair } : {}),
    total: entries.length,
    ...(truncated ? { truncated: true } : {}),
    guidance:
      (truncated
        ? `${SKILLS_GUIDANCE} ${entries.length - cap} more skills not shown — promote workflow.manage.list to enumerate all.`
        : `${SKILLS_GUIDANCE} These are all skills available in this space.`) +
      setupGuidance +
      repairGuidance,
  };
}

/** The space-dependent capability-readiness axis read off a SkillProjection. */
export interface SkillActivation {
  activationStatus: ActivationStatus;
  missingCapabilities: string[];
  missingEndpointIds: string[];
  contractValidity?: SkillValidity;
  contractValidityHash?: string;
}

const ACTIVATION_STATUSES: ReadonlySet<string> = new Set<ActivationStatus>([
  'active',
  'needs_binding',
  'degraded',
  'dormant',
  'archived',
]);

function collectMissingEndpointIds(capabilityDependencies: unknown): string[] {
  if (!Array.isArray(capabilityDependencies)) return [];
  const out: string[] = [];
  for (const dep of capabilityDependencies) {
    if (!dep || typeof dep !== 'object') continue;
    const d = dep as { status?: unknown; missingEndpointIds?: unknown };
    if (d.status !== 'missing_endpoint' || !Array.isArray(d.missingEndpointIds)) continue;
    for (const id of d.missingEndpointIds) {
      if (typeof id === 'string') out.push(id);
    }
  }
  return out;
}

export function buildProjectionActivationMap(
  rows: ReadonlyArray<{ path: string; inlineContent: string | null }>,
): Map<string, SkillActivation> {
  const map = new Map<string, SkillActivation>();
  for (const row of rows) {
    if (!row.inlineContent) continue;
    const skillId = row.path.split('/')[2]; // ['', 'skills', '{skillId}', 'projection.json']
    if (!skillId) continue;
    try {
      const doc = JSON.parse(row.inlineContent) as {
        activationStatus?: unknown;
        missingCapabilities?: unknown;
        capabilityDependencies?: unknown;
        contractValidity?: unknown;
        contractValidityHash?: unknown;
      };
      const rawStatus = doc.activationStatus;
      const activationStatus: ActivationStatus =
        typeof rawStatus === 'string' && ACTIVATION_STATUSES.has(rawStatus)
          ? (rawStatus as ActivationStatus)
          : 'active';
      const missingCapabilities = Array.isArray(doc.missingCapabilities)
        ? doc.missingCapabilities.filter((c): c is string => typeof c === 'string')
        : [];
      const missingEndpointIds = collectMissingEndpointIds(doc.capabilityDependencies);
      // Carry the cached verdict only when BOTH verdict and hash parse (a hashless verdict can't be trusted).
      const parsedValidity = SkillValiditySchema.safeParse(doc.contractValidity);
      const cacheable = parsedValidity.success && typeof doc.contractValidityHash === 'string';
      map.set(skillId, {
        activationStatus,
        missingCapabilities,
        missingEndpointIds,
        ...(cacheable
          ? {
              contractValidity: parsedValidity.data,
              contractValidityHash: doc.contractValidityHash as string,
            }
          : {}),
      });
    } catch {
      // Skip malformed projection docs — the lookup falls back to 'active'.
    }
  }
  return map;
}

/**
 * Recompute the binding-dependent activation axis at read time. The projection's
 * cached `activationStatus`/`missingCapabilities` are an advisory snapshot from
 * install/last-reconcile; the moment the operator binds a previously-missing
 * capability the cache is stale and a working skill is wrongly surfaced as
 * `needs_binding` in the context the Helmsman reads. Re-filter the cached missing
 * list against the live `available` capability set so a now-bound skill flips back
 * to callable. `available` is undefined when no projection claimed `needs_binding`
 * (nothing to recompute) — the cached values pass through verbatim.
 */
export function recomputeActivation(
  activation: SkillActivation | undefined,
  available: Set<string> | undefined,
): { activationStatus: ActivationStatus; missingCapabilities: string[] } {
  const activationStatus = activation?.activationStatus ?? 'active';
  const missingCapabilities = activation?.missingCapabilities ?? [];
  if (available && activationStatus === 'needs_binding' && missingCapabilities.length > 0) {
    const stillMissing = missingCapabilities.filter((c) => !available.has(c));
    if (stillMissing.length === 0) return { activationStatus: 'active', missingCapabilities: [] };
    return { activationStatus, missingCapabilities: stillMissing };
  }
  return { activationStatus, missingCapabilities };
}

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
      const [
        spaceRows,
        rootDirRows,
        docCountRows,
        dirCountRows,
        objectiveRows,
        projectionRows,
        indexNoteRows,
      ] = await Promise.all([
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

        tx
          .select({
            path: memoryDocs.path,
            inlineContent: memoryDocs.inlineContent,
          })
          .from(memoryDocs)
          .where(
            and(
              eq(memoryDocs.spaceId, spaceId),
              sql`${memoryDocs.path} LIKE '/workflows/%/workflow.json'`,
              isNull(memoryDocs.deletedAt),
            ),
          )
          .limit(SKILL_DOC_SCAN_LIMIT), // whole bounded skill set — never hide callable skills behind the cap

        tx
          .select({
            path: memoryDocs.path,
            inlineContent: memoryDocs.inlineContent,
          })
          .from(memoryDocs)
          .where(
            and(
              eq(memoryDocs.spaceId, spaceId),
              sql`${memoryDocs.path} LIKE '/skills/%/projection.json'`,
              isNull(memoryDocs.deletedAt),
            ),
          )
          .limit(SKILL_DOC_SCAN_LIMIT), // whole space — no shared ordering with the workflow scan

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
      ]);

      return {
        spaceRows,
        rootDirRows,
        docCountRows,
        dirCountRows,
        workflowRows: objectiveRows,
        projectionRows,
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
        const harnesses = mergeHostHarnesses(await readLiveHostInventories(getRedisConnection()));
        context.hostFolders = {
          items: folderRows.slice(0, limit).map(hostFolderEntry),
          harnesses,
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

    const activeSkills: ActiveSkillEntry[] = buildPlatformSkillEntries();
    const needsRepair: NeedsRepairSkillEntry[] = [];
    const needsSetup: NeedsSetupSkillEntry[] = [];
    const seenSlugs = new Set<string>(activeSkills.map((s) => s.slug));

    const projectionActivation = buildProjectionActivationMap(result.projectionRows);

    // Activation readiness is a space-dependent axis (which capabilities are bound)
    // and the projection's cached `activationStatus` goes stale the moment the
    // operator binds a capability after the skill was installed — leaving a
    // working skill marked `needs_binding` in the context the Helmsman reads.
    // Recompute that axis at read against the CURRENT bindings, just as the
    // contract axis is recomputed above. Only load the (cheap) binding set when a
    // projection actually claims `needs_binding`, so fully-bound spaces pay nothing.
    const hasNeedsBindingProjection = [...projectionActivation.values()].some(
      (a) => a.activationStatus === 'needs_binding' && a.missingCapabilities.length > 0,
    );
    let availableCapabilities = hasNeedsBindingProjection
      ? await loadAvailableCapabilitySet({ db, tenantId, spaceId })
      : undefined;
    // Lane tokens are re-derived from the live workflow below (a stale 'active'
    // projection predating lane gating carries none), so the capability set may
    // be needed even when no projection claims needs_binding.
    const ensureAvailableCapabilities = async (): Promise<Set<string>> => {
      availableCapabilities ??= await loadAvailableCapabilitySet({ db, tenantId, spaceId });
      return availableCapabilities;
    };
    // A cached projection can still carry the lane's key and repo tokens from a
    // reconcile that ran where a coding lane existed; where none is composed,
    // they fold into the one token that says so.
    const codeLane = codeLaneComposed();

    // Pass 2: space-local skills from memory docs (still keyed under /workflows/ on disk).
    if (result.workflowRows.length > 0) {
      interface WfData {
        slug: string;
        name: string;
        description?: string;
        mode: 'optimization' | 'process' | 'project';
        status: string;
        budget?: { maxRuns?: number };
        tasks?: unknown;
      }
      interface LedgerData {
        entries: Array<{
          status: string;
          evaluation?: { outcomeResults?: Array<{ value?: unknown }>; allMet?: boolean };
        }>;
      }

      const activeWfData: WfData[] = [];
      for (const row of result.workflowRows) {
        if (!row.inlineContent) continue;
        if (
          activeSkills.length + activeWfData.length >= SPACE_CONTEXT_LIMITS.skills &&
          needsRepair.length >= NEEDS_REPAIR_SURFACE_LIMIT &&
          needsSetup.length >= NEEDS_SETUP_SURFACE_LIMIT
        ) {
          break; // all three surfaces full — nothing more to collect
        }
        try {
          const wf = JSON.parse(row.inlineContent) as WfData;
          if (wf.status !== 'draft' && wf.status !== 'approved') continue;
          if (seenSlugs.has(wf.slug)) continue; // platform-first dedup
          seenSlugs.add(wf.slug);

          // Projection carries both axes: cached contract verdict (+ hash, Slice
          // 5b) and capability activation. No projection ⇒ `active`.
          const activation = projectionActivation.get(wf.slug);

          // Contract axis — cached-or-recompute (cache used only while the config
          // hash matches); an `invalid` skill goes to `needsRepair`, not callable.
          const validity = cachedOrRecomputeValidity(wf, activation);
          if (validity.status === 'invalid') {
            if (needsRepair.length < NEEDS_REPAIR_SURFACE_LIMIT) {
              needsRepair.push({
                slug: wf.slug,
                name: wf.name,
                diagnostics: validity.diagnostics.slice(0, NEEDS_REPAIR_DIAGNOSTIC_CAP),
              });
            }
            continue;
          }

          // Capability axis — recompute the binding-dependent status at read so a
          // capability bound after install flips the skill back to callable instead
          // of staying stuck on the projection's stale `needs_binding`.
          const recomputed = recomputeActivation(activation, availableCapabilities);
          let { activationStatus } = recomputed;
          let { missingCapabilities } = recomputed;

          // Lane + space-policy axes — always derived from the live tasks, never
          // the cached projection, so skills installed before a gate existed gain
          // the check at read.
          const wfTasks = Array.isArray(wf.tasks)
            ? (wf.tasks as Array<{
                operation?: string;
                inputTemplate?: unknown;
                context?: unknown;
              }>)
            : [];
          const gatedTokens = [
            ...deriveWorkflowLaneTokens(wfTasks),
            ...deriveWorkflowPolicyPrefixes(wfTasks),
          ];
          if (gatedTokens.length > 0 && activationStatus !== 'dormant') {
            const caps = await ensureAvailableCapabilities();
            const gatedMissing = gatedTokens.filter((t) => !caps.has(t));
            if (gatedMissing.length > 0) {
              activationStatus = 'needs_binding';
              missingCapabilities = [...new Set([...missingCapabilities, ...gatedMissing])];
            }
          }
          missingCapabilities = foldMissingCapabilitiesForAbsentCodeLane(
            missingCapabilities,
            codeLane,
          );

          const readiness = computeSkillReadiness({ contractValidity: validity, activationStatus });

          // Valid-but-unbound: the operator binds a credential (`needsSetup`).
          // Narrow on the activation status itself (not a cast) so this stays
          // correct if `computeSkillReadiness`'s `needsSetup` ever broadens.
          if (
            readiness.needsSetup &&
            (activationStatus === 'needs_binding' || activationStatus === 'degraded')
          ) {
            if (needsSetup.length < NEEDS_SETUP_SURFACE_LIMIT) {
              const missingEndpointIds = (activation?.missingEndpointIds ?? []).slice(
                0,
                NEEDS_SETUP_CAPABILITY_CAP,
              );
              const surfacedCapabilities = missingCapabilities.slice(0, NEEDS_SETUP_CAPABILITY_CAP);
              needsSetup.push({
                slug: wf.slug,
                name: wf.name,
                activationStatus,
                missingCapabilities: surfacedCapabilities,
                ...(surfacedCapabilities.length > 0
                  ? { setup: surfacedCapabilities.map(describeMissingCapability) }
                  : {}),
                // `degraded` (endpoint drift) carries which endpoints broke; the
                // `missingCapabilities` list is empty in that sub-case.
                ...(missingEndpointIds.length > 0 ? { missingEndpointIds } : {}),
              });
            }
            continue;
          }

          // Callable now (`canRun`) → the offerable `active` list. A contract-valid
          // but dormant/archived activation is neither canRun nor needsSetup — dropped.
          if (
            readiness.canRun &&
            activeSkills.length + activeWfData.length < SPACE_CONTEXT_LIMITS.skills
          ) {
            activeWfData.push(wf);
          }
        } catch {
          // Malformed doc (invalid JSON or a non-object body) — surface as
          // `needsRepair` (the most basic parse-dimension diagnostic) rather than
          // silently dropping, so a corrupt skill stays visible to the
          // operator/Coach. The slug is recoverable from the path even when the
          // body won't parse; route the raw content through `ensureWorkflowDocValidity`
          // so the diagnostic shape matches every other surface. The `seenSlugs`
          // guard means a doc that parsed (and was already routed) before a later
          // throw is never double-surfaced here.
          const slug = row.path.split('/')[2]; // /workflows/{slug}/workflow.json
          if (slug && !seenSlugs.has(slug) && needsRepair.length < NEEDS_REPAIR_SURFACE_LIMIT) {
            seenSlugs.add(slug);
            needsRepair.push({
              slug,
              name: slug,
              diagnostics: ensureWorkflowDocValidity(row.inlineContent).diagnostics.slice(
                0,
                NEEDS_REPAIR_DIAGNOSTIC_CAP,
              ),
            });
          }
        }
      }

      if (activeWfData.length > 0) {
        const ledgerPaths = activeWfData.map((wf) => `/workflows/${wf.slug}/ledger.json`);
        const ledgerRows = await withTenantSchema(db, tenantContext, async (tx) =>
          Promise.all(
            ledgerPaths.map((path) =>
              tx
                .select({ inlineContent: memoryDocs.inlineContent })
                .from(memoryDocs)
                .where(and(eq(memoryDocs.path, path), isNull(memoryDocs.deletedAt)))
                .limit(1)
                .then((rows) => rows[0]?.inlineContent ?? null),
            ),
          ),
        );

        for (let i = 0; i < activeWfData.length; i++) {
          const wf = activeWfData[i]!;
          // `activeWfData` holds only `canRun` skills (the split above routed
          // contract-invalid ones to `needsRepair` and valid-but-unbound ones to
          // `needsSetup`), so this loop just builds the `active` entries with
          // progress/ledger detail.
          const ledgerJson = ledgerRows[i];
          let progress: string;
          let bestResult: string | undefined;

          if (wf.status === 'draft') {
            progress = 'draft — not yet approved';
          } else if (!ledgerJson) {
            progress = 'approved — no runs yet';
          } else {
            try {
              const ledger = JSON.parse(ledgerJson) as LedgerData;
              const totalRuns = ledger.entries.length;
              const runningCount = ledger.entries.filter((e) => e.status === 'running').length;
              const maxRuns = wf.budget?.maxRuns;

              if (runningCount > 0) {
                progress = `running — iteration ${String(totalRuns)}${maxRuns ? ` of ${String(maxRuns)}` : ''}`;
              } else {
                progress = `${String(totalRuns)} run${totalRuns !== 1 ? 's' : ''} completed${maxRuns ? ` (max ${String(maxRuns)})` : ''}`;
              }

              for (const entry of ledger.entries) {
                if (entry.evaluation?.outcomeResults) {
                  for (const result of entry.evaluation.outcomeResults) {
                    if (typeof result.value === 'number') {
                      if (!bestResult || result.value > parseFloat(bestResult)) {
                        bestResult = String(result.value);
                      }
                    }
                  }
                }
              }
            } catch {
              progress = 'approved';
            }
          }

          let firstTaskInputContract: Record<string, unknown> | null = null;
          if (Array.isArray(wf.tasks)) {
            try {
              firstTaskInputContract = deriveFirstTaskInputContract({
                slug: wf.slug,
                tasks: wf.tasks as never,
                runInputs: (wf as { runInputs?: unknown }).runInputs as never,
              });
            } catch {
              firstTaskInputContract = null;
            }
          }
          activeSkills.push({
            slug: wf.slug,
            name: wf.name,
            ...(wf.description ? { description: wf.description } : {}),
            mode: wf.mode,
            status: wf.status as SkillStatus,
            progress,
            ...(bestResult ? { bestResult } : {}),
            origin: 'space',
            ...(firstTaskInputContract !== null ? { firstTaskInputContract } : {}),
          });
        }
      }
    }

    const skillsSection = composeSkillsSection(activeSkills, needsRepair, needsSetup);
    if (skillsSection) {
      context.skills = skillsSection;
    }

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
    return JSON.parse(runState.spaceContextJson) as SpaceContext;
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
