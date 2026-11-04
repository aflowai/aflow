/**
 * How a `host.harness.run` ended and what the harness spent, read from the
 * harness's own usage report rather than estimated by the executor.
 */
import { z } from 'zod';

export const HostHarnessUsageSchema = z
  .object({
    tokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
  })
  .describe(
    "What the harness reported it spent, summed over the run's turns and read from its own " +
      "usage report: Claude Code's result event, or Codex's completed turns. Claude Code's " +
      'tokens count input, output, cache writes and cache reads. Codex counts cached input ' +
      'inside its input and reports no cost. A count is null when the harness did not report ' +
      'it on every turn — a plain-text harness, or a turn cut short before its report.',
  );

export type HostHarnessUsage = z.infer<typeof HostHarnessUsageSchema>;

/** How a `host.harness.run` ended and what it spent, as its result reports both. */
export const HOST_HARNESS_RUN_END_SHAPE = {
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  usage: HostHarnessUsageSchema,
};
