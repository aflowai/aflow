import { z } from 'zod';
import { StagedChangeSourceSchema } from './stagedChange.js';

/**
 * Who proposed a change and where, as a reader is shown it. The conversation
 * is the one the proposing session belongs to, resolved at read time. It is
 * null when no conversation in this space holds that session or run.
 */
export const ProposalProvenanceSchema = z.object({
  source: StagedChangeSourceSchema,
  conversation: z
    .object({
      sessionId: z.string(),
      title: z.string().nullable(),
    })
    .nullable(),
});

export type ProposalProvenance = z.infer<typeof ProposalProvenanceSchema>;
