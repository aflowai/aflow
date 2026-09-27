/**
 * Applet listing → installed-artifact contract. An applet catalog entry
 * installs as exactly one bundle-style artifact seed, so the same machinery
 * bundles use (`applyArtifactSeeds`) writes the head + version, and the same
 * render-contract hash is the provenance stamp and the divergence baseline.
 */
import {
  BundleArtifactSeedSchema,
  type BundleArtifactSeed,
  type CatalogAppletEntry,
} from '@aflow/schemas';

/** `bundle_artifact_key` of the one artifact an applet listing installs. */
export function appletArtifactKey(catalogId: string): string {
  return `${catalogId}:applet`;
}

/**
 * The synthesized seed — re-parsed so an entry that slipped past registry
 * bounds (source cap, tag caps) fails here rather than mid-transaction.
 */
export function appletSeedForEntry(entry: CatalogAppletEntry): BundleArtifactSeed {
  return BundleArtifactSeedSchema.parse({
    bindingId: entry.catalogId,
    bundleArtifactKey: appletArtifactKey(entry.catalogId),
    name: entry.name,
    kind: entry.payload.artifactKind,
    appletDefinition: entry.payload.appletDefinition,
    source: entry.payload.viewSource,
    dataSchema: {},
    sampleData: entry.payload.sampleData ?? {},
    catalogPin: entry.payload.catalogPin,
    tags: entry.tags,
    description: entry.tagline,
  });
}
