/**
 * The coding lane's breaker — the one switch that decides whether a deployment
 * runs the lane at all.
 *
 * It answers a different question from `spaces.code_policy`. The space policy
 * asks whether a particular space wants the lane; this asks whether the
 * deployment hosting that space is willing to run a credential-bearing agent
 * with network egress over a real git checkout. The deployment answer is read
 * first, and it is read at three points that do not depend on each other:
 * dispatch (nothing is enqueued), executor startup (nothing is consumed), and
 * per claimed job (nothing already queued is executed).
 *
 * Opt-in, which is the opposite polarity from a background task's feature gate
 * (`backgroundTaskFeatureEnabled` reads an unset variable as "on", so a task
 * predating its own gate keeps running). Here an unset variable is off, and so
 * is any value that is not an explicit yes: a deployment that has never heard of
 * the lane must not be running it, and a typo must not be what turns it on.
 */
import type { AflowError } from './errors.js';

export const CODE_LANE_ENABLED_ENV = 'CODE_LANE_ENABLED';

/** The step type whose job stream (`aflow:jobs:code`) the breaker governs. */
export const CODE_LANE_STEP_TYPE = 'code';

export const CODE_LANE_DISABLED_CODE = 'CODE_LANE_DISABLED';

export const CODE_LANE_DISABLED_MESSAGE =
  'The coding lane is switched off on this deployment, so no code operation can run. ' +
  `An operator turns it on by setting ${CODE_LANE_ENABLED_ENV}=true on every host that ` +
  'dispatches or executes code steps.';

/**
 * Exported because the host provisioning script decides the same question in
 * shell, and a host that read "set to anything" as armed would disagree with the
 * executor about whether the lane is on.
 */
export const CODE_LANE_AFFIRMATIVE_VALUES: readonly string[] = ['1', 'true', 'on', 'yes'];

const AFFIRMATIVE_VALUES: ReadonlySet<string> = new Set(CODE_LANE_AFFIRMATIVE_VALUES);

export function isCodeLaneEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[CODE_LANE_ENABLED_ENV];
  if (raw === undefined) return false;
  return AFFIRMATIVE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Carries its own classification so every path that surfaces it agrees on what
 * it means: a refusal, not an outage. `permission` + `retryable: false` is what
 * `toAgentToolError` needs to make an agent answer `signal_blocked` instead of
 * re-calling a lane that will never say yes.
 */
export class CodeLaneDisabledError extends Error {
  readonly stepType = CODE_LANE_STEP_TYPE;

  constructor(context?: string) {
    super(context ? `${CODE_LANE_DISABLED_MESSAGE} (${context})` : CODE_LANE_DISABLED_MESSAGE);
    this.name = 'CodeLaneDisabledError';
  }

  toAflowError(): AflowError {
    return {
      code: CODE_LANE_DISABLED_CODE,
      message: this.message,
      classification: 'permission',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * The refusal for a step type the breaker governs, or undefined when the step
 * type may proceed. Callers pass the step type rather than asking about the lane
 * directly, so a generic dispatch or consume path can consult the breaker
 * without knowing which lanes have one.
 */
export function codeLaneBreakerRefusal(
  stepType: string,
  context?: string,
  env: Record<string, string | undefined> = process.env,
): CodeLaneDisabledError | undefined {
  if (stepType !== CODE_LANE_STEP_TYPE) return undefined;
  if (isCodeLaneEnabled(env)) return undefined;
  return new CodeLaneDisabledError(context);
}
