import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { CatalogEntryKindSchema, CatalogIdSchema } from '../store/listingCore.js';
import { StoreListingInstalledStateSchema } from './store.js';

// ============================================================================

export const IntegrationRegistryLookupInputSchema = z.object({
  /** Vendor/service identifier — matched case-insensitively (substring) against apiId, bindingId, MCP serverId, and the human-readable definition name. */
  identifier: z.string().min(1).max(120),
});
export type IntegrationRegistryLookupInput = z.infer<typeof IntegrationRegistryLookupInputSchema>;

const RegistryCatalogCandidateSchema = z.object({
  catalogId: CatalogIdSchema,
  name: z.string(),
  kind: CatalogEntryKindSchema,
  version: z.number().int().min(1),
  installedState: StoreListingInstalledStateSchema,
});

const RegistryMatchSchema = z.object({
  sourceKind: z.enum(['api', 'mcp']),
  status: z.enum(['bound', 'needs_credentials', 'disabled', 'definition-only']),
  credentialStatus: z.enum(['ready', 'missing', 'unpinned', 'expired']).optional(),
  /** Number of callable tools when status='bound'. Zero otherwise. */
  toolCount: z.number().int().min(0).optional(),
  /** Vendor identifier as Helmsman should forward it: apiId for kind='api', serverId for kind='mcp'. */
  identifier: z.string(),
  apiId: z.string().optional(),
  bindingId: z.string().optional(),
  serverId: z.string().optional(),
  definitionName: z.string().optional(),
});

export const IntegrationRegistryLookupOutputSchema = z.object({
  /**
   * Roll-up across matches, in order of actionability:
   *   - 'bound'             — at least one match is fully bound (callable now);
   *   - 'needs_credentials' — at least one match needs credential / pin setup;
   *   - 'disabled'          — all matches are explicitly disabled (operator
   *     re-enables, NOT re-binds — distinct next step from definition-only);
   *   - 'definition-only'   — a definition exists with no binding at all;
   *   - 'unknown'           — no matches.
   * Always branch on `matches[*].status` when the user named a specific
   * vendor — substring matches can collide on the roll-up.
   */
  status: z.enum(['bound', 'needs_credentials', 'disabled', 'definition-only', 'unknown']),
  matches: z.array(RegistryMatchSchema),
  catalogCandidates: z
    .array(RegistryCatalogCandidateSchema)
    .optional()
    .describe(
      'Store listings matching the identifier, present only when no binding exists. ' +
        'Installing one (store.listing.get, then store.listing.install — operator-ratified) ' +
        'supersedes authoring a definition from scratch.',
    ),
});
export type IntegrationRegistryLookupOutput = z.infer<typeof IntegrationRegistryLookupOutputSchema>;

// ============================================================================

export const IntegrationRegistryListInputSchema = z.object({
  /** Restrict to source kinds. Omit for both. */
  sourceKinds: z.array(z.enum(['api', 'mcp'])).optional(),
  /** Whether to include definition-only entries (definitions without a binding). Default false. */
  includeDefinitionOnly: z.boolean().optional(),
});
export type IntegrationRegistryListInput = z.infer<typeof IntegrationRegistryListInputSchema>;

const IntegrationListItemSchema = z.object({
  sourceKind: z.enum(['api', 'mcp']),
  integrationId: z.string(),
  bindingId: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  status: z.enum(['bound', 'needs_credentials', 'disabled', 'definition-only']),
  toolCount: z.number().int().min(0),
  credentialStatus: z.enum(['ready', 'missing', 'unpinned', 'expired']).optional(),
});

export const IntegrationRegistryListOutputSchema = z.object({
  items: z.array(IntegrationListItemSchema),
  total: z.number().int().min(0),
  /** Number of definition-only entries hidden from `items` (set when `includeDefinitionOnly` is false). */
  definitionOnlyCount: z.number().int().min(0),
});
export type IntegrationRegistryListOutput = z.infer<typeof IntegrationRegistryListOutputSchema>;

// ============================================================================
// Registrations
// ============================================================================

export const IntegrationOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'integration',
    group: 'registry',
    verb: 'lookup',
    name: 'Lookup Integration Registry',
    actionLabel: 'Looking up integration…',
    semanticDescription:
      'Look up whether a named vendor/service (e.g. "kaggle", "stripe") is bound, has a definition only, or is unknown in this space. Use this BEFORE composing a skill or running an ad-hoc tool call that needs an external service: if status is not "bound", acquire the capability first — install a `catalogCandidates` listing when one matches (store.listing.get → store.listing.install), otherwise run bind-capability — ratify, then proceed.',
    tags: ['integration', 'registry', 'cybernetic', 'bind-first'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Check whether an external service is bound, defined, or unknown in this space.',
      whenToUse: [
        'Pre-flight before invoking compose-skill for a goal that names an external service',
        'Confirming a binding still exists before referencing it in delegation context',
      ],
      whenNotToUse: [
        'Listing all bindings (use integration.registry.list)',
        'Mutating bindings (use bind-capability skill)',
      ],
      minimalExampleInput: { identifier: 'kaggle' },
    },
    accessMode: 'read',
    inputZod: IntegrationRegistryLookupInputSchema,
    outputZod: IntegrationRegistryLookupOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'registry',
    verb: 'list',
    name: 'List Integrations',
    actionLabel: 'Listing integrations…',
    semanticDescription:
      'Inventory of external-service integrations in this space across APIs and MCP servers. Returns one entry per (definition, binding) tuple with `status` (bound, needs_credentials, disabled), `toolCount`, and source kind. Definition-only entries are hidden by default and reported as `definitionOnlyCount`.',
    tags: ['integration', 'registry', 'cybernetic'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'List integrations in this space with readiness and tool counts. Pivot to catalog.tool.search to find specific tools.',
      whenToUse: [
        'Understanding what external services are configured in the space',
        'Reporting integration readiness to the operator',
      ],
      whenNotToUse: [
        'Finding a specific tool by intent — use catalog.tool.search',
        'Checking one named vendor — use integration.registry.lookup',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: IntegrationRegistryListInputSchema,
    outputZod: IntegrationRegistryListOutputSchema,
  },
];
