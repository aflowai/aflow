/**
 * EvalTranscript — the universal evaluation input.
 * Built lazily from run_events + payload store after a run completes.
 */
import { z } from 'zod';

export const AgentTurnTranscriptSchema = z.object({
  stepExecutionId: z.string(),
  turnNumber: z.number().int().nonnegative(),
  decision: z.record(z.unknown()),
  reasoning: z.string().optional(),
  toolCalls: z.array(
    z.object({
      stepId: z.string(),
      operationId: z.string().optional(),
      args: z.unknown(),
      result: z.unknown().optional(),
      status: z.string(),
      durationMs: z.number(),
    }),
  ),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    // Optional so turns recorded before the split reached this schema stay
    // parseable, and so an unreported split stays distinguishable from a
    // measured zero. `promptTokens` answers context-window pressure; only the
    // split answers what was billed, and the two are separate questions.
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    uncachedPromptTokens: z.number().int().nonnegative().optional(),
  }),
  durationMs: z.number(),
  snapshotRef: z.string().optional(),
});
export type AgentTurnTranscript = z.infer<typeof AgentTurnTranscriptSchema>;

export const StepTranscriptSchema = z.object({
  stepExecutionId: z.string(),
  stepId: z.string(),
  stepType: z.string(),
  operationId: z.string().optional(),
  parentStepExecutionId: z.string().optional(),
  status: z.string(),
  inputRef: z.string().optional(),
  outputRef: z.string().optional(),
  errorRef: z.string().optional(),
  durationMs: z.number(),
  attempt: z.number().int().optional(),
});
export type StepTranscript = z.infer<typeof StepTranscriptSchema>;

export const EvalTranscriptSchema = z.object({
  runId: z.string(),
  flowId: z.string(),
  flowVersion: z.string().optional(),
  startedAtMs: z.number(),
  finishedAtMs: z.number(),
  totalDurationMs: z.number(),
  finalStatus: z.string(),
  finalOutputRef: z.string().optional(),
  finalOutput: z.unknown().optional(),
  turns: z.array(AgentTurnTranscriptSchema),
  steps: z.array(StepTranscriptSchema),
  totalTokens: z.object({
    prompt: z.number().int().nonnegative(),
    completion: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  totalToolCalls: z.number().int().nonnegative(),
  totalTurns: z.number().int().nonnegative(),
  modelsUsed: z.array(z.string()),
  runtimeState: z.record(z.unknown()).optional(),
  inputRef: z.string().optional(),
  input: z.unknown().optional(),
});
export type EvalTranscript = z.infer<typeof EvalTranscriptSchema>;
