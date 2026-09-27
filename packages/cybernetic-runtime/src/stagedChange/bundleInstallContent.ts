import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { MemoryDocRepository } from '@aflow/database';
import type {
  ApiBindingTemplate,
  BundledApiDefinition,
  BundledMcpServerDefinition,
  McpBindingTemplate,
  MemoryDocEmbedJob,
  MemorySeed,
  SkillBundle,
  TenantId,
} from '@aflow/schemas';
import {
  prepareDerivedIndexes,
  commitDerivedIndexes,
  isLinkableDocType,
} from '@aflow/memory-store';
import { publishMemoryDocEmbedJob } from '@aflow/redis';
import {
  buildPlaceholderAuthJsonFromSlots,
  writeApiDefinitionDraft,
  writePlaceholderBinding,
  type WriteOutcome,
} from './apiWriteHelpers.js';
import {
  buildPlaceholderMcpAuthJsonFromSlots,
  writeMcpServerDefinition,
  writePlaceholderMcpBinding,
} from './mcpWriteHelpers.js';

// ============================================================================
// Result accumulators
// ============================================================================

export interface ApiDefinitionsApplyResult {
  installedApiDefinitionIds: string[];
  skippedApiDefinitionIds: string[];
}

export interface ApiBindingTemplatesApplyResult {
  installedBindingIds: string[];
  skippedBindingIds: string[];
}

export interface MemorySeedsApplyResult {
  installedMemoryDocPaths: string[];
  skippedMemoryDocPaths: string[];
  /**
   * Embed jobs for linkable seeds whose chunks derived this call. The seed put
   * + its derived indexes commit with the CALLER's outer transaction, so these
   * MUST be published post-commit (the embed worker resolves the docId against
   * committed rows) — publishMemorySeedEmbedJobs after the tx returns.
   */
  pendingEmbedJobs: MemoryDocEmbedJob[];
}

export interface McpDefinitionsApplyResult {
  installedMcpDefinitionIds: string[];
  skippedMcpDefinitionIds: string[];
}

export interface McpBindingTemplatesApplyResult {
  installedMcpBindingIds: string[];
  skippedMcpBindingIds: string[];
}

// ============================================================================
// applyApiDefinitions
// ============================================================================

/**
 * Write each `bundle.apiDefinitions[]` entry. Conflict behavior is per-entry
 * (`conflictPolicy: 'skip' | 'overwrite' | 'fail'`). A `'skipped'` outcome
 * means the row was already present and left untouched — common on
 * idempotent reinstall.
 */
export async function applyApiDefinitions(opts: {
  apiDefinitions: readonly BundledApiDefinition[];
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<ApiDefinitionsApplyResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const entry of opts.apiDefinitions) {
    const outcome = await writeApiDefinitionDraft({
      apiId: entry.apiId,
      draft: entry.definition,
      spaceId: opts.spaceId,
      conflictPolicy: entry.conflictPolicy,
      tx: opts.tx,
    });
    bucketOutcome(outcome, entry.apiId, installed, skipped);
  }
  return { installedApiDefinitionIds: installed, skippedApiDefinitionIds: skipped };
}

// ============================================================================
// applyApiBindingTemplates
// ============================================================================

export async function applyApiBindingTemplates(opts: {
  apiBindingTemplates: readonly ApiBindingTemplate[];
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<ApiBindingTemplatesApplyResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const tpl of opts.apiBindingTemplates) {
    const authJson = buildPlaceholderAuthJsonFromSlots(tpl.authShape, tpl.credentialSlots);
    const outcome = await writePlaceholderBinding({
      bindingId: tpl.bindingId,
      apiId: tpl.apiId,
      spaceId: opts.spaceId,
      name: tpl.name,
      ...(tpl.description !== undefined ? { description: tpl.description } : {}),
      scope: { tenantId: opts.tenantId, spaceId: opts.spaceId },
      authJson,
      egressPolicy: tpl.egressPolicy,
      conflictPolicy: tpl.conflictPolicy,
      tx: opts.tx,
    });
    bucketOutcome(outcome, tpl.bindingId, installed, skipped);
  }
  return { installedBindingIds: installed, skippedBindingIds: skipped };
}

// ============================================================================
// applyMemorySeeds
// ============================================================================

export async function applyMemorySeeds(opts: {
  memorySeed: readonly MemorySeed[];
  spaceId: string;
  tenantId: TenantId;
  repo: MemoryDocRepository;
}): Promise<MemorySeedsApplyResult & { warnings: string[] }> {
  const installed: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const pendingEmbedJobs: MemoryDocEmbedJob[] = [];
  for (const seed of opts.memorySeed) {
    const existing = await opts.repo.getByPath(seed.path, opts.spaceId);
    if (existing !== null) {
      if (seed.seedPolicy === 'skip' || seed.seedPolicy === 'merge_frontmatter') {
        skipped.push(seed.path);
        if (seed.seedPolicy === 'merge_frontmatter') {
          warnings.push(
            `memorySeed '${seed.path}': seedPolicy='merge_frontmatter' is not yet implemented; treating as 'skip'.`,
          );
        }
        continue;
      }
      // 'overwrite' — fall through and put the new content unconditionally.
    }

    // LINKABLE seeds index like authored docs: chunks + outgoing links +
    // frontmatter properties derive and commit atomically with the put, so their
    // graph edges and searchable chunks exist from install (no backfill wait).
    // Structural/binary docType seeds carry no links and stay derivation-free.
    const linkable = isLinkableDocType(seed.docType);
    // Parse OUTSIDE the transaction (prepareDerivedIndexes is pure) so the put +
    // commit hold the lock for the write alone, not the parse.
    const prepared = linkable ? prepareDerivedIndexes(seed.content, seed.docType, seed.path) : null;

    const embedJob = await opts.repo.withTransaction(async (txRepo, txLinkRepo) => {
      const doc = await txRepo.put({
        path: seed.path,
        docType: seed.docType,
        mimeType: mimeTypeForDocType(seed.docType),
        inlineContent: seed.content,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(seed.content, 'utf8'),
        contentHash: sha256(seed.content),
        preview: seed.content.slice(0, 240),
        tags: [],
        summary: seed.description ?? null,
        scope: { spaceId: opts.spaceId },
        writeMode: 'upsert',
        indexing: linkable ? 'auto' : 'disabled',
      });
      if (!prepared) return null;
      const { embedJob: ej } = await commitDerivedIndexes(txRepo, txLinkRepo, doc, prepared, {
        tenantId: opts.tenantId,
      });
      return ej;
    });
    if (embedJob) pendingEmbedJobs.push(embedJob);

    installed.push(seed.path);
  }

  return {
    installedMemoryDocPaths: installed,
    skippedMemoryDocPaths: skipped,
    warnings,
    pendingEmbedJobs,
  };
}

/**
 * Publish the embed jobs that {@link applyMemorySeeds} accrued — call ONLY after
 * the writing transaction commits, so the embed worker resolves each docId
 * against committed rows. Best-effort per job (FTS remains; vectors backfill on
 * the next write if a publish is lost).
 */
export async function publishMemorySeedEmbedJobs(
  redis: Redis,
  jobs: readonly MemoryDocEmbedJob[],
): Promise<void> {
  for (const job of jobs) {
    // Best-effort per job: one failed publish must not block the rest (FTS
    // remains; a lost vector job is re-owed on the doc's next write).
    try {
      await publishMemoryDocEmbedJob(redis, job);
    } catch {
      /* swallow — see contract above */
    }
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function mimeTypeForDocType(docType: MemorySeed['docType']): string {
  // Exhaustiveness check — adding a new MemoryDocType in @aflow/schemas
  switch (docType) {
    case 'markdown':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'ndjson':
      return 'application/x-ndjson';
    case 'code':
    case 'text':
    case 'schema':
    case 'directory':
    case 'prompt':
    case 'report':
    case 'dataset':
    case 'objective':
    case 'plan':
    case 'ledger':
    case 'artifact':
      return 'text/plain';
    case 'html_app':
      return 'text/html';
    case 'image':
      return 'application/octet-stream';
    case 'audio':
      return 'application/octet-stream';
    case 'video':
      return 'application/octet-stream';
    default:
      return 'text/plain';
  }
}

// ============================================================================

/**
 * Write each `bundle.mcpDefinitions[]` entry. Source is stamped to
 * `'bundle'` regardless of the inner definition's `source` field.
 */
export async function applyMcpDefinitions(opts: {
  mcpDefinitions: readonly BundledMcpServerDefinition[];
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<McpDefinitionsApplyResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const entry of opts.mcpDefinitions) {
    const outcome = await writeMcpServerDefinition({
      serverId: entry.serverId,
      definition: entry.definition,
      source: 'bundle',
      spaceId: opts.spaceId,
      conflictPolicy: entry.conflictPolicy,
      tx: opts.tx,
    });
    bucketOutcome(outcome, entry.serverId, installed, skipped);
  }
  return { installedMcpDefinitionIds: installed, skippedMcpDefinitionIds: skipped };
}

// ============================================================================

/**
 * Write each `bundle.mcpBindingTemplates[]` entry as a placeholder MCP
 * binding (disabled, no pinned_origin). The operator fills credentials +
 * runs the Save & connect flow in the Integrations UI; the form's
 * auto-test pins origin and enables on success.
 */
export async function applyMcpBindingTemplates(opts: {
  mcpBindingTemplates: readonly McpBindingTemplate[];
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<McpBindingTemplatesApplyResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const tpl of opts.mcpBindingTemplates) {
    const authJson = buildPlaceholderMcpAuthJsonFromSlots(tpl.authShape, tpl.credentialSlots);
    const outcome = await writePlaceholderMcpBinding({
      bindingId: tpl.bindingId,
      serverId: tpl.serverId,
      spaceId: opts.spaceId,
      name: tpl.name,
      ...(tpl.description !== undefined ? { description: tpl.description } : {}),
      scope: { tenantId: opts.tenantId, spaceId: opts.spaceId },
      authJson,
      subscribeListChanged: tpl.subscribeListChanged,
      samplingPolicy: tpl.samplingPolicy,
      conflictPolicy: tpl.conflictPolicy,
      tx: opts.tx,
    });
    bucketOutcome(outcome, tpl.bindingId, installed, skipped);
  }
  return { installedMcpBindingIds: installed, skippedMcpBindingIds: skipped };
}

// ============================================================================
// Shared
// ============================================================================

function bucketOutcome(
  outcome: WriteOutcome,
  id: string,
  installed: string[],
  skipped: string[],
): void {
  if (outcome.status === 'skipped') {
    skipped.push(id);
  } else {
    installed.push(id);
  }
}

// ============================================================================
// Convenience: did anything actually write?
// ============================================================================

/** True iff at least one row was inserted/updated (vs. all skipped). */
export function anyContentChanged(
  apiDefs: ApiDefinitionsApplyResult,
  bindings: ApiBindingTemplatesApplyResult,
  seeds: MemorySeedsApplyResult,
  mcpDefs: McpDefinitionsApplyResult = {
    installedMcpDefinitionIds: [],
    skippedMcpDefinitionIds: [],
  },
  mcpBindings: McpBindingTemplatesApplyResult = {
    installedMcpBindingIds: [],
    skippedMcpBindingIds: [],
  },
): boolean {
  return (
    apiDefs.installedApiDefinitionIds.length > 0 ||
    bindings.installedBindingIds.length > 0 ||
    seeds.installedMemoryDocPaths.length > 0 ||
    mcpDefs.installedMcpDefinitionIds.length > 0 ||
    mcpBindings.installedMcpBindingIds.length > 0
  );
}

// Re-export for the install op's local typing convenience.
export type { SkillBundle };
