import { z } from 'zod';
import { isHostSafeEgressEntry } from '../models/repoBinding.js';
import { SkillBundleSchema } from '../cybernetic/skillBundle.js';
import {
  ConnectorCatalogEntrySchema,
  ConnectorHonestyLabelSchema,
  IntegrationSourceKindSchema,
  McpConnectorCatalogEntrySchema,
} from '../integrations/index.js';
import { IconRefSchema } from './iconRef.js';
import { CatalogAppletPayloadSchema } from './appletListing.js';
import { CatalogEntryKindSchema, CatalogIdSchema } from './listingCore.js';

export {
  CatalogEntryKindSchema,
  CatalogIdSchema,
  ListingRequirementsSchema,
} from './listingCore.js';
export type { CatalogEntryKind, ListingRequirements } from './listingCore.js';

/**
 * - `published` — listed and installable.
 * - `unlisted` — installable by direct link/id only; excluded from browse and search.
 * - `deprecated` — visible to spaces that installed it (update/uninstall), not installable fresh.
 */
export const CatalogListingStatusSchema = z.enum(['published', 'unlisted', 'deprecated']);
export type CatalogListingStatus = z.infer<typeof CatalogListingStatusSchema>;

export const HostPatternSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isHostSafeEgressEntry, {
    message:
      'Hosts must be bare hostnames (optionally *.-prefixed) — no scheme, port, path, or userinfo.',
  })
  .refine((host) => !host.startsWith('*.') || host.slice(2).includes('.'), {
    message:
      'Wildcard patterns must cover a registrable domain (e.g. *.example.com) — a top-level wildcard like *.com grants unbounded egress.',
  });

/**
 * The full outbound surface a listing's artifacts may contact. Captured at
 * install as the artifact's vetted egress grant, so completeness is
 * load-bearing: a host missing here is a host the installed artifact cannot
 * reach under an allowlist policy.
 */
export const HostManifestSchema = z.object({
  apiHosts: z
    .array(HostPatternSchema)
    .max(50)
    .default([])
    .describe('API base hosts, egress additions, and redirect sources'),
  oauthHosts: z
    .array(HostPatternSchema)
    .max(50)
    .default([])
    .describe('OAuth token and authorization endpoints'),
  mcpHosts: z
    .array(HostPatternSchema)
    .max(50)
    .default([])
    .describe('MCP server and discovery hosts'),
  redirectHosts: z.array(HostPatternSchema).max(50).default([]).describe('Known redirect targets'),
});
export type HostManifest = z.infer<typeof HostManifestSchema>;

/** All hosts a manifest declares, flattened across surfaces and deduped. */
export function hostManifestHosts(manifest: HostManifest): string[] {
  return [
    ...new Set([
      ...manifest.apiHosts,
      ...manifest.oauthHosts,
      ...manifest.mcpHosts,
      ...manifest.redirectHosts,
    ]),
  ];
}

/** Per-surface union of manifests (captured grants for one artifact may span several installs). */
export function mergeHostManifests(manifests: readonly HostManifest[]): HostManifest {
  const merged: HostManifest = { apiHosts: [], oauthHosts: [], mcpHosts: [], redirectHosts: [] };
  for (const key of ['apiHosts', 'oauthHosts', 'mcpHosts', 'redirectHosts'] as const) {
    merged[key] = [...new Set(manifests.flatMap((m) => m[key]))];
  }
  return merged;
}

export const CatalogEntryEnvelopeSchema = z.object({
  catalogId: CatalogIdSchema,
  kind: CatalogEntryKindSchema,
  version: z
    .number()
    .int()
    .min(1)
    .describe(
      'Monotonic revision, bumped on any content change; guarded by the canonical content hash',
    ),
  status: CatalogListingStatusSchema.default('published'),
  name: z.string().min(1).max(200),
  tagline: z.string().min(1).max(300),
  description: z.string().min(1).max(5000),
  tags: z.array(z.string().min(1).max(64)).max(20).default([]),
  category: z.string().min(1).max(64).optional(),
  vendor: z.string().min(1).max(128).optional(),
  icon: IconRefSchema.optional(),
  honestyLabel: ConnectorHonestyLabelSchema,
  hostManifest: HostManifestSchema.default({}),
});
export type CatalogEntryEnvelope = z.infer<typeof CatalogEntryEnvelopeSchema>;

/** Envelope slice the tenant-admin Store tab lists. */
export const StoreCatalogListingSchema = CatalogEntryEnvelopeSchema.pick({
  catalogId: true,
  kind: true,
  name: true,
  tagline: true,
  status: true,
  version: true,
  vendor: true,
  category: true,
  icon: true,
});
export type StoreCatalogListing = z.infer<typeof StoreCatalogListingSchema>;

export const CatalogBundleEntrySchema = CatalogEntryEnvelopeSchema.extend({
  kind: z.literal('bundle'),
  payload: SkillBundleSchema,
});
export type CatalogBundleEntry = z.infer<typeof CatalogBundleEntrySchema>;

export const CatalogApiConnectorEntrySchema = CatalogEntryEnvelopeSchema.extend({
  kind: z.literal('connector'),
  sourceKind: z.literal('api'),
  payload: ConnectorCatalogEntrySchema,
});
export type CatalogApiConnectorEntry = z.infer<typeof CatalogApiConnectorEntrySchema>;

export const CatalogMcpConnectorEntrySchema = CatalogEntryEnvelopeSchema.extend({
  kind: z.literal('connector'),
  sourceKind: z.literal('mcp'),
  payload: McpConnectorCatalogEntrySchema,
});
export type CatalogMcpConnectorEntry = z.infer<typeof CatalogMcpConnectorEntrySchema>;

/** Connector variant, discriminated by the definition substrate underneath. */
export const CatalogConnectorEntrySchema = z.discriminatedUnion('sourceKind', [
  CatalogApiConnectorEntrySchema,
  CatalogMcpConnectorEntrySchema,
]);
export type CatalogConnectorEntry = z.infer<typeof CatalogConnectorEntrySchema>;

export const CatalogAppletEntrySchema = CatalogEntryEnvelopeSchema.extend({
  kind: z.literal('applet'),
  payload: CatalogAppletPayloadSchema,
});
export type CatalogAppletEntry = z.infer<typeof CatalogAppletEntrySchema>;

// discriminatedUnion members must be plain objects, so the kind-level connector
// member accepts either payload shape; the sourceKind↔payload pairing is
// enforced by the union's superRefine through CatalogConnectorEntrySchema.
const CatalogConnectorEntryMemberSchema = CatalogEntryEnvelopeSchema.extend({
  kind: z.literal('connector'),
  sourceKind: IntegrationSourceKindSchema,
  payload: z.union([ConnectorCatalogEntrySchema, McpConnectorCatalogEntrySchema]),
});

/**
 * One catalog entry — the envelope wraps the kind's existing payload schema
 * (each kind keeps its own validation). Where the payload carries its own
 * identity/version/trust fields, they must agree with the envelope — the
 * envelope is what listing surfaces read, the payload is what installs run.
 */
export const CatalogEntrySchema = z
  .discriminatedUnion('kind', [
    CatalogBundleEntrySchema,
    CatalogConnectorEntryMemberSchema,
    CatalogAppletEntrySchema,
  ])
  .superRefine((entry, ctx) => {
    if (entry.kind === 'connector') {
      const connector = CatalogConnectorEntrySchema.safeParse(entry);
      if (!connector.success) {
        for (const issue of connector.error.issues) ctx.addIssue(issue);
        return;
      }
    }
    if (entry.kind === 'applet') {
      // The applet payload carries no version of its own (the definition's
      // `version` counts definition revisions, not listing revisions) — its
      // identity field is the appletKey.
      if (entry.payload.appletDefinition.appletKey !== entry.catalogId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'appletDefinition', 'appletKey'],
          message:
            `payload.appletDefinition.appletKey '${entry.payload.appletDefinition.appletKey}' ` +
            `must equal envelope catalogId '${entry.catalogId}'`,
        });
      }
      return;
    }
    const payloadIdField = entry.kind === 'bundle' ? 'bundleId' : 'catalogId';
    const payloadId = entry.kind === 'bundle' ? entry.payload.bundleId : entry.payload.catalogId;
    if (payloadId !== entry.catalogId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', payloadIdField],
        message: `payload.${payloadIdField} '${payloadId}' must equal envelope catalogId '${entry.catalogId}'`,
      });
    }
    if (entry.payload.version !== entry.version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'version'],
        message: `payload.version ${entry.payload.version} must equal envelope version ${entry.version}`,
      });
    }
    if (entry.kind === 'connector' && entry.payload.honestyLabel !== entry.honestyLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'honestyLabel'],
        message: `payload.honestyLabel '${entry.payload.honestyLabel}' must equal envelope honestyLabel '${entry.honestyLabel}'`,
      });
    }
    if ('hidden' in entry.payload && entry.payload.hidden !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'hidden'],
        message:
          "Shelf visibility lives on the envelope status ('published' | 'unlisted' | 'deprecated') — remove payload.hidden.",
      });
    }
  })
  // The pairing refine above guarantees a connector payload matches its
  // sourceKind — a correlation the plain-object member cannot express — so the
  // output narrows to the per-sourceKind union.
  .transform((entry) => entry as CatalogEntry);
export type CatalogEntry = CatalogBundleEntry | CatalogConnectorEntry | CatalogAppletEntry;
