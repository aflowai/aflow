import {
  CatalogEntrySchema,
  processEditionDescriptor,
  type CatalogEntry,
  type CatalogEntryKind,
  type CatalogListingStatus,
  type ComposedLanes,
  type ConnectorCatalogEntry,
  type IconRef,
  type SkillBundle,
} from '@aflow/schemas';

import { SKILL_BUNDLE_CATALOG } from '../skillBundleCatalog.js';
import { CONNECTOR_CATALOG } from '../connectorCatalog/index.js';
import { APPLET_CATALOG, type AppletCatalogListing } from '../appletCatalog/index.js';
import { deriveApiConnectorHostManifest, deriveBundleHostManifest } from './hostManifest.js';
import { isListingComposed } from './composedLanes.js';
import { catalogEntryContentHash } from './contentHash.js';

/**
 * Curated brand icons, applied during envelope wrap. Every `assetId` must
 * resolve in the design system's `BRAND_ASSETS`; listings without an entry
 * render the deterministic initials avatar.
 */
export const LISTING_ICONS: Readonly<Record<string, IconRef>> = {
  github: { kind: 'brand', assetId: 'github' },
  'jira-cloud': { kind: 'brand', assetId: 'jira' },
  'kaggle-competition': { kind: 'brand', assetId: 'kaggle' },
  'alpaca-thesis-trading': { kind: 'brand', assetId: 'alpaca' },
  notion: { kind: 'brand', assetId: 'notion' },
  linear: { kind: 'brand', assetId: 'linear' },
  airtable: { kind: 'brand', assetId: 'airtable' },
  stripe: { kind: 'brand', assetId: 'stripe' },
  twilio: { kind: 'brand', assetId: 'twilio' },
  'brave-search': { kind: 'brand', assetId: 'brave' },
  resend: { kind: 'brand', assetId: 'resend' },
  wikipedia: { kind: 'brand', assetId: 'wikipedia' },
  arxiv: { kind: 'brand', assetId: 'arxiv' },
  pubmed: { kind: 'brand', assetId: 'pubmed' },
  'semantic-scholar': { kind: 'brand', assetId: 'semantic-scholar' },
  slack: { kind: 'brand', assetId: 'slack' },
  cloudflare: { kind: 'brand', assetId: 'cloudflare' },
  gmail: { kind: 'brand', assetId: 'gmail' },
  'google-calendar': { kind: 'brand', assetId: 'google-calendar' },
  'google-sheets': { kind: 'brand', assetId: 'google-sheets' },
  sentry: { kind: 'brand', assetId: 'sentry' },
  vercel: { kind: 'brand', assetId: 'vercel' },
};

function parseListing(raw: Record<string, unknown>, catalogId: string): CatalogEntry {
  const icon = LISTING_ICONS[catalogId];
  const result = CatalogEntrySchema.safeParse(icon ? { ...raw, icon } : raw);
  if (!result.success) {
    throw new Error(
      `Invalid store listing "${catalogId}": ${result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

function listingStatus(hidden: boolean | undefined): CatalogListingStatus {
  return hidden ? 'unlisted' : 'published';
}

function wrapBundle(bundle: SkillBundle): CatalogEntry {
  const { hidden, ...payload } = bundle;
  return parseListing(
    {
      catalogId: bundle.bundleId,
      kind: 'bundle',
      version: bundle.version,
      status: listingStatus(hidden),
      name: bundle.name,
      tagline: bundle.tagline,
      description: bundle.description,
      tags: bundle.tags,
      honestyLabel: 'curated',
      hostManifest: deriveBundleHostManifest(bundle),
      payload,
    },
    bundle.bundleId,
  );
}

function wrapApiConnector(entry: ConnectorCatalogEntry): CatalogEntry {
  const { hidden, ...payload } = entry;
  return parseListing(
    {
      catalogId: entry.catalogId,
      kind: 'connector',
      sourceKind: 'api',
      version: entry.version,
      status: listingStatus(hidden),
      name: entry.name,
      tagline: entry.tagline,
      description: entry.description,
      tags: entry.tags,
      ...(entry.vendor !== undefined ? { vendor: entry.vendor } : {}),
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      honestyLabel: entry.honestyLabel,
      hostManifest: deriveApiConnectorHostManifest(entry),
      payload,
    },
    entry.catalogId,
  );
}

/**
 * Applet views call no external APIs — actions flow through the platform
 * gateway — so the listing declares no outbound hosts.
 */
function wrapApplet(listing: AppletCatalogListing): CatalogEntry {
  return parseListing(
    {
      catalogId: listing.catalogId,
      kind: 'applet',
      version: listing.version,
      status: listingStatus(listing.hidden),
      name: listing.name,
      tagline: listing.tagline,
      description: listing.description,
      tags: listing.tags,
      honestyLabel: 'curated',
      payload: listing.payload,
    },
    listing.catalogId,
  );
}

interface ContributedListing {
  entry: CatalogEntry;
  hidden: boolean;
}

// Wrap (and so validate) every entry in both modes; hidden test fixtures are
// then dropped entirely in production so 'unlisted' stays reserved for vetted
// direct-link listings — mirrors the per-kind routes' hidden-in-prod 404.
const CONTRIBUTED_LISTINGS: readonly ContributedListing[] = [
  ...SKILL_BUNDLE_CATALOG.map((bundle) => ({
    entry: wrapBundle(bundle),
    hidden: bundle.hidden === true,
  })),
  ...CONNECTOR_CATALOG.map((entry) => ({
    entry: wrapApiConnector(entry),
    hidden: entry.hidden === true,
  })),
  ...APPLET_CATALOG.map((listing) => ({
    entry: wrapApplet(listing),
    hidden: listing.hidden === true,
  })),
];

/**
 * Every listing across the contributing registries (bundles + connectors),
 * wrapped into the store envelope and re-validated through
 * `CatalogEntrySchema` at module load — the same fail-fast the contributing
 * registries apply to their own entries. Skills are not standalone listings;
 * bundles resolve their members through the skill registry. In production,
 * hidden test fixtures are excluded entirely.
 */
export const STORE_CATALOG: readonly CatalogEntry[] = Object.freeze(
  CONTRIBUTED_LISTINGS.filter(
    (listing) => !(listing.hidden && process.env['NODE_ENV'] === 'production'),
  ).map((listing) => listing.entry),
);

const LISTING_BY_ID: Readonly<Record<string, CatalogEntry>> = Object.freeze(
  STORE_CATALOG.reduce<Record<string, CatalogEntry>>((acc, entry) => {
    if (acc[entry.catalogId]) {
      throw new Error(`Duplicate catalog id across store listings: ${entry.catalogId}`);
    }
    acc[entry.catalogId] = entry;
    return acc;
  }, {}),
);

export interface ListCatalogFilter {
  kind?: CatalogEntryKind;
  status?: CatalogListingStatus;
  /**
   * Lanes to list against. Defaults to the ones this process composes, so a
   * listing surface withholds what the edition cannot run without having to
   * remember to ask — the registry is one shared catalog served by both.
   */
  lanes?: ComposedLanes;
}

export function listCatalog(filter?: ListCatalogFilter): readonly CatalogEntry[] {
  const { kind, status, lanes } = filter ?? {};
  const composed = lanes ?? processEditionDescriptor();
  return STORE_CATALOG.filter(
    (entry) =>
      (kind === undefined || entry.kind === kind) &&
      (status === undefined || entry.status === status) &&
      isListingComposed(entry, composed),
  );
}

/** Fetch a store listing by id. Returns `null` for unknown ids. */
export function getCatalogEntry(catalogId: string): CatalogEntry | null {
  return LISTING_BY_ID[catalogId] ?? null;
}

/**
 * The icon the platform ships for a well-known integration id — a **curated
 * default**, not a join.
 *
 * A curated connector's id is platform-owned: `github` names one specific vetted
 * definition, which install registers verbatim under that same id
 * (`connectorCatalogIdentity.test.ts` pins the agreement). So an id is enough to
 * know the artwork, with no provenance lookup, no query, and nothing stored per
 * space — and a listing that changes its mark changes it everywhere at once
 * rather than leaving a trail of copies.
 *
 * It is only a **default**: an explicit `icon` on the definition outranks it (see
 * `ApiDefinitionSchema.icon`). Callers must apply that precedence themselves —
 * this function deliberately knows nothing about a specific definition.
 */
export function curatedIntegrationIcon(id: string): IconRef | undefined {
  return LISTING_BY_ID[id]?.icon;
}

export type StoreCatalogHashes = Record<string, { version: number; contentHash: string }>;

/**
 * Per-listing canonical content hashes, keyed by catalogId — the baseline the
 * committed `storeCatalogHashes.json` snapshot guards a version bump against.
 */
export function computeStoreCatalogHashes(): StoreCatalogHashes {
  const hashes: StoreCatalogHashes = {};
  const ordered = [...STORE_CATALOG].sort((a, b) => a.catalogId.localeCompare(b.catalogId));
  for (const entry of ordered) {
    hashes[entry.catalogId] = {
      version: entry.version,
      contentHash: catalogEntryContentHash(entry),
    };
  }
  return hashes;
}
