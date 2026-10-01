import { z } from 'zod';

// --- workflow.run.latest ---

/**
 * How many of a skill's newest completed runs one call examines.
 *
 * A run's promoted values are read from its task outputs rather than a column,
 * so each run examined costs a payload read; the bound keeps one call's cost
 * flat however long the skill's history grows.
 */
export const WORKFLOW_RUN_LATEST_SCAN_LIMIT = 50;

export const WorkflowRunLatestInputSchema = z.object({
  slug: z.string().min(1).max(200).describe('The skill whose runs are searched, by its slug.'),
  match: z
    .object({
      stateVariable: z
        .string()
        .min(1)
        .max(200)
        .describe('A state variable the skill declares, such as `reviewedHead`.'),
      equals: z.string().min(1).describe('The value it must hold, compared exactly.'),
    })
    .optional()
    .describe(
      'Return the newest completed run whose promoted value matches. Absent, the newest ' +
        'completed run is returned whatever it holds.',
    ),
});
export type WorkflowRunLatestInput = z.infer<typeof WorkflowRunLatestInputSchema>;

export const WorkflowRunLatestOutputSchema = z.object({
  run: z
    .object({
      runId: z.string(),
      completedAt: z.string().datetime(),
      state: z
        .record(z.unknown())
        .describe(
          "The run's promoted values, keyed by state variable — a review's `verdict` and " +
            '`reviewedHead`, for one. Sensitive variables are left out.',
        ),
    })
    .nullable()
    .describe('Null when none of the newest completed runs matches.'),
  scanned: z
    .number()
    .int()
    .nonnegative()
    .describe(
      `How many completed runs were examined, newest first — at most ${String(WORKFLOW_RUN_LATEST_SCAN_LIMIT)}. ` +
        'A match older than those is not found.',
    ),
});
export type WorkflowRunLatestOutput = z.infer<typeof WorkflowRunLatestOutputSchema>;
