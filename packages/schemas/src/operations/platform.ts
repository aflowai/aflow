/**
 * Platform step operation schemas.
 *
 * Administrative operations for managing platform resources.
 * These are typically admin-only and require elevated permissions.
 */
import { z } from 'zod';
import { StepTypeSchema } from '../artifact/operationDefinition.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { OperationIdSchema, SpaceSlugSchema } from '../runtime/ids.js';
import { ApiVariableValuesSchema } from '../models/apiVariableValues.js';
import { BindingFulfillmentSchema } from '../models/bindingFulfillment.js';
import { IntegrationCredentialStatusSchema } from '../integrations/credentialStatus.js';

// ============================================================================
// Shared Types
// ============================================================================

export const PaginationSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});

// ============================================================================
// Flow Management
// ============================================================================

/** Discriminated identifier accepted by agent.manage.* — UUID or per-space slug. */
const AgentIdentifierFields = {
  /** Stable agent UUID (preferred). */
  agentId: z.string().uuid().optional(),
  /** Per-space slug (history-aware resolution). */
  agentSlug: z.string().min(1).max(64).optional(),
} as const;

export const PlatformFlowCreateInputSchema = z.object({
  /** Per-space slug. Unique within the space; auto-derived from `name` if omitted. */
  slug: z.string().min(1).max(64).describe('Per-space slug (kebab-case)'),
  /** Human-readable name */
  name: z.string().max(256).describe('Human-readable agent name'),
  /** Description */
  description: z.string().max(2000).optional(),
  /** Agent definition (steps, transitions) */
  definition: z.record(z.unknown()),
  /** Tags for categorization */
  tags: z.array(z.string().max(64)).max(20).optional(),
});
export type PlatformFlowCreateInput = z.infer<typeof PlatformFlowCreateInputSchema>;

export const PlatformFlowCreateOutputSchema = z.object({
  agentId: z.string().uuid(),
  slug: z.string(),
  version: z.string(),
  createdAt: z.string().datetime(),
});
export type PlatformFlowCreateOutput = z.infer<typeof PlatformFlowCreateOutputSchema>;

export const PlatformFlowReadInputSchema = z.object({
  ...AgentIdentifierFields,
  version: z.string().max(64).optional().describe('Specific version (omit for latest)'),
});
export type PlatformFlowReadInput = z.infer<typeof PlatformFlowReadInputSchema>;

export const PlatformFlowReadOutputSchema = z.object({
  agentId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),
  definition: z.record(z.unknown()),
  tags: z.array(z.string()),
  spaceId: z.string(),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlatformFlowReadOutput = z.infer<typeof PlatformFlowReadOutputSchema>;

export const PlatformFlowUpdateInputSchema = z.object({
  ...AgentIdentifierFields,
  /** New slug (writes agent_slug_history on change). */
  newSlug: z.string().min(1).max(64).optional(),
  name: z.string().max(256).optional(),
  description: z.string().max(2000).optional(),
  definition: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
});
export type PlatformFlowUpdateInput = z.infer<typeof PlatformFlowUpdateInputSchema>;

export const PlatformFlowUpdateOutputSchema = z.object({
  agentId: z.string().uuid(),
  slug: z.string(),
  version: z.string().optional(),
  updatedAt: z.string().datetime(),
});
export type PlatformFlowUpdateOutput = z.infer<typeof PlatformFlowUpdateOutputSchema>;

export const PlatformFlowDeleteInputSchema = z.object({
  ...AgentIdentifierFields,
});
export type PlatformFlowDeleteInput = z.infer<typeof PlatformFlowDeleteInputSchema>;

export const PlatformFlowDeleteOutputSchema = z.object({
  agentId: z.string().uuid(),
  deleted: z.boolean(),
  deletedAt: z.string().datetime(),
});
export type PlatformFlowDeleteOutput = z.infer<typeof PlatformFlowDeleteOutputSchema>;

export const PlatformFlowListInputSchema = PaginationSchema.extend({
  tags: z.array(z.string().max(64)).optional(),
  search: z.string().max(256).optional(),
});
export type PlatformFlowListInput = z.infer<typeof PlatformFlowListInputSchema>;

export const PlatformFlowListOutputSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      description: z.string().optional(),
      spaceId: z.string(),
      archivedAt: z.string().datetime().optional(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
  total: z.number().int().nonnegative(),
});
export type PlatformFlowListOutput = z.infer<typeof PlatformFlowListOutputSchema>;

// ============================================================================
// Space Management
// ============================================================================

export const PlatformSpaceCreateInputSchema = z.object({
  slug: SpaceSlugSchema,
  name: z.string().max(256).describe('Human-readable space name'),
  description: z.string().max(2000).optional(),
});
export type PlatformSpaceCreateInput = z.infer<typeof PlatformSpaceCreateInputSchema>;

export const PlatformSpaceCreateOutputSchema = z.object({
  spaceId: z.string(),
  createdAt: z.string().datetime(),
});
export type PlatformSpaceCreateOutput = z.infer<typeof PlatformSpaceCreateOutputSchema>;

export const PlatformSpaceReadInputSchema = z.object({
  spaceId: z
    .string()
    .max(128)
    .describe('Space UUID or slug (use agent.manage.list to discover spaces)'),
});
export type PlatformSpaceReadInput = z.infer<typeof PlatformSpaceReadInputSchema>;

export const PlatformSpaceReadOutputSchema = z.object({
  spaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlatformSpaceReadOutput = z.infer<typeof PlatformSpaceReadOutputSchema>;

export const PlatformSpaceUpdateInputSchema = z.object({
  spaceId: z.string().max(128).describe('Space UUID or slug'),
  name: z.string().max(256).optional(),
  description: z.string().max(2000).optional(),
});
export type PlatformSpaceUpdateInput = z.infer<typeof PlatformSpaceUpdateInputSchema>;

export const PlatformSpaceUpdateOutputSchema = z.object({
  spaceId: z.string(),
  updatedAt: z.string().datetime(),
});
export type PlatformSpaceUpdateOutput = z.infer<typeof PlatformSpaceUpdateOutputSchema>;

// ----------------------------------------------------------------------------

export const PlatformSpaceArchiveInputSchema = z.object({
  spaceId: z.string().uuid(),
  reason: z.string().max(500).optional().describe('Free-text reason for the audit log'),
  /**
   * When true, force-cancel stalled active sessions / runs in the same
   * transaction. Refuses if any session is RUNNING or any run is 'running'
   * — those need to be cancelled deliberately.
   */
  force: z.boolean().optional(),
});
export type PlatformSpaceArchiveInput = z.infer<typeof PlatformSpaceArchiveInputSchema>;

export const PlatformSpaceArchiveOutputSchema = z.object({
  spaceId: z.string().uuid(),
  archivedAt: z.string().datetime(),
  pausedScheduleCount: z.number().int().nonnegative(),
  pausedWebhookCount: z.number().int().nonnegative(),
  /** Preserved memberships count — for audit display; rows are NOT removed. */
  memberCount: z.number().int().nonnegative(),
  /** True if `tenants.default_space_id` pointed at this space and was reassigned. */
  tenantDefaultSpaceUpdated: z.boolean(),
  /** Sessions force-cancelled by archive (only populated when force=true). */
  forceCancelledSessionIds: z.array(z.string()),
  forceCancelledRunIds: z.array(z.string()),
});
export type PlatformSpaceArchiveOutput = z.infer<typeof PlatformSpaceArchiveOutputSchema>;

export const PlatformSpaceUnarchiveInputSchema = z.object({
  spaceId: z.string().uuid(),
});
export type PlatformSpaceUnarchiveInput = z.infer<typeof PlatformSpaceUnarchiveInputSchema>;

export const PlatformSpaceUnarchiveOutputSchema = z.object({
  spaceId: z.string().uuid(),
  restoredAt: z.string().datetime(),
  /** Schedules that were paused-by-archive — counts only; NOT auto-re-enabled.
   *  Operator opts back in deliberately to avoid a flurry of cron firings. */
  pausedByArchiveScheduleCount: z.number().int().nonnegative(),
  pausedByArchiveWebhookCount: z.number().int().nonnegative(),
});
export type PlatformSpaceUnarchiveOutput = z.infer<typeof PlatformSpaceUnarchiveOutputSchema>;

const BlockingItemSchema = z.object({
  kind: z.enum(['session', 'workflow_run']),
  id: z.string(),
  status: z.string(),
});

export const PlatformSpacePreviewArchiveInputSchema = z.object({
  spaceId: z.string().uuid(),
});
export type PlatformSpacePreviewArchiveInput = z.infer<
  typeof PlatformSpacePreviewArchiveInputSchema
>;

export const PlatformSpacePreviewArchiveOutputSchema = z.object({
  spaceId: z.string().uuid(),
  /** True if `slug='general'` — archive will reject regardless of other counts. */
  isGeneralSpace: z.boolean(),
  /** True if this is the tenant's default space; archive will reassign. */
  isTenantDefaultSpace: z.boolean(),
  /** UNION of Redis hot-state and Postgres — NOT just Postgres count. */
  activeSessionCount: z.number().int().nonnegative(),
  activeWorkflowRunCount: z.number().int().nonnegative(),
  /** Will be paused (not blocked) on archive. */
  activeScheduleCount: z.number().int().nonnegative(),
  activeWebhookCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  /** Items that block archive — operator must cancel before retrying. */
  blockingItems: z.array(BlockingItemSchema),
});
export type PlatformSpacePreviewArchiveOutput = z.infer<
  typeof PlatformSpacePreviewArchiveOutputSchema
>;

export const PlatformSpaceListInputSchema = z.object({
  /** Optional name pattern filter (case-insensitive substring match) */
  nameFilter: z.string().max(256).optional(),
});
export type PlatformSpaceListInput = z.infer<typeof PlatformSpaceListInputSchema>;

export const PlatformSpaceListOutputSchema = z.object({
  spaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().optional(),
      createdAt: z.string().datetime(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type PlatformSpaceListOutput = z.infer<typeof PlatformSpaceListOutputSchema>;

// ============================================================================
// API Definition Management (v2)
// ============================================================================

/**
 * The agent-facing endpoint input shape. Deliberately narrower than the model
 * `ApiEndpointSchema` — orchestrator/executor-plane fields (writeRiskTier,
 * responseTransformPresetId, …) are not expressible here; the upsert merge
 * preserves them from the stored endpoint on re-sends.
 *
 * `responseSchemas` is not one of those. It is the response half of the
 * contract rather than a governance decision, and a simulated fulfillment is
 * validated against it — so an author with no way to write it can only
 * describe endpoints that can never be simulated.
 */
export const ApiUpsertEndpointInputSchema = z.object({
  endpointId: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(2000).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  pathTemplate: z.string().max(2048),
  params: z
    .array(
      z.object({
        name: z.string().max(128),
        location: z.enum(['path', 'query', 'header', 'body']),
        required: z.boolean(),
        description: z.string().max(2000).optional(),
        schema: z.record(z.unknown()).optional(),
        defaultValue: z
          .string()
          .max(512)
          .optional()
          .describe(
            'Sent as the parameter value when the caller omits it (path and query parameters). ' +
              'A real wire-level default, not an annotation.',
          ),
      }),
    )
    .optional(),
  bodyEncoding: z
    .enum(['json', 'form-data', 'form-urlencoded'])
    .optional()
    .describe(
      'How to encode the request body. json (default): application/json. ' +
        'form-data: multipart/form-data. form-urlencoded: application/x-www-form-urlencoded.',
    ),
  responseSchemas: z
    .record(
      // Keyed by status CLASS, never a status. Every lookup derives the key as
      // `${status/100}xx`, so a schema filed under "404" is never consulted and
      // the endpoint reads as having no 4xx contract while plainly declaring
      // one — an authoring trap the key regex removes rather than documents.
      z
        .string()
        .regex(
          /^[1-5]xx$/,
          'Response schemas are keyed by status class — "2xx", "4xx", "5xx" — not by an individual status like "404".',
        ),
      z.record(z.unknown()),
    )
    .optional()
    .describe(
      'JSON Schema per status class — "2xx", "4xx", "5xx". The response half of the ' +
        "endpoint's contract: what a caller may rely on, and what a simulated " +
        'fulfillment is held to. An endpoint without one can be called but not simulated.',
    ),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

export const PlatformApiUpsertDefinitionInputSchema = z.object({
  apiId: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(2000).optional(),
  baseUrl: z.string().url().max(2048).optional(),
  baseUrlTemplate: z.string().min(1).max(2048).optional(),
  variables: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        description: z.string().max(500),
        example: z.string().max(256).optional(),
        required: z.boolean().default(true),
      }),
    )
    .max(20)
    .optional(),
  version: z.string().max(64).optional(),
  /** 'direct_url' bindings declare no endpoints; called via api.http.call direct-URL mode. */
  callMode: z.enum(['endpoint', 'direct_url']).optional(),
  endpoints: z
    .array(ApiUpsertEndpointInputSchema)
    .describe(
      'Merged by endpointId into the stored definition: named endpoints are added or replaced, ' +
        'stored endpoints not named here are kept. To fix one endpoint, send just that endpoint.',
    ),
  removeEndpointIds: z
    .array(z.string().max(128))
    .max(100)
    .optional()
    .describe('Stored endpointIds to remove. An id not currently stored is an error.'),
  defaultHeaders: z.record(z.string()).optional(),
  suggestedEgressPolicy: z
    .object({
      allowCrossHostRedirects: z.boolean().optional(),
      additionalHosts: z.array(z.string().max(256)).max(20).optional(),
      allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).optional(),
      minResponseBodyBytes: z.number().int().positive().optional(),
      minTimeoutMs: z.number().int().positive().optional(),
    })
    .optional()
    .describe(
      'Hints for binding creators about egress policy requirements. ' +
        'E.g., file download APIs should set allowCrossHostRedirects: true and add CDN hosts to additionalHosts.',
    ),
  tags: z.array(z.string().max(64)).max(20).optional(),
  source: z.enum(['platform', 'custom', 'openapi_import']).optional(),
});
export type PlatformApiUpsertDefinitionInput = z.infer<
  typeof PlatformApiUpsertDefinitionInputSchema
>;

export const PlatformApiUpsertDefinitionOutputSchema = z.object({
  apiId: z.string(),
  status: z.enum(['created', 'updated']),
  endpoints: z
    .object({
      added: z.array(z.string()).describe('endpointIds new in this upsert'),
      updated: z.array(z.string()).describe('endpointIds whose definition changed'),
      removed: z.array(z.string()).describe('endpointIds removed via removeEndpointIds'),
      unchanged: z
        .number()
        .int()
        .nonnegative()
        .describe('Stored endpoints this upsert did not change.'),
    })
    .describe(
      'Diff against the previously stored definition. All-zero added/updated/removed means this call changed nothing.',
    ),
});
export type PlatformApiUpsertDefinitionOutput = z.infer<
  typeof PlatformApiUpsertDefinitionOutputSchema
>;

// ---------------------------------------------------------------------------

export const PlatformApiPatchDefinitionInputSchema = z.object({
  apiId: z.string().max(128).describe('API definition to update'),
  baseUrl: z.string().url().max(2048).optional().describe('Update the base URL'),
  name: z.string().max(256).optional().describe('Update the display name'),
  description: z.string().max(2000).optional().describe('Update the description'),
  auth: z.record(z.unknown()).optional().describe('Update the auth configuration'),
  tags: z.array(z.string().max(64)).max(20).optional().describe('Update tags'),
  defaultHeaders: z.record(z.string()).optional().describe('Update default headers'),
});
export type PlatformApiPatchDefinitionInput = z.infer<typeof PlatformApiPatchDefinitionInputSchema>;

export const PlatformApiPatchDefinitionOutputSchema = z.object({
  apiId: z.string(),
  status: z.literal('updated'),
  updatedFields: z.array(z.string()).describe('List of fields that were actually changed'),
});
export type PlatformApiPatchDefinitionOutput = z.infer<
  typeof PlatformApiPatchDefinitionOutputSchema
>;

export const PlatformApiDeleteDefinitionInputSchema = z.object({
  apiId: z.string().max(128),
});
export type PlatformApiDeleteDefinitionInput = z.infer<
  typeof PlatformApiDeleteDefinitionInputSchema
>;

export const PlatformApiDeleteDefinitionOutputSchema = z.object({
  apiId: z.string(),
  deleted: z.boolean(),
});
export type PlatformApiDeleteDefinitionOutput = z.infer<
  typeof PlatformApiDeleteDefinitionOutputSchema
>;

export const PlatformApiGetDefinitionInputSchema = z.object({
  apiId: z.string().max(128),
});
export type PlatformApiGetDefinitionInput = z.infer<typeof PlatformApiGetDefinitionInputSchema>;

export const PlatformApiGetDefinitionOutputSchema = z.object({
  apiId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  baseUrlTemplate: z.string().optional(),
  variables: z.array(z.record(z.unknown())).optional(),
  version: z.string(),
  callMode: z.enum(['endpoint', 'direct_url']).optional(),
  endpoints: z
    .array(z.record(z.unknown()))
    .describe(
      'The stored endpoints — read-modify-write safe against api.definition.upsert ' +
        '(which merges by endpointId).',
    ),
  defaultHeaders: z.record(z.string()).optional(),
  suggestedEgressPolicy: z.record(z.unknown()).optional(),
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlatformApiGetDefinitionOutput = z.infer<typeof PlatformApiGetDefinitionOutputSchema>;

// ============================================================================
// API Binding Management (v2)
// ============================================================================

export const PlatformApiUpsertBindingInputSchema = z.object({
  bindingId: z.string().max(128),
  apiId: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(2000).optional(),
  scope: z.object({
    tenantId: z.string().max(128),
    spaceId: z.string().max(128).optional(),
    flowId: z.string().max(128).optional(),
  }),
  /** Auth profile — credential key references only, NO secret material */
  auth: z
    .record(z.unknown())
    .optional()
    .describe(
      'Omit on an update to keep the stored auth profile unchanged. Providing the same type ' +
        'inherits every stored profile field you do not explicitly set; providing a different ' +
        'type replaces the profile. Credential VALUES are never set here — Integrations page only.',
    ),
  // Optional: omitting egress on an update preserves the binding's stored allowlist —
  // a partial (e.g. credential-only) upsert must never silently narrow it.
  egressPolicy: z.record(z.unknown()).optional(),
  /** NON-SECRET per-binding (space-scoped) config substituted into the
   *  definition's baseUrlTemplate (e.g. { domain: "acme" }). NEVER secrets —
   *  those stay in api_credentials referenced by auth.*credentialKey. */
  variableValues: ApiVariableValuesSchema.optional(),
  /** How calls through this binding are answered. Omit on an update to keep the stored mode. */
  fulfillment: BindingFulfillmentSchema.optional().describe(
    'How calls through this binding are answered: { mode: "live" } reaches the real host, ' +
      '{ mode: "simulated", simulationId } answers from a simulation with no network and no ' +
      'credential read. Omitting it preserves the stored mode, and a new binding defaults to ' +
      'live — simulation is something a binding states, never something it falls into.',
  ),
  enabled: z.boolean().optional(),
});
export type PlatformApiUpsertBindingInput = z.infer<typeof PlatformApiUpsertBindingInputSchema>;

export const PlatformApiUpsertBindingOutputSchema = z.object({
  bindingId: z.string(),
  status: z.enum(['created', 'updated']),
  authType: z.string(),
  credentialKeys: z
    .array(z.string())
    .describe(
      'Credential key names the stored auth profile references. An empty list on a non-none ' +
        'auth type means the binding cannot call — its endpoints will not promote as tools.',
    ),
  credentialStatus: IntegrationCredentialStatusSchema.describe(
    'Whether the referenced credentials are actually configured. Anything but "ready" means ' +
      'calls will fail until the operator configures credentials in the Integrations page.',
  ),
  fulfillment: BindingFulfillmentSchema.describe(
    'The stored fulfillment mode. A simulated binding reaches no host and reads no credential, ' +
      'so credentialStatus describes what promotion to live would need rather than what this ' +
      'binding needs now.',
  ),
});
export type PlatformApiUpsertBindingOutput = z.infer<typeof PlatformApiUpsertBindingOutputSchema>;

export const PlatformApiDeleteBindingInputSchema = z.object({
  bindingId: z.string().max(128),
});
export type PlatformApiDeleteBindingInput = z.infer<typeof PlatformApiDeleteBindingInputSchema>;

export const PlatformApiDeleteBindingOutputSchema = z.object({
  bindingId: z.string(),
  deleted: z.boolean(),
});
export type PlatformApiDeleteBindingOutput = z.infer<typeof PlatformApiDeleteBindingOutputSchema>;

export const PlatformApiGetBindingInputSchema = z.object({
  bindingId: z
    .string()
    .max(128)
    .describe('Binding ID (convention: "{apiId}-default"). Also accepts an apiId as fallback.'),
});
export type PlatformApiGetBindingInput = z.infer<typeof PlatformApiGetBindingInputSchema>;

export const PlatformApiGetBindingOutputSchema = z.object({
  bindingId: z.string(),
  apiId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  scope: z.object({
    tenantId: z.string(),
    spaceId: z.string().optional(),
    flowId: z.string().optional(),
  }),
  auth: z
    .record(z.unknown())
    .describe(
      'The stored auth profile in the exact shape api.binding.upsert accepts as its auth input ' +
        '(credential key references only, never secret material) — read-modify-write safe.',
    ),
  credentialKeys: z.array(z.string()),
  egressPolicy: z.record(z.unknown()),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlatformApiGetBindingOutput = z.infer<typeof PlatformApiGetBindingOutputSchema>;

// ---------------------------------------------------------------------------

export const PlatformApiBindingTestInputSchema = z.object({
  apiId: z.string().max(128).describe('API definition to test'),
  endpointId: z
    .string()
    .max(128)
    .optional()
    .describe('Specific endpoint to test (uses first endpoint if omitted)'),
});
export type PlatformApiBindingTestInput = z.infer<typeof PlatformApiBindingTestInputSchema>;

export const PlatformApiBindingTestOutputSchema = z.object({
  status: z.enum(['ok', 'error']),
  checks: z.object({
    definitionFound: z.boolean(),
    endpointFound: z.boolean(),
    bindingResolved: z.boolean(),
    credentialConfigured: z.boolean(),
    egressAllowed: z.boolean(),
  }),
  resolvedUrl: z.string().optional().describe('The fully resolved URL (for verification)'),
  error: z.string().optional().describe('Description of the first check that failed'),
});
export type PlatformApiBindingTestOutput = z.infer<typeof PlatformApiBindingTestOutputSchema>;

export const PlatformApiListBindingsInputSchema = z.object({
  apiId: z.string().max(128).optional(),
});
export type PlatformApiListBindingsInput = z.infer<typeof PlatformApiListBindingsInputSchema>;

export const PlatformApiListBindingsOutputSchema = z.object({
  bindings: z.array(
    z.object({
      bindingId: z.string(),
      apiId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      scope: z.object({
        tenantId: z.string(),
        spaceId: z.string().optional(),
        flowId: z.string().optional(),
      }),
      auth: z
        .record(z.unknown())
        .describe('Stored auth profile in api.binding.upsert input shape (key references only).'),
      credentialKeys: z.array(z.string()),
      egressPolicy: z.record(z.unknown()),
      enabled: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type PlatformApiListBindingsOutput = z.infer<typeof PlatformApiListBindingsOutputSchema>;

// ============================================================================
// OpenAPI Import — populate API definition from OpenAPI spec
// ============================================================================

export const PlatformApiImportOpenApiInputSchema = z
  .object({
    /** Target API definition ID. If it exists, endpoints are merged/updated. */
    apiId: z.string().min(1).max(128),
    /** Human-readable name (used if creating a new definition). */
    name: z.string().min(1).max(256).optional(),
    /** Description (used if creating a new definition). */
    description: z.string().max(2000).optional(),
    /** The OpenAPI spec content. Provide EITHER specUrl OR specInline, not both. */
    specUrl: z.string().url().max(4096).optional(),
    /** Inline OpenAPI spec as a JSON string. */
    specInline: z.string().max(2_000_000).optional(),
    /** Options for import behavior. */
    options: z
      .object({
        /** Only import endpoints matching these tags (from the OpenAPI spec). */
        filterTags: z.array(z.string().max(64)).max(50).optional(),
        /** Only import endpoints matching these operationIds. */
        filterOperationIds: z.array(z.string().max(128)).max(200).optional(),
        /** Prefix to add to all endpointIds (e.g., "v2_"). */
        endpointIdPrefix: z.string().max(32).optional(),
        /** If true, remove endpoints not present in the new spec (default: false — additive merge). */
        pruneAbsent: z.boolean().default(false),
      })
      .optional(),
    /** If true, return the diff summary without persisting changes (preview mode). */
    dryRun: z.boolean().default(false),
  })
  .refine((d) => Boolean(d.specUrl) !== Boolean(d.specInline), {
    message: 'Provide exactly one of specUrl or specInline',
  });
export type PlatformApiImportOpenApiInput = z.infer<typeof PlatformApiImportOpenApiInputSchema>;

export const PlatformApiImportOpenApiOutputSchema = z.object({
  apiId: z.string(),
  /** Total endpoints now in the definition. */
  totalEndpoints: z.number().int().nonnegative(),
  /** Endpoints added in this import. */
  added: z.array(z.string()),
  /** Endpoints updated (already existed, spec changed). */
  updated: z.array(z.string()),
  /** Endpoints removed (only if pruneAbsent was true). */
  removed: z.array(z.string()),
  /** Endpoints unchanged. */
  unchanged: z.number().int().nonnegative(),
  /** Base URL derived from the spec (servers[0].url). */
  baseUrl: z.string(),
  /** True if this was a dry run — no changes were persisted. */
  dryRun: z.boolean().optional(),
});
export type PlatformApiImportOpenApiOutput = z.infer<typeof PlatformApiImportOpenApiOutputSchema>;

// ============================================================================
// List API Definitions — agent-facing discovery (no secrets)
// ============================================================================

export const PlatformListApiDefinitionsInputSchema = z.object({
  /** Filter by specific API IDs (e.g., ['github', 'polygon']) */
  apiIds: z.array(z.string().max(128)).optional(),
  /** Filter by tags */
  tags: z.array(z.string().max(64)).optional(),
  /** Filter by source type */
  source: z.enum(['platform', 'custom', 'openapi_import']).optional(),
  /** Only return enabled APIs (default: true) */
  enabledOnly: z.boolean().default(true),
  /**
   * When false (default), only APIs with at least one binding are returned (callable APIs).
   * When true, include definitions even if they have no bindings yet (useful for admin/setup flows).
   */
  includeUnbound: z.boolean().default(false),
});
export type PlatformListApiDefinitionsInput = z.infer<typeof PlatformListApiDefinitionsInputSchema>;

export const PlatformListApiDefinitionsOutputSchema = z.object({
  apis: z.array(
    z.object({
      apiId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      version: z.string(),
      callMode: z.enum(['endpoint', 'direct_url']).optional(),
      endpoints: z.array(
        z.object({
          endpointId: z.string(),
          name: z.string(),
          description: z.string().optional(),
          method: z.string(),
          pathTemplate: z.string(),
          params: z.array(
            z.object({
              name: z.string(),
              location: z.string(),
              required: z.boolean(),
              description: z.string().optional(),
            }),
          ),
          tags: z.array(z.string()),
        }),
      ),
      tags: z.array(z.string()),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type PlatformListApiDefinitionsOutput = z.infer<
  typeof PlatformListApiDefinitionsOutputSchema
>;

// ============================================================================
// Shared: Tool source filter for catalog operations
// ============================================================================

/** Which tool sources to include in catalog results. Omit for all. */
export const ToolSourceSchema = z.enum(['platform', 'agent', 'api', 'mcp']);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

// ============================================================================
// Get Schema - Query operation schemas for agent tool discovery
// ============================================================================

export const PlatformGetSchemaInputSchema = z.object({
  /** Filter by step types (e.g., ['ai', 'api', 'memory']). If omitted, returns a step-type directory (lightweight overview of all step types with operation counts) — call again with specific stepTypes to drill down. */
  stepTypes: z.array(StepTypeSchema).optional(),
  /** Filter by qualified group IDs (e.g., ['ai.text', 'platform.flow']) */
  groupIds: z.array(z.string()).optional(),
  /** Filter by specific operation IDs to get full input schemas (e.g., ['compute.sandbox.exec']). When specified, returns detailed JSON schemas instead of compact summaries. */
  operationIds: z.array(z.string()).optional(),
  toolIds: z.array(z.string().min(1).max(384)).max(20).optional(),
  callName: z.string().min(1).max(256).optional(),
  /** Whether to include output schemas (default: false — agents discover outputs from actual results) */
  includeOutputSchema: z.boolean().default(false),
  /** Exclude specific operation IDs from the result (e.g., ['ai.text.generate', 'ai.agent.turn'] to hide agent-irrelevant ops). */
  excludeOperationIds: z.array(z.string()).optional(),
  /** Exclude entire groups from the result (e.g., ['ai.text'] to hide all text generation ops). */
  excludeGroupIds: z.array(z.string()).optional(),
  /** Which tool sources to include. Omit for all. Use ['api'] to discover only API endpoints. */
  sources: z.array(ToolSourceSchema).optional(),
});
export type PlatformGetSchemaInput = z.infer<typeof PlatformGetSchemaInputSchema>;

/**
 * A single operation descriptor returned by get_schema in full mode (operationIds query).
 * Agent-optimized: only operationId, description, pruned inputSchema, and usage hints.
 */
export const AgentOperationDescriptorSchema = z.object({
  /** Operation ID (e.g., 'ai.text.generate') — pass to agent.control.run_step as `operation` */
  operationId: OperationIdSchema,
  /** Description of what this operation does */
  description: z.string(),
  /** Pruned JSON Schema for the operation's input */
  inputSchema: z.record(z.unknown()),
  /** JSON Schema for the operation's output (if requested) */
  outputSchema: z.record(z.unknown()).optional(),
  /** Usage hints (whenToUse, whenNotToUse, pitfalls — no minimalExampleInput) */
  usage: z
    .object({
      oneLine: z.string(),
      whenToUse: z.array(z.string()),
      whenNotToUse: z.array(z.string()),
      pitfalls: z.array(z.string()).optional(),
    })
    .optional(),
});
export type AgentOperationDescriptor = z.infer<typeof AgentOperationDescriptorSchema>;

/**
 * Output of catalog.tool.list — discriminated union by `mode`.
 *
 * Three tiers:
 * - directory: no filters → step types + groups overview
 * - compact: stepTypes/groupIds (no operationIds) → operationId + one-liner + param names
 * - detail: operationIds provided → full pruned input schemas + usage hints
 */
const CatalogListDirectoryOutputSchema = z.object({
  mode: z.literal('directory'),
  guidance: z.string(),
  stepTypes: z.array(
    z.object({
      stepType: z.string(),
      description: z.string(),
      operationCount: z.number(),
      groups: z.array(
        z.object({
          groupId: z.string(),
          group: z.string().nullable(),
          operationCount: z.number(),
        }),
      ),
    }),
  ),
  totalStepTypes: z.number(),
  totalOperations: z.number(),
  integrations: z
    .object({
      api: z.object({
        bound: z.number().int().min(0),
        needsCredentials: z.number().int().min(0),
        disabled: z.number().int().min(0),
        toolCount: z.number().int().min(0),
      }),
      mcp: z.object({
        bound: z.number().int().min(0),
        needsCredentials: z.number().int().min(0),
        disabled: z.number().int().min(0),
        toolCount: z.number().int().min(0),
      }),
      definitionOnlyCount: z.number().int().min(0),
    })
    .optional(),
});

const CatalogListCompactOutputSchema = z.object({
  mode: z.literal('compact'),
  guidance: z.string(),
  operations: z.array(
    z.object({
      operationId: z.string(),
      description: z.string(),
      requiredParams: z.array(z.string()),
      optionalParams: z.array(z.string()),
      caution: z.string().optional(),
    }),
  ),
  count: z.number(),
});

const CatalogListDetailOutputSchema = z.object({
  mode: z.literal('detail'),
  operations: z.array(AgentOperationDescriptorSchema),
  integrationTools: z
    .array(
      z.object({
        sourceKind: z.enum(['api', 'mcp']),
        integrationId: z.string(),
        bindingId: z.string(),
        toolName: z.string(),
        toolId: z.string(),
        callName: z.string(),
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
        opTaskOnly: z.boolean().optional(),
        stale: z.boolean().optional(),
      }),
    )
    .optional(),
  ambiguous: z
    .object({
      callName: z.string(),
      candidates: z.array(z.string()),
    })
    .optional(),
  count: z.number(),
});

export const PlatformGetSchemaOutputSchema = z.discriminatedUnion('mode', [
  CatalogListDirectoryOutputSchema,
  CatalogListCompactOutputSchema,
  CatalogListDetailOutputSchema,
]);
export type PlatformGetSchemaOutput = z.infer<typeof PlatformGetSchemaOutputSchema>;

// ============================================================================

export const PlatformGetDefinitionSchemaInputSchema = z.object({
  /** The definition type to retrieve (e.g., "flow_definition"). */
  definitionType: z.string().min(1).max(64),
  /** Whether to include the full JSON Schema (can be large). Default: false. */
  includeJsonSchema: z.boolean().default(false),
  /** Whether to include validation rule descriptors. Default: true. */
  includeValidationRules: z.boolean().default(true),
  /** Whether to include the compact text representation. Default: true — this is the primary grounding format. */
  includeCompactText: z.boolean().default(true),
  /** Whether to include curated guidance bullets. Default: true. */
  includeGuidance: z.boolean().default(true),
});
export type PlatformGetDefinitionSchemaInput = z.infer<
  typeof PlatformGetDefinitionSchemaInputSchema
>;

const DefinitionValidationRuleSchema = z.object({
  ruleId: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  summary: z.string(),
  paths: z.array(z.string()),
  layer: z.enum(['shape', 'consistency', 'binding', 'expression', 'zod_input']),
});

export const PlatformGetDefinitionSchemaOutputSchema = z.object({
  /** Which definition type this describes. */
  definitionType: z.string(),
  /** SHA-256 hash of the bundle (changes when schema changes). */
  schemaHash: z.string(),
  /** Name of the root Zod schema. */
  zodSchemaName: z.string(),
  /** Full JSON Schema (if requested). */
  jsonSchema: z.record(z.unknown()).optional(),
  /** Named sub-schemas (if JSON Schema requested). */
  subSchemas: z.record(z.record(z.unknown())).optional(),
  /** Compact text for prompt injection (if requested). */
  compactText: z.string().optional(),
  /** Validation rules (if requested). */
  validationRules: z.array(DefinitionValidationRuleSchema).optional(),
  /** Curated guidance (if requested). */
  guidance: z.array(z.string()).optional(),
});
export type PlatformGetDefinitionSchemaOutput = z.infer<
  typeof PlatformGetDefinitionSchemaOutputSchema
>;

// ============================================================================

export const PlatformOperationRegistrations: OperationRegistration[] = [
  // ---------------------------------------------------------------------------
  // Space CRUD (space.manage.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'space',
    group: 'manage',
    verb: 'create',
    name: 'Create Space',
    actionLabel: 'Creating space…',
    semanticDescription: 'Create a new space (organizational container for flows)',
    tags: ['crud', 'space'],
    crudView: { entityType: 'space', action: 'create' },
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Create a new organizational space for flows.',
      whenToUse: [
        'Setting up a new project or team workspace',
        'Organizing flows into logical groups',
      ],
      whenNotToUse: ['The space already exists — use space.manage.update to modify it'],
      minimalExampleInput: { slug: 'my-space', name: 'My Space' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged', 'admin'],
    inputZod: PlatformSpaceCreateInputSchema,
    outputZod: PlatformSpaceCreateOutputSchema,
  },
  {
    stepType: 'space',
    group: 'manage',
    verb: 'get',
    name: 'Get Space',
    actionLabel: 'Reading space…',
    semanticDescription: 'Retrieve a space by ID',
    tags: ['crud', 'space'],
    crudView: { entityType: 'space', action: 'read' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve a space by ID.',
      whenToUse: ['Inspecting space details before adding flows or bindings'],
      whenNotToUse: ['Listing flows in a space — use agent.manage.list with spaceId filter'],
      minimalExampleInput: { spaceId: '550e8400-e29b-41d4-a716-446655440000' },
    },
    accessMode: 'read',
    inputZod: PlatformSpaceReadInputSchema,
    outputZod: PlatformSpaceReadOutputSchema,
  },
  {
    stepType: 'space',
    group: 'manage',
    verb: 'update',
    name: 'Update Space',
    actionLabel: 'Updating space…',
    semanticDescription: 'Update an existing space (name, description)',
    tags: ['crud', 'space'],
    crudView: { entityType: 'space', action: 'update' },
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Update a space name or description.',
      whenToUse: ['Renaming or re-describing an existing space'],
      whenNotToUse: ['Creating a new space — use space.manage.create'],
      minimalExampleInput: { spaceId: 'my-space', name: 'Renamed Space' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged', 'admin'],
    inputZod: PlatformSpaceUpdateInputSchema,
    outputZod: PlatformSpaceUpdateOutputSchema,
  },
  {
    stepType: 'space',
    group: 'manage',
    verb: 'archive',
    name: 'Archive Space',
    actionLabel: 'Archiving space…',
    semanticDescription:
      "Take a workspace out of circulation: soft-deletes the space (sets archived_at), pauses active schedules and webhooks (status='paused' with metadata.disabledByArchive=true), and reassigns tenants.default_space_id to General if needed. Members are preserved; access blocked via 410 from the archived-space preHandler. Reversible via space.manage.unarchive — feedback and causal measurements are NOT touched. Operator-only: not on the agent tool surface; agents recommend in natural language and let the operator click.",
    tags: ['lifecycle', 'space'],
    crudView: { entityType: 'space', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Operator-facing space archive (HTTP/UI-only, fully reversible).',
      whenToUse: [
        'Operator wants to retire a workspace — hide from members, halt schedules, block new sessions',
      ],
      whenNotToUse: [
        'Agents — internal: true. Use space.manage.preview_archive to describe blast radius',
        'The General space (slug="general") — rejected with SPACE_GENERAL_PROTECTED',
        'A space with active sessions or workflow runs — operator must cancel first',
      ],
      minimalExampleInput: { spaceId: '550e8400-e29b-41d4-a716-446655440000' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged', 'admin'],
    inputZod: PlatformSpaceArchiveInputSchema,
    outputZod: PlatformSpaceArchiveOutputSchema,
    internal: true,
  },
  {
    stepType: 'space',
    group: 'manage',
    verb: 'unarchive',
    name: 'Unarchive Space',
    actionLabel: 'Restoring space…',
    semanticDescription:
      'Restore an archived space. Clears archived_at; members regain access. Schedules and webhooks paused-by-archive are NOT auto-re-enabled — operator opts back in deliberately to avoid a flurry of automation firing. Operator-only: not on the agent tool surface.',
    tags: ['lifecycle', 'space'],
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Restore an archived workspace (HTTP/UI-only).',
      whenToUse: ['Operator wants to bring an archived space back into circulation'],
      whenNotToUse: [
        'Agents — internal: true',
        "Spaces that aren't archived — returns SPACE_NOT_ARCHIVED",
      ],
      minimalExampleInput: { spaceId: '550e8400-e29b-41d4-a716-446655440000' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged', 'admin'],
    inputZod: PlatformSpaceUnarchiveInputSchema,
    outputZod: PlatformSpaceUnarchiveOutputSchema,
    internal: true,
  },
  {
    stepType: 'space',
    group: 'manage',
    verb: 'preview_archive',
    name: 'Preview Space Archive',
    actionLabel: 'Computing archive preview…',
    semanticDescription:
      'Read-only dry-run for space.manage.archive. Returns blast-radius counts: active sessions (Redis hot state UNION Postgres), active workflow runs, schedules to pause, webhooks to pause, members preserved. Used by the danger-zone confirmation dialog and by the Helmsman to describe the impact before recommending archive.',
    tags: ['lifecycle', 'space', 'preview'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Compute archive blast-radius counts; safe to call from agents.',
      whenToUse: [
        'Before recommending archive — surface accurate counts to the operator',
        'In the danger-zone confirmation dialog',
      ],
      whenNotToUse: ['As a substitute for archive — preview never mutates'],
      minimalExampleInput: { spaceId: '550e8400-e29b-41d4-a716-446655440000' },
    },
    accessMode: 'read',
    inputZod: PlatformSpacePreviewArchiveInputSchema,
    outputZod: PlatformSpacePreviewArchiveOutputSchema,
    internal: false,
  },
  {
    stepType: 'space',
    group: 'manage',
    verb: 'list',
    name: 'List Spaces',
    actionLabel: 'Listing spaces…',
    semanticDescription: 'List all spaces in the tenant, optionally filtered by name',
    tags: ['crud', 'space'],
    crudView: { entityType: 'space', action: 'list' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List all available spaces.',
      whenToUse: [
        'Discovering which spaces exist before creating flows',
        'Looking up a space by name when you only have a partial match',
      ],
      whenNotToUse: ['You already know the space ID — use space.manage.get'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: PlatformSpaceListInputSchema,
    outputZod: PlatformSpaceListOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // Catalog Tools (catalog.tool.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'catalog',
    group: 'tool',
    verb: 'list',
    name: 'List Operations',
    actionLabel: 'Listing operations…',
    semanticDescription:
      'Browse the operation catalog by scope. Three tiers: ' +
      '(1) no filters → step-type directory with groups and counts, ' +
      '(2) stepTypes/groupIds → compact operation summaries with param names, ' +
      '(3) operationIds → full input schemas and usage hints.',
    tags: ['catalog', 'schema', 'agent', 'discovery'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Browse operations by scope — directory, compact summaries, or full schemas.',
      whenToUse: [
        'Browsing a known category (e.g., all memory operations)',
        'Getting full input schemas for specific operations you want to call',
      ],
      whenNotToUse: [
        'Finding tools by intent — use catalog.tool.search',
        'You already know the operation ID — call it directly',
      ],
      minimalExampleInput: { stepTypes: ['memory'] },
    },
    accessMode: 'read',
    inputZod: PlatformGetSchemaInputSchema,
    outputZod: PlatformGetSchemaOutputSchema,
  },
  {
    stepType: 'catalog',
    group: 'tool',
    verb: 'search',
    name: 'Search Tools',
    actionLabel: 'Searching tools…',
    semanticDescription:
      'Search for tools by natural language intent. One unified search across platform operations, ' +
      'agents, and integration tools (bound API endpoints + MCP tools). Returns lean results (no schemas) — ' +
      'use catalog.tool.list with toolIds for full schemas. Read-only: discovered tools do not become ' +
      'callable until you pass their toolIds to catalog.tool.promote (response carries `suggestedPromoteCall`).',
    tags: ['catalog', 'discovery', 'search', 'agent'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Search for tools by intent. Response carries `suggestedPromoteCall` — pass it to catalog.tool.promote to add tools to your toolbox.',
      whenToUse: [
        "You need to find a tool but don't know the exact ID",
        'Discovering what bound integration (API/MCP) tools exist for a task',
      ],
      whenNotToUse: [
        'You already know the operation ID — call it directly',
        'Browsing a known area — use catalog.tool.list with stepTypes',
      ],
      minimalExampleInput: { query: 'save data to memory' },
    },
    accessMode: 'read',
    inputZod: z.object({
      /** Natural language query describing what you want to do */
      query: z.string().optional(),
      /** Filter by step types */
      stepTypes: z.array(z.string()).optional(),
      /** Filter by group IDs */
      groupIds: z.array(z.string()).optional(),
      /** Filter by specific operation IDs */
      operationIds: z.array(z.string()).optional(),
      /** Max results to return (default 5, max 10) */
      maxResults: z.number().int().min(1).max(10).optional(),
      /** Which tool sources to search. Omit for all. Use ['api'] to discover only API endpoints. */
      sources: z.array(ToolSourceSchema).optional(),
    }),
    outputZod: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('directory'),
        guidance: z.string(),
        stepTypes: z.array(
          z.object({
            stepType: z.string(),
            operationCount: z.number(),
            groups: z.array(z.object({ groupId: z.string(), count: z.number() })),
          }),
        ),
        totalOperations: z.number(),
      }),
      z.object({
        mode: z.literal('search'),
        discovered: z.array(
          z.object({
            operationId: z.string().optional(),
            agentId: z.string().optional(),
            toolId: z.string().optional(),
            callName: z.string().optional(),
            type: z.enum(['platform', 'agent', 'api', 'mcp']),
            name: z.string().optional(),
            description: z.string(),
            matchReason: z.string(),
            apiId: z.string().optional(),
            serverId: z.string().optional(),
            opTaskOnly: z.boolean().optional(),
            caution: z.string().optional(),
          }),
        ),
        count: z.number(),
        query: z.string().optional(),
        promotion: z.string(),
        suggestedPromoteCall: z
          .object({
            operation: z.literal('catalog.tool.promote'),
            input: z.object({
              toolIds: z.array(z.string()),
            }),
          })
          .optional(),
      }),
    ]),
  },

  // ---------------------------------------------------------------------------
  {
    stepType: 'catalog',
    group: 'tool',
    verb: 'promote',
    name: 'Promote Tools',
    actionLabel: 'Promoting tools…',
    semanticDescription:
      'Promote selected toolIds (platform operations, agents, API endpoints, MCP tools) into the active toolbox. ' +
      'Discovery (catalog.tool.search / list) is read-only — promotion is the one mutation that expands ' +
      'what you can call natively. Promoted tools become callable by their `callName` on the next turn.',
    tags: ['catalog', 'promotion', 'agent', 'discovery'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Add selected toolIds to the active toolbox. Use after catalog.tool.search / list.',
      whenToUse: [
        'After discovering a tool via catalog.tool.search and you intend to call it',
        'When you need an API endpoint or MCP tool that is not in your core toolbelt',
      ],
      whenNotToUse: [
        'You already have the tool in your core toolbelt — call it directly',
        'You only wanted to inspect schemas — catalog.tool.list does not promote',
      ],
      pitfalls: [
        "**Scope is YOU only.** This op mutates YOUR current session's toolbox. Promoted tools are callable by you on subsequent turns. They are NOT granted to subagents, Runners inside workflow tasks, or other sessions — a Runner's toolset comes from the skill's task definition, not from any promotion you do.",
      ],
      minimalExampleInput: { toolIds: ['mcp:kaggle-default/search_competitions'] },
    },
    accessMode: 'write',
    inputZod: z.object({
      toolIds: z
        .array(z.string().min(1).max(384))
        .min(1)
        .max(20)
        .describe(
          'Tool identifiers to promote. Platform op IDs (e.g., "memory.store.put"), ' +
            'agents ("agent:{agentId}"), API endpoints ("api:{bindingId}/{endpointId}"), ' +
            'and MCP tools ("mcp:{bindingId}/{toolName}").',
        ),
    }),
    outputZod: z.object({
      promoted: z.array(z.string()),
      rejected: z.array(z.object({ toolId: z.string(), reason: z.string() })),
      count: z.number().int().min(0),
    }),
  },

  // ---------------------------------------------------------------------------
  // Agent Definition Schema (agent.manage.get_definition_schema)
  // ---------------------------------------------------------------------------
  {
    stepType: 'agent',
    group: 'manage',
    verb: 'get_definition_schema',
    name: 'Get Definition Schema',
    actionLabel: 'Loading definition schema…',
    semanticDescription:
      'Retrieve the authoritative schema bundle for an authorable artifact type (e.g., flow_definition). ' +
      'Returns a compact text representation, validation rules, and optionally the full JSON Schema. ' +
      'Builder agents should call this before authoring artifacts to ground themselves on the exact contract.',
    tags: ['catalog', 'schema', 'builder', 'grounding'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Get the schema bundle for an authorable definition type (flow, API, etc.).',
      whenToUse: [
        'Before authoring a flow definition — get the authoritative schema',
        'Understanding what fields and validation rules apply to an artifact',
      ],
      whenNotToUse: [
        'Discovering executable operations — use catalog.tool.list instead',
        'Validating an already-built definition — use agent.manage.validate instead',
      ],
      minimalExampleInput: { definitionType: 'flow_definition' },
    },
    accessMode: 'read',
    inputZod: PlatformGetDefinitionSchemaInputSchema,
    outputZod: PlatformGetDefinitionSchemaOutputSchema,
  },

  // ---------------------------------------------------------------------------
  {
    stepType: 'catalog',
    group: 'agent',
    verb: 'list',
    name: 'List Agents',
    actionLabel: 'Listing agents…',
    semanticDescription:
      'List available agents in the current space. Returns agent summaries including name, description, and ID. ' +
      'Use this to discover agents you can delegate to via agent.control.delegate or call as virtual tools.',
    tags: ['catalog', 'agent', 'discovery', 'delegation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Discover available agents for delegation.',
      whenToUse: [
        'Find specialist agents to delegate tasks to',
        'Discover what agents exist in the workspace',
      ],
      whenNotToUse: [
        'Managing agent definitions — use agent.manage.list instead',
        'You already know the agent ID — delegate directly',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: z.object({
      search: z.string().optional().describe('Filter agents by name or description'),
      limit: z.number().int().positive().max(50).default(20).optional(),
    }),
    outputZod: z.object({
      agents: z.array(
        z.object({
          agentId: z.string(),
          name: z.string(),
          description: z.string(),
          system: z.boolean(),
        }),
      ),
      total: z.number(),
    }),
  },
  {
    stepType: 'catalog',
    group: 'agent',
    verb: 'get',
    name: 'Get Agent Details',
    actionLabel: 'Loading agent details…',
    semanticDescription:
      'Get detailed information about a specific agent including its input contract, supported modes, and capabilities. ' +
      'Use this before delegating to understand what input the agent expects.',
    tags: ['catalog', 'agent', 'discovery', 'delegation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Get details about a specific agent before delegating to it.',
      whenToUse: [
        "Understand an agent's input contract before delegation",
        'Check what modes an agent supports (chat, mcp, etc.)',
      ],
      whenNotToUse: [
        'Listing all agents — use catalog.agent.list instead',
        'Modifying agent definitions — use agent.manage.get instead',
      ],
      minimalExampleInput: { agentId: 'mcp-runner' },
    },
    accessMode: 'read',
    inputZod: z.object({
      agentId: z.string().max(128).describe('Agent ID to look up'),
    }),
    outputZod: z.object({
      agentId: z.string(),
      name: z.string(),
      description: z.string(),
      version: z.string(),
      system: z.boolean(),
      tags: z.array(z.string()),
      inputContract: z.array(
        z.object({
          variableId: z.string(),
          name: z.string(),
          inputRole: z.string().optional(),
          typeSchema: z.unknown(),
        }),
      ),
      supportedModes: z.array(z.string()),
    }),
  },
];
