/**
 * One trial, in enough detail to name a suspect (Plan 300 §5.6).
 *
 * A batch read answers "what failed" — verdict and a pass fraction. It does
 * not answer "which of the three exits is this", and the three exits are the
 * whole product: a failure belongs to the contract, to the instructions, or to
 * the case, and the evidence separating them is different in each direction.
 *
 * So this view carries the four artifacts an attribution actually needs, for a
 * single trial rather than a whole batch — a batch of 200 cases at 10 trials
 * would be an unbounded read, and nobody attributes 2000 trials at once:
 *
 *   - `expectationResults` — which check fired, and what it saw
 *   - `rubricResults` — what the judges made of the same answer, which is how
 *     a wrong CHECK is told apart from a wrong answer
 *   - `trajectory` — the endpoints the run reached, the contract exit
 *   - `reply` — what the subject actually said, the instruction exit
 *
 * This read is operator-only and deliberately has no operation: `eval.*` ops
 * are the Helmsman-permitted management slice, and attribution is analysis,
 * not management.
 */
import { z } from 'zod';
import {
  EvalCaseResultDispositionSchema,
  EvalCaseRubricResultSchema,
  EvalCaseTrialVerdictSchema,
  ExpectationResultSchema,
} from './evalBatch.js';

/**
 * One simulated call the trial made, as the journal recorded it.
 *
 * `mutated` rather than the delta itself: whether a call CHANGED the world is
 * the fact an attribution turns on — a desk that says it opened a case and did
 * not is visible here — while the delta body belongs to the world inspector.
 */
export const EvalTrialCallViewSchema = z.object({
  /**
   * Position in the call sequence, 0-based.
   *
   * NOT the journal's `ordinal`, which counts calls per endpoint and is 0 for
   * the first call to each — sorting a trajectory by it interleaves endpoints
   * and reports an order the run never took. The array is already in journal
   * order; this numbers it so a consumer that re-sorts still gets it right.
   */
  sequence: z.number().int().nonnegative(),
  simulationId: z.string().min(1).max(200),
  endpointId: z.string().min(1).max(200),
  responseStatus: z.number().int(),
  mutated: z.boolean(),
});
export type EvalTrialCallView = z.infer<typeof EvalTrialCallViewSchema>;

export const EvalTrialDetailViewSchema = z.object({
  batchId: z.string().uuid(),
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().optional(),
  trial: z.number().int().positive(),
  disposition: EvalCaseResultDispositionSchema,
  verdict: EvalCaseTrialVerdictSchema.optional(),
  runId: z.string().optional(),
  runStatus: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']).optional(),
  /**
   * Absent when the case carries no deterministic expectations at all — a
   * judge-only case has no fraction to report, which is not the same as a
   * record that could not be read. `resultsReadable` tells them apart.
   */
  fractionPassed: z.number().min(0).max(1).optional(),
  /**
   * False when the grader's stored record did not parse, so every result
   * field below is empty because nothing was read. A readable record with no
   * expectations reads identically and means the opposite, and only this
   * field separates them.
   */
  resultsReadable: z.boolean().default(true),
  gradingError: z.string().max(2000).optional(),
  expectationResults: z.array(ExpectationResultSchema).max(50).default([]),
  rubricResults: z.array(EvalCaseRubricResultSchema).max(10).default([]),
  /**
   * Rubric slots the judge stage never resolved. Non-empty means the judges
   * could not run at all, which is a different thing from judging and
   * disagreeing — and only this field tells them apart.
   */
  pendingRubrics: z.array(z.string().min(1).max(300)).max(10).default([]),
  trajectory: z.array(EvalTrialCallViewSchema).max(500).default([]),
  /**
   * What the subject said, for a run that stopped on a pause contract.
   * Absent when the run produced no pause contract, or when the reader had no
   * payload store to resolve it with — never silently empty-stringed, because
   * "said nothing" and "not fetched" lead to opposite conclusions.
   */
  reply: z.string().optional(),
  replyRef: z.string().optional(),
});
export type EvalTrialDetailView = z.infer<typeof EvalTrialDetailViewSchema>;
