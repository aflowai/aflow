import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const LearnerLearningResolveInputSchema = z.object({
  /** Durable Coach learning to resolve (coach_learnings id). */
  learningId: z.string().uuid(),
  action: z
    .enum(['ratify', 'reject'])
    .describe(
      'ratify: a staged (proposed) learning becomes durable and starts injecting. ' +
        'reject: the learning stops injecting — works on proposed and auto-recorded learnings.',
    ),
});
export type LearnerLearningResolveInput = z.infer<typeof LearnerLearningResolveInputSchema>;

export const LearnerLearningResolveOutputSchema = z.object({
  learningId: z.string().uuid(),
  status: z.enum(['ratified', 'rejected']),
});
export type LearnerLearningResolveOutput = z.infer<typeof LearnerLearningResolveOutputSchema>;

export const LearnerLearningResolveRegistration: OperationRegistration = {
  stepType: 'learner',
  group: 'learning',
  verb: 'resolve',
  name: 'Resolve Coach Learning',
  actionLabel: 'Resolving Coach learning…',
  semanticDescription:
    'Operator resolution of a durable Coach learning — the same authority the skill ' +
    'learnings panel exposes. Ratify promotes a staged (proposed) skill- or space-scope ' +
    'learning into the durable injected tier; reject stops it from injecting (a soft ' +
    'status transition — the audit trail and supersession chain stay intact). ' +
    'Op-task-only: this is an operator decision, never an agent tool call.',
  tags: ['learner', 'learning', 'cybernetic', 'coach', 'governance'],
  groupDisplayName: 'Coach Learnings',
  groupDescription:
    'Durable, compounding Coach learning records (heuristics, constraints, ranges).',
  idempotency: 'non_idempotent',
  mutates: true,
  opTaskOnly: true,
  usage: {
    oneLine: 'Ratify or reject a durable Coach learning (operator authority).',
    whenToUse: [
      'The operator approves a staged skill- or space-scope learning for durable injection',
      'The operator prunes a wrong or stale learning from the injected set (reject)',
    ],
    whenNotToUse: [
      'Resolving run-recorded candidates — use learner.learning.resolve_candidate',
      'Merging or retiring the durable corpus — use learner.learning.consolidate',
    ],
    pitfalls: [
      'Only a staged (proposed) learning can be ratified; an auto-recorded one is already active and can only be rejected',
      'Rejection does not delete — the learning stays visible as resolved history',
    ],
    minimalExampleInput: {
      learningId: '00000000-0000-0000-0000-000000000000',
      action: 'ratify',
    },
  },
  accessMode: 'write',
  inputZod: LearnerLearningResolveInputSchema,
  outputZod: LearnerLearningResolveOutputSchema,
};
