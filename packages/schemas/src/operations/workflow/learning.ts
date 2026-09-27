import { z } from 'zod';
import {
  WorkflowLearningCategorySchema,
  WorkflowLearningKindSchema,
  WorkflowLearningSourceSchema,
} from './enums.js';

// ============================================================================
// Learning Schema
// ============================================================================

/** Cap shared by every field that carries a learning's prose verbatim —
 *  quoting surfaces must derive from this, never restate a number. */
export const WORKFLOW_LEARNING_TEXT_MAX_CHARS = 1500;

export const WorkflowLearningEvidenceSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  metrics: z.record(z.unknown()).optional(),
});

export const WorkflowLearningSchema = z.object({
  id: z.string().min(1).max(64),
  category: WorkflowLearningCategorySchema,
  kind: WorkflowLearningKindSchema.describe(
    'How this learning is governed. Fast-inject (co-injected into the next ' +
      'run with the campaign trajectory): search_heuristic (a search/strategy ' +
      'tactic), constraint (an approach to avoid), observation (a noticed ' +
      'correlation), next_direction (what to try next). Block-until-vetted ' +
      '(applied only after Coach promotion): objective_semantics, eval_semantics, ' +
      'workflow_structure, capability_scope, doctrine — anything that changes ' +
      'how the goal/eval/structure/scope is interpreted.',
  ),
  observation: z.string().min(1).max(WORKFLOW_LEARNING_TEXT_MAX_CHARS),
  interpretation: z.string().max(WORKFLOW_LEARNING_TEXT_MAX_CHARS).optional(),
  recommendation: z.string().max(WORKFLOW_LEARNING_TEXT_MAX_CHARS).optional(),
  detailRef: z
    .string()
    .max(512)
    .optional()
    .describe(
      'Memory doc path with the full notes behind this learning; read it when the ' +
        'one-line statement is not enough.',
    ),
  appliesToTaskIds: z
    .array(z.string().min(1).max(120))
    .max(20)
    .optional()
    .describe('Which workflow tasks this learning is for; absent = all tasks.'),
  evidence: WorkflowLearningEvidenceSchema,
  confidence: z.enum(['low', 'medium', 'high']),
  source: WorkflowLearningSourceSchema,
  tags: z.array(z.string().max(64)).max(10).optional(),
});
export type WorkflowLearning = z.infer<typeof WorkflowLearningSchema>;
