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

/**
 * The rule for an optional field an agent can clear. LLMs habitually send
 * `null` for a field they mean to leave alone — and step input resolution
 * strips a `null` the schema rejects — so `null` keeps the stored value as an
 * omission does; removing one takes naming it in `clear`.
 */
export const KEPT_UNLESS_CLEARED =
  'Optional. Left out or sent as null, an existing row keeps its stored value; to remove the ' +
  'stored value, name this field in clear.';

/** The `clear` input of an upsert: the stored optional fields this write removes. */
export function clearFieldsSchema<const F extends readonly [string, ...string[]]>(fields: F) {
  return z
    .array(z.enum(fields))
    .optional()
    .describe(
      `Optional. The stored fields this write removes (${fields.join(', ')}). A field named here ` +
        'must not also be given a value. null on a field does not remove it — only naming it ' +
        'here does.',
    );
}

export const CLEARED_OUTPUT_DESCRIPTION =
  'The fields named in clear, which the row no longer holds after this write. Empty when the ' +
  'call removed nothing.';
