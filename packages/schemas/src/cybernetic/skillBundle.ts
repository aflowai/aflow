import { z } from 'zod';
import { SkillBundleIdSchema } from '../runtime/ids.js';
import { AppletDefinitionSchema } from '../applet/definition.js';
import { EgressPolicySchema } from '../models/apiDefinition.js';
import { ApiDefinitionDraftSchema } from './stagedChange.js';
import { MemoryDocTypeSchema } from '../operations/memory.js';

import {
  McpServerDefinitionSchema,
  McpSamplingPolicySchema,
} from '../models/mcpServerDefinition.js';

// ============================================================================
// SkillCatalogId reference — matches existing SkillCatalogEntry.catalogId shape
// ============================================================================

/**
 * Identifier of a skill catalog entry (`SkillCatalogEntry.catalogId`).
 * Defined inline here to avoid an import cycle with `skillCatalog.ts`
 * and to make the bundle schema self-contained.
 */
const SkillCatalogIdRefSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/);

// ============================================================================

/**
 * Auth *shape* — the per-auth-type configuration MINUS the credential-key
 * fields. The credential-key bindings (which `usernameCredentialKey` maps
 * to which Integrations-UI `credentialKey`, etc.) are externalized to
 * `credentialSlots[]` on the binding template so the operator's
 * Integrations UI can render them as a checklist.
 *
 * Mirrors `AuthProfileSchema` (`models/apiDefinition.ts`) one-for-one in the
 * `type` discriminator and non-credential fields. Adding a new auth type
 * here means mirroring it in both schemas and updating the superRefine on
 * `ApiBindingTemplateSchema` to declare the required slot roles.
 */
export const AuthShapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('api_key'),
    placement: z.enum(['header', 'query']).default('header'),
    headerName: z.string().max(128).default('X-API-Key'),
    queryParamName: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal('api_key_pair'),
    primaryHeaderName: z.string().min(1).max(128),
    secondaryHeaderName: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('basic') }),
  z.object({
    type: z.literal('oauth2_client_credentials'),
    tokenEndpoint: z.string().url().max(2048),
    scopes: z.array(z.string().max(128)).optional(),
  }),
]);
export type AuthShape = z.infer<typeof AuthShapeSchema>;

/**
 * Operator-visible role for a credential slot. The Integrations UI renders
 * one input per slot; the role drives the label/icon/help-text.
 */
export const CredentialSlotRoleSchema = z.enum([
  'username',
  'password',
  'token',
  'client_id',
  'client_secret',
  'api_key',
  'api_key_secondary',
  'other',
]);
export type CredentialSlotRole = z.infer<typeof CredentialSlotRoleSchema>;

/**
 * One credential slot on a bundle's binding template — maps an `authField`
 * (the field name in the resulting `auth_json`) to a tenant-scoped
 * `credentialKey` (the Integrations UI's identifier) plus operator-facing
 * label + role.
 *
 * Per-auth-type completeness is enforced by the superRefine on
 * `ApiBindingTemplateSchema` so the bundle author catches missing /
 * mismatched slots at load time, not at install time.
 */
export const CredentialSlotSchema = z.object({
  /** e.g. 'usernameCredentialKey' — the field on the resulting auth_json. */
  authField: z.string().min(1).max(128),
  /** e.g. 'alpaca-key-id' — the Integrations UI key the operator fills. */
  credentialKey: z.string().min(1).max(256),
  role: CredentialSlotRoleSchema,
  label: z.string().min(1).max(256),
});
export type CredentialSlot = z.infer<typeof CredentialSlotSchema>;

// ============================================================================

export const BundledApiDefinitionSchema = z.object({
  apiId: z.string().min(1).max(128),
  definition: ApiDefinitionDraftSchema,
  conflictPolicy: z.enum(['skip', 'overwrite', 'fail']).default('skip'),
});
export type BundledApiDefinition = z.infer<typeof BundledApiDefinitionSchema>;

export const ApiBindingTemplateSchema = z
  .object({
    bindingId: z.string().min(1).max(128),
    /** Must match a `bundle.apiDefinitions[].apiId` (or a prereq bundle's — checked at install time). */
    apiId: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    description: z.string().max(2000).optional(),
    authShape: AuthShapeSchema,
    /** One entry per credential key the operator must fill via Integrations. */
    credentialSlots: z.array(CredentialSlotSchema),
    egressPolicy: EgressPolicySchema,
    conflictPolicy: z.enum(['skip', 'overwrite', 'fail']).default('skip'),
  })
  .superRefine((tpl, ctx) => {
    // Per-auth-type slot validation. Each auth type pins:
    //   - the exact set of allowed `authField` names on the resulting
    //     auth_json (`usernameCredentialKey`, `credentialKey`, etc.)
    //   - the role that each authField MUST carry
    //
    // Without the role↔authField pinning, a basic template could ship
    // role=username on authField=passwordCredentialKey (and vice versa) —
    // Phase 2's placeholder auth_json builder would then persist the
    // operator's username under the password slot at runtime and fail
    // every call with 401. Catching the swap here means schema-author
    // mistakes can't escape to Integrations or runtime.
    type Role = z.infer<typeof CredentialSlotRoleSchema>;
    const spec = ((): { fields: Record<string, Role> } => {
      switch (tpl.authShape.type) {
        case 'none':
          return { fields: {} };
        case 'basic':
          return {
            fields: {
              usernameCredentialKey: 'username',
              passwordCredentialKey: 'password',
            },
          };
        case 'bearer':
          return { fields: { credentialKey: 'token' } };
        case 'api_key':
          return { fields: { credentialKey: 'api_key' } };
        case 'api_key_pair':
          return {
            fields: {
              credentialKey: 'api_key',
              secondaryCredentialKey: 'api_key_secondary',
            },
          };
        case 'oauth2_client_credentials':
          return {
            fields: {
              clientIdCredentialKey: 'client_id',
              clientSecretCredentialKey: 'client_secret',
            },
          };
      }
    })();
    const requiredFields = Object.keys(spec.fields);
    if (tpl.credentialSlots.length !== requiredFields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `auth.type='${tpl.authShape.type}' requires exactly ${requiredFields.length} credentialSlot(s); got ${tpl.credentialSlots.length}`,
        path: ['credentialSlots'],
      });
      return;
    }
    const seenFields = new Set<string>();
    for (let i = 0; i < tpl.credentialSlots.length; i++) {
      const slot = tpl.credentialSlots[i]!;
      const expectedRole = spec.fields[slot.authField];
      if (expectedRole === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `auth.type='${tpl.authShape.type}' does not accept authField='${slot.authField}'; allowed: [${requiredFields.join(', ')}]`,
          path: ['credentialSlots', i, 'authField'],
        });
        continue;
      }
      if (seenFields.has(slot.authField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate authField='${slot.authField}' — each authField may appear at most once`,
          path: ['credentialSlots', i, 'authField'],
        });
        continue;
      }
      seenFields.add(slot.authField);
      if (slot.role !== expectedRole) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `authField='${slot.authField}' requires role='${expectedRole}'; got role='${slot.role}'`,
          path: ['credentialSlots', i, 'role'],
        });
      }
    }
  });
export type ApiBindingTemplate = z.infer<typeof ApiBindingTemplateSchema>;

// ============================================================================

/**
 * MCP auth shape — the per-auth-type configuration MINUS credential-key
 * fields. Mirrors `AuthShapeSchema` above for the MCP mesh.
 *
 * Bundle v1 supports `none`, `bearer`, `header`, and
 * `oauth2_client_credentials` — the auth types whose credentials can be
 * pre-staged by an operator pasting a secret. `oauth2_pkce` and
 * `oauth2_cimd` require a browser consent flow and are out of scope for
 * the install-time bundle pattern (a future post-install task variant —
 * `complete_oauth_consent` — would handle those when Phase 11.b lands).
 */
export const McpAuthShapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({
    type: z.literal('header'),
    headerName: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal('oauth2_client_credentials'),
    tokenEndpoint: z.string().url().max(2048),
    scopes: z.array(z.string().max(128)).optional(),
  }),
]);
export type McpAuthShape = z.infer<typeof McpAuthShapeSchema>;

/**
 * One MCP server definition shipped with a bundle. The install op writes
 * the canonical row to `mcp_server_definitions` with `source: 'bundle'`
 * (the bundled definition's own `source` field is overridden during
 * install — bundles can't author other source values).
 *
 * `serverId` lives outside the inner `definition` for symmetry with
 * `BundledApiDefinitionSchema`, even though the MCP definition schema
 * already carries `serverId` internally (the omit keeps the inner shape
 * stable across schema migrations).
 */
export const BundledMcpServerDefinitionSchema = z.object({
  serverId: z.string().min(1).max(128),
  definition: McpServerDefinitionSchema.omit({
    serverId: true,
    source: true,
    createdAt: true,
    updatedAt: true,
  }),
  conflictPolicy: z.enum(['skip', 'overwrite', 'fail']).default('skip'),
});
export type BundledMcpServerDefinition = z.infer<typeof BundledMcpServerDefinitionSchema>;

export const McpBindingTemplateSchema = z
  .object({
    bindingId: z.string().min(1).max(128),
    /** References `bundle.mcpDefinitions[].serverId` or a prereq bundle's. */
    serverId: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    description: z.string().max(2000).optional(),
    authShape: McpAuthShapeSchema,
    /** One entry per credential key the operator must fill via Integrations. */
    credentialSlots: z.array(CredentialSlotSchema),
    subscribeListChanged: z.boolean().default(true),
    samplingPolicy: McpSamplingPolicySchema.default('off'),
    conflictPolicy: z.enum(['skip', 'overwrite', 'fail']).default('skip'),
  })
  .superRefine((tpl, ctx) => {
    // Per-auth-type slot validation — mirrors ApiBindingTemplateSchema's
    // superRefine but with MCP's auth profile fields. Catches bundle-author
    // mistakes (wrong role on a slot, missing slot, etc.) at schema parse
    // rather than at install or runtime.
    type Role = z.infer<typeof CredentialSlotRoleSchema>;
    const spec = ((): { fields: Record<string, Role> } => {
      switch (tpl.authShape.type) {
        case 'none':
          return { fields: {} };
        case 'bearer':
          return { fields: { credentialKey: 'token' } };
        case 'header':
          return { fields: { credentialKey: 'api_key' } };
        case 'oauth2_client_credentials':
          return {
            fields: {
              clientIdCredentialKey: 'client_id',
              clientSecretCredentialKey: 'client_secret',
            },
          };
      }
    })();
    const requiredFields = Object.keys(spec.fields);
    if (tpl.credentialSlots.length !== requiredFields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MCP auth.type='${tpl.authShape.type}' requires exactly ${requiredFields.length} credentialSlot(s); got ${tpl.credentialSlots.length}`,
        path: ['credentialSlots'],
      });
      return;
    }
    const seenFields = new Set<string>();
    for (let i = 0; i < tpl.credentialSlots.length; i++) {
      const slot = tpl.credentialSlots[i]!;
      const expectedRole = spec.fields[slot.authField];
      if (expectedRole === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `MCP auth.type='${tpl.authShape.type}' does not accept authField='${slot.authField}'; allowed: [${requiredFields.join(', ')}]`,
          path: ['credentialSlots', i, 'authField'],
        });
        continue;
      }
      if (seenFields.has(slot.authField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate authField='${slot.authField}' — each authField may appear at most once`,
          path: ['credentialSlots', i, 'authField'],
        });
        continue;
      }
      seenFields.add(slot.authField);
      if (slot.role !== expectedRole) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `authField='${slot.authField}' requires role='${expectedRole}'; got role='${slot.role}'`,
          path: ['credentialSlots', i, 'role'],
        });
      }
    }
  });
export type McpBindingTemplate = z.infer<typeof McpBindingTemplateSchema>;

// ============================================================================

/**
 * One memory doc shipped with a bundle. On install, the install op writes
 * the doc verbatim to the target space's memory at `path`. When `seedPolicy`
 * is `'skip'` (default), an existing doc at the same path is left untouched.
 */
export const MemorySeedSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(1_000_000),
  docType: MemoryDocTypeSchema,
  description: z.string().max(500).optional(),
  seedPolicy: z.enum(['skip', 'overwrite', 'merge_frontmatter']).default('skip'),
});
export type MemorySeed = z.infer<typeof MemorySeedSchema>;

// ============================================================================

export const BundleArtifactSeedSchema = z.object({
  /** Stable bundle-scoped binding identifier referenced by
   *  `SkillManifest.uiOutput.bindingId`. Unique within the bundle. */
  bindingId: z.string().min(1).max(128),
  /** Human-readable stable lookup key in `{bundleId}:{slug}` form
   *  (e.g., `alpaca:portfolio-review-card`). Recorded on the
   *  `ui_artifacts.bundle_artifact_key` column with a unique constraint
   *  per `(space_id, bundle_artifact_key)`. */
  bundleArtifactKey: z.string().min(1).max(256),
  /** Display name. */
  name: z.string().min(1).max(200),
  /** Artifact substrate kind. `react_tsx` / `html_js` lazy-compile at first
   *  render; `applet` (standalone HTML/JS) is admitted for curated applet
   *  seeds but has no lazy-wrap path yet, so applet-kind seeds are
   *  instantiable before they are renderable. `illustration` is deferred
   *  until `@aflow/ui-artifact-compiler` exposes the validate+wrap path
   *  for raw SVGs. */
  kind: z.enum(['react_tsx', 'html_js', 'applet']),
  /** Applet definition pinned (with its platform-computed hash) on the
   *  seeded version row, making the seed instantiable via
   *  ui.applet.instantiate. Parsed at module load for platform seeds. */
  appletDefinition: AppletDefinitionSchema.optional(),
  /** Raw TSX / HTML / SVG source. Validated + compiled at bundle-author
   *  time by the visual-QA gate (§4.11).
   *
   *  Not bounded by the inline payload cap: the installer measures the
   *  encoded source itself and writes it inline under the cap or
   *  content-addressed above it, so the schema states only the outer bound
   *  a source may reach at all. */
  source: z.string().min(1).max(200_000),
  /** JSON Schema describing the runtime data shape this artifact expects.
   *  Stored as `data_schema` on `ui_artifact_versions`. */
  dataSchema: z.record(z.unknown()),
  /** Golden render-time data used by §4.11 visual QA. Stored inline on
   *  `ui_artifact_versions.sample_data` (≤64 KB) or via
   *  `sample_data_payload_ref` for larger samples. */
  sampleData: z.record(z.unknown()),
  /** Catalog pin — recorded on `ui_artifacts` so the renderer can reject
   *  data that requires a newer catalog version than this artifact knows. */
  catalogPin: z.object({
    catalogId: z.string().min(1).max(128),
    catalogVersion: z.string().min(1).max(64),
    catalogHash: z.string().min(1).max(128),
  }),
  /** Hint for the chat reducer when mounting the iframe inline. */
  layoutConstraints: z
    .object({
      maxHeightPx: z.number().int().positive().max(8000).optional(),
      preferredWidth: z.enum(['narrow', 'medium', 'wide']).optional(),
    })
    .optional(),
  /** Additional discovery tags. Install also adds `bundle:{bundleId}`,
   *  `binding:{bindingId}`, and `skill:{slug}` for every skill that
   *  references this binding. */
  tags: z.array(z.string().min(1).max(64)).max(20).default([]),
  /** Short description shown in operator UI listings. */
  description: z.string().max(500).optional(),
});
export type BundleArtifactSeed = z.infer<typeof BundleArtifactSeedSchema>;

/**
 * Discriminated union of post-install completion tasks. Kinds:
 *
 *  - `fill_credentials` / `fill_mcp_credentials` / `run_mcp_binding_test` —
 *    derived from the bundle's declared API/MCP `bindingTemplates[]` whose
 *    binding still has unfilled credential slots or an unverified handshake.
 *    The UI deep-links to the Integrations page for each.
 *  - `designate_repo` — derived NOT from binding templates but from the
 *    installed skills' unmet capability state: emitted when the bundle's
 *    skills require a coding repo (`code_repo`) and the space has no `ready`
 *    repo designated yet. The UI deep-links to the Integrations page (Add repository).
 *  - `enable_space_policy` — the bundle's skills use a policy-gated lane
 *    (`SPACE_POLICY_OPERATION_PREFIXES`) this space has switched off. No
 *    binding or credential resolves it; only a space admin's toggle does.
 *  - `assign_capability_profile` — the lane is switched on, but the space's
 *    assigned capability profile withholds the lane's write capability
 *    groups. No space setting resolves it; only a tenant admin's profile
 *    assignment (or a per-user capability grant) does.
 *  - `pair_machine` — the bundle's skills run on the host lane, whose grant is
 *    a paired machine and a connected folder rather than a space policy. The
 *    UI opens This Computer; an edition with no machine to pair says so.
 *
 * Variants are AUTO-GENERATED by the install op at response time — bundle
 * authors do not author this list directly. The contract lives in this file
 * so the install op (cybernetic-runtime) and the UI (web) share one source
 * of truth. The discriminator stays open for future kinds.
 */
export const PostInstallTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fill_credentials'),
    bindingId: z.string().min(1).max(128),
    // A `fill_credentials` entry is generated only for bindings with at
    // least one unfilled slot — emitting one with `slots: []` would be a
    // no-op checklist row in the UI. .min(1) hardens that against
    // accidental Phase 2 generator regressions.
    slots: z.array(CredentialSlotSchema).min(1),
    description: z.string().max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('fill_mcp_credentials'),
    bindingId: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128),
    slots: z.array(CredentialSlotSchema).min(1),
    description: z.string().max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('run_mcp_binding_test'),
    bindingId: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128),
    description: z.string().max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('designate_repo'),
    description: z.string().min(1).max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('connect_provider'),
    /** Credential providerIds — ANY ONE connected key satisfies the lane. */
    providerOptions: z.array(z.string().min(1).max(64)).min(1),
    description: z.string().min(1).max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('pair_machine'),
    description: z.string().min(1).max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('enable_space_policy'),
    /** The gated operation prefix — `code`, `compute`, …. */
    policy: z.string().min(1).max(64),
    description: z.string().min(1).max(500),
    required: z.literal(true),
  }),
  z.object({
    kind: z.literal('assign_capability_profile'),
    /** The gated operation prefix — `code`, `compute`, …. */
    policy: z.string().min(1).max(64),
    /** Write-mode capability groups the space's effective authority does not cover. */
    missingCapabilityGroups: z.array(z.string().min(1).max(128)).min(1),
    /**
     * Which authority withheld the lane, and so where the operator has to go.
     * A tenant ceiling ANDs over every profile by design, so pointing them at
     * the space's profile assignment would be a wasted errand. `both` means
     * the two withhold different groups at once and neither action alone
     * unblocks the lane.
     */
    remedy: z.enum(['profile', 'ceiling', 'both']).default('profile'),
    description: z.string().min(1).max(500),
    required: z.literal(true),
  }),
]);
export type PostInstallTask = z.infer<typeof PostInstallTaskSchema>;

// ============================================================================
// SkillBundle — a curated installable bundle
// ============================================================================

export const SkillBundleSchema = z
  .object({
    /** Unique catalog identifier for this bundle. */
    bundleId: SkillBundleIdSchema,
    /** Monotonically increasing revision number. Bumped on any content change. */
    version: z.number().int().min(1),
    /** Display name for the Store UI. */
    name: z.string().min(1).max(200),
    /** One-line summary shown on the card. */
    tagline: z.string().min(1).max(300),
    /** Multi-paragraph description shown in the detail view. */
    description: z.string().min(1).max(5000),
    /** Domain tags for filtering/search (e.g., 'trading', 'portfolio'). */
    tags: z.array(z.string().min(1).max(50)).max(10).default([]),
    /**
     * Skills installed by this bundle, in declared order.
     * Each entry references a `SkillCatalogEntry.catalogId`. Order is
     * authoritative for the Phase-2 transactional install loop.
     */
    skillCatalogIds: z.array(SkillCatalogIdRefSchema).min(1).max(50),
    setupSkillCatalogId: SkillCatalogIdRefSchema.optional(),
    prerequisiteBundleIds: z.array(SkillBundleIdSchema).max(10).default([]),
    /** If true, hidden from the Store UI. Used for test fixtures. */
    hidden: z.boolean().optional(),

    /** API definition drafts the install op lowers + writes per-space. */
    apiDefinitions: z.array(BundledApiDefinitionSchema).max(20).default([]),
    apiBindingTemplates: z.array(ApiBindingTemplateSchema).max(20).default([]),
    mcpDefinitions: z.array(BundledMcpServerDefinitionSchema).max(20).default([]),
    mcpBindingTemplates: z.array(McpBindingTemplateSchema).max(20).default([]),
    /** Memory docs the install op writes verbatim to the target space. */
    memorySeed: z.array(MemorySeedSchema).max(50).default([]),
    artifactSeed: z.array(BundleArtifactSeedSchema).max(50).default([]),
    /**
     * Free-text next-steps guidance the install response surfaces to the
     * operator (and, via the install response, to Helmsman). Use when the
     * structured manifest (`fill_credentials`) can't capture the guidance —
     * e.g. "Customize approval thresholds in `policy/trade_governance.md`."
     */
    helmsmanHints: z.array(z.string().min(1).max(500)).max(10).default([]),
  })
  .refine((b) => !b.setupSkillCatalogId || b.skillCatalogIds.includes(b.setupSkillCatalogId), {
    message: 'setupSkillCatalogId must appear in skillCatalogIds',
    path: ['setupSkillCatalogId'],
  })
  .refine(
    (b) => {
      const bindingIds = b.artifactSeed.map((a) => a.bindingId);
      return new Set(bindingIds).size === bindingIds.length;
    },
    {
      message: 'artifactSeed[].bindingId must be unique within the bundle',
      path: ['artifactSeed'],
    },
  )
  .refine(
    (b) => {
      const keys = b.artifactSeed.map((a) => a.bundleArtifactKey);
      return new Set(keys).size === keys.length;
    },
    {
      message: 'artifactSeed[].bundleArtifactKey must be unique within the bundle',
      path: ['artifactSeed'],
    },
  );

// NOTE: Cross-field apiId reference validation (every
// `apiBindingTemplates[].apiId` resolves to either `bundle.apiDefinitions[]`
// or a prerequisite bundle's `apiDefinitions[]`) lives at install-op entry

export type SkillBundle = z.infer<typeof SkillBundleSchema>;
/**
 * Parse-input shape for `SkillBundleSchema`. Use this when authoring bundle
 * literals (e.g. in `packages/platform-artifacts/src/skillBundleCatalog.ts`):
 * fields with Zod defaults (`tags`, `prerequisiteBundleIds`, `apiDefinitions`,
 * `apiBindingTemplates`, `memorySeed`, `helmsmanHints`) are OPTIONAL here,
 * matching the runtime parse semantics — the author leaves them out and the
 * schema fills in `[]`. The output type (`SkillBundle`) requires them as
 * arrays because the parse has already materialized the defaults.
 */
export type SkillBundleInput = z.input<typeof SkillBundleSchema>;
