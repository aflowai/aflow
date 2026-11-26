/**
 * Store listing operation schemas.
 *
 * The store is the discovery-and-install surface over the platform catalog.
 * Listing kinds: `bundle` (a skill pack — 1..n skills plus their
 * integrations and seeds), `connector` (a standalone API or MCP
 * integration), and `applet` (a curated stateful applet installed as one
 * artifact). Discovery is read-only. Install and update apply on the space's
 * autonomy (Plan 345): under `full` they install or update at once, and under
 * `ratify` an install is a StagedChange proposal the operator ratifies.
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
import { PostInstallTaskSchema } from '../cybernetic/skillBundle.js';
import { SkillDiagnosticSchema } from '../cybernetic/skillValidity.js';
import { StoreUpdateModeSchema, StoreUpdatedArtifactSchema } from '../store/updateContracts.js';

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
      'The listing version this install pins — read it from store.listing.get. A mismatch means the listing changed: re-read it and install again.',
    ),
});
export type StoreListingInstallInput = z.infer<typeof StoreListingInstallInputSchema>;

const SetupChecklistSchema = z
  .array(PostInstallTaskSchema)
  .describe(
    'What the listing still needs before it runs. A credential is the operator’s to enter under Settings → Credentials: name each one to them with its link. Every other item is yours to settle.',
  );

export const StoreListingInstallOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z
      .literal('installed')
      .describe('The space’s autonomy is `full`: the listing is installed in this space now.'),
    catalogId: CatalogIdSchema,
    installedVersion: z.number().int().min(1),
    setupChecklist: SetupChecklistSchema,
  }),
  z.object({
    status: z
      .literal('proposed')
      .describe(
        'The space’s autonomy is `ratify`: an install proposal waits on the operator. Nothing is installed until they ratify it.',
      ),
    catalogId: CatalogIdSchema,
    proposalId: z.string().uuid(),
  }),
]);
export type StoreListingInstallOutput = z.infer<typeof StoreListingInstallOutputSchema>;

export const StoreListingUpdateInputSchema = z.object({
  catalogId: CatalogIdSchema,
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .describe(
      'The catalog version to update to — the listing version store.listing.get reports with `installedState: update_available`. A mismatch means the listing moved again: re-read it.',
    ),
  mode: StoreUpdateModeSchema.default('update').describe(
    '`update`, the default: apply the new version, refused where the space changed an artifact the update replaces. `replace_customized`: apply it and discard those local changes. `keep`: keep the installed content and skip this version.',
  ),
});
export type StoreListingUpdateInput = z.infer<typeof StoreListingUpdateInputSchema>;

export const StoreListingUpdateOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  mode: StoreUpdateModeSchema,
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  updatedArtifacts: z.array(StoreUpdatedArtifactSchema),
  reconcile: z
    .array(z.string())
    .describe(
      'Skills the update replaced or stopped managing. Reconcile each schedule and active campaign that runs one: the update is already applied.',
    ),
  credentialsReset: z
    .boolean()
    .describe('True where the update reset credential slots, which the setup checklist lists.'),
  setupChecklist: SetupChecklistSchema,
  advisories: z
    .array(SkillDiagnosticSchema)
    .describe(
      'Warnings on the skills the update replaced. None blocks the update. Tell the operator each one, and fix the skill where it names a real defect.',
    ),
});
export type StoreListingUpdateOutput = z.infer<typeof StoreListingUpdateOutputSchema>;

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
      'through store.listing.install.',
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
        'Results are summaries without the installable payload — read the full listing with store.listing.get before installing it.',
        'The result set is governed by the tenant shelf — a vendor with no result has no listing available here; author it via the bind-capability skill instead.',
      ],
      minimalExampleInput: { query: 'jira' },
      followUp: [
        {
          operationId: 'store.listing.get',
          note: 'Read a result in full before installing it.',
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
      'install state in the current space. The listing’s version is the expectedVersion an install or an update pins.',
    tags: ['store', 'listing', 'discovery'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Read one store listing in full, with install state and the version an install pins.',
      whenToUse: [
        'Inspecting a listing found via store.listing.search before installing it.',
        'Checking whether a specific listing is installed or has an update in this space.',
      ],
      whenNotToUse: ['Browsing or keyword discovery — use store.listing.search.'],
      minimalExampleInput: { catalogId: 'github' },
      followUp: [
        {
          operationId: 'store.listing.install',
          note: 'Install it, pinning expectedVersion to this listing’s version.',
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
    name: 'Install Store Listing',
    actionLabel: 'Installing from the store…',
    semanticDescription:
      'Install a store listing into this space, pinned to expectedVersion, on the path the Store page ' +
      'takes. The space’s autonomy decides: under `full` the listing installs now and the output ' +
      'carries its setup checklist; under `ratify` it is an install proposal the operator ratifies.',
    tags: ['store', 'listing', 'install'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Install a store listing into this space, pinned to the version store.listing.get read.',
      whenToUse: [
        'After store.listing.get confirms the listing matches the need and its current version.',
        'Acquiring capability the store covers instead of drafting an integration definition from scratch.',
      ],
      whenNotToUse: [
        'The vendor has no listing — author a definition via the bind-capability path.',
        'The listing is already installed — apply an available update with store.listing.update.',
      ],
      pitfalls: [
        'Read `status` in the output. `installed` is installed now. `proposed` waits on the operator, so never call it installed.',
        'A credential in the setup checklist is the operator’s: tell them which, with its link. The listing does not run until they enter it.',
        'expectedVersion must match the current listing version — on mismatch, re-read via store.listing.get and install again.',
      ],
      minimalExampleInput: { catalogId: 'github', expectedVersion: 1 },
      followUp: [
        {
          operationId: 'channel.message.send',
          note: 'Tell the operator what was installed, and any credential it needs.',
        },
      ],
    },
    accessMode: 'write',
    inputZod: StoreListingInstallInputSchema,
    outputZod: StoreListingInstallOutputSchema,
  },
  {
    stepType: 'store',
    group: 'listing',
    verb: 'update',
    name: 'Update Store Listing',
    actionLabel: 'Updating from the store…',
    semanticDescription:
      'Apply an available update of an installed store listing to this space, on the path the Store ' +
      'page’s Update takes: credentials are kept, the update is recorded as any install, and the ' +
      'output names the skills to reconcile with schedules and campaigns. Under the space’s autonomy ' +
      '`ratify` it applies nothing and is refused: an update is the operator’s there.',
    tags: ['store', 'listing', 'update'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Apply an available update of an installed store listing to this space.',
      whenToUse: [
        'store.listing.get or the space context reports a listing as `update_available`.',
        'The space context lists a followed update as `customized` or `failed`, and the update should go in.',
      ],
      whenNotToUse: [
        'The listing is not installed — install it with store.listing.install.',
        'The space follows the catalog and lists the update as `applied` — it is in already.',
      ],
      pitfalls: [
        'Under the space autonomy `ratify` the op is refused. Tell the operator an update is available instead.',
        'Mode `update` is refused where the space changed an artifact the update replaces. Read that refusal, then choose `replace_customized` or `keep`.',
        'Reconcile every schedule and active campaign that runs a skill under `reconcile` once the update is in.',
        'expectedVersion must match the current listing version — on mismatch, re-read via store.listing.get.',
      ],
      minimalExampleInput: { catalogId: 'github', expectedVersion: 2 },
      followUp: [
        {
          operationId: 'channel.message.send',
          note: 'Tell the operator which listing moved to which version, and what was reconciled.',
        },
      ],
    },
    accessMode: 'write',
    inputZod: StoreListingUpdateInputSchema,
    outputZod: StoreListingUpdateOutputSchema,
  },
];
