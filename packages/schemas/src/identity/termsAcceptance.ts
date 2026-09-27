import { z } from 'zod';

/**
 * The version of the Terms of Service a user must have accepted to use the
 * platform. Dated rather than numbered so it matches the "Last updated" line
 * the Terms page renders from this same constant — a mismatch between what a
 * user sees and what gets recorded is the failure mode worth designing out.
 *
 * Bumping this re-gates every existing account at their next request. Only bump
 * it for changes that need fresh agreement; an editorial fix does not.
 */
export const CURRENT_TERMS_VERSION = '2026-07-30';

export const TermsVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Terms version must be an ISO date (YYYY-MM-DD).');

export const TermsAcceptanceRequestSchema = z.object({
  /**
   * Echoed back by the client so a stale tab cannot record agreement to a
   * version the person was never shown.
   */
  version: TermsVersionSchema,
});
export type TermsAcceptanceRequest = z.infer<typeof TermsAcceptanceRequestSchema>;

export const TermsAcceptanceStatusSchema = z.object({
  /** True when the user must accept before the API will serve them. */
  required: z.boolean(),
  currentVersion: TermsVersionSchema,
  acceptedVersion: TermsVersionSchema.nullable(),
  acceptedAt: z.string().datetime().nullable(),
});
export type TermsAcceptanceStatus = z.infer<typeof TermsAcceptanceStatusSchema>;
