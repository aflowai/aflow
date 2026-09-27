/**
 * Store listing operation schemas.
 *
 * The store is the discovery-and-install surface over the platform catalog.
 * Listing kinds: `bundle` (a skill pack — 1..n skills plus their
 * integrations and seeds), `connector` (a standalone API or MCP
 * integration), and `applet` (a curated stateful applet installed as one
 * artifact). Discovery is read-only; install emits a StagedChange proposal
 * an operator ratifies — agents never install directly.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  CatalogEntryEnvelopeSchema,
  CatalogEntryKindSchema,
  CatalogEntrySchema,
  CatalogIdSchema,
  ListingRequirementsSchema,
} from '../store/catalogEntry.js';

export const StoreListingInstalledStateSchema = z
  .enum(['not_installed', 'installed', 'update_available'])
  .describe(
    'Install state of the listing in the current space; update_available means the installed version is behind the catalog',
  );
export type StoreListingInstalledState = z.infer<typeof StoreListingInstalledStateSchema>;

export const StoreListingSummarySchema = CatalogEntryEnvelopeSchema.extend({
  installedState: StoreListingInstalledStateSchema,
  requirements: ListingRequirementsSchema.describe(
    'What this listing needs before it can run — derived from the payload at read time',
  ),
});
export type StoreListingSummary = z.infer<typeof StoreListingSummarySchema>;

export const StoreListingSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Vendor, task, or keyword intent; omit to browse the shelf'),
  kind: CatalogEntryKindSchema.optional().describe('Restrict results to one listing kind'),
  maxResults: z.number().int().min(1).max(10).default(5),
});
export type StoreListingSearchInput = z.infer<typeof StoreListingSearchInputSchema>;

export const StoreListingSearchOutputSchema = z.object({
  listings: z
    .array(StoreListingSummarySchema)
    .describe(
      'Listing summaries without the installable payload — read one in full via store.listing.get',
    ),
});
export type StoreListingSearchOutput = z.infer<typeof StoreListingSearchOutputSchema>;

export const StoreListingGetInputSchema = z.object({
  catalogId: CatalogIdSchema,
});
export type StoreListingGetInput = z.infer<typeof StoreListingGetInputSchema>;

export const StoreListingGetOutputSchema = z.object({
  listing: CatalogEntrySchema,
  installedState: StoreListingInstalledStateSchema,
  requirements: ListingRequirementsSchema,
});
export type StoreListingGetOutput = z.infer<typeof StoreListingGetOutputSchema>;

export const StoreListingInstallInputSchema = z.object({
  catalogId: CatalogIdSchema,
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .describe(
      'The listing version this proposal pins — read it from store.listing.get; a mismatch means the listing changed, so re-read and re-propose',
    ),
});
export type StoreListingInstallInput = z.infer<typeof StoreListingInstallInputSchema>;

export const StoreListingInstallOutputSchema = z.object({
  proposalId: z.string().uuid(),
  catalogId: CatalogIdSchema,
  status: z.literal('proposed'),
});
export type StoreListingInstallOutput = z.infer<typeof StoreListingInstallOutputSchema>;

// ============================================================================

export const StoreListingOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'store',
    group: 'listing',
    verb: 'search',
    name: 'Search Store Listings',
    actionLabel: 'Searching the store…',
    groupDisplayName: 'Store Listings',
    groupDescription:
      'Discover and install curated skill packs (bundles) and integrations (connectors).',
    semanticDescription:
      'Search the store for installable listings: skill packs (kind bundle — skills plus their ' +
      'integrations) and standalone API/MCP integrations (kind connector). Returns listing summaries ' +
      'with each listing’s install state in the current space. Read-only: installing a result goes ' +
      'through store.listing.install, which emits a proposal for operator ratification.',
    tags: ['store', 'listing', 'discovery', 'search'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Search installable skill packs and integrations; returns summaries with install state for this space.',
      whenToUse: [
        'BEFORE authoring an integration definition from scratch — a curated listing for the vendor installs in one click with credential prompts, OAuth wiring, and vetted hosts included.',
        'When integration.registry.lookup reports a needed vendor as unknown or definition-only.',
        'Finding installable capability by vendor, task, or keyword.',
      ],
      whenNotToUse: [
        'Discovering platform operations or already-bound tools — use catalog.tool.search.',
        'Reading one known listing in full — use store.listing.get.',
      ],
      pitfalls: [
        'Results are summaries without the installable payload — read the full listing with store.listing.get before proposing an install.',
        'The result set is governed by the tenant shelf — a vendor with no result has no listing available here; author it via the bind-capability skill instead.',
      ],
      minimalExampleInput: { query: 'jira' },
      followUp: [
        {
          operationId: 'store.listing.get',
          note: 'Read a result in full before proposing an install.',
        },
      ],
    },
    accessMode: 'read',
    inputZod: StoreListingSearchInputSchema,
    outputZod: StoreListingSearchOutputSchema,
  },
  {
    stepType: 'store',
    group: 'listing',
    verb: 'get',
    name: 'Get Store Listing',
    actionLabel: 'Fetching store listing…',
    semanticDescription:
      'Read one store listing in full — the envelope plus the kind’s installable payload — with its ' +
      'install state in the current space. The listing’s version is the expectedVersion an install proposal pins.',
    tags: ['store', 'listing', 'discovery'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Read one store listing in full, with install state and the version an install pins.',
      whenToUse: [
        'Inspecting a listing found via store.listing.search before proposing an install.',
        'Checking whether a specific listing is installed or has an update in this space.',
      ],
      whenNotToUse: ['Browsing or keyword discovery — use store.listing.search.'],
      minimalExampleInput: { catalogId: 'github' },
      followUp: [
        {
          operationId: 'store.listing.install',
          note: 'Propose the install, pinning expectedVersion to this listing’s version.',
        },
      ],
    },
    accessMode: 'read',
    inputZod: StoreListingGetInputSchema,
    outputZod: StoreListingGetOutputSchema,
  },
  {
    stepType: 'store',
    group: 'listing',
    verb: 'install',
    name: 'Propose Store Install',
    actionLabel: 'Proposing store install…',
    semanticDescription:
      'Emit a store_install StagedChange proposal for a listing, pinned to expectedVersion. Never installs ' +
      'directly: an operator ratifies the proposal, ratification performs the install, and the setup ' +
      'checklist (credentials, OAuth consent) lands on the Action Center.',
    tags: ['store', 'listing', 'install'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Propose installing a store listing for operator ratification — never installs directly.',
      whenToUse: [
        'After store.listing.get confirms the listing matches the need and its current version.',
        'Acquiring capability the store covers instead of drafting an integration definition from scratch.',
      ],
      whenNotToUse: [
        'The vendor has no listing — author a definition via the bind-capability path.',
        'The listing is already installed (any state) — updates and reinstalls are operator actions in the Store, not new proposals.',
      ],
      pitfalls: [
        'Installation requires operator ratification — this op only emits a proposal. Say in chat that an install proposal is awaiting review; never claim the item is installed.',
        'The capability is not usable until the operator ratifies and completes the setup checklist (credentials, OAuth consent).',
        'expectedVersion must match the current listing version — on mismatch, re-read via store.listing.get and re-propose.',
      ],
      minimalExampleInput: { catalogId: 'github', expectedVersion: 1 },
    },
    accessMode: 'write',
    inputZod: StoreListingInstallInputSchema,
    outputZod: StoreListingInstallOutputSchema,
  },
];
