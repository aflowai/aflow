import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { oauthClients } from '@aflow/database';
import type {
  ApiDefinition,
  ApiDefinitionDraft,
  AuthShape,
  CredentialSlot,
  EgressPolicy,
} from '@aflow/schemas';
import {
  ApiDefinitionSchema,
  ApiEndpointSchema,
  ApiUpsertEndpointInputSchema,
} from '@aflow/schemas';
import { synthesizeEndpoints } from './endpointSynthesis.js';

// ============================================================================
// Result + policy types
// ============================================================================

export type ConflictPolicy = 'skip' | 'overwrite' | 'fail';

/** Outcome of a single helper write. Callers use it to populate the install
 *  response's `installed*` vs `skipped*` arrays and `stateChanged` boolean. */
export type WriteOutcome =
  { status: 'inserted' } | { status: 'updated' } | { status: 'skipped'; reason: 'already-exists' };

/** Thrown by helpers when `conflictPolicy: 'fail'` hits an existing row. */
export class BundleWriteConflictError extends Error {
  constructor(
    message: string,
    readonly conflict: { kind: 'api_definition' | 'api_binding'; id: string; spaceId: string },
  ) {
    super(message);
    this.name = 'BundleWriteConflictError';
  }
}

// ============================================================================
// API definition write
// ============================================================================

export async function writeApiDefinitionDraft(opts: {
  apiId: string;
  draft: ApiDefinitionDraft;
  spaceId: string;
  conflictPolicy: ConflictPolicy;
  tx: PostgresJsDatabase;
}): Promise<WriteOutcome> {
  const { apiId, draft, spaceId, conflictPolicy, tx } = opts;
  const definitionJson = buildDefinitionJsonForDraft(apiId, draft);

  // Plane-only endpoint fields survive a draft OVERWRITE — the draft surface
  // cannot express writeRiskTier (Plan 253), so replacing a stored endpoint
  // wholesale would silently un-gate a curated write endpoint. Skip/fail
  // policies never replace an existing row, so no stored fields are at risk.
  if (conflictPolicy === 'overwrite') {
    const existingRows = await tx.execute<{ definition_json: unknown }>(sql`
      SELECT definition_json FROM api_definitions
      WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid
      LIMIT 1
    `);
    const existingDefJson = existingRows[0]?.definition_json as Record<string, unknown> | undefined;
    const storedEndpoints =
      (existingDefJson?.['endpoints'] as Array<Record<string, unknown>> | undefined) ?? [];
    if (storedEndpoints.length > 0) {
      definitionJson['endpoints'] = overlayPlaneOnlyEndpointFields(
        storedEndpoints,
        (definitionJson['endpoints'] as Array<Record<string, unknown>> | undefined) ?? [],
      );
    }
  }

  // Fail loud: the stored definition MUST satisfy the executor's model schema.
  // The draft and model schemas differ (e.g. draft `summary` ≤500 vs endpoint
  // `name` ≤256), and the executor's loader silently SKIPS a row that fails
  // safeParse — surfacing only as "API definition not found in space". Catch
  // that mismatch here so it fails the write with a clear reason instead.
  const modelCheck = ApiDefinitionSchema.safeParse(definitionJson);
  if (!modelCheck.success) {
    const issues = modelCheck.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `API definition "${apiId}" failed model validation and would be unusable at runtime: ${issues}`,
    );
  }

  if (conflictPolicy === 'fail') {
    // Atomic: one INSERT ... ON CONFLICT DO NOTHING RETURNING. A returned
    // row means we inserted; no row means the (api_id, space_id) was
    // already present and we refuse. Prevents the SELECT-then-UPSERT
    // race where bind-capability (or another bundle install) writes the
    // same row between our existence check and our INSERT.
    const inserted = await tx.execute<{ api_id: string }>(sql`
      INSERT INTO api_definitions (api_id, name, base_url, definition_json, space_id)
      VALUES (${apiId}, ${draft.name}, ${draft.baseUrl ?? null}, ${JSON.stringify(definitionJson)}::jsonb, ${spaceId}::uuid)
      ON CONFLICT (api_id, space_id) DO NOTHING
      RETURNING api_id
    `);
    if (inserted.length === 0) {
      throw new BundleWriteConflictError(
        `API definition '${apiId}' already exists in space ${spaceId} and conflictPolicy is 'fail'.`,
        { kind: 'api_definition', id: apiId, spaceId },
      );
    }
    return { status: 'inserted' };
  }

  if (conflictPolicy === 'skip') {
    const inserted = await tx.execute<{ api_id: string }>(sql`
      INSERT INTO api_definitions (api_id, name, base_url, definition_json, space_id)
      VALUES (${apiId}, ${draft.name}, ${draft.baseUrl ?? null}, ${JSON.stringify(definitionJson)}::jsonb, ${spaceId}::uuid)
      ON CONFLICT (api_id, space_id) DO NOTHING
      RETURNING api_id
    `);
    return inserted.length > 0
      ? { status: 'inserted' }
      : { status: 'skipped', reason: 'already-exists' };
  }

  // overwrite
  await tx.execute(sql`
    INSERT INTO api_definitions (api_id, name, base_url, definition_json, space_id)
    VALUES (${apiId}, ${draft.name}, ${draft.baseUrl ?? null}, ${JSON.stringify(definitionJson)}::jsonb, ${spaceId}::uuid)
    ON CONFLICT (api_id, space_id) DO UPDATE SET
      name = EXCLUDED.name,
      base_url = EXCLUDED.base_url,
      definition_json = EXCLUDED.definition_json,
      updated_at = NOW()
  `);
  return { status: 'updated' };
}

export function buildDefinitionJsonForDraft(
  apiId: string,
  draft: ApiDefinitionDraft,
): Record<string, unknown> {
  return {
    apiId,
    name: draft.name,
    // baseUrl XOR baseUrlTemplate — a template-only draft must round-trip
    // without a literal baseUrl (ApiDefinitionSchema's superRefine rejects both).
    ...(draft.baseUrl !== undefined ? { baseUrl: draft.baseUrl } : {}),
    ...(draft.baseUrlTemplate !== undefined ? { baseUrlTemplate: draft.baseUrlTemplate } : {}),
    ...(draft.variables !== undefined ? { variables: draft.variables } : {}),
    authKind: draft.authKind,
    // Persist callMode — without it a direct_url definition is read back as
    // 'endpoint' (the default) and ApiDefinitionSchema then rejects its empty
    // endpoints[] in consumers.
    callMode: draft.callMode,
    endpoints: synthesizeEndpoints(draft.endpoints),
    ...(draft.specUrl ? { specUrl: draft.specUrl } : {}),
    ...(draft.suggestedEgressPolicy ? { suggestedEgressPolicy: draft.suggestedEgressPolicy } : {}),
  };
}

// ============================================================================
// API definition write (model form — for already-synthesized definitions)
// ============================================================================

/**
 * Register an already-materialized model `ApiDefinition` (endpoints already
 * synthesized — e.g. a curated connector-catalog definition) in a space.
 * Sibling of `writeApiDefinitionDraft` for callers that hold the model rather
 * than a draft; both write the identical `api_definitions` row shape so the
 * executor loader, promotion, and call path stay unchanged. `base_url` is
 * NULL for a `baseUrlTemplate` definition; the whole model rides in
 * `definition_json`.
 */
export async function writeApiDefinition(opts: {
  definition: ApiDefinition;
  spaceId: string;
  conflictPolicy: ConflictPolicy;
  tx: PostgresJsDatabase;
}): Promise<WriteOutcome> {
  const { definition, spaceId, conflictPolicy, tx } = opts;

  const modelCheck = ApiDefinitionSchema.safeParse(definition);
  if (!modelCheck.success) {
    const issues = modelCheck.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `API definition "${definition.apiId}" failed model validation and would be unusable at runtime: ${issues}`,
    );
  }
  const def = modelCheck.data;
  const baseUrl = def.baseUrl ?? null;

  if (conflictPolicy === 'fail') {
    const inserted = await tx.execute<{ api_id: string }>(sql`
      INSERT INTO api_definitions (api_id, name, description, base_url, version, definition_json, tags, space_id)
      VALUES (
        ${def.apiId}, ${def.name}, ${def.description ?? null}, ${baseUrl}, ${def.version},
        ${JSON.stringify(def)}::jsonb, ${JSON.stringify(def.tags)}::jsonb, ${spaceId}::uuid
      )
      ON CONFLICT (api_id, space_id) DO NOTHING
      RETURNING api_id
    `);
    if (inserted.length === 0) {
      throw new BundleWriteConflictError(
        `API definition '${def.apiId}' already exists in space ${spaceId} and conflictPolicy is 'fail'.`,
        { kind: 'api_definition', id: def.apiId, spaceId },
      );
    }
    return { status: 'inserted' };
  }

  if (conflictPolicy === 'skip') {
    const inserted = await tx.execute<{ api_id: string }>(sql`
      INSERT INTO api_definitions (api_id, name, description, base_url, version, definition_json, tags, space_id)
      VALUES (
        ${def.apiId}, ${def.name}, ${def.description ?? null}, ${baseUrl}, ${def.version},
        ${JSON.stringify(def)}::jsonb, ${JSON.stringify(def.tags)}::jsonb, ${spaceId}::uuid
      )
      ON CONFLICT (api_id, space_id) DO NOTHING
      RETURNING api_id
    `);
    return inserted.length > 0
      ? { status: 'inserted' }
      : { status: 'skipped', reason: 'already-exists' };
  }

  await tx.execute(sql`
    INSERT INTO api_definitions (api_id, name, description, base_url, version, definition_json, tags, space_id)
    VALUES (
      ${def.apiId}, ${def.name}, ${def.description ?? null}, ${baseUrl}, ${def.version},
      ${JSON.stringify(def)}::jsonb, ${JSON.stringify(def.tags)}::jsonb, ${spaceId}::uuid
    )
    ON CONFLICT (api_id, space_id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      base_url = EXCLUDED.base_url,
      version = EXCLUDED.version,
      definition_json = EXCLUDED.definition_json,
      tags = EXCLUDED.tags,
      updated_at = NOW()
  `);
  return { status: 'updated' };
}

// ============================================================================
// Placeholder binding write
// ============================================================================

export async function writePlaceholderBinding(opts: {
  bindingId: string;
  apiId: string;
  spaceId: string;
  name: string;
  description?: string;
  /** Tenant + space + (optional) flow scope. Mirrored into the dedicated `space_id` column too. */
  scope: { tenantId: string; spaceId: string; flowId?: string };
  /** Caller-built placeholder auth shape — MUST NOT contain credential values. */
  authJson: Record<string, unknown>;
  egressPolicy: EgressPolicy;
  /**
   * Answered by a world rather than a host. The two columns move together —
   * a CHECK ties them — so they are set in the same insert that creates the
   * binding rather than patched afterwards, which would leave a window where
   * the binding is live and points at nothing.
   */
  fulfillment?: { mode: 'simulated'; simulationId: string } | undefined;
  conflictPolicy: ConflictPolicy;
  tx: PostgresJsDatabase;
}): Promise<WriteOutcome> {
  const {
    bindingId,
    apiId,
    spaceId,
    name,
    description,
    scope,
    authJson,
    egressPolicy,
    fulfillment,
    conflictPolicy,
    tx,
  } = opts;
  const fulfillmentMode = fulfillment?.mode ?? 'live';
  const simulationId = fulfillment?.simulationId ?? null;

  if (conflictPolicy === 'fail') {
    // Atomic — see the matching block in writeApiDefinitionDraft above
    // for the race-condition rationale.
    const inserted = await tx.execute<{ binding_id: string }>(sql`
      INSERT INTO api_bindings (
        binding_id, api_id, name, description,
        scope_json, auth_json, egress_policy_json, enabled, space_id,
        fulfillment_mode, simulation_id
      )
      VALUES (
        ${bindingId},
        ${apiId},
        ${name},
        ${description ?? null},
        ${JSON.stringify(scope)}::jsonb,
        ${JSON.stringify(authJson)}::jsonb,
        ${JSON.stringify(egressPolicy)}::jsonb,
        1,
        ${spaceId}::uuid,
        ${fulfillmentMode},
        ${simulationId}
      )
      ON CONFLICT (binding_id, space_id) DO NOTHING
      RETURNING binding_id
    `);
    if (inserted.length === 0) {
      throw new BundleWriteConflictError(
        `API binding '${bindingId}' already exists in space ${spaceId} and conflictPolicy is 'fail'.`,
        { kind: 'api_binding', id: bindingId, spaceId },
      );
    }
    return { status: 'inserted' };
  }

  if (conflictPolicy === 'skip') {
    const inserted = await tx.execute<{ binding_id: string }>(sql`
      INSERT INTO api_bindings (
        binding_id, api_id, name, description,
        scope_json, auth_json, egress_policy_json, enabled, space_id,
        fulfillment_mode, simulation_id
      )
      VALUES (
        ${bindingId},
        ${apiId},
        ${name},
        ${description ?? null},
        ${JSON.stringify(scope)}::jsonb,
        ${JSON.stringify(authJson)}::jsonb,
        ${JSON.stringify(egressPolicy)}::jsonb,
        1,
        ${spaceId}::uuid,
        ${fulfillmentMode},
        ${simulationId}
      )
      ON CONFLICT (binding_id, space_id) DO NOTHING
      RETURNING binding_id
    `);
    return inserted.length > 0
      ? { status: 'inserted' }
      : { status: 'skipped', reason: 'already-exists' };
  }

  // overwrite
  await tx.execute(sql`
    INSERT INTO api_bindings (
      binding_id, api_id, name, description,
      scope_json, auth_json, egress_policy_json, enabled, space_id
    )
    VALUES (
      ${bindingId},
      ${apiId},
      ${name},
      ${description ?? null},
      ${JSON.stringify(scope)}::jsonb,
      ${JSON.stringify(authJson)}::jsonb,
      ${JSON.stringify(egressPolicy)}::jsonb,
      1,
      ${spaceId}::uuid
    )
    ON CONFLICT (binding_id, space_id) DO UPDATE SET
      api_id = EXCLUDED.api_id,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      scope_json = EXCLUDED.scope_json,
      auth_json = EXCLUDED.auth_json,
      egress_policy_json = EXCLUDED.egress_policy_json,
      enabled = EXCLUDED.enabled,
      updated_at = NOW()
  `);
  return { status: 'updated' };
}

// ============================================================================

/**
 * Build the placeholder `auth_json` for a bundle's `ApiBindingTemplate`,
 * using the bundle-author-declared credential slots rather than the
 * bind-capability bindingId-convention. Each slot maps an `authField` on
 * the resulting auth_json to a tenant-scoped `credentialKey` (the
 * Integrations UI's key); the operator fills the actual credential VALUE
 * via /integrations after install.
 *
 * Mirrors `buildPlaceholderAuthJson` in `capabilityBindingApply.ts` but
 * the credential-key naming is explicit, not synthesized. The shapes the
 * two builders produce are structurally identical at runtime so the
 * resolver / preflight code paths don't need to distinguish them.
 *
 * The `superRefine` on `ApiBindingTemplateSchema` has already validated
 * that `credentialSlots` contains exactly the right authFields with the
 * right roles for `authShape.type` — this builder can trust that.
 */
export function buildPlaceholderAuthJsonFromSlots(
  authShape: AuthShape,
  credentialSlots: readonly CredentialSlot[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: authShape.type };
  // Auth-type-specific non-credential fields.
  switch (authShape.type) {
    case 'none':
      break;
    case 'api_key':
      out['placement'] = authShape.placement;
      out['headerName'] = authShape.headerName;
      if (authShape.queryParamName !== undefined) out['queryParamName'] = authShape.queryParamName;
      break;
    case 'api_key_pair':
      out['primaryHeaderName'] = authShape.primaryHeaderName;
      out['secondaryHeaderName'] = authShape.secondaryHeaderName;
      break;
    case 'bearer':
    case 'basic':
      break;
    case 'oauth2_client_credentials':
      out['tokenEndpoint'] = authShape.tokenEndpoint;
      if (authShape.scopes !== undefined) out['scopes'] = authShape.scopes;
      break;
  }
  // Stamp each slot's credentialKey onto its authField.
  for (const slot of credentialSlots) {
    out[slot.authField] = slot.credentialKey;
  }
  return out;
}

// ============================================================================
// Auth-profile credential slots
// ============================================================================

export { extractCredentialKeys } from '@aflow/schemas';

// ============================================================================
// Plane-only endpoint fields
// ============================================================================

/**
 * Endpoint fields no agent-facing surface can express (Plan 253:
 * writeRiskTier lives in the orchestrator/executor plane; likewise curated
 * transform/response metadata). Every writer that replaces a stored endpoint
 * with an agent-derived one must preserve these from the stored endpoint —
 * otherwise an agent edit silently un-gates a curated write endpoint.
 * Derived from the two schemas, never hand-listed.
 */
export const PLANE_ONLY_ENDPOINT_FIELDS = Object.keys(ApiEndpointSchema.shape).filter(
  (field) => !(field in ApiUpsertEndpointInputSchema.shape),
);

/**
 * Overlay plane-only fields from stored endpoints onto same-id next endpoints.
 * Returns a NEW array; endpoints without a stored counterpart pass through.
 */
export function overlayPlaneOnlyEndpointFields(
  storedEndpoints: ReadonlyArray<Record<string, unknown>>,
  nextEndpoints: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (storedEndpoints.length === 0) return [...nextEndpoints];
  const storedById = new Map(storedEndpoints.map((ep) => [ep['endpointId'] as string, ep]));
  return nextEndpoints.map((ep) => {
    const stored = storedById.get(ep['endpointId'] as string);
    if (!stored) return ep;
    const preserved: Record<string, unknown> = {};
    for (const field of PLANE_ONLY_ENDPOINT_FIELDS) {
      if (ep[field] === undefined && stored[field] !== undefined) preserved[field] = stored[field];
    }
    return Object.keys(preserved).length > 0 ? { ...ep, ...preserved } : ep;
  });
}

/**
 * Config-error guard: a binding may only declare `clientScope='tenant'`/`'space'`
 * when a matching `oauth_clients` row is registered for that issuer at that
 * scope. `platform` is the implicit CIMD client and never needs a row. Returns
 * an error message when the guard fails, otherwise null. DB read is
 * tenant-schema scoped (run inside withTenantSchema).
 */
export async function checkOAuthClientRegistered(
  tx: PostgresJsDatabase,
  clientScope: 'platform' | 'tenant' | 'space',
  issuerKey: string,
  scopeId: { tenantId: string; spaceId: string },
): Promise<string | null> {
  if (clientScope === 'platform') return null;
  const ownerId = clientScope === 'tenant' ? scopeId.tenantId : scopeId.spaceId;
  const rows = await tx
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .where(
      and(
        eq(oauthClients.scope, clientScope),
        eq(oauthClients.scopeId, ownerId),
        eq(oauthClients.issuerKey, issuerKey),
      ),
    )
    .limit(1);
  if (rows.length > 0) return null;
  return (
    `clientScope="${clientScope}" requires a registered OAuth app for issuer "${issuerKey}" ` +
    `at the ${clientScope} scope, but none exists. Register one under ${
      clientScope === 'tenant' ? 'Settings → OAuth Apps' : 'the space integrations OAuth Apps'
    } first, or use clientScope="platform".`
  );
}
