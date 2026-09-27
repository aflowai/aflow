import AjvModule from 'ajv';
import type { Campaign, CampaignRequiredErrorDetails, SkillCampaignContract } from '@aflow/schemas';
import { isCampaignFieldMutable, stableHash } from '@aflow/schemas';

// `ajv` ships its constructor as the package default in ESM and as the module
// shape in CJS — mirror `parentTaskInputs.ts` so behaviour matches across
// both build outputs.
const AjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => (data: unknown) => boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
};
let _ajv: InstanceType<typeof AjvCtor> | undefined;
function getAjv(): InstanceType<typeof AjvCtor> {
  if (!_ajv) _ajv = new AjvCtor({ allErrors: true, strict: false });
  return _ajv;
}

// ============================================================================
// Config validation (workflow.campaign.start / update)
// ============================================================================

export interface CampaignConfigIssue {
  /** Contract field key (or the unknown key the caller provided). */
  field: string;
  /**
   * Stable code so callers can pattern-match:
   *   - `MISSING_FIELD`    — contract declares the field; config omits it
   *     (every contract field is required at campaign start).
   *   - `UNKNOWN_FIELD`    — config provides a key the contract doesn't declare.
   *   - `IMMUTABLE_FIELD`  — update targets an identity / `mutable: false` field.
   *   - `SCHEMA_VIOLATION` — value failed the field's JSON Schema.
   */
  code: 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'IMMUTABLE_FIELD' | 'SCHEMA_VIOLATION';
  /** Operator-facing detail, suitable for inclusion in the error message. */
  detail: string;
}

export type CampaignConfigValidationResult =
  | { ok: true; validatedConfig: Record<string, unknown> }
  | { ok: false; issues: CampaignConfigIssue[] };

function ajvIssueFor(
  field: string,
  schema: Record<string, unknown>,
  value: unknown,
): CampaignConfigIssue | null {
  const ajv = getAjv();
  const validator = ajv.compile(schema);
  if (validator(value)) return null;
  const errs =
    (validator as unknown as { errors?: Array<{ instancePath: string; message?: string }> })
      .errors ?? [];
  const summary = errs
    .slice(0, 3)
    .map((e) => `${e.instancePath || '<root>'}: ${e.message ?? 'invalid'}`)
    .join('; ');
  return {
    field,
    code: 'SCHEMA_VIOLATION',
    detail: `value failed the field's JSON Schema: ${summary || 'unknown error'}.`,
  };
}

/**
 * Full-config validation for `workflow.campaign.start`: every declared
 * contract field is required (the campaign carries the complete instance
 * config — partial instances would re-open the per-run forget loop), unknown
 * keys are rejected, and each value is Ajv-validated against its field schema.
 */
export function validateCampaignConfig(
  contract: SkillCampaignContract,
  config: Record<string, unknown>,
): CampaignConfigValidationResult {
  const issues: CampaignConfigIssue[] = [];

  for (const key of Object.keys(contract.fields)) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      issues.push({
        field: key,
        code: 'MISSING_FIELD',
        detail: `"${key}" is a declared campaign-contract field but is absent from \`config\`. All contract fields are required.`,
      });
    }
  }

  for (const [key, value] of Object.entries(config)) {
    const field = contract.fields[key];
    if (!field) {
      issues.push({
        field: key,
        code: 'UNKNOWN_FIELD',
        detail: `"${key}" is not a declared campaign-contract field.`,
      });
      continue;
    }
    const issue = ajvIssueFor(key, field.schema, value);
    if (issue) issues.push(issue);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validatedConfig: config };
}

/**
 * Patch validation for `workflow.campaign.update`: each provided key must be
 * declared, effectively mutable (non-identity and not `mutable: false`), and
 * schema-valid. Missing keys are fine — updates are partial by design.
 */
export function validateCampaignConfigUpdate(
  contract: SkillCampaignContract,
  configPatch: Record<string, unknown>,
): CampaignConfigValidationResult {
  const issues: CampaignConfigIssue[] = [];

  for (const [key, value] of Object.entries(configPatch)) {
    const field = contract.fields[key];
    if (!field) {
      issues.push({
        field: key,
        code: 'UNKNOWN_FIELD',
        detail: `"${key}" is not a declared campaign-contract field.`,
      });
      continue;
    }
    if (!isCampaignFieldMutable(field)) {
      issues.push({
        field: key,
        code: 'IMMUTABLE_FIELD',
        detail:
          field.identity === true
            ? `"${key}" is an identity field — immutable for the life of a campaign. A different ${key} is a DIFFERENT campaign: start one with workflow.campaign.start.`
            : `"${key}" is declared \`mutable: false\` and cannot be changed mid-campaign.`,
      });
      continue;
    }
    const issue = ajvIssueFor(key, field.schema, value);
    if (issue) issues.push(issue);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validatedConfig: configPatch };
}

/** Render config issues as a multi-line error message (one line per field). */
export function renderCampaignConfigIssues(slug: string, issues: CampaignConfigIssue[]): string {
  const lines = issues.map((i) => `  - "${i.field}" (${i.code}): ${i.detail}`);
  return `Campaign config failed validation against skill "${slug}"'s campaign contract:\n${lines.join('\n')}`;
}

// ============================================================================
// Contract → JSON Schema (the teach-by-schema surface)
// ============================================================================

/**
 * Derive one JSON Schema object describing the campaign contract — the shape
 * `CAMPAIGN_REQUIRED` error details carry and a `<SchemaForm>` can render.
 * Field `label`/`description` fold into `title`/`description`; every field is
 * required; `additionalProperties: false` mirrors the strict validator.
 */
export function deriveCampaignContractJsonSchema(
  contract: SkillCampaignContract,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(contract.fields)) {
    properties[key] = {
      ...field.schema,
      title: field.label,
      ...(field.description !== undefined ? { description: field.description } : {}),
    };
    required.push(key);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Compact prose listing of the contract's fields — `key (type)` or
 * `key (one of: a | b)` for enums. Carried inline in the agent-facing
 * `CAMPAIGN_REQUIRED` message so it stays self-contained even when the agent
 * reads only the message and not the structured `error.details` riding beside
 * it. Derived from the contract — never drifts.
 */
export function describeCampaignContractFields(contract: SkillCampaignContract): string {
  return Object.entries(contract.fields)
    .map(([key, field]) => {
      const schema = field.schema as { type?: unknown; enum?: unknown };
      const enumVals = Array.isArray(schema.enum) ? schema.enum : undefined;
      const typeDesc = enumVals
        ? `one of: ${enumVals.map((v) => String(v)).join(' | ')}`
        : typeof schema.type === 'string'
          ? schema.type
          : 'value';
      return `${key} (${typeDesc})`;
    })
    .join(', ');
}

/**
 * Build the structured `error.details` for `CAMPAIGN_REQUIRED` — the contract
 * as a JSON Schema plus a `WorkflowSuggestedAction`-shaped pointer back at
 * `workflow.run.start` with `campaignConfig` (the create-on-first-run path —
 * the same teach-by-schema move as `PARENT_INPUTS_INVALID`, one entry point).
 */
export function buildCampaignRequiredErrorDetails(
  slug: string,
  contract: SkillCampaignContract,
): CampaignRequiredErrorDetails {
  return {
    campaignContract: deriveCampaignContractJsonSchema(contract),
    suggestedAction: {
      op: 'workflow.run.start',
      args: { slug, campaignConfig: {} },
      preconditions:
        'Collect every field in details.campaignContract from the operator in ONE structured round. ' +
        'If you ask via human.chat.ask, set its inputSchema to details.campaignContract verbatim — do ' +
        'not re-author the schema, the declared field types must survive. Then re-issue ' +
        'workflow.run.start with the collected values as `campaignConfig` — it creates the campaign ' +
        'and starts the run in one call.',
    },
  };
}

// ============================================================================
// Config comparison (idempotent-on-identity start)
// ============================================================================

/**
 * Keys among the contract's declared fields whose values differ between two
 * configs (stable structural compare). Used by the idempotent-on-identity
 * `workflow.campaign.start`: same identity + zero diffs ⇒ return the existing
 * campaign; same identity + diffs ⇒ error directing to
 * `workflow.campaign.update` (no silent overwrite).
 */
export function diffCampaignConfig(
  contract: SkillCampaignContract,
  existingConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(contract.fields)) {
    const a = existingConfig[key];
    const b = newConfig[key];
    if (a === undefined && b === undefined) continue;
    if (stableHash({ v: a }) !== stableHash({ v: b })) out.push(key);
  }
  return out;
}

// ============================================================================
// Run-start campaign selection (THE START-TIME INVARIANT)
// ============================================================================

export type CampaignSelectionResult =
  /** A campaign was selected — persist `campaign.campaignId` on the run row. */
  | { ok: true; campaign: Campaign }
  /**
   * Nothing selected and nothing required: the skill has NO campaign contract
   * and the caller passed no explicit id — the caller ensures the config-less
   * campaign (identity = goalRef alone, pre-195 behavior).
   */
  | { ok: true; campaign: null }
  | { ok: false; code: 'CAMPAIGN_NOT_FOUND'; message: string }
  | {
      ok: false;
      code: 'CAMPAIGN_AMBIGUOUS';
      message: string;
      activeCampaigns: readonly Campaign[];
    }
  | { ok: false; code: 'CAMPAIGN_REQUIRED'; message: string };

export interface SelectCampaignForRunStartParams {
  workflowSlug: string;
  /** `workflow.run.start.campaignId` (explicit selection). */
  explicitCampaignId?: string;
  /** ACTIVE campaigns for `(spaceId, workflowSlug)` at start time. */
  activeCampaigns: readonly Campaign[];
  /** Whether the skill manifest declares a campaign contract. */
  hasCampaignContract: boolean;
}

export function selectCampaignForRunStart(
  params: SelectCampaignForRunStartParams,
): CampaignSelectionResult {
  const { workflowSlug, explicitCampaignId, activeCampaigns, hasCampaignContract } = params;

  if (explicitCampaignId !== undefined) {
    const found = activeCampaigns.find((c) => c.campaignId === explicitCampaignId);
    if (!found) {
      return {
        ok: false,
        code: 'CAMPAIGN_NOT_FOUND',
        message:
          `No ACTIVE campaign "${explicitCampaignId}" exists for skill "${workflowSlug}" in this space. ` +
          `List campaigns with workflow.campaign.list({ slug: "${workflowSlug}" }), or omit campaignId ` +
          'when exactly one campaign is active.',
      };
    }
    return { ok: true, campaign: found };
  }

  if (!hasCampaignContract) {
    // Config-less skills: the caller ensures the goalRef-identity campaign.
    return { ok: true, campaign: null };
  }

  if (activeCampaigns.length === 1) {
    return { ok: true, campaign: activeCampaigns[0]! };
  }

  if (activeCampaigns.length > 1) {
    return {
      ok: false,
      code: 'CAMPAIGN_AMBIGUOUS',
      activeCampaigns,
      message:
        `${String(activeCampaigns.length)} campaigns are active for skill "${workflowSlug}" — pass ` +
        '`campaignId` to workflow.run.start to pick one (candidates in error.details.activeCampaigns; ' +
        `browse with workflow.campaign.list({ slug: "${workflowSlug}" })).`,
    };
  }

  return {
    ok: false,
    code: 'CAMPAIGN_REQUIRED',
    message:
      `Skill "${workflowSlug}" declares a campaign contract: every run must belong to a campaign, and ` +
      'none is active in this space. Collect the contract fields (JSON Schema in ' +
      'error.details.campaignContract) from the operator once, then re-issue workflow.run.start with ' +
      'them as `campaignConfig` — it creates the campaign and starts the run in one call.',
  };
}
