/**
 * How many coding agents this machine runs at once.
 *
 * A machine-wide number in the machine's own policy file, beside the harnesses
 * it counts. The file holds it only once the operator chose one, so a machine
 * that never chose reads the default each time and follows a change of it.
 */
import type { z } from 'zod';

import { HOST_HARNESS_CONCURRENCY_DEFAULT } from '@aflow/schemas';

import type { HostPolicySchema } from './bindings.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;

export const CLEAR_HARNESS_CONCURRENCY = '--clear';

/** The policy with the operator's number, or with none for `--clear`. */
export function withHarnessConcurrency(policy: HostPolicy, requested: string): HostPolicy {
  const { maxConcurrentHarnessRuns: _current, ...rest } = policy;
  if (requested === CLEAR_HARNESS_CONCURRENCY) return rest;
  const count = /^[0-9]+$/.test(requested) ? Number(requested) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(
      `\`${requested}\` is not a number of coding agents. Name a whole number of at least one, ` +
        `or \`${CLEAR_HARNESS_CONCURRENCY}\` for the default.`,
    );
  }
  return { ...rest, maxConcurrentHarnessRuns: count };
}

/** One line, in the words the CLI prints. */
export function describeHarnessConcurrency(policy: HostPolicy): string {
  const count = policy.maxConcurrentHarnessRuns ?? HOST_HARNESS_CONCURRENCY_DEFAULT;
  const agents = count === 1 ? 'one coding agent' : `${String(count)} coding agents`;
  const chosen = policy.maxConcurrentHarnessRuns === undefined ? ', the default' : '';
  return `runs ${agents} at once${chosen}; a run past that waits for one to end`;
}
