/**
 * The dispatch refusal for a channel step where no channel lane is composed
 * (Plan 327 D7).
 *
 * The catalog already withholds `channel.*` from an install without the lane.
 * A skill step or a direct call can still name one, and without this it would
 * park on an executor that will never come, because nothing is installed to
 * serve it. Scoped to the `channel` step type alone, as the coding lane's
 * breaker is to `code`: an absent `code`, `host` or `browser` lane still parks,
 * and a composed channel lane with no app online parks too.
 */
import { LaneRefusalError } from '../runtime/laneRefusal.js';
import { channelLaneComposed } from './descriptor.js';

export const CHANNEL_LANE_STEP_TYPE = 'channel';

export const LANE_NOT_COMPOSED_CODE = 'LANE_NOT_COMPOSED';

export class ChannelLaneAbsentError extends LaneRefusalError {
  readonly code = LANE_NOT_COMPOSED_CODE;
  readonly stepType = CHANNEL_LANE_STEP_TYPE;

  constructor(operationId: string) {
    super(
      `lane_not_composed: "${operationId}" needs the channel lane, which this deployment does ` +
        'not compose: no channel app is set up here. The operator sets one up with ' +
        '`yarn channel:slack setup` and restarts the stack. No retry or promotion can reach it.',
    );
    this.name = 'ChannelLaneAbsentError';
  }
}

/**
 * The refusal for a step type the channel lane governs, or undefined when the
 * step may proceed. Undefined for every step type that is not `channel`.
 */
export function channelLaneRefusal(
  stepType: string,
  operationId: string,
  env: NodeJS.ProcessEnv = process.env,
): ChannelLaneAbsentError | undefined {
  if (stepType !== CHANNEL_LANE_STEP_TYPE) return undefined;
  if (channelLaneComposed(env) === 'present') return undefined;
  return new ChannelLaneAbsentError(operationId);
}
