import { z } from 'zod';

/**
 * Agents write to their run's space, so the space is never theirs to state;
 * one naming another space is refused rather than written there.
 */
export const RunSpaceIdSchema = z
  .string()
  .uuid()
  .describe("Optional. The run's space is the one used; naming any other space is refused.")
  .optional();

export const UPDATE_KEEPS_OMITTED =
  'On an existing row, a field left out keeps its stored value; defaults apply only when creating.';

/** The rule for an optional field an agent can clear. */
export const NULL_CLEARS =
  'Optional. null removes the stored value; left out, an existing row keeps it.';
