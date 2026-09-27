/**
 * Capability Binding Apply — 104g Phase 3.
 *
 * Ratification handler for `capability_binding` proposals. Delegates to
 * existing `api.definition.upsert` logic for creates, and `api.binding.delete`
 * for removals. Never touches credentials — definitions only.
 *
 * Plugs into the shared ratification engine (`applyRatifiedOps`).
 *
 * @packageDocumentation
 */
import type {
  TenantId,
  StagedChange,
  ApiDefinitionDraft,
  EgressPolicy,
  SuggestedEgressPolicyDraft,
} from '@aflow/schemas';

type AuthKind = ApiDefinitionDraft['authKind'];
import { createTenantContext, withTenantSchema, apiBindings } from '@aflow/database';
import { deriveHostFromBaseUrlTemplate } from '@aflow/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { getCyberneticLogger } from '../logger.js';
import type { ApplyContext, ApplyResult } from './applyRatifiedOps.js';
import { RatificationApplyError } from './applyRatifiedOps.js';
import { writeApiDefinitionDraft, writePlaceholderBinding } from './apiWriteHelpers.js';
import { collectApiDefinitionHosts } from '../integrationPolicy/collectDeclaredHosts.js';
import { IntegrationHostPolicyError } from '../integrationPolicy/assertHostsAllowed.js';
import { enforceIntegrationHostPolicy } from '../integrationPolicy/enforce.js';
export { synthesizeEndpoints, synthesizeEndpointId } from './endpointSynthesis.js';

// ============================================================================

/**
 * Non-secret placement and credential-key naming for a placeholder binding.
 *
 * `credentialKeys` maps an auth field (`credentialKey`,
 * `secondaryCredentialKey`, …) to the credential key the binding should name.
 * An unmapped field falls back to the `${bindingId}-*` derivation. Pinning is
 * what lets several bindings that share one provider account resolve one
 * pasted secret instead of one per binding — credentials are keyed
 * `(credential_key, space_id)`, so a shared name is a shared value.
 */
export interface PlaceholderAuthOptions {
  apiKeyHeaderName?: string | undefined;
  apiKeyQueryParamName?: string | undefined;
  apiKeyPairHeaderNames?: { primary: string; secondary: string } | undefined;
  credentialKeys?: Readonly<Record<string, string>> | undefined;
}

/**
 * Collapse a listing's credential prompts into the `authField -> credentialKey`
 * map `buildPlaceholderAuthJson` consumes, keeping only the prompts that
 * actually pin a key. Shared by install and the listing's derived slot list so
 * the two cannot disagree about which key the operator ends up filling.
 */
export type CredentialKeyPinning = ReadonlyArray<{
  authField: string;
  credentialKey?: string | undefined;
}>;

export function pinnedCredentialKeys(
  prompts: CredentialKeyPinning | undefined,
): Record<string, string> | undefined {
  if (!prompts) return undefined;
  const pinned: Record<string, string> = {};
  for (const prompt of prompts) {
    if (prompt.credentialKey) pinned[prompt.authField] = prompt.credentialKey;
  }
  return Object.keys(pinned).length > 0 ? pinned : undefined;
}

export function buildPlaceholderAuthJson(
  authKind: AuthKind,
  bindingId: string,
  options: PlaceholderAuthOptions = {},
): Record<string, unknown> {
  const { apiKeyHeaderName, apiKeyQueryParamName, apiKeyPairHeaderNames, credentialKeys } = options;
  const key = (authField: string, fallbackSuffix: string): string =>
    credentialKeys?.[authField] ?? `${bindingId}-${fallbackSuffix}`;

  switch (authKind) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', credentialKey: key('credentialKey', 'token') };
    case 'api_key':
      // Placement is derived: a query-param name → query placement, otherwise
      // the header form (default X-API-Key when no header name is pinned).
      if (apiKeyQueryParamName !== undefined) {
        return {
          type: 'api_key',
          credentialKey: key('credentialKey', 'key'),
          placement: 'query',
          queryParamName: apiKeyQueryParamName,
        };
      }
      return {
        type: 'api_key',
        credentialKey: key('credentialKey', 'key'),
        ...(apiKeyHeaderName !== undefined ? { headerName: apiKeyHeaderName } : {}),
      };
    case 'api_key_pair': {
      if (!apiKeyPairHeaderNames) {
        throw new Error(
          'buildPlaceholderAuthJson: api_key_pair requires apiKeyPairHeaderNames. ' +
            'An ApiDefinition carries no auth profile, so the two header names must come ' +
            'from the caller (a catalog entry or a binding template).',
        );
      }
      return {
        type: 'api_key_pair',
        primaryHeaderName: apiKeyPairHeaderNames.primary,
        secondaryHeaderName: apiKeyPairHeaderNames.secondary,
        credentialKey: key('credentialKey', 'key'),
        secondaryCredentialKey: key('secondaryCredentialKey', 'secondary-key'),
      };
    }
    case 'basic':
      return {
        type: 'basic',
        usernameCredentialKey: key('usernameCredentialKey', 'username'),
        passwordCredentialKey: key('passwordCredentialKey', 'secret'),
      };
    case 'oauth2':
      return {
        type: 'oauth2_client_credentials',
        clientIdCredentialKey: key('clientIdCredentialKey', 'client-id'),
        clientSecretCredentialKey: key('clientSecretCredentialKey', 'client-secret'),
      };
    default: {
      // Exhaustiveness check — if the draft enum grows, TS flags this until
      // a case is added. We deliberately do NOT silently fall back to a
      // benign value: an unknown authKind should fail loudly so the placeholder
      // can't masquerade as an unauthenticated binding.
      const _exhaustive: never = authKind;
      throw new Error(
        `buildPlaceholderAuthJson: unhandled authKind '${String(_exhaustive)}'. ` +
          'Add a case here when ApiDefinitionDraftSchema.authKind grows a new value.',
      );
    }
  }
}

// ============================================================================

/**
 * Extract the host from an http(s) URL, or return null if unparseable.
 * Used to seed `allowedHosts` from the API definition's baseUrl so the
 * binding can call the API itself.
 */
export function parseHostFromUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Merge a `SuggestedEgressPolicyDraft` into an existing egress policy
 * record. Used both for new placeholder bindings (baseline = `{ allowedHosts:
 * [baseUrlHost] }`) AND for existing bindings (baseline = current
 * `egress_policy_json`).
 *
 * Merge semantics:
 *   - `allowedHosts`: union of existing + suggested.additionalHosts (deduped).
 *   - `allowedMethods`: replaced when suggested provides one; existing
 *     otherwise.
 *   - `allowCrossHostRedirects`: replaced when suggested provides a value.
 *   - `maxResponseBodyBytes`: `max(existing, suggested.minResponseBodyBytes)`
 *     so we never shrink a tighter operator-set limit.
 *   - `timeoutMs`: same `max(existing, suggested.minTimeoutMs)` semantics.
 *   - All other fields: preserved verbatim from existing.
 *
 * Returns a NEW object — never mutates inputs.
 */
export function mergeSuggestedEgressIntoBaseline(
  existing: Record<string, unknown>,
  suggested: SuggestedEgressPolicyDraft | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  if (!suggested) return out;

  // allowedHosts: union with additionalHosts.
  const existingHosts = Array.isArray(out['allowedHosts']) ? (out['allowedHosts'] as string[]) : [];
  const additional = suggested.additionalHosts ?? [];
  if (existingHosts.length > 0 || additional.length > 0) {
    out['allowedHosts'] = [...new Set([...existingHosts, ...additional])];
  }

  if (suggested.allowedMethods) {
    out['allowedMethods'] = suggested.allowedMethods;
  }

  if (suggested.allowCrossHostRedirects !== undefined) {
    out['allowCrossHostRedirects'] = suggested.allowCrossHostRedirects;
  }

  if (suggested.minResponseBodyBytes !== undefined) {
    const existingBytes =
      typeof out['maxResponseBodyBytes'] === 'number' ? out['maxResponseBodyBytes'] : 0;
    out['maxResponseBodyBytes'] = Math.max(existingBytes, suggested.minResponseBodyBytes);
  }

  if (suggested.minTimeoutMs !== undefined) {
    const existingTimeout = typeof out['timeoutMs'] === 'number' ? out['timeoutMs'] : 0;
    out['timeoutMs'] = Math.max(existingTimeout, suggested.minTimeoutMs);
  }

  return out;
}

// ============================================================================
// Apply handler
// ============================================================================

/**
 * Apply a `capability_binding` proposal.
 *
 * Dispatches on op type:
 * - `capability.definition.upsert`: creates/updates the API definition via
 *   the same SQL upsert pattern as `apiAdmin.ts`. Does NOT create a
 *   credentialled binding — the operator does that separately.
 * - `capability.binding.remove`: deletes the credentialled binding.
 */
export async function applyCapabilityBindingOps(
  ctx: ApplyContext,
  stagedChange: StagedChange,
): Promise<ApplyResult> {
  const logger = getCyberneticLogger();
  const result: ApplyResult = {
    applied: false,
    appliedOps: [],
    skippedOps: [],
  };

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  for (const op of stagedChange.proposal.ops) {
    switch (op.op) {
      case 'capability.definition.upsert': {
        const { apiId, definition } = op;

        try {
          await enforceIntegrationHostPolicy({
            db: ctx.db,
            tenantId: ctx.tenantId,
            spaceId: ctx.spaceId,
            kind: 'api',
            hosts: collectApiDefinitionHosts(definition),
            grantRefs: [{ artifactType: 'api_definition', artifactKey: apiId }],
          });
        } catch (err) {
          if (err instanceof IntegrationHostPolicyError) {
            throw new RatificationApplyError(op.op, err.message, 'post_validation');
          }
          throw err;
        }

        await withTenantSchema(ctx.db, tenantCtx, async (tx) => {
          await writeApiDefinitionDraft({
            apiId,
            draft: definition,
            spaceId: ctx.spaceId,
            conflictPolicy: 'overwrite',
            tx,
          });

          const placeholderBindingId = `${apiId}-default`;
          const placeholderAuth = buildPlaceholderAuthJson(
            definition.authKind,
            placeholderBindingId,
          );
          const baseUrlHost = definition.baseUrl
            ? parseHostFromUrl(definition.baseUrl)
            : definition.baseUrlTemplate
              ? (deriveHostFromBaseUrlTemplate(definition.baseUrlTemplate) ?? null)
              : null;
          const initialEgress = mergeSuggestedEgressIntoBaseline(
            { allowedHosts: baseUrlHost ? [baseUrlHost] : [] },
            definition.suggestedEgressPolicy,
          );

          // Step 1: insert if missing, leave existing untouched (preserves
          await writePlaceholderBinding({
            bindingId: placeholderBindingId,
            apiId,
            spaceId: ctx.spaceId,
            name: definition.name,
            description: 'Default binding (credentials pending — add at /integrations).',
            scope: { tenantId: ctx.tenantId, spaceId: ctx.spaceId },
            authJson: placeholderAuth,
            egressPolicy: initialEgress as EgressPolicy,
            conflictPolicy: 'skip',
            tx,
          });

          // Step 2: when the proposal carries egress hints, MERGE them into
          // whatever the binding currently holds (whether the placeholder we
          // just inserted, or a real operator-credentialled binding). Read
          // existing → merge → write keeps the SQL obvious.
          if (definition.suggestedEgressPolicy) {
            const existingRows = await tx.execute<{
              egress_policy_json: Record<string, unknown> | null;
            }>(sql`
              SELECT egress_policy_json
              FROM api_bindings
              WHERE binding_id = ${placeholderBindingId}
                AND space_id = ${ctx.spaceId}::uuid
              LIMIT 1
            `);
            const existing = existingRows[0]?.egress_policy_json ?? {};
            const merged = mergeSuggestedEgressIntoBaseline(
              existing,
              definition.suggestedEgressPolicy,
            );
            // Always include the baseUrl host even when the caller forgot
            // — defense-in-depth so a typo in the proposal can't lock out
            // the API itself.
            if (baseUrlHost) {
              const hostsSet = new Set<string>(
                Array.isArray(merged['allowedHosts']) ? (merged['allowedHosts'] as string[]) : [],
              );
              hostsSet.add(baseUrlHost);
              merged['allowedHosts'] = [...hostsSet];
            }
            await tx.execute(sql`
              UPDATE api_bindings
              SET egress_policy_json = ${JSON.stringify(merged)}::jsonb,
                  updated_at = NOW()
              WHERE binding_id = ${placeholderBindingId}
                AND space_id = ${ctx.spaceId}::uuid
            `);
          }
        });

        result.appliedOps.push('capability.definition.upsert');
        result.applied = true;

        logger.info(
          `[capabilityBindingApply] Upserted API definition '${apiId}' ` +
            `(${String(definition.endpoints.length)} endpoints) ` +
            (definition.suggestedEgressPolicy
              ? '+ binding egress merged'
              : '+ placeholder binding (egress unchanged)'),
        );
        break;
      }

      case 'capability.binding.remove': {
        const { bindingId } = op;

        await withTenantSchema(ctx.db, tenantCtx, async (tx) => {
          await tx
            .delete(apiBindings)
            .where(and(eq(apiBindings.bindingId, bindingId), eq(apiBindings.spaceId, ctx.spaceId)));
        });

        result.appliedOps.push('capability.binding.remove');
        result.applied = true;

        logger.info(
          `[capabilityBindingApply] Removed binding '${bindingId}' (space ${ctx.spaceId})`,
        );
        break;
      }

      // All non-capability ops are invalid for this kind.
      case 'platform_issue':
      case 'skill_compose':
      case 'update_task_goal':
      case 'update_task_context_spec':
      case 'update_task_dependencies':
      case 'add_task':
      case 'replace_task':
      case 'remove_task':
      case 'reorder_tasks':
      case 'update_outcome_threshold':
      case 'update_activation_hint':
      case 'add_trigger_pattern':
      case 'update_iteration_policy':
      case 'promote_context_strategy':
      case 'flag_pattern':
      case 'block_workflow':
      case 'unblock_workflow':
      case 'update_workflow_contract':
      case 'amend_directives':
      case 'eval.criterion.add':
      case 'eval.criterion.remove':
      case 'eval.criterion.update':
      case 'update_goal':
      case 'campaign.field.add':
      case 'campaign.field.update':
      case 'campaign.field.remove':
      case 'store_install':
      case 'update_artifact':
      case 'eval_case_draft':
        throw new RatificationApplyError(
          op.op,
          `Op '${op.op}' is not valid for capability_binding kind`,
        );
    }
  }

  return result;
}
