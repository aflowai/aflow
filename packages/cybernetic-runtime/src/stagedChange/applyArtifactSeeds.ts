import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  assertAppletDefinitionSchemasSafe,
  checkAppletConformance,
  computeAppletDefinitionHash,
} from '@aflow/applet-runtime';
import { uiArtifacts, uiArtifactVersions } from '@aflow/database';
import {
  encodeInlinePayloadRef,
  storeArtifactSource,
  type PayloadStore,
} from '@aflow/payload-store';
import {
  MAX_INLINE_PAYLOAD_BYTES,
  artifactTagsForBundleSkill,
  type BundleArtifactSeed,
  type SkillBundle,
  type TenantId,
} from '@aflow/schemas';
import { invalidateArtifactBindingCache } from '../artifactBindingResolver.js';

// ============================================================================
// Result accumulator
// ============================================================================

export type ArtifactSeedOutcome = 'inserted_new' | 'inserted_new_version' | 'skipped_unchanged';

export interface ArtifactSeedInstallEntry {
  bindingId: string;
  bundleArtifactKey: string;
  artifactId: string;
  version: number;
  contentHash: string;
  outcome: ArtifactSeedOutcome;
}

export interface ArtifactSeedsApplyResult {
  /** One entry per processed seed, in input order. */
  entries: ArtifactSeedInstallEntry[];
  /** Convenience accumulator for the install op's response shape. */
  installedArtifactBindings: string[];
  /** Bindings whose backing artifact existed unchanged. */
  skippedArtifactBindings: string[];
}

// ============================================================================
// applyArtifactSeeds
// ============================================================================

/**
 * Inline-encode raw text as a PayloadRef the executor's `loadBlob` (and
 * thus `PayloadStore.retrieve → parseInlineRef`) can read back as the
 * original string. Mirrors the shape `parseInlineRef` expects:
 * `inline:<base64(JSON.stringify(value))>` where the value is the raw
 * source string. `JSON.parse(JSON.stringify('foo')) === 'foo'`, so the
 * round-trip is lossless and the render path's existing inline branch
 * needs no changes.
 */
function inlineRefForString(text: string): string {
  return encodeInlinePayloadRef(text);
}

/**
 * Where a seed's source lands: inline under the payload cap, content-addressed
 * and persisted above it. The measure is the encoder's own — JSON-encoded
 * bytes — so this decision and the encoder's refusal can never disagree. A
 * large source with no store to take it fails here, by name, rather than as
 * an unhandled encoder throw mid-transaction.
 */
async function sourceRefForSeed(opts: {
  seed: BundleArtifactSeed;
  tenantId: string;
  payloadStore?: PayloadStore | undefined;
}): Promise<string> {
  const encodedBytes = Buffer.byteLength(JSON.stringify(opts.seed.source), 'utf8');
  if (encodedBytes <= MAX_INLINE_PAYLOAD_BYTES) return inlineRefForString(opts.seed.source);
  if (!opts.payloadStore) {
    throw new Error(
      `Artifact seed '${opts.seed.bindingId}' carries ${String(encodedBytes)} bytes of source, ` +
        'over the inline cap, and no payload store was provided to persist it.',
    );
  }
  return storeArtifactSource(opts.payloadStore, opts.tenantId as TenantId, opts.seed.source);
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Render-contract hash. The "what this artifact is" identity covers more
 * than the raw source: dataSchema gates what data the runtime can pass,
 * sampleData drives §4.11 visual QA + Inspector fallback rendering,
 * catalogPin determines which DS catalog the compile binds to, and kind
 * dictates the substrate. Changing any of these makes the artifact
 * effectively a new version even if the TSX text is byte-identical.
 *
 * Excluded: bundle-author-supplied `tags` (operators can re-tag freely
 * without churning the install) and `name` / `description` (cosmetic
 * metadata, refreshed via head-row UPDATE without bumping the version).
 */
export function renderContractHash(seed: BundleArtifactSeed): string {
  return sha256(stableStringify(renderContractContent(seed)));
}

/**
 * The exact object {@link renderContractHash} covers — also the Mine-vs-Store
 * diff payload for applet listings, so the diff and the hash can never
 * disagree about what "the contract" is.
 */
export function renderContractContent(
  seed: Pick<
    BundleArtifactSeed,
    'source' | 'kind' | 'dataSchema' | 'sampleData' | 'catalogPin' | 'appletDefinition'
  >,
): Record<string, unknown> {
  return {
    source: seed.source,
    kind: seed.kind,
    dataSchema: seed.dataSchema,
    sampleData: seed.sampleData,
    catalogPin: seed.catalogPin,
    // Conditional so pre-applet seeds keep their recorded hashes stable.
    ...(seed.appletDefinition !== undefined ? { appletDefinition: seed.appletDefinition } : {}),
  };
}

/**
 * Sort object keys recursively so the JSON output is independent of
 * declaration order. Required for stable hashing — a JS object literal's
 * key order is preserved by JSON.stringify but bundle authors can rewrite
 * the same field set with keys reordered, and the hash would otherwise
 * flip every commit.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export async function applyArtifactSeeds(opts: {
  bundle: Pick<SkillBundle, 'bundleId' | 'artifactSeed'>;
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
  payloadStore?: PayloadStore | undefined;
}): Promise<ArtifactSeedsApplyResult> {
  const seeds = opts.bundle.artifactSeed;
  const entries: ArtifactSeedInstallEntry[] = [];
  const installedArtifactBindings: string[] = [];
  const skippedArtifactBindings: string[] = [];

  for (const seed of seeds) {
    const entry = await applyOneSeed({
      seed,
      bundleId: opts.bundle.bundleId,
      tenantId: opts.tenantId,
      spaceId: opts.spaceId,
      tx: opts.tx,
      payloadStore: opts.payloadStore,
    });
    entries.push(entry);
    if (entry.outcome === 'skipped_unchanged') {
      skippedArtifactBindings.push(entry.bindingId);
    } else {
      installedArtifactBindings.push(entry.bindingId);
    }
  }

  return { entries, installedArtifactBindings, skippedArtifactBindings };
}

async function applyOneSeed(opts: {
  seed: BundleArtifactSeed;
  bundleId: string;
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
  payloadStore?: PayloadStore | undefined;
}): Promise<ArtifactSeedInstallEntry> {
  const { seed, bundleId, tenantId, spaceId, tx } = opts;
  // A seed's definition installs a live agent+human surface, so it meets the
  // same bar as a generated one: schema-safety bounds on every JSON Schema
  // and call-site/replay conformance of the view against the declared
  // actions. Late discovery at first act would be a per-act runtime failure
  // in an installed space.
  if (seed.appletDefinition !== undefined) {
    assertAppletDefinitionSchemasSafe(seed.appletDefinition);
    const conformance = checkAppletConformance({
      source: seed.source,
      definition: seed.appletDefinition,
    });
    if (!conformance.ok) {
      const detail = conformance.errors.map((e) => e.message).join('; ');
      throw new Error(`applet seed '${seed.bindingId}' failed conformance: ${detail}`);
    }
  }
  const contentHash = renderContractHash(seed);

  // Tags — bundle and binding always; skill slugs deferred (see header).
  const tags = artifactTagsForBundleSkill({
    bundleId,
    bindingId: seed.bindingId,
    extras: seed.tags,
  });

  // ── Step 1: find or create the artifact head row ───────────────────────
  // Filter `deletedAt IS NULL` so a previously soft-deleted artifact
  // doesn't get resurrected on reinstall — the partial unique index
  // `uq_ui_artifacts_bundle_key` allows multiple soft-deleted rows
  // alongside one live row, and the render path enforces
  // `deleted_at IS NULL`. Without this filter, a reinstall could
  // rebind to a dead row, leaving the runtime stuck on "artifact not
  // found." Phase 3 review fix.
  const existing = await tx
    .select()
    .from(uiArtifacts)
    .where(
      and(
        eq(uiArtifacts.spaceId, spaceId),
        eq(uiArtifacts.bundleArtifactKey, seed.bundleArtifactKey),
        isNull(uiArtifacts.deletedAt),
      ),
    )
    .limit(1);

  const existingArtifact = existing[0];
  let artifactId: string;
  let nextVersion: number;
  let parentVersionId: string | null = null;
  let outcome: ArtifactSeedOutcome;

  if (existingArtifact) {
    artifactId = existingArtifact.id;
    // Check if the current version's contract hash matches — short-circuit
    // when reinstalling the same seed.
    const currentVersionRows = await tx
      .select()
      .from(uiArtifactVersions)
      .where(
        and(
          eq(uiArtifactVersions.artifactId, artifactId),
          eq(uiArtifactVersions.version, existingArtifact.currentVersion),
        ),
      )
      .limit(1);
    const currentVersion = currentVersionRows[0];

    if (currentVersion?.contentHash === contentHash) {
      // Skipped path: still converge the binding row + head-row cosmetic
      // metadata. Bundle authors can rename / re-tag without bumping the
      // version, and operators editing a stale binding should self-heal
      // on the next install.
      await refreshHeadCosmetics({ tx, artifactId, seed, tags });
      await upsertArtifactBinding({
        tx,
        spaceId,
        bundleId,
        bindingId: seed.bindingId,
        artifactId,
        bundleArtifactKey: seed.bundleArtifactKey,
        installedContentHash: contentHash,
      });
      invalidateArtifactBindingCache({
        tenantId,
        spaceId,
        bundleId,
        bindingId: seed.bindingId,
      });
      return {
        bindingId: seed.bindingId,
        bundleArtifactKey: seed.bundleArtifactKey,
        artifactId,
        version: existingArtifact.currentVersion,
        contentHash,
        outcome: 'skipped_unchanged',
      };
    }

    // Content changed — new version with parent lineage.
    nextVersion = existingArtifact.currentVersion + 1;
    parentVersionId = currentVersion?.id ?? null;
    await tx
      .update(uiArtifacts)
      .set({
        name: seed.name,
        description: seed.description ?? null,
        kind: seed.kind,
        currentVersion: nextVersion,
        catalogId: seed.catalogPin.catalogId,
        catalogVersion: seed.catalogPin.catalogVersion,
        catalogHash: seed.catalogPin.catalogHash,
        tags,
        updatedAt: new Date(),
      })
      .where(eq(uiArtifacts.id, artifactId));
    outcome = 'inserted_new_version';
  } else {
    // First install of this `(spaceId, bundleArtifactKey)`.
    const inserted = await tx
      .insert(uiArtifacts)
      .values({
        name: seed.name,
        description: seed.description ?? null,
        kind: seed.kind,
        spaceId,
        currentVersion: 1,
        catalogId: seed.catalogPin.catalogId,
        catalogVersion: seed.catalogPin.catalogVersion,
        catalogHash: seed.catalogPin.catalogHash,
        tags,
        bundleArtifactKey: seed.bundleArtifactKey,
      })
      .returning({ id: uiArtifacts.id });
    artifactId = inserted[0]!.id;
    nextVersion = 1;
    outcome = 'inserted_new';
  }

  // ── Step 2: insert the version row ─────────────────────────────────────
  // Sample data inline up to ~64 KB; larger samples would go through
  const sampleDataEncodedSize = Buffer.byteLength(JSON.stringify(seed.sampleData), 'utf8');
  if (sampleDataEncodedSize > 64 * 1024) {
    throw new Error(
      `BundleArtifactSeed sampleData exceeds 64 KB inline cap for bindingId=${seed.bindingId} ` +
        `(actual=${sampleDataEncodedSize}). PayloadRef overflow is not wired in Phase 1.`,
    );
  }

  await tx.insert(uiArtifactVersions).values({
    artifactId,
    version: nextVersion,
    sourceRef: await sourceRefForSeed({ seed, tenantId, payloadStore: opts.payloadStore }),
    compiledRef: null,
    htmlRef: null,
    contentHash,
    prompt: `bundle:${bundleId} seed:${seed.bindingId}`,
    dataSchema: seed.dataSchema,
    validationReport: null,
    parentVersionId,
    sampleData: seed.sampleData,
    sampleDataPayloadRef: null,
    appletDefinition: seed.appletDefinition ?? null,
    definitionHash:
      seed.appletDefinition !== undefined
        ? computeAppletDefinitionHash(seed.appletDefinition)
        : null,
  });

  // ── Step 3: upsert the artifact_bindings row ───────────────────────────
  await upsertArtifactBinding({
    tx,
    spaceId,
    bundleId,
    bindingId: seed.bindingId,
    artifactId,
    bundleArtifactKey: seed.bundleArtifactKey,
    installedContentHash: contentHash,
  });

  invalidateArtifactBindingCache({
    tenantId,
    spaceId,
    bundleId,
    bindingId: seed.bindingId,
  });

  return {
    bindingId: seed.bindingId,
    bundleArtifactKey: seed.bundleArtifactKey,
    artifactId,
    version: nextVersion,
    contentHash,
    outcome,
  };
}

/**
 * ON CONFLICT (space_id, bundle_id, binding_id) DO UPDATE so reinstalls
 * that change which artifact the binding points at (rare — typically
 * `bundleArtifactKey` is stable) repoint cleanly. `enabled` stays at its
 * stored value on conflict; operators who disabled a binding keep their
 * override across reinstalls.
 *
 * Called on every install path — including `skipped_unchanged` — so a
 * missing or stale binding row self-heals on the next install.
 */
async function upsertArtifactBinding(opts: {
  tx: PostgresJsDatabase;
  spaceId: string;
  bundleId: string;
  bindingId: string;
  artifactId: string;
  bundleArtifactKey: string;
  installedContentHash: string;
}): Promise<void> {
  await opts.tx.execute(sql`
    INSERT INTO artifact_bindings (
      space_id, bundle_id, binding_id, artifact_id, bundle_artifact_key,
      installed_content_hash, enabled, updated_at
    ) VALUES (
      ${opts.spaceId}::uuid, ${opts.bundleId}, ${opts.bindingId}, ${opts.artifactId}::uuid,
      ${opts.bundleArtifactKey}, ${opts.installedContentHash}, true, NOW()
    )
    ON CONFLICT (space_id, bundle_id, binding_id) DO UPDATE
      SET artifact_id = EXCLUDED.artifact_id,
          bundle_artifact_key = EXCLUDED.bundle_artifact_key,
          installed_content_hash = EXCLUDED.installed_content_hash,
          updated_at = NOW()
  `);
}

/**
 * Refresh head-row cosmetic metadata on the skipped path. `name`,
 * `description`, and `tags` are bundle-author-mutable but don't affect
 * the render contract — we refresh them without bumping the version so
 * operator-visible labels stay current across reinstalls.
 */
async function refreshHeadCosmetics(opts: {
  tx: PostgresJsDatabase;
  artifactId: string;
  seed: BundleArtifactSeed;
  tags: string[];
}): Promise<void> {
  await opts.tx
    .update(uiArtifacts)
    .set({
      name: opts.seed.name,
      description: opts.seed.description ?? null,
      tags: opts.tags,
      updatedAt: new Date(),
    })
    .where(eq(uiArtifacts.id, opts.artifactId));
}
