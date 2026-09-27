import { z } from 'zod';
import type { MaterializedSkillGoal, SkillGoal } from './skill.js';
import type { EvalCriterion, MaterializedEvalCriterion } from './eval.js';
import type { MaterializedOutcome, Outcome } from '../operations/workflow/outcome.js';

// ============================================================================
// Shared slot vocabularies (single source — slot owners derive their enums)
// ============================================================================

/** Direction literals a numeric goal / campaign may take. */
export const CAMPAIGN_GOAL_DIRECTIONS = ['maximize', 'minimize'] as const;
export type CampaignGoalDirection = (typeof CAMPAIGN_GOAL_DIRECTIONS)[number];

/** Threshold comparison operators (eval criteria + outcome evaluators). */
export const THRESHOLD_OPERATORS = ['lt', 'lte', 'gt', 'gte', 'eq', 'between'] as const;
export type ThresholdOperator = (typeof THRESHOLD_OPERATORS)[number];
export const ThresholdOperatorSchema = z.enum(THRESHOLD_OPERATORS);

/**
 * Direction-aware threshold comparison — the ONE operator switch shared by
 * `evaluateCriterion`, `workflow.evaluate`, and the campaign goal-met check
 * (DRY: this logic previously existed in three copies).
 */
export function compareWithThresholdOperator(
  value: number,
  operator: ThresholdOperator,
  target: number,
  targetHigh?: number,
): boolean {
  switch (operator) {
    case 'lt':
      return value < target;
    case 'lte':
      return value <= target;
    case 'gt':
      return value > target;
    case 'gte':
      return value >= target;
    case 'eq':
      return value === target;
    case 'between':
      return value >= target && value <= (targetHigh ?? target);
  }
}

// ============================================================================
// Reference grammar
// ============================================================================

/**
 * Campaign field keys are identifier-shaped so they compose into both the
 * `$campaign` grammar and `campaign_input` binding paths without escaping.
 * Kept in lockstep with `SkillCampaignContractSchema`'s key rule (skill.ts
 * imports THIS constant).
 */
export const CAMPAIGN_FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * A `$campaign` reference as it appears in a skill document. `map` is the
 * enum-mapped form: the referenced field's (string-enum) value selects a slot
 * literal. Slot owners constrain `map` values to the slot's literal type via
 * {@link campaignParam}; this structural type is what the runtime resolvers
 * narrow against.
 */
export interface CampaignRef {
  $campaign: string;
  map?: Record<string, unknown> | undefined;
}

/**
 * Build the schema union `slot | $campaign-ref` for one parameterizable slot.
 * The ref's `map` values are constrained to the slot's own literal schema, so
 * an enum-mapped ref with an invalid mapped value fails parse — map-value
 * validity is enforced by the schema, not a separate rule.
 */
export function campaignParam<T extends z.ZodTypeAny>(slot: T) {
  return z.union([
    slot,
    z
      .object({
        $campaign: z.string().min(1).max(64).regex(CAMPAIGN_FIELD_KEY_RE),
        map: z.record(z.string().min(1).max(128), slot).optional(),
      })
      .strict(),
  ]);
}

/** Structural narrow: is this slot value a `$campaign` reference? */
export function isCampaignRef(value: unknown): value is CampaignRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['$campaign'] === 'string'
  );
}

const THRESHOLD_OPERATOR_SYMBOLS: Record<ThresholdOperator, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
  between: 'between',
};

/** Render a `$campaign`-parameterized slot for operator-facing copy. */
export function formatCampaignParamForDisplay(value: unknown): string {
  if (isCampaignRef(value)) return `campaign.${value.$campaign}`;
  return String(value);
}

/** Render a threshold operator (literal or `$campaign` ref) for display. */
export function formatThresholdOperatorForDisplay(
  operator: ThresholdOperator | CampaignRef,
): string {
  if (isCampaignRef(operator)) return `(campaign.${operator.$campaign})`;
  return THRESHOLD_OPERATOR_SYMBOLS[operator];
}

// ============================================================================
// Resolution — the read-time half (never written back into the doc)
// ============================================================================

export type CampaignParamResolution<T> = { ok: true; value: T } | { ok: false; reason: string };

function resolveRefRaw(
  ref: CampaignRef,
  config: Record<string, unknown>,
): CampaignParamResolution<unknown> {
  const raw = config[ref.$campaign];
  if (raw === undefined) {
    return {
      ok: false,
      reason: `campaign config has no value for "$campaign": "${ref.$campaign}"`,
    };
  }
  if (ref.map !== undefined) {
    const key = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : undefined;
    if (key === undefined || !Object.prototype.hasOwnProperty.call(ref.map, key)) {
      return {
        ok: false,
        reason:
          `map on "$campaign": "${ref.$campaign}" has no entry for config value ` +
          JSON.stringify(raw),
      };
    }
    return { ok: true, value: ref.map[key] };
  }
  return { ok: true, value: raw };
}

/** Resolve a number slot (`target`): value must resolve to a finite number. */
export function resolveCampaignNumberParam(
  value: number | CampaignRef,
  config: Record<string, unknown>,
): CampaignParamResolution<number> {
  if (!isCampaignRef(value)) return { ok: true, value };
  const r = resolveRefRaw(value, config);
  if (!r.ok) return r;
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
    return {
      ok: false,
      reason:
        `"$campaign": "${value.$campaign}" resolved to ${JSON.stringify(r.value)} — ` +
        'this slot requires a finite number',
    };
  }
  return { ok: true, value: r.value };
}

/** Resolve an enum slot (`direction`, `operator`): result must be an allowed literal. */
export function resolveCampaignEnumParam<T extends string>(
  value: T | CampaignRef,
  config: Record<string, unknown>,
  allowed: readonly T[],
): CampaignParamResolution<T> {
  if (!isCampaignRef(value)) return { ok: true, value };
  const r = resolveRefRaw(value, config);
  if (!r.ok) return r;
  if (typeof r.value !== 'string' || !(allowed as readonly string[]).includes(r.value)) {
    return {
      ok: false,
      reason:
        `"$campaign": "${value.$campaign}" resolved to ${JSON.stringify(r.value)} — ` +
        `this slot requires one of [${allowed.join(', ')}]` +
        (value.map === undefined ? ' (add a `map` to translate enum values)' : ''),
    };
  }
  return { ok: true, value: r.value as T };
}

// ============================================================================

export type ResolveCampaignGoalResult =
  { ok: true; goal: MaterializedSkillGoal } | { ok: false; reason: string };

/** Does this goal carry any `$campaign` reference? */
export function goalHasCampaignRefs(goal: SkillGoal): boolean {
  return goal.type === 'numeric' && isCampaignRef(goal.direction);
}

/**
 * Materialize a (possibly campaign-parameterized) skill goal against a
 * campaign's validated config. Every consumer that needs a *materialized*
 * goal (`deriveGoalRef`, scoring, learning injection, campaign-row creation)
 * goes through here — there is no second substitution mechanism.
 *
 * - With a run in scope, pass the run's campaign config (`campaign.config`).
 * - For skills without `$campaign` refs, pass `{}` — concrete goals pass
 *   through unchanged.
 * - Without a campaign in scope, a parameterized goal is **not resolvable**:
 *   carry it as parameterized (projection/surface reads) instead of faking a
 *   direction.
 */
export function resolveCampaignGoal(
  manifest: { goal: SkillGoal },
  config: Record<string, unknown>,
): ResolveCampaignGoalResult {
  const goal = manifest.goal;
  if (goal.type !== 'numeric') return { ok: true, goal };
  const direction = resolveCampaignEnumParam<CampaignGoalDirection>(
    goal.direction,
    config,
    CAMPAIGN_GOAL_DIRECTIONS,
  );
  if (!direction.ok) return { ok: false, reason: `goal.direction: ${direction.reason}` };
  return {
    ok: true,
    goal: { type: 'numeric', metricKey: goal.metricKey, direction: direction.value },
  };
}

// ============================================================================
// Eval criterion / outcome resolution (the once-per-eval step — §4.3)
// ============================================================================

/** Does this criterion carry any `$campaign` reference? (threshold only) */
export function criterionHasCampaignRefs(criterion: EvalCriterion): boolean {
  return (
    criterion.type === 'threshold' &&
    (isCampaignRef(criterion.operator) || isCampaignRef(criterion.target))
  );
}

export type ResolveEvalCriterionResult =
  { ok: true; criterion: MaterializedEvalCriterion } | { ok: false; reason: string };

/**
 * Replace `$campaign` refs in one eval criterion with concrete values.
 * Non-threshold criteria pass through unchanged (they have no parameterizable
 * slots). `evaluateCriterion` itself stays dumb — it receives the resolved
 * criterion this function produces.
 */
export function resolveEvalCriterionParams(
  criterion: EvalCriterion,
  config: Record<string, unknown>,
): ResolveEvalCriterionResult {
  if (criterion.type !== 'threshold') return { ok: true, criterion };
  const operator = resolveCampaignEnumParam<ThresholdOperator>(
    criterion.operator,
    config,
    THRESHOLD_OPERATORS,
  );
  if (!operator.ok) return { ok: false, reason: `operator: ${operator.reason}` };
  const target = resolveCampaignNumberParam(criterion.target, config);
  if (!target.ok) return { ok: false, reason: `target: ${target.reason}` };
  return {
    ok: true,
    criterion: { ...criterion, operator: operator.value, target: target.value },
  };
}

/** Does this outcome's evaluator carry any `$campaign` reference? */
export function outcomeHasCampaignRefs(outcome: Outcome): boolean {
  const ev = outcome.evaluator;
  return ev.type === 'threshold' && (isCampaignRef(ev.operator) || isCampaignRef(ev.target));
}

export type ResolveOutcomeResult =
  { ok: true; outcome: MaterializedOutcome } | { ok: false; reason: string };

/** Replace `$campaign` refs in one workflow outcome's evaluator. */
export function resolveOutcomeEvaluatorParams(
  outcome: Outcome,
  config: Record<string, unknown>,
): ResolveOutcomeResult {
  const ev = outcome.evaluator;
  if (ev.type !== 'threshold') return { ok: true, outcome: { ...outcome, evaluator: ev } };
  const operator = resolveCampaignEnumParam<ThresholdOperator>(
    ev.operator,
    config,
    THRESHOLD_OPERATORS,
  );
  if (!operator.ok) return { ok: false, reason: `evaluator.operator: ${operator.reason}` };
  const target = resolveCampaignNumberParam(ev.target, config);
  if (!target.ok) return { ok: false, reason: `evaluator.target: ${target.reason}` };
  return {
    ok: true,
    outcome: { ...outcome, evaluator: { ...ev, operator: operator.value, target: target.value } },
  };
}

// ============================================================================
// The campaign bar — where the goal target lives post-195
// ============================================================================

/**
 * The campaign-resolved goal bar: `SkillGoal.threshold` was DELETED (one home
 * for the bar, not two); the bar is the workflow's threshold outcome evaluator
 * on the goal metric, resolved against the campaign config.
 */
export interface CampaignTargetBar {
  outcomeId: string;
  operator: ThresholdOperator;
  target: number;
  targetHigh?: number;
}

/**
 * Resolve "the bar" for a campaign: the first threshold-type outcome
 * evaluator on `metricKey` that resolves cleanly against `config`. Returns
 * `null` when no outcome targets the goal metric or resolution fails (an
 * unresolved bar must never silently end a campaign as goal-met).
 */
export function resolveCampaignTargetBar(
  outcomes: readonly Outcome[],
  metricKey: string,
  config: Record<string, unknown>,
): CampaignTargetBar | null {
  for (const outcome of outcomes) {
    const ev = outcome.evaluator;
    if (ev.type !== 'threshold' || ev.metric !== metricKey) continue;
    const resolved = resolveOutcomeEvaluatorParams(outcome, config);
    if (!resolved.ok) continue;
    const rev = resolved.outcome.evaluator;
    if (rev.type !== 'threshold') continue;
    return {
      outcomeId: outcome.id,
      operator: rev.operator,
      target: rev.target,
      ...(rev.targetHigh !== undefined ? { targetHigh: rev.targetHigh } : {}),
    };
  }
  return null;
}
