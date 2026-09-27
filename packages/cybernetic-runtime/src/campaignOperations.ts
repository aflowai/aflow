/**
 * Campaign write operations as pure, transport-agnostic functions returning
 * discriminated results. Shared by the orchestrator inline-ops (agent path)
 * and the server's REST routes (operator path) so both produce identical
 * campaigns and identical error semantics — there is no second copy of this
 * logic. Transport adapters map `{ ok: false, code, message, details }` onto
 * their own surface (step error / HTTP status).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  Campaign,
  CampaignConfigChange,
  CampaignEndedReason,
  MaterializedSkillGoal,
  SkillCampaignContract,
  SkillGoal,
} from '@aflow/schemas';
import {
  resolveCampaignGoal,
  deriveGoalRef,
  extractCampaignIdentityValues,
  hashCampaignContract,
  PROCESS_CAMPAIGN_SCORE_METRIC,
} from '@aflow/schemas';

import { resolveSkillForWorkflow } from './skill.js';
import {
  getActiveCampaign,
  ensureActiveCampaign,
  updateCampaignConfig,
  endCampaign,
  getCampaignById,
} from './campaigns.js';
import {
  validateCampaignConfig,
  validateCampaignConfigUpdate,
  renderCampaignConfigIssues,
  deriveCampaignContractJsonSchema,
  diffCampaignConfig,
} from './campaignConfig.js';
import { getCampaignInSpace } from './campaignViews.js';

/** A failed campaign operation — `code`/`message`/`details` ride to the caller. */
export interface CampaignOpError {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Skill / goal resolution helpers (shared by start, update and run.start)
// ---------------------------------------------------------------------------

/** Numeric goal + (optional) campaign contract for a skill's workflow slug. */
export type CampaignSkillResolution =
  | {
      ok: true;
      goal: Extract<SkillGoal, { type: 'numeric' }>;
      contract: SkillCampaignContract | null;
    }
  | { ok: false; code: 'SKILL_NOT_FOUND' | 'CAMPAIGN_GOAL_NOT_NUMERIC'; message: string };

export async function resolveCampaignSkill(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slug: string,
): Promise<CampaignSkillResolution> {
  const skill = await resolveSkillForWorkflow({ db, tenantId, spaceId }, slug);
  if (!skill) {
    return {
      ok: false,
      code: 'SKILL_NOT_FOUND',
      message:
        `No skill owns workflow slug "${slug}" in this space — campaigns are skill instances. ` +
        'Check the slug with workflow.manage.list.',
    };
  }
  const goal = skill.manifest.goal;
  if (goal.type !== 'numeric') {
    return {
      ok: false,
      code: 'CAMPAIGN_GOAL_NOT_NUMERIC',
      message:
        `Skill "${slug}" has a ${goal.type} goal — campaigns track numeric goals ` +
        '(metricKey + direction). There is nothing to campaign over.',
    };
  }
  return { ok: true, goal, contract: skill.manifest.campaign ?? null };
}

export type MaterializedNumericGoal = Extract<MaterializedSkillGoal, { type: 'numeric' }>;

/**
 * The NOT-NULL `(scoreMetricKey, direction)` a campaign row must carry, derived
 * from the materialized goal. A numeric goal contributes its own metric +
 * direction; an objective goal is a PROCESS campaign scored on completion under
 * the {@link PROCESS_CAMPAIGN_SCORE_METRIC} sentinel, direction `maximize`
 * (1 = success is the better outcome). There is no nullable-metric path.
 */
export function deriveCampaignScoreColumns(goal: MaterializedSkillGoal): {
  scoreMetricKey: string;
  direction: 'maximize' | 'minimize';
} {
  if (goal.type === 'numeric') {
    return { scoreMetricKey: goal.metricKey, direction: goal.direction };
  }
  return { scoreMetricKey: PROCESS_CAMPAIGN_SCORE_METRIC, direction: 'maximize' };
}

export function materializeNumericCampaignGoal(
  goal: Extract<SkillGoal, { type: 'numeric' }>,
  config: Record<string, unknown>,
  slug: string,
):
  | { ok: true; goal: MaterializedNumericGoal }
  | { ok: false; code: 'CAMPAIGN_GOAL_UNRESOLVED'; message: string } {
  const resolved = resolveCampaignGoal({ goal }, config);
  if (!resolved.ok || resolved.goal.type !== 'numeric') {
    return {
      ok: false,
      code: 'CAMPAIGN_GOAL_UNRESOLVED',
      message:
        `Skill "${slug}"'s goal could not be materialized against the campaign config` +
        (resolved.ok ? '.' : `: ${resolved.reason}.`) +
        ' A $campaign-parameterized goal requires a campaign contract declaring the referenced ' +
        'field — fix the skill (workflow.manage.get surfaces the contract diagnostics).',
    };
  }
  return { ok: true, goal: resolved.goal };
}

export type CreateContractedCampaignResult =
  { ok: true; campaign: Campaign; created: boolean } | CampaignOpError;

/**
 * Validate `config` against the manifest contract → materialize the goal →
 * derive the instance identity → create-or-return the active campaign
 * (idempotent on identity; differing config on an existing identity is a
 * conflict, not a silent overwrite). The create primitive shared by
 * `workflow.campaign.start` AND `workflow.run.start`'s create-on-first-run
 * path — so both routes produce identical campaigns.
 *
 * Accepts a numeric OR an objective goal. A numeric goal carries its own
 * `(scoreMetricKey, direction)`; an objective goal is a PROCESS campaign scored
 * on completion (`deriveCampaignScoreColumns`). Both columns are NOT-NULL.
 */
export async function createContractedCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  params: {
    spaceId: string;
    slug: string;
    goal: Exclude<SkillGoal, { type: 'subjective' }>;
    contract: SkillCampaignContract;
    config: Record<string, unknown>;
  },
): Promise<CreateContractedCampaignResult> {
  const { spaceId, slug, goal, contract, config } = params;

  const validation = validateCampaignConfig(contract, config);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'CAMPAIGN_CONFIG_INVALID',
      message: renderCampaignConfigIssues(slug, validation.issues),
      details: {
        issues: validation.issues,
        campaignContract: deriveCampaignContractJsonSchema(contract),
      },
    };
  }

  // A numeric goal may carry a `$campaign` direction ref that resolves against
  // the validated config; an objective goal passes through unchanged.
  const materialized = resolveCampaignGoal({ goal }, validation.validatedConfig);
  if (!materialized.ok) {
    return {
      ok: false,
      code: 'CAMPAIGN_GOAL_UNRESOLVED',
      message:
        `Skill "${slug}"'s goal could not be materialized against the campaign config: ` +
        `${materialized.reason}. A $campaign-parameterized goal requires a campaign contract ` +
        'declaring the referenced field — fix the skill (workflow.manage.get surfaces the diagnostics).',
    };
  }
  const concreteGoal = materialized.goal;
  const { scoreMetricKey, direction } = deriveCampaignScoreColumns(concreteGoal);

  const identityValues = extractCampaignIdentityValues(contract, validation.validatedConfig);
  const goalRef = deriveGoalRef(slug, concreteGoal, identityValues);

  const existing = await getActiveCampaign(db, tenantId, { spaceId, workflowSlug: slug, goalRef });
  if (existing) {
    const changedKeys = diffCampaignConfig(
      contract,
      existing.config ?? {},
      validation.validatedConfig,
    );
    if (changedKeys.length > 0) {
      return {
        ok: false,
        code: 'CAMPAIGN_CONFIG_CONFLICT',
        message:
          `An active campaign already exists for this identity (campaignId: "${existing.campaignId}") ` +
          `with different config for: [${changedKeys.join(', ')}]. Starting never overwrites — ` +
          `change mutable fields with workflow.campaign.update({ campaignId: "${existing.campaignId}", config: { … } }).`,
        details: { campaignId: existing.campaignId, changedKeys },
      };
    }
    return { ok: true, campaign: existing, created: false };
  }

  const campaign = await ensureActiveCampaign(db, tenantId, {
    spaceId,
    workflowSlug: slug,
    goalRef,
    scoreMetricKey,
    direction,
    config: validation.validatedConfig,
    contractHash: hashCampaignContract(contract),
  });
  // ensureActiveCampaign may return a concurrent winner whose config differs on
  // non-identity fields — surface the conflict instead of a mismatched campaign.
  const raceDiffs = diffCampaignConfig(contract, campaign.config ?? {}, validation.validatedConfig);
  if (raceDiffs.length > 0) {
    return {
      ok: false,
      code: 'CAMPAIGN_CONFIG_CONFLICT',
      message:
        `A concurrent campaign creation won with different config for: [${raceDiffs.join(', ')}] ` +
        `(campaignId: "${campaign.campaignId}"). Change mutable fields with workflow.campaign.update.`,
      details: { campaignId: campaign.campaignId, changedKeys: raceDiffs },
    };
  }
  return { ok: true, campaign, created: true };
}

// ---------------------------------------------------------------------------
// Operations: start / update / end
// ---------------------------------------------------------------------------

export type StartCampaignResult =
  { ok: true; campaign: Campaign; created: boolean } | CampaignOpError;

/**
 * Start (or idempotently return) a campaign for a skill. Config-less skills
 * campaign on goalRef alone; contracted skills validate `config` and create
 * on identity. Idempotent: an identical active campaign returns `created:false`.
 */
export async function startCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; slug: string; config?: Record<string, unknown> },
): Promise<StartCampaignResult> {
  const { spaceId, slug } = params;
  const config = params.config ?? {};

  const resolution = await resolveCampaignSkill(db, tenantId, spaceId, slug);
  if (!resolution.ok) return resolution;
  const { goal, contract } = resolution;

  if (!contract) {
    // Config-less skill: a campaign exists per goalRef alone; config has no
    // contract to validate against, so providing one is a caller error.
    if (Object.keys(config).length > 0) {
      return {
        ok: false,
        code: 'CAMPAIGN_CONTRACT_MISSING',
        message:
          `Skill "${slug}" declares no campaign contract (manifest.campaign) — there are no config ` +
          'fields to set. Start without `config`, or pass per-run values via workflow.run.start inputs.',
      };
    }
    const materialized = materializeNumericCampaignGoal(goal, {}, slug);
    if (!materialized.ok) return materialized;
    const concreteGoal = materialized.goal;
    const goalRef = deriveGoalRef(slug, concreteGoal, {});
    const existing = await getActiveCampaign(db, tenantId, {
      spaceId,
      workflowSlug: slug,
      goalRef,
    });
    const campaign =
      existing ??
      (await ensureActiveCampaign(db, tenantId, {
        spaceId,
        workflowSlug: slug,
        goalRef,
        scoreMetricKey: concreteGoal.metricKey,
        direction: concreteGoal.direction,
      }));
    return { ok: true, campaign, created: existing === null };
  }

  return createContractedCampaign(db, tenantId, { spaceId, slug, goal, contract, config });
}

export type UpdateCampaignResult =
  { ok: true; campaign: Campaign; changedKeys: string[] } | CampaignOpError;

/**
 * Mutate `mutable` non-identity config fields on an ACTIVE campaign. Identity
 * fields and goal direction are immutable; every effective change is
 * ledger-stamped on `campaign.configHistory`.
 */
export async function updateCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; campaignId: string; config: Record<string, unknown> },
): Promise<UpdateCampaignResult> {
  const { spaceId, campaignId, config } = params;

  const campaign = await getCampaignInSpace(db, tenantId, spaceId, campaignId);
  if (!campaign) {
    return {
      ok: false,
      code: 'CAMPAIGN_NOT_FOUND',
      message: `No campaign found with id "${campaignId}" in this space.`,
    };
  }
  if (campaign.status !== 'active') {
    return {
      ok: false,
      code: 'CAMPAIGN_ENDED',
      message:
        `Campaign "${campaignId}" has ended — its config is immutable history. ` +
        'Start a new campaign with workflow.campaign.start.',
    };
  }

  const resolution = await resolveCampaignSkill(db, tenantId, spaceId, campaign.workflowSlug);
  if (!resolution.ok) return resolution;
  if (!resolution.contract) {
    return {
      ok: false,
      code: 'CAMPAIGN_CONTRACT_MISSING',
      message:
        `Skill "${campaign.workflowSlug}" declares no campaign contract — campaign ` +
        `"${campaignId}" is config-less and has nothing to update.`,
    };
  }
  const contract = resolution.contract;

  const validation = validateCampaignConfigUpdate(contract, config);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'CAMPAIGN_CONFIG_INVALID',
      message: renderCampaignConfigIssues(campaign.workflowSlug, validation.issues),
      details: { issues: validation.issues },
    };
  }

  const currentConfig = campaign.config ?? {};
  const mergedConfig = { ...currentConfig, ...validation.validatedConfig };
  const changedKeys = diffCampaignConfig(contract, currentConfig, mergedConfig);
  if (changedKeys.length === 0) {
    // Nothing effectively changed — idempotent no-op, no ledger entry.
    return { ok: true, campaign, changedKeys: [] };
  }

  const remat = materializeNumericCampaignGoal(
    resolution.goal,
    mergedConfig,
    campaign.workflowSlug,
  );
  if (!remat.ok) return remat;
  if (remat.goal.direction !== campaign.direction) {
    return {
      ok: false,
      code: 'CAMPAIGN_DIRECTION_IMMUTABLE',
      message:
        `This update would flip the campaign's goal direction (${campaign.direction} → ` +
        `${remat.goal.direction}). The direction is materialized into the campaign's identity, ` +
        'score series, and trajectory — a different direction is a DIFFERENT campaign. End this ' +
        'one (workflow.campaign.end) and start a new one with workflow.campaign.start.',
    };
  }

  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of changedKeys) {
    previous[key] = currentConfig[key];
    next[key] = validation.validatedConfig[key];
  }
  const change: CampaignConfigChange = {
    changedAt: new Date().toISOString(),
    changedKeys,
    previous,
    next,
  };

  const updated = await updateCampaignConfig(db, tenantId, {
    campaignId: campaign.campaignId,
    config: mergedConfig,
    change,
  });
  if (!updated) {
    // CAS miss — the campaign ended between the read above and the write.
    return {
      ok: false,
      code: 'CAMPAIGN_ENDED',
      message: `Campaign "${campaignId}" ended concurrently — config not changed.`,
    };
  }

  return { ok: true, campaign: updated, changedKeys };
}

export type EndCampaignResult =
  | {
      ok: true;
      campaign: Campaign;
      /** True only when THIS call transitioned active → ended — the caller's
       *  cue for end-of-campaign side effects (never fired on the idempotent
       *  already-ended reply). */
      endedNow: boolean;
    }
  | CampaignOpError;

/** Idempotent: ending an already-ended campaign returns it unchanged. */
export async function endCampaignInSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; campaignId: string; reason: CampaignEndedReason },
): Promise<EndCampaignResult> {
  const { spaceId, campaignId, reason } = params;

  const campaign = await getCampaignInSpace(db, tenantId, spaceId, campaignId);
  if (!campaign) {
    return {
      ok: false,
      code: 'CAMPAIGN_NOT_FOUND',
      message: `No campaign found with id "${campaignId}" in this space.`,
    };
  }
  if (campaign.status === 'ended') {
    return { ok: true, campaign, endedNow: false };
  }

  const ended = await endCampaign(db, tenantId, campaignId, reason);
  if (!ended) {
    // CAS miss — already ended concurrently; re-read for the idempotent reply.
    const current = await getCampaignById(db, tenantId, campaignId);
    return { ok: true, campaign: current ?? campaign, endedNow: false };
  }
  return { ok: true, campaign: ended, endedNow: true };
}
