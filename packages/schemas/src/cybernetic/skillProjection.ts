import { z } from 'zod';
import { SkillValiditySchema, type SkillValidity } from './skillValidity.js';

// ============================================================================
// Skill status
// ============================================================================

export const SkillStatusSchema = z.enum(['active', 'dormant', 'archived']);

export type SkillStatus = z.infer<typeof SkillStatusSchema>;

// ============================================================================
// Activation status (104g — registry-aware)
// ============================================================================

/**
 * Activation status — whether the skill can be offered for activation.
 *
 * - `active`: all `requiredCapabilities` are satisfied by credentialled bindings.
 * - `needs_binding`: one or more capabilities are missing. The Helmsman will not
 *   see this skill in its attention context. Operator Console shows the gap.
 * - `dormant`: manually deactivated or scarcity-decayed (independent of bindings).
 * - `archived`: permanently removed from the playbook.
 */
export const ActivationStatusSchema = z.enum([
  'active',
  'needs_binding',
  'degraded',
  'dormant',
  'archived',
]);

export type ActivationStatus = z.infer<typeof ActivationStatusSchema>;

// ============================================================================
// Skill maturity
// ============================================================================

export const SkillMaturitySchema = z.enum(['adhoc', 'practising', 'mastered']);

export type SkillMaturity = z.infer<typeof SkillMaturitySchema>;

// ============================================================================
// Skill Capability Dependency (104n §4.2)
// ============================================================================

/**
 * Derived dependency relationship between a skill and a capability surface.
 * Source of truth is the task-level grants; this is a denormalized projection
 * for console views, activation guards, and Coach assessment.
 */
/**
 * The kind-level capability token a coding skill requires (Plan 222 P2): satisfied
 * by ANY `status='ready'` repo designation in the space. Underscore form avoids
 * collision with the `code.repo` op capability GROUP (a permission gate, not a
 * resource). The per-run `repo` coordinate (campaign identity) is separate.
 */
export const CODE_REPO_CAPABILITY_ID = 'code_repo';

/**
 * Lane-credential capability tokens: satisfied space-wide when a backing
 * provider credential is resolvable (owner-user, space, or tenant scope).
 * They turn a mid-run executor failure ("no credential configured") into a
 * pre-run `needsSetup` diagnostic with a connect CTA.
 *
 * A coding task that PINS `backendProvider` in its input template requires
 * that exact provider (`code_model:zai`); an unpinned task accepts any
 * coding backend (`code_model`). Search gates only `search.web.search`
 * (Brave is hard-required by the handler; `search.web.fetch` runs keyless).
 */
export const CODE_MODEL_CAPABILITY_ID = 'code_model';
export const SEARCH_PROVIDER_CAPABILITY_ID = 'search_provider';

/** Credential providerIds satisfying the generic (unpinned) lane token. */
export const LANE_CAPABILITY_PROVIDERS: Record<string, readonly string[]> = {
  [CODE_MODEL_CAPABILITY_ID]: ['zai', 'anthropic', 'openai'],
  [SEARCH_PROVIDER_CAPABILITY_ID]: ['brave'],
};

/** Lane tokens a task's operation (+ pinned backend) requires. */
export function laneCapabilityTokensForTask(task: {
  operation?: string | null | undefined;
  inputTemplate?: unknown;
}): string[] {
  const op = task.operation;
  if (!op) return [];
  const tokens: string[] = [];
  if (op.split('.')[0] === 'code') {
    const tpl =
      task.inputTemplate && typeof task.inputTemplate === 'object'
        ? (task.inputTemplate as Record<string, unknown>)
        : undefined;
    const pinned = typeof tpl?.['backendProvider'] === 'string' ? tpl['backendProvider'] : null;
    tokens.push(pinned ? `${CODE_MODEL_CAPABILITY_ID}:${pinned}` : CODE_MODEL_CAPABILITY_ID);
  }
  if (op === 'search.web.search') tokens.push(SEARCH_PROVIDER_CAPABILITY_ID);
  return tokens;
}

/**
 * A pinned token subsumes the generic one: any key satisfying `code_model:P`
 * also satisfies `code_model`, so requiring both is redundant noise.
 */
export function subsumeLaneTokens(tokens: Iterable<string>): string[] {
  const set = new Set(tokens);
  if ([...set].some((t) => t.startsWith(`${CODE_MODEL_CAPABILITY_ID}:`))) {
    set.delete(CODE_MODEL_CAPABILITY_ID);
  }
  return [...set];
}

export function isLaneCapabilityToken(token: string): boolean {
  return (
    token === CODE_MODEL_CAPABILITY_ID ||
    token === SEARCH_PROVIDER_CAPABILITY_ID ||
    token.startsWith(`${CODE_MODEL_CAPABILITY_ID}:`)
  );
}

/** Providers that would satisfy an unmet lane token (null = not a lane token). */
export function laneProvidersForToken(token: string): readonly string[] | null {
  if (token.startsWith(`${CODE_MODEL_CAPABILITY_ID}:`)) {
    return [token.slice(CODE_MODEL_CAPABILITY_ID.length + 1)];
  }
  const generic = LANE_CAPABILITY_PROVIDERS[token];
  return generic ?? null;
}

/**
 * A deployment without a managed coding lane cannot run `code.*` whatever the
 * space enables or connects. Readiness reports that as one token in place of
 * the lane, repo and key tokens, so no surface asks for a key that cannot help.
 */
export const CODE_LANE_ABSENT_CAPABILITY_ID = 'code_lane_absent';

/** Tokens that only mean anything where a managed coding lane exists. */
export function isCodeLaneToken(token: string): boolean {
  return (
    token === 'code' ||
    token === CODE_REPO_CAPABILITY_ID ||
    token === CODE_MODEL_CAPABILITY_ID ||
    token.startsWith(`${CODE_MODEL_CAPABILITY_ID}:`)
  );
}

/**
 * Where the deployment composes no coding lane, the lane's tokens collapse into
 * `code_lane_absent`; everything else passes through unchanged.
 */
export function foldMissingCapabilitiesForAbsentCodeLane(
  missing: readonly string[],
  codeLane: 'present' | 'absent' | undefined,
): string[] {
  // Only a known absence folds; an unknown lane keeps every remedy visible.
  if (codeLane !== 'absent') return [...missing];
  const kept = missing.filter((token) => !isCodeLaneToken(token));
  return kept.length === missing.length ? kept : [CODE_LANE_ABSENT_CAPABILITY_ID, ...kept];
}

/**
 * What a missing capability token means and what closes it, as data for the
 * surfaces that carry the token: the space context's needs-setup entry, the
 * needs-capability pause contract and the Store's setup views. One text per
 * token keeps those surfaces from each describing the same gap differently.
 */
export function describeMissingCapability(token: string): string {
  if (token === CODE_LANE_ABSENT_CAPABILITY_ID) {
    return (
      'This deployment composes no managed coding lane, so no key, repository or space ' +
      'setting makes a code.* skill runnable here. Coding work on this edition runs through ' +
      'host.harness.run on a connected folder (This Computer).'
    );
  }
  if (token === 'code') {
    return 'The coding lane is switched off for this space; a space admin turns it on in space settings.';
  }
  if (token === CODE_REPO_CAPABILITY_ID) {
    return 'No coding repository is designated; designate one under Integrations → Repositories and link its GitHub connection.';
  }
  if (token.startsWith(`${CODE_MODEL_CAPABILITY_ID}:`)) {
    const provider = token.slice(CODE_MODEL_CAPABILITY_ID.length + 1);
    return `No ${provider} coding-lane key is connected; connect one under Settings → Credentials, Coding section.`;
  }
  if (token === CODE_MODEL_CAPABILITY_ID) {
    return `No coding-lane key is connected (${LANE_CAPABILITY_PROVIDERS[CODE_MODEL_CAPABILITY_ID]?.join(', ') ?? ''}); connect one under Settings → Credentials, Coding section.`;
  }
  if (token === SEARCH_PROVIDER_CAPABILITY_ID) {
    return 'No search key (Brave) is connected; connect one under Settings → Credentials.';
  }
  return `${token} has no bound integration in this space; bind one under Integrations.`;
}

export const SkillCapabilityDependencySchema = z.object({
  // 'repo' (Plan 222 P2): a coding-lane repo designation — satisfied space-wide by
  // ANY ready repo (kind-level), distinct from the per-run campaign coordinate.
  // 'lane': a lane-credential token (`code_model`, `search_provider`).
  capabilityType: z.enum(['api', 'mcp', 'operation', 'operationGroup', 'repo', 'lane']),
  capabilityId: z.string().min(1).max(128),
  bindingId: z.string().min(1).max(128).optional(),
  definitionId: z.string().min(1).max(128).optional(),
  taskIds: z.array(z.string().max(64)).min(1),
  endpoints: z
    .array(
      z.object({
        endpointId: z.string().min(1).max(128),
        revision: z.string().min(1).max(128).optional(),
        schemaHash: z.string().min(1).max(128).optional(),
      }),
    )
    .optional(),
  tools: z
    .array(
      z.object({
        toolName: z.string().min(1).max(128),
        schemaHash: z.string().min(1).max(128).optional(),
      }),
    )
    .optional(),
  status: z.enum(['ready', 'needs_binding', 'disabled', 'missing_endpoint', 'schema_drift']),
  missingEndpointIds: z.array(z.string().min(1).max(128)).max(50).optional(),
});

export type SkillCapabilityDependency = z.infer<typeof SkillCapabilityDependencySchema>;

// ============================================================================
// SkillProjection
// ============================================================================

export const SkillProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string().min(1).max(128),
  status: SkillStatusSchema.default('active'),
  /**
   * 104g: activation status — whether the skill can be offered for activation.
   * Computed by SkillProjectionReconciler from `requiredCapabilities` vs
   * credentialled bindings. Defaults to 'active' for backward compat with
   * pre-104g projections (skills without `requiredCapabilities` are always active).
   */
  activationStatus: ActivationStatusSchema.default('active'),
  /**
   * 104g: capability prefixes that are required but not yet satisfied by
   * credentialled bindings. Empty when `activationStatus` is 'active'.
   */
  missingCapabilities: z.array(z.string()).max(20).default([]),
  /**
   * 104n: derived capability dependencies from task-level grants.
   * Denormalized for console views, activation guards, and Coach assessment.
   * Source of truth is always the workflow task context.
   */
  capabilityDependencies: z.array(SkillCapabilityDependencySchema).max(100).default([]),
  contractValidity: SkillValiditySchema.optional(),
  contractValidityHash: z.string().min(1).max(128).optional(),
  lastUsedAt: z.string().datetime().optional(),
  usageCount: z.number().int().min(0).default(0),
  maturity: SkillMaturitySchema.default('practising'),
  projectedAt: z.string().datetime(),
});

export type SkillProjection = z.infer<typeof SkillProjectionSchema>;

// ============================================================================

/**
 * The three derived booleans that compose the two ORTHOGONAL readiness axes —
 * contract validity (this plan, space-independent) and activation/capability
 * (`activationStatus`, space-dependent). Deliberately NOT merged into one
 * enum: "your skill is fine, it just needs a binding" (`needsSetup`) must stay
 * distinguishable from "your skill's contract is broken" (`!contractValid`).
 */
export interface SkillReadiness {
  /** Config coherent vs current rules? (`SkillValidity.status === 'valid'`.) */
  contractValid: boolean;
  /** Truly callable now: contract-valid AND capabilities bound in this space. */
  canRun: boolean;
  /** Appears in lists (not archived/dormant) — shown even when not callable. */
  canShow: boolean;
  /** Valid skill missing a binding/credential — fixable by the operator, not the Coach. */
  needsSetup: boolean;
}

/**
 * Compose {@link SkillReadiness} from the two axes. `canRun` is deliberately
 * strict (only `active`): a `needs_binding`/`degraded` skill is shown and
 * marked `needsSetup`, never offered as callable, so the Helmsman routes around
 * it rather than into a guaranteed failure. A contract-`invalid` skill is
 * `canShow` but neither `canRun` nor `needsSetup` — it needs a Coach fix, and
 * the diagnostics say why (§6).
 *
 * `needsSetup` is precisely "valid skill, missing a binding/cred" — i.e.
 * `needs_binding`/`degraded` only, NOT archived/dormant (those are lifecycle
 * states, not operator-fixable setup gaps, and `canShow` already hides them).
 *
 * Fail-closed on a missing verdict: `contractValid` is `false` unless a
 * persisted `valid` verdict is present (§4 — never valid by omission).
 */
export function computeSkillReadiness(input: {
  contractValidity?: SkillValidity | undefined;
  activationStatus: ActivationStatus;
}): SkillReadiness {
  const contractValid = input.contractValidity?.status === 'valid';
  const { activationStatus } = input;
  return {
    contractValid,
    canRun: contractValid && activationStatus === 'active',
    canShow: activationStatus !== 'archived' && activationStatus !== 'dormant',
    needsSetup:
      contractValid && (activationStatus === 'needs_binding' || activationStatus === 'degraded'),
  };
}
