import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { COACH_LEARNING_SUPERSEDES_MAX } from '../cybernetic/coachLearning.js';

export const LearnerConsolidationActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('merge'),
      survivorId: z
        .string()
        .uuid()
        .describe('Durable learning that absorbs the others and keeps injecting.'),
      absorbedIds: z
        .array(z.string().uuid())
        .min(1)
        .max(COACH_LEARNING_SUPERSEDES_MAX)
        .describe(
          'Learnings folded into the survivor — marked superseded, stop injecting, ' +
            'and are recorded on the survivor via `supersedes`.',
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal('retire'),
      learningId: z.string().uuid(),
      reason: z
        .enum(['internalized', 'stale'])
        .describe(
          'internalized: the learning is baked into the skill structure and no longer ' +
            'needs injecting. stale: it aged out — no longer relevant, no contradiction.',
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal('disprove'),
      learningId: z.string().uuid(),
      rationale: z
        .string()
        .min(1)
        .max(500)
        .describe('What contradicted the learning — kept on the record as negative evidence.'),
    })
    .strict(),
  z
    .object({
      action: z.literal('prune'),
      learningId: z
        .string()
        .uuid()
        .describe('Deletes the learning outright. For noise; disprove/retire keep the record.'),
    })
    .strict(),
]);
export type LearnerConsolidationAction = z.infer<typeof LearnerConsolidationActionSchema>;

export const LearnerLearningConsolidateInputSchema = z.object({
  actions: z.array(LearnerConsolidationActionSchema).min(1).max(50),
});
export type LearnerLearningConsolidateInput = z.infer<typeof LearnerLearningConsolidateInputSchema>;

export const LearnerLearningConsolidateOutputSchema = z.object({
  applied: z.array(
    z.object({
      action: z.enum(['merge', 'retire', 'disprove', 'prune']),
      learningIds: z.array(z.string().uuid()),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
export type LearnerLearningConsolidateOutput = z.infer<
  typeof LearnerLearningConsolidateOutputSchema
>;

export const LearnerLearningConsolidateRegistration: OperationRegistration = {
  stepType: 'learner',
  group: 'learning',
  verb: 'consolidate',
  name: 'Consolidate Learnings',
  actionLabel: 'Consolidating learnings…',
  semanticDescription:
    'Curate the durable learning corpus in one batched call: merge duplicates into a ' +
    'surviving learning, retire learnings that were internalized into skill structure or ' +
    'went stale, disprove learnings the evidence now contradicts, and prune noise. ' +
    'Everything except prune keeps the record (as negative or superseded evidence); only ' +
    'active learnings inject into runs, so consolidation is how the injected set shrinks ' +
    'back under budget.',
  tags: ['learner', 'learning', 'consolidation', 'cybernetic', 'coach'],
  groupDisplayName: 'Coach Learnings',
  groupDescription:
    'Durable, compounding Coach learning records (heuristics, constraints, ranges).',
  idempotency: 'idempotent',
  mutates: true,
  usage: {
    oneLine: 'Batch-curate durable learnings: merge, retire, disprove, or prune.',
    whenToUse: [
      'The brief shows the active learning set over budget (consolidation due)',
      'Two or more learnings state the same claim — merge them into the strongest one',
      'A ratified skill change baked a learning into structure — retire it as internalized',
      'Later runs contradicted a learning — disprove it with the contradicting evidence',
    ],
    whenNotToUse: [
      'Resolving run-recorded candidates — use learner.learning.resolve_candidate',
      'Recording a new learning — use learner.learning.record',
      'Operator ratify/reject of a proposed learning — that stays on the operator surface',
    ],
    pitfalls: [
      'Learning ids come from the durable-learnings block of the review brief or from workflow.manage.get / workflow.ledger.get activeLearnings[].learningId — never invent them',
      'prune deletes the record permanently — prefer retire/disprove so the corpus keeps negative evidence',
      'merge marks the absorbed learnings superseded; they stop injecting immediately',
      `A survivor's supersedes list caps at ${String(COACH_LEARNING_SUPERSEDES_MAX)}; a merge that would exceed it fails — pick a fresher survivor or prune instead`,
      'Actions apply per-entry: an unknown learning id fails that action and leaves the rest applied',
    ],
    minimalExampleInput: {
      actions: [
        {
          action: 'merge',
          survivorId: '00000000-0000-0000-0000-000000000001',
          absorbedIds: ['00000000-0000-0000-0000-000000000002'],
        },
        {
          action: 'retire',
          learningId: '00000000-0000-0000-0000-000000000003',
          reason: 'internalized',
        },
      ],
    },
  },
  accessMode: 'write',
  inputZod: LearnerLearningConsolidateInputSchema,
  outputZod: LearnerLearningConsolidateOutputSchema,
};
