import { z } from 'zod';

/**
 * A free-text field a model writes, whose length limit it is actually told.
 *
 * `z.string().max(n)` does reach the model — `zodToJsonSchema` emits
 * `maxLength` and the provider adapters pass it through. Models ignore it
 * anyway: providers constrain STRUCTURE during decoding (types, required
 * fields, enum members) and treat numeric keywords as advice. A judge
 * overran a 600-character cap on a third of its answers with the cap plainly
 * in its schema.
 *
 * So the limit is restated in the description, which models follow far more
 * reliably than a keyword — and stating it here means a cap can never be
 * tightened without the writer being told.
 *
 * The other half is the caller's: a cap on model-written prose is enforced by
 * a validator that rejects the WHOLE response, so it should be generous enough
 * that an honest answer fits. Trim on read; do not fail on write.
 */
export function cappedText(maxChars: number, description: string) {
  return z
    .string()
    .max(maxChars)
    .describe(`${description} Keep this under ${String(maxChars)} characters.`);
}
