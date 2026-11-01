/**
 * How much of the machine the host lane's heavy work takes at once.
 *
 * Coding agents and folder checks each wait for a slot of their own, sized by
 * the machine's policy. A check runs outside the agents' count, since a
 * publication's check should not wait behind a two-hour commission, but never
 * beside another check: two test suites at once beside two agents load a
 * laptop until tests run out of time having failed at nothing.
 */
import type { LoadedHostPolicy } from './bindings.js';
import { COMMIT_CHECK_OPERATION } from './handlers/checkHandlers.js';
import { HARNESS_RUN_OPERATION } from './handlers/harnessHandlers.js';

/** What the runtime offers for a limit of an operation's own. */
export interface OperationLimits {
  limitOperation(operationId: string, maxConcurrent: number): void;
}

export type HostLaneLimits = Pick<
  LoadedHostPolicy,
  'maxConcurrentHarnessRuns' | 'maxConcurrentChecks'
>;

/** Set both lanes' limits from the policy; a later call changes them without ending anything. */
export function limitHostLanes(runtime: OperationLimits, limits: HostLaneLimits): void {
  runtime.limitOperation(HARNESS_RUN_OPERATION, limits.maxConcurrentHarnessRuns);
  runtime.limitOperation(COMMIT_CHECK_OPERATION, limits.maxConcurrentChecks);
}
