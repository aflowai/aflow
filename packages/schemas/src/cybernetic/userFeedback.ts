import { z } from 'zod';

/**
 * Closed-set reason codes for user feedback. The Coach groups feedback by
 * reason code when reviewing a skill. `'other'` requires non-empty free text.
 */
export const UserFeedbackReasonSchema = z.enum([
  'wrong_outcome', // "that's not what I asked for"
  'wrong_approach', // "the result is OK but you did it wrong"
  'missing_context', // "you didn't account for X"
  'too_slow', // "this took way too long"
  'too_expensive', // "this cost more than it was worth"
  'unclear_communication', // "I couldn't tell what you were doing"
  'good_as_is', // positive feedback with optional note
  'other',
]);

export type UserFeedbackReason = z.infer<typeof UserFeedbackReasonSchema>;

/**
 * A single user feedback record, linked to a subject (run, proposal, skill,
 * or message). Independent first-class input — doesn't need a proposal to exist.
 */
export const UserFeedbackSchema = z
  .object({
    feedbackId: z.string().uuid(),
    spaceId: z.string().uuid(),
    subjectKind: z.enum(['run', 'proposal', 'skill', 'message']),
    subjectId: z.string().max(256),
    reasonCode: UserFeedbackReasonSchema,
    freeText: z.string().max(1000).optional(),
    createdByUserId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .superRefine((data, ctx) => {
    if (data.reasonCode === 'other' && (!data.freeText || data.freeText.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Reason 'other' requires non-empty freeText",
        path: ['freeText'],
      });
    }
  });

export type UserFeedback = z.infer<typeof UserFeedbackSchema>;
