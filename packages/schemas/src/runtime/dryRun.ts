import { z } from 'zod';
import type { SpaceWriteApprovalPolicy } from '../models/apiDefinition.js';

/**
 * Dry-run mode of a workflow run (`workflow.run.start` with `dryRun: true`).
 *
 * Every task runs with real agents and real model calls on the live stack, and
 * every validator and output contract runs at full strength. The platform
 * holds every write the run asks for, at the tier that would perform it: the
 * orchestrator holds platform writes (memory, campaign, learnings and the rest)
 * before they dispatch, and the API executor holds every API write tier as the
 * go-live rehearsal's write hold does. A held write succeeds with a
 * `DryRunHeldOutput`, so the task that asked for it reads what happened and
 * completes. The run records each held write, and its detail lists them.
 */

/**
 * Every tier a write can carry is held. The go-live rehearsal sets it as the
 * space's write policy, and a dry run composes it with each API write it holds.
 */
export const WRITE_HOLD_EVERY_TIER: SpaceWriteApprovalPolicy = {
  requireApprovalByTier: { low: true, medium: true, high: true },
};

/** A write the platform held in a dry run, as the step result and the run's record carry it. */
export const DryRunHeldWriteSchema = z.object({
  runId: z.string().min(1).describe('The dry run whose task asked for the write.'),
  operationId: z.string().min(1),
  target: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Where the write would have gone: an API method and endpoint, a memory path, or the operation.',
    ),
  preview: z
    .string()
    .max(8000)
    .optional()
    .describe('A redacted, bounded preview of what would have been written.'),
});
export type DryRunHeldWrite = z.infer<typeof DryRunHeldWriteSchema>;

export const DRY_RUN_HELD_MESSAGE =
  'This run is a dry run. The platform held this write, so nothing was written. Continue the task as if the write was accepted. Report what it would have done, and do not send it again.';

/** What a held write returns to the task that asked for it. */
export const DryRunHeldOutputSchema = z
  .object({
    dryRun: z.literal(true),
    held: z.literal(true),
    operationId: z.string(),
    target: z.string(),
    wouldWrite: z.string().optional(),
    message: z.string(),
  })
  .passthrough();
export type DryRunHeldOutput = z.infer<typeof DryRunHeldOutputSchema>;

/**
 * The held result a task reads. `echo` carries the addressing fields the write
 * named, such as a memory `path`, so a task that projects them from the write's
 * output reads the address it asked for.
 */
export function buildDryRunHeldOutput(
  held: DryRunHeldWrite,
  echo: Record<string, unknown> = {},
): DryRunHeldOutput {
  return {
    ...echo,
    dryRun: true,
    held: true,
    operationId: held.operationId,
    target: held.target,
    ...(held.preview !== undefined ? { wouldWrite: held.preview } : {}),
    message: DRY_RUN_HELD_MESSAGE,
  };
}

/** One held write in a dry run's detail. */
export const WorkflowRunHeldWriteSchema = DryRunHeldWriteSchema.extend({
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  stepExecutionId: z.string(),
  heldAt: z.string().datetime(),
});
export type WorkflowRunHeldWrite = z.infer<typeof WorkflowRunHeldWriteSchema>;
