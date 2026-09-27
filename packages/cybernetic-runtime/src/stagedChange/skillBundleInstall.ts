import type { Redis } from 'ioredis';
import type { PostInstallTask, SkillBundle } from '@aflow/schemas';
import { getSkillBundleEntry, getSkillCatalogEntry } from '@aflow/platform-artifacts';
import { createMemoryDocRepository, createTenantContext, withTenantSchema } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { publishApiCatalogInvalidation, publishMcpCatalogInvalidation } from '@aflow/redis';
import type { ApplyContext } from './applyRatifiedOps.js';
import { applySkillComposeBundle } from './skillComposeApply.js';
import { rebuildSkillProjection } from '../skillProjectionReconciler.js';
import {
  applyApiBindingTemplates,
  applyApiDefinitions,
  applyMcpBindingTemplates,
  applyMcpDefinitions,
  applyMemorySeeds,
  publishMemorySeedEmbedJobs,
} from './bundleInstallContent.js';
import { applyArtifactSeeds } from './applyArtifactSeeds.js';
import { generatePostInstallManifest } from './bundleInstallManifest.js';
import { validateBundleInstallPreconditions } from './bundleInstallValidator.js';
import { tryAcquireStoreMutationLock } from './storeMutationLock.js';

// ============================================================================
// Paths (local helpers — must mirror skillComposeApply.ts + skill.ts so the
// completeness check sees exactly the same docs the install path writes).
// ============================================================================

function workflowDocPath(slug: string): string {
  return `/workflows/${slug}/workflow.json`;
}

function manifestDocPath(skillId: string): string {
  return `/skills/${skillId}/manifest.json`;
}

function evalSuiteDocPath(slug: string): string {
  return `/evals/${slug}/suite.json`;
}

function activationDocPath(slug: string): string {
  return `/workflows/${slug}/activation.json`;
}

function projectionDocPath(skillId: string): string {
  return `/skills/${skillId}/projection.json`;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Hint returned to the caller when the bundle declares a setup skill and
 * at least one skill changed state during install. `installSkillBundle`
 * does NOT fire the setup workflow itself (see module docs) — the caller
 * fires it via `workflow.run.start` after install returns.
 */
export interface SetupSkillIntent {
  /** Catalog id of the setup skill (matches `bundle.setupSkillCatalogId`). */
  skillCatalogId: string;
  /** Workflow slug to start. Derived from the catalog entry's bundle. */
  workflowSlug: string;
  /** Bundle that triggered the setup — for caller-side audit/metadata. */
  bundleId: string;
  /** Bundle version, same purpose. */
  bundleVersion: number;
}

export interface InstallSkillBundleResult {
  bundleId: string;
  /** Skill catalog ids freshly installed in this call. */
  installedSkillCatalogIds: string[];
  /**
   * Skill catalog ids that were already fully present and skipped (idempotent).
   * If every id is in this list and `installedSkillCatalogIds` is empty,
   * the bundle was already installed.
   */
  skippedSkillCatalogIds: string[];
  repairedProjectionSkillCatalogIds: string[];
  /** apiId values whose api_definitions row was freshly inserted. */
  installedApiDefinitionIds: string[];
  /** apiId values whose api_definitions row was already present (per conflictPolicy). */
  skippedApiDefinitionIds: string[];
  /** bindingId values whose api_bindings row was freshly inserted. */
  installedBindingIds: string[];
  /** bindingId values whose api_bindings row was already present (per conflictPolicy). */
  skippedBindingIds: string[];
  /** serverId values whose mcp_server_definitions row was freshly inserted. */
  installedMcpDefinitionIds: string[];
  /** serverId values whose mcp_server_definitions row was already present. */
  skippedMcpDefinitionIds: string[];
  /** bindingId values whose mcp_server_bindings row was freshly inserted. */
  installedMcpBindingIds: string[];
  /** bindingId values whose mcp_server_bindings row was already present. */
  skippedMcpBindingIds: string[];
  /** memorySeed paths whose memory doc was freshly written. */
  installedMemoryDocPaths: string[];
  /** memorySeed paths whose memory doc was already present (per seedPolicy). */
  skippedMemoryDocPaths: string[];
  installedArtifactBindings: string[];
  skippedArtifactBindings: string[];
  /**
   * Typed completion checklist derived from CURRENT state:
   * `fill_credentials` per binding with unfilled slots. Manifest is
   * regenerated on every call (idempotent re-call shrinks it as the
   * operator fills credentials).
   */
  postInstallManifest: PostInstallTask[];
  /**
   * Free-text "next steps" guidance the bundle author declared. Passed
   * through verbatim. Surfaced by the Skill Shop UI; readable by Helmsman.
   */
  helmsmanHints: string[];
  warnings: string[];
  /**
   * `true` when at least one skill was newly installed, its projection
   * was repaired, any apiDefinitions / bindings / memorySeeds were
   * actually written this call (i.e. not all skipped). `false` when the
   * call was a pure no-op. UI uses this to distinguish fresh install from
   * idempotent retry.
   */
  stateChanged: boolean;
  setupSkillIntent?: SetupSkillIntent;
}

/**
 * Thrown when a skill referenced by the bundle is in a partial-install
 * state — some required artifacts exist but not all. v1 surfaces this
 * as a hard error; the operator must resolve manually before re-running.
 */
export class BundlePartiallyInstalledError extends Error {
  readonly code = 'BUNDLE_PARTIALLY_INSTALLED' as const;
  constructor(
    public readonly bundleId: string,
    public readonly skillCatalogId: string,
    public readonly presentArtifacts: readonly string[],
    public readonly missingArtifacts: readonly string[],
  ) {
    super(
      `Bundle "${bundleId}" cannot complete install: skill "${skillCatalogId}" is in a partial-install state ` +
        `(present: ${presentArtifacts.join(', ') || 'none'}; missing: ${missingArtifacts.join(', ')}). ` +
        `Resolve manually before re-running install.`,
    );
    this.name = 'BundlePartiallyInstalledError';
  }
}

export class BundleInstallInProgressError extends Error {
  readonly code = 'BUNDLE_INSTALL_IN_PROGRESS' as const;
  constructor(
    public readonly bundleId: string,
    public readonly spaceId: string,
  ) {
    super(
      `Bundle install for space "${spaceId}" is already in progress (bundle "${bundleId}"). ` +
        `Retry after the prior install completes.`,
    );
    this.name = 'BundleInstallInProgressError';
  }
}

export class BundleInstallValidationError extends Error {
  readonly code = 'BUNDLE_INSTALL_VALIDATION_FAILED' as const;
  constructor(
    public readonly bundleId: string,
    public readonly spaceId: string,
    public readonly errors: readonly string[],
  ) {
    super(
      `Bundle "${bundleId}" cannot install in space "${spaceId}": ${errors.length} validation error(s). ` +
        errors.map((e, i) => `(${i + 1}) ${e}`).join(' '),
    );
    this.name = 'BundleInstallValidationError';
  }
}

// ============================================================================
// Install
// ============================================================================

export async function installSkillBundle(
  ctx: ApplyContext,
  bundle: SkillBundle,
  opts?: { redis?: Redis },
): Promise<InstallSkillBundleResult> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  const txOutcome = await withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    // Acquire the space-scoped store-mutation advisory lock as the FIRST
    // statement in the tx. Non-blocking; released on commit/rollback.
    const acquired = await tryAcquireStoreMutationLock(tx, ctx.spaceId);
    if (!acquired) {
      throw new BundleInstallInProgressError(bundle.bundleId, ctx.spaceId);
    }

    // tx-scoped context: the apply path's internal repo creations now
    const txCtx: ApplyContext = {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      db: tx,
      inTransaction: true,
    };
    const txRepo = createMemoryDocRepository(tx, tenantCtx, { inTransaction: true });

    const validation = await validateBundleInstallPreconditions({
      bundle,
      spaceId: ctx.spaceId,
      tx,
      resolveBundle: (id) => getSkillBundleEntry(id) ?? null,
      checkSkillInstalled: async (catalogId) => {
        const entry = getSkillCatalogEntry(catalogId);
        if (!entry) return false;
        return (await checkSkillInstallState(txCtx, txRepo, entry)) === 'complete';
      },
    });
    if (!validation.ok) {
      throw new BundleInstallValidationError(bundle.bundleId, ctx.spaceId, validation.errors);
    }

    // Skill loop first — keeps the existing semantics + error contracts.
    const loopResult = await runInstallLoop(txCtx, txRepo, bundle);

    const apiDefResult = await applyApiDefinitions({
      apiDefinitions: bundle.apiDefinitions ?? [],
      spaceId: ctx.spaceId,
      tx,
    });
    const bindingResult = await applyApiBindingTemplates({
      apiBindingTemplates: bundle.apiBindingTemplates ?? [],
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      tx,
    });
    const mcpDefResult = await applyMcpDefinitions({
      mcpDefinitions: bundle.mcpDefinitions ?? [],
      spaceId: ctx.spaceId,
      tx,
    });
    const mcpBindingResult = await applyMcpBindingTemplates({
      mcpBindingTemplates: bundle.mcpBindingTemplates ?? [],
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      tx,
    });
    const memorySeedResult = await applyMemorySeeds({
      memorySeed: bundle.memorySeed ?? [],
      spaceId: ctx.spaceId,
      tenantId: ctx.tenantId as TenantId,
      repo: txRepo,
    });
    const artifactSeedResult = await applyArtifactSeeds({
      bundle: { bundleId: bundle.bundleId, artifactSeed: bundle.artifactSeed ?? [] },
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      tx,
      payloadStore: ctx.payloadStore,
    });

    const postInstallManifest = await generatePostInstallManifest({
      bundle,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      tx,
      repo: txRepo,
    });

    return {
      loopResult,
      apiDefResult,
      bindingResult,
      mcpDefResult,
      mcpBindingResult,
      memorySeedResult,
      artifactSeedResult,
      postInstallManifest,
    };
  });

  // ---- Post-commit side effects -----------------------------------------
  // Cache invalidation publishes after the tx commits so consumers can't
  // observe a stale "you have a new binding" while our writes are still
  // un-committed. publishApiCatalogInvalidation is best-effort.
  if (opts?.redis) {
    publishBundleInstallInvalidations(opts.redis, ctx.tenantId, ctx.spaceId, bundle, {
      installedApiDefinitionIds: txOutcome.apiDefResult.installedApiDefinitionIds,
      skippedApiDefinitionIds: txOutcome.apiDefResult.skippedApiDefinitionIds,
      installedBindingIds: txOutcome.bindingResult.installedBindingIds,
      skippedBindingIds: txOutcome.bindingResult.skippedBindingIds,
      installedMcpDefinitionIds: txOutcome.mcpDefResult.installedMcpDefinitionIds,
      installedMcpBindingIds: txOutcome.mcpBindingResult.installedMcpBindingIds,
    });
    await publishMemorySeedEmbedJobs(opts.redis, txOutcome.memorySeedResult.pendingEmbedJobs);
  }

  // Compute setup intent (post-commit decision).
  //
  const stateChanged =
    txOutcome.loopResult.installedSkillCatalogIds.length > 0 ||
    txOutcome.loopResult.repairedProjectionSkillCatalogIds.length > 0 ||
    txOutcome.apiDefResult.installedApiDefinitionIds.length > 0 ||
    txOutcome.bindingResult.installedBindingIds.length > 0 ||
    txOutcome.mcpDefResult.installedMcpDefinitionIds.length > 0 ||
    txOutcome.mcpBindingResult.installedMcpBindingIds.length > 0 ||
    txOutcome.memorySeedResult.installedMemoryDocPaths.length > 0 ||
    txOutcome.artifactSeedResult.installedArtifactBindings.length > 0;

  // A skill counts as "present" if it was just installed, was already
  // installed (skipped), or was self-healed (repaired). These three
  // buckets are exhaustive for a successful install — any other state
  // would have thrown.
  const everySkillPresent =
    txOutcome.loopResult.installedSkillCatalogIds.length +
      txOutcome.loopResult.skippedSkillCatalogIds.length +
      txOutcome.loopResult.repairedProjectionSkillCatalogIds.length ===
    bundle.skillCatalogIds.length;

  let setupSkillIntent: SetupSkillIntent | undefined;
  if (everySkillPresent && bundle.setupSkillCatalogId !== undefined) {
    const setupEntry = getSkillCatalogEntry(bundle.setupSkillCatalogId);
    if (!setupEntry) {
      // Catalog integrity check should have caught this at module load.
      throw new Error(
        `Bundle "${bundle.bundleId}" setupSkillCatalogId "${bundle.setupSkillCatalogId}" not found in catalog`,
      );
    }
    setupSkillIntent = {
      skillCatalogId: bundle.setupSkillCatalogId,
      workflowSlug: setupEntry.bundle.workflow.slug,
      bundleId: bundle.bundleId,
      bundleVersion: bundle.version,
    };
  }

  return {
    bundleId: bundle.bundleId,
    installedSkillCatalogIds: txOutcome.loopResult.installedSkillCatalogIds,
    skippedSkillCatalogIds: txOutcome.loopResult.skippedSkillCatalogIds,
    repairedProjectionSkillCatalogIds: txOutcome.loopResult.repairedProjectionSkillCatalogIds,
    installedApiDefinitionIds: txOutcome.apiDefResult.installedApiDefinitionIds,
    skippedApiDefinitionIds: txOutcome.apiDefResult.skippedApiDefinitionIds,
    installedBindingIds: txOutcome.bindingResult.installedBindingIds,
    skippedBindingIds: txOutcome.bindingResult.skippedBindingIds,
    installedMcpDefinitionIds: txOutcome.mcpDefResult.installedMcpDefinitionIds,
    skippedMcpDefinitionIds: txOutcome.mcpDefResult.skippedMcpDefinitionIds,
    installedMcpBindingIds: txOutcome.mcpBindingResult.installedMcpBindingIds,
    skippedMcpBindingIds: txOutcome.mcpBindingResult.skippedMcpBindingIds,
    installedMemoryDocPaths: txOutcome.memorySeedResult.installedMemoryDocPaths,
    skippedMemoryDocPaths: txOutcome.memorySeedResult.skippedMemoryDocPaths,
    installedArtifactBindings: txOutcome.artifactSeedResult.installedArtifactBindings,
    skippedArtifactBindings: txOutcome.artifactSeedResult.skippedArtifactBindings,
    postInstallManifest: txOutcome.postInstallManifest,
    helmsmanHints: [...(bundle.helmsmanHints ?? [])],
    warnings: [...txOutcome.loopResult.warnings, ...txOutcome.memorySeedResult.warnings],
    stateChanged,
    ...(setupSkillIntent ? { setupSkillIntent } : {}),
  };
}

/**
 * Catalog-cache invalidations for the api/mcp artifacts a bundle install
 * wrote. Must fire only after the writing transaction commits — a caller that
 * wraps the install in an outer transaction passes no redis to
 * `installSkillBundle` and calls this itself post-commit.
 */
export function publishBundleInstallInvalidations(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  bundle: SkillBundle,
  result: Pick<
    InstallSkillBundleResult,
    | 'installedApiDefinitionIds'
    | 'skippedApiDefinitionIds'
    | 'installedBindingIds'
    | 'skippedBindingIds'
    | 'installedMcpDefinitionIds'
    | 'installedMcpBindingIds'
  >,
): void {
  if (result.installedApiDefinitionIds.length > 0 || result.skippedApiDefinitionIds.length > 0) {
    publishApiCatalogInvalidation(redis, tenantId, spaceId, { kind: 'definition' });
  }
  if (result.installedBindingIds.length > 0 || result.skippedBindingIds.length > 0) {
    publishApiCatalogInvalidation(redis, tenantId, spaceId, { kind: 'binding' });
  }
  // MCP invalidation — fire once per artifact kind we touched, so the
  // executor's per-(tenant, space) cache drops fresh entries on the next call.
  for (const serverId of result.installedMcpDefinitionIds) {
    publishMcpCatalogInvalidation(redis, tenantId, spaceId, { kind: 'definition', serverId });
  }
  for (const bindingId of result.installedMcpBindingIds) {
    const tpl = bundle.mcpBindingTemplates?.find((t) => t.bindingId === bindingId);
    if (tpl) {
      publishMcpCatalogInvalidation(redis, tenantId, spaceId, {
        kind: 'binding',
        serverId: tpl.serverId,
        bindingId,
      });
    }
  }
}

// ============================================================================
// Install loop (tx-scoped)
// ============================================================================

interface InstallLoopResult {
  installedSkillCatalogIds: string[];
  skippedSkillCatalogIds: string[];
  repairedProjectionSkillCatalogIds: string[];
  warnings: string[];
}

async function runInstallLoop(
  txCtx: ApplyContext,
  repo: ReturnType<typeof createMemoryDocRepository>,
  bundle: SkillBundle,
): Promise<InstallLoopResult> {
  const installedSkillCatalogIds: string[] = [];
  const skippedSkillCatalogIds: string[] = [];
  const repairedProjectionSkillCatalogIds: string[] = [];
  const warnings = await collectPrerequisiteWarnings(bundle, txCtx, repo);

  for (const skillCatalogId of bundle.skillCatalogIds) {
    const entry = getSkillCatalogEntry(skillCatalogId);
    if (!entry) {
      throw new Error(
        `Bundle "${bundle.bundleId}" references unknown skill catalog id: ${skillCatalogId}`,
      );
    }

    const installState = await checkSkillInstallState(txCtx, repo, entry);
    if (installState === 'complete') {
      skippedSkillCatalogIds.push(skillCatalogId);
      continue;
    }
    if (installState === 'projection-missing') {
      await rebuildSkillProjection(txCtx, entry.bundle.workflow.slug);
      repairedProjectionSkillCatalogIds.push(skillCatalogId);
      continue;
    }
    if (installState === 'partial') {
      const detail = await diagnosePartialState(repo, entry, txCtx.spaceId);
      throw new BundlePartiallyInstalledError(
        bundle.bundleId,
        skillCatalogId,
        detail.present,
        detail.missing,
      );
    }

    const now = new Date().toISOString();
    await applySkillComposeBundle(txCtx, entry.bundle, {
      origin: 'cloned',
      provenance: {
        sourceCatalogId: entry.catalogId,
        sourceVersion: entry.version,
        installedAt: now,
      },
    });
    await rebuildSkillProjection(txCtx, entry.bundle.workflow.slug);
    installedSkillCatalogIds.push(skillCatalogId);
  }

  return {
    installedSkillCatalogIds,
    skippedSkillCatalogIds,
    repairedProjectionSkillCatalogIds,
    warnings,
  };
}

// ============================================================================
// Skill-install state detection
// ============================================================================

type SkillInstallState = 'complete' | 'projection-missing' | 'partial' | 'absent';

async function checkSkillInstallState(
  ctx: ApplyContext,
  repo: ReturnType<typeof createMemoryDocRepository>,
  entry: ReturnType<typeof getSkillCatalogEntry> & {},
): Promise<SkillInstallState> {
  const required = expectedArtifactPaths(entry);

  const presence = await Promise.all(
    required.core.map(async (slot) => ({
      slot,
      doc: await repo.getByPath(slot.path, ctx.spaceId),
    })),
  );
  const coreCount = presence.filter((p) => p.doc !== null).length;

  if (coreCount === 0) return 'absent';
  if (coreCount !== required.core.length) return 'partial';

  // All required core artifacts present — projection determines complete vs heal.
  const projDoc = await repo.getByPath(required.projection.path, ctx.spaceId);
  return projDoc ? 'complete' : 'projection-missing';
}

interface ArtifactSlot {
  name: string;
  path: string;
}

interface ExpectedArtifacts {
  /** Required core artifacts — must ALL be present for the skill to be considered installed. */
  core: ArtifactSlot[];
  /** Projection artifact — separate because absence is repairable. */
  projection: ArtifactSlot;
}

/**
 * The artifact set `applySkillComposeBundle` writes for this catalog entry.
 * The eval-suite and activation slots are included only when the bundle
 * declares them (otherwise `applySkillComposeBundle` never writes those docs).
 */
function expectedArtifactPaths(
  entry: ReturnType<typeof getSkillCatalogEntry> & {},
): ExpectedArtifacts {
  const workflowSlug = entry.bundle.workflow.slug;
  const skillId = entry.bundle.manifest.skillId;
  const core: ArtifactSlot[] = [
    { name: 'workflow', path: workflowDocPath(workflowSlug) },
    { name: 'manifest', path: manifestDocPath(skillId) },
  ];
  if (entry.bundle.evalSuite) {
    core.push({ name: 'evalSuite', path: evalSuiteDocPath(workflowSlug) });
  }
  if (entry.bundle.activation) {
    core.push({ name: 'activation', path: activationDocPath(workflowSlug) });
  }
  return {
    core,
    projection: { name: 'projection', path: projectionDocPath(skillId) },
  };
}

async function diagnosePartialState(
  repo: ReturnType<typeof createMemoryDocRepository>,
  entry: ReturnType<typeof getSkillCatalogEntry> & {},
  spaceId: string,
): Promise<{ present: readonly string[]; missing: readonly string[] }> {
  const required = expectedArtifactPaths(entry);
  const present: string[] = [];
  const missing: string[] = [];
  for (const slot of required.core) {
    const doc = await repo.getByPath(slot.path, spaceId);
    (doc ? present : missing).push(slot.name);
  }
  return { present, missing };
}

// ============================================================================
// Prerequisite warning collection (UX-only)
// ============================================================================

async function collectPrerequisiteWarnings(
  bundle: SkillBundle,
  ctx: ApplyContext,
  repo: ReturnType<typeof createMemoryDocRepository>,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const prereqId of bundle.prerequisiteBundleIds) {
    const prereqBundle = getSkillBundleEntry(prereqId);
    if (!prereqBundle) {
      warnings.push(`Prerequisite bundle "${prereqId}" is not registered in the catalog.`);
      continue;
    }

    const missingSkills: string[] = [];
    for (const skillId of prereqBundle.skillCatalogIds) {
      const entry = getSkillCatalogEntry(skillId);
      if (!entry) {
        missingSkills.push(skillId);
        continue;
      }
      const state = await checkSkillInstallState(ctx, repo, entry);
      if (state !== 'complete') missingSkills.push(skillId);
    }

    if (missingSkills.length > 0) {
      warnings.push(
        `Prerequisite bundle "${prereqId}" expects these skills installed first: ${missingSkills.join(', ')}.`,
      );
    }
  }

  return warnings;
}
