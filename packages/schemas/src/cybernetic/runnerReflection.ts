import { z } from 'zod';
import { AgentConditionSchema } from './agentCondition.js';

// ============================================================================
// Blocker kinds — the signal_blocked category set (one vocabulary, not two)
// ============================================================================

export const BlockerKindSchema = z.enum([
  'missing_input',
  'ambiguous_requirement',
  'approval_required',
  'external_dependency',
  'access_denied',
  'capability_unavailable',
  'data_unavailable',
  'other',
]);

export type BlockerKind = z.infer<typeof BlockerKindSchema>;

// ============================================================================
// RunnerReflection
// ============================================================================

export const RunnerReflectionSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  /** Which terminal produced this reflection. */
  source: z.enum(['submit_output', 'signal_blocked']),
  condition: AgentConditionSchema.optional(),
  blockers: z
    .array(
      z.object({
        kind: BlockerKindSchema,
        detail: z.string().max(500),
      }),
    )
    .max(5)
    .optional(),
  missingInputs: z.array(z.string().max(200)).max(10).optional(),
  missingTools: z.array(z.string().max(128)).max(10).optional(),
  emittedAt: z.string().datetime(),
});

export type RunnerReflection = z.infer<typeof RunnerReflectionSchema>;

// ============================================================================
// Citable reflection fields — the Coach evidence citation contract
// ============================================================================

const REFLECTION_CITABLE_FIELDS = [
  'condition',
  'blockers',
  'missingInputs',
  'missingTools',
] as const satisfies ReadonlyArray<keyof RunnerReflection>;

export const ReflectionFieldSchema = z.enum(REFLECTION_CITABLE_FIELDS);
export type ReflectionField = z.infer<typeof ReflectionFieldSchema>;
