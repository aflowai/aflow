/**
 * A dispatch refused because the deployment will not run the step's lane.
 *
 * The base of every lane refusal `addStepJob` raises, so each dispatch path
 * answers them the one way a refusal is answered: the step fails at once with a
 * non-retryable `permission` error, which `toAgentToolError` turns into
 * `signal_blocked`, instead of waiting on an executor or retrying a lane that
 * will never say yes.
 */
import type { AflowError } from './errors.js';

export abstract class LaneRefusalError extends Error {
  abstract readonly code: string;
  abstract readonly stepType: string;

  toAflowError(): AflowError {
    return {
      code: this.code,
      message: this.message,
      classification: 'permission',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
  }
}
