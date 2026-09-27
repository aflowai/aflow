import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const LearnerCandidateResolutionSchema = z.object({
  runId: z.string().uuid().describe('Run that recorded the learning (result.learnings.items).'),
  learningId: z
    .string()
    .min(1)
    .max(64)
    .describe('The learning id within that run (result.learnings.items[].id).'),
  resolution: z
    .enum(['reviewed-rejected', 'reviewed-noise', 'reviewed-promoted'])
    .describe(
      'reviewed-rejected: the trajectory contradicts it — stops injecting, kept as negative ' +
        'evidence. reviewed-noise: a one-off, not a signal — stops injecting. reviewed-promoted: ' +
        'it proved out — a campaign candidate becomes a durable campaign learning that keeps ' +
        'injecting; a non-campaign candidate stages a skill-scope learning for operator review.',
    ),
  /** Optional rationale for the audit trail. */
  rationale: z.string().max(500).optional(),
});
export type LearnerCandidateResolution = z.infer<typeof LearnerCandidateResolutionSchema>;

export const LearnerLearningResolveCandidateInputSchema = z.object({
  resolutions: z.array(LearnerCandidateResolutionSchema).min(1).max(50),
});
export type LearnerLearningResolveCandidateInput = z.infer<
  typeof LearnerLearningResolveCandidateInputSchema
>;

export const LearnerLearningResolveCandidateOutputSchema = z.object({
  results: z.array(
    z.object({
      runId: z.string(),
      learningId: z.string(),
      status: z.enum(['reviewed-rejected', 'reviewed-noise', 'reviewed-promoted']),
      /** False when the entry was already resolved, or the learning is unknown for that run. */
      applied: z.boolean(),
    }),
  ),
});
export type LearnerLearningResolveCandidateOutput = z.infer<
  typeof LearnerLearningResolveCandidateOutputSchema
>;

export const LearnerLearningResolveCandidateRegistration: OperationRegistration = {
  stepType: 'learner',
  group: 'learning',
  verb: 'resolve_candidate',
  name: 'Resolve Candidate Learnings',
  actionLabel: 'Resolving candidate learnings…',
  semanticDescription:
    'Resolve run-recorded learnings in one batched call, addressed by (runId, learningId). ' +
    'Unresolved learnings inject into the next run as pending hypotheses. Rejected/noise ' +
    'entries stop injecting but stay visible as negative evidence (so the same bad learning ' +
    'is not re-proposed). Promoted campaign entries become durable campaign learnings; ' +
    'promoted non-campaign entries stage a skill-scope learning for operator review. ' +
    'Resolution works even before the ledger row exists — the first resolution wins over a ' +
    'later ledger write.',
  tags: ['learner', 'learning', 'candidate', 'cybernetic'],
  groupDisplayName: 'Coach Learnings',
  groupDescription:
    'Durable, compounding Coach learning records (heuristics, constraints, ranges).',
  idempotency: 'idempotent',
  mutates: true,
  usage: {
    oneLine: 'Batch-resolve run-recorded learnings: reject, mark noise, or promote to durable.',
    whenToUse: [
      'A learning steered a run AWAY from the campaign objective (drift) — reject it',
      'A learning is sampling noise / a one-off, not a real signal — mark it noise',
      'A learning proved out across runs — promote it to a durable campaign learning',
    ],
    whenNotToUse: [
      'You want to edit a learning — entries are immutable; resolve and record a new one',
      'Recording a NEW learning — use workflow.learn',
    ],
    pitfalls: [
      'Resolution is for run-recorded candidates, not durable CoachLearnings (those use ratify/reject)',
      'A rejected entry stays as negative evidence — it is not deleted',
      'The first resolution wins: an already-resolved entry reports applied: false',
    ],
    minimalExampleInput: {
      resolutions: [
        {
          runId: '00000000-0000-0000-0000-000000000040',
          learningId: 'l-cv-lb-gap',
          resolution: 'reviewed-rejected',
          rationale: 'Over-regularization shrank the CV-LB gap but regressed the LB from its peak.',
        },
      ],
    },
  },
  accessMode: 'write',
  inputZod: LearnerLearningResolveCandidateInputSchema,
  outputZod: LearnerLearningResolveCandidateOutputSchema,
};
