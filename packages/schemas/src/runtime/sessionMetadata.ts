import { z } from 'zod';

/**
 * A conversation's name and synopsis — derived presentation data, held apart
 * from the execution state it describes.
 *
 * Four things people conflate and this deliberately keeps distinct: the
 * **title** names the conversation, the **summary** says what happened in it,
 * the session **status** says whether it is running, and the agent's context
 * compaction is a separate machinery that serves the model rather than a
 * reader. None of the four is a substitute for another.
 */

/** A stored title. Long enough for a sentence in any language it might be written in. */
export const SESSION_TITLE_MAX = 300;

/**
 * A stored summary. Sized for a few sentences with room to spare rather than
 * for the shortest one imagined: a ceiling tight enough to reject the useful
 * paragraph turns a background refresh into a retry loop.
 */
export const SESSION_SUMMARY_MAX = 4000;

/** Characters of the opening request the deterministic fallback keeps. */
export const SESSION_FALLBACK_TITLE_MAX = 80;

/** What the shown title is worth, and therefore whether it may still be replaced. */
export const SessionTitleStateSchema = z.enum([
  /** Deterministic excerpt of the opening request. No model has seen it. */
  'fallback',
  /** Generated from the opening request alone, before any answer existed. */
  'provisional',
  /** Generated from a completed exchange. Automatic refresh stops here. */
  'established',
]);
export type SessionTitleState = z.infer<typeof SessionTitleStateSchema>;

/** Which of the two stored titles the resolved one came from. */
export const SessionTitleSourceSchema = z.enum(['generated', 'manual']);
export type SessionTitleSource = z.infer<typeof SessionTitleSourceSchema>;

/** How much of the conversation the summary actually saw. */
export const SessionSummaryCoverageSchema = z.enum(['full', 'partial']);
export type SessionSummaryCoverage = z.infer<typeof SessionSummaryCoverageSchema>;

/** How the Clerk model behind a generation was arrived at. */
export const ClerkResolutionModeSchema = z.enum(['auto', 'space_default', 'explicit']);
export type ClerkResolutionMode = z.infer<typeof ClerkResolutionModeSchema>;

/**
 * What produced the current generated title and summary.
 *
 * Kept because a summary read months later is only as trustworthy as what it
 * was written from: which model, over how much of the conversation, at which
 * revision of the evidence.
 */
export const SessionMetadataProvenanceSchema = z.object({
  /** The ref the assignment carried — an alias where there is one. */
  modelRef: z.string().max(128),
  /** The concrete catalog id that answered. */
  modelId: z.string().max(128),
  providerId: z.string().max(64),
  resolution: ClerkResolutionModeSchema,
  /** Bumped when the prompt changes, so old output is identifiable as old. */
  promptVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  /** Session activity count this generation read. */
  evidenceRevision: z.number().int().nonnegative(),
  coverage: SessionSummaryCoverageSchema,
  /** Committed exchanges the evidence envelope carried. */
  exchangeCount: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  costCents: z.number().nonnegative().optional(),
});
export type SessionMetadataProvenance = z.infer<typeof SessionMetadataProvenanceSchema>;

/**
 * Why a conversation has no generated name.
 *
 * Metadata availability is advisory: none of these makes a space unready or
 * blocks a conversation, and every one of them leaves the deterministic
 * fallback in place.
 */
export const SessionMetadataDiagnosticSchema = z.object({
  code: z.enum([
    /** Auto found no permitted small model for the space default's provider. */
    'no_clerk_model',
    /** A model resolved, but no credential for its provider did. */
    'no_credential',
    /** The model answered with something the contract rejects, or not at all. */
    'generation_failed',
    /** Nothing worth naming has been said yet. */
    'no_evidence',
  ]),
  message: z.string().max(1000),
  at: z.string().datetime(),
  /** Whether the next activity boundary is worth another attempt. */
  retryable: z.boolean(),
  attempts: z.number().int().nonnegative(),
});
export type SessionMetadataDiagnostic = z.infer<typeof SessionMetadataDiagnosticSchema>;

/**
 * The metadata block carried on a session listing row or detail response.
 *
 * `title` is already resolved: a manual name wins over a generated one, and
 * the two are stored separately so a generation landing after a rename cannot
 * race it — they write different columns and the read picks.
 */
export const SessionMetadataSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX).nullable(),
  titleSource: SessionTitleSourceSchema.nullable(),
  /** Null when the title is manual — a person's name has no automatic state. */
  titleState: SessionTitleStateSchema.nullable(),
  summary: z.string().max(SESSION_SUMMARY_MAX).nullable(),
  summaryCoverage: SessionSummaryCoverageSchema.nullable(),
  /** Bumped by every committed metadata write. The rename conflict handle. */
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(),
  /** Who last renamed it. Attribution, never authorization. */
  editedByUserId: z.string().uuid().nullable(),
  /** Whether a refresh is currently owed. Diagnostics, not a status badge. */
  pending: z.boolean(),
});
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

/** Metadata plus the parts only an inspector needs. */
export const SessionMetadataDetailSchema = SessionMetadataSchema.extend({
  provenance: SessionMetadataProvenanceSchema.nullable(),
  diagnostic: SessionMetadataDiagnosticSchema.nullable(),
});
export type SessionMetadataDetail = z.infer<typeof SessionMetadataDetailSchema>;

/**
 * What the `metadata_json` column holds — the parts of the metadata block that
 * are read by an inspector rather than by a listing, kept out of the flat
 * columns a list query selects.
 */
export const SessionMetadataRecordSchema = z.object({
  provenance: SessionMetadataProvenanceSchema.optional(),
  diagnostic: SessionMetadataDiagnosticSchema.optional(),
});
export type SessionMetadataRecord = z.infer<typeof SessionMetadataRecordSchema>;

/** Read the column back, tolerating a shape written before a field existed. */
export function parseSessionMetadataRecord(value: unknown): SessionMetadataRecord {
  const parsed = SessionMetadataRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// ============================================================================
// What the Clerk returns
// ============================================================================

/**
 * The generator's whole contract. No status, no verdict, no references it was
 * not handed — anything authoritative about the run is read from the run.
 *
 * Both fields are optional on the way back: a first request with no answer yet
 * yields a title and no summary, and refusing the response over the missing
 * half would cost the title too.
 */
export const SessionMetadataProposalSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX).optional(),
  summary: z.string().max(SESSION_SUMMARY_MAX).optional(),
});
export type SessionMetadataProposal = z.infer<typeof SessionMetadataProposalSchema>;

// ============================================================================
// Deterministic fallback
// ============================================================================

/**
 * Strip the characters that make a one-line label misbehave, and collapse the
 * whitespace a pasted request arrives with.
 *
 * Control and format characters are removed rather than replaced: a bidi
 * override or a zero-width joiner surviving into a list row renders as
 * something other than what it says.
 */
export function normalizeSessionLabel(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A usable name for a conversation before any model has read it.
 *
 * Cut on a word boundary where one is near the limit, so the excerpt reads as
 * a phrase rather than a severed word. No ellipsis: the UI owns truncation of
 * whatever it is given, and a stored ellipsis would be truncated again.
 */
export function deriveFallbackSessionTitle(firstRequest: string | undefined | null): string | null {
  if (!firstRequest) return null;
  const normalized = normalizeSessionLabel(firstRequest);
  if (normalized.length === 0) return null;
  if (normalized.length <= SESSION_FALLBACK_TITLE_MAX) return normalized;
  const cut = normalized.slice(0, SESSION_FALLBACK_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > SESSION_FALLBACK_TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Whether a first request carries enough intent to name a conversation from.
 *
 * A greeting is not a subject. Detection is deliberately weak and one-sided:
 * it can only hold a title at `fallback`, never refuse to run anything, so a
 * false negative costs one deferred rename and a false positive costs a title
 * the next boundary refines.
 */
const GREETING_ONLY =
  /^(hi|hey|hello|yo|hola|salut|hallo|moin|servus|ciao|ol[áa]|привет|你好|こんにちは|안녕하세요)[\s!.,?]*$/iu;

export function isSubstantiveRequest(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = normalizeSessionLabel(text);
  if (normalized.length < 3) return false;
  return !GREETING_ONLY.test(normalized);
}

// ============================================================================
// Cadence
// ============================================================================

/**
 * How long a committed boundary waits before it is claimable.
 *
 * Long enough that the answer arriving straight after a request joins the same
 * generation instead of forcing a second one; short enough that a name appears
 * while the person is still looking at the conversation they just opened.
 *
 * The only cadence in the metadata plane, and deliberately so. There is no
 * throttle between rewrites: a summary that lags even one exchange is a
 * confident claim about a state the conversation has already left, and nothing
 * on screen says which. An earlier revision spaced rewrites three exchanges
 * apart to avoid churning on wording — it bought staleness with savings that
 * did not exist, at eight thousandths of a cent a call.
 */
export const SESSION_METADATA_DEBOUNCE_MS = 2_000;

/**
 * How long a generation waits for its own evidence to become readable.
 *
 * The reply that arms a conversation is written to Redis; the evidence is read
 * from Postgres, which the projection worker gets to a moment later. Without
 * this wait every summary is produced from a transcript missing the very
 * answer that triggered it — which is not a lag of milliseconds but a summary
 * that is always one turn behind, describing the state before the reply a
 * reader can see on screen. Measured live: armed at 12:41:18, generated at
 * 12:41:22, and it had read one turn where two had happened.
 *
 * Bounded by a grace window rather than a counter: past it, projection has
 * either happened or something is wrong, and a summary of what is readable
 * beats no summary at all.
 */
export const SESSION_METADATA_PROJECTION_GRACE_MS = 30_000;

/** Backoff after a failed generation, by attempt. Past the last one it retires. */
export const SESSION_METADATA_RETRY_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];

// ============================================================================
// Eligibility
// ============================================================================

/**
 * What the platform knows about a session when it decides whether to name it.
 *
 * Every field is read from a record that already exists — none of this is
 * stored a second time for the metadata plane's benefit.
 */
export interface SessionMetadataEligibilityInput {
  spaceId: string | null | undefined;
  /** Null until a person has spoken in the session. */
  lastActivityAt: Date | number | null | undefined;
  /** Transport that opened it. Absent once hot state has aged out. */
  trigger?: string | null | undefined;
}

export type SessionMetadataEligibility =
  { eligible: true } | { eligible: false; reason: 'no_space' | 'no_human_activity' | 'eval' };

/**
 * Whether a session is a conversation worth naming.
 *
 * The load-bearing test is the activity clock, and it costs nothing extra:
 * it advances only when a person says something, so a Runner working through
 * a skill's tasks, a scheduled job, and a delegated child executing a brief
 * all fail it without anyone having to enumerate them. Their identity already
 * belongs to the run surface that dispatched them; a second generated name
 * would duplicate it and bill a model call for the privilege.
 *
 * Evaluation runs are excluded outright — a frozen replay is not a
 * conversation, and naming one would put it in front of an operator as though
 * it were.
 */
export function evaluateSessionMetadataEligibility(
  input: SessionMetadataEligibilityInput,
): SessionMetadataEligibility {
  if (!input.spaceId) return { eligible: false, reason: 'no_space' };
  if (input.trigger === 'eval') return { eligible: false, reason: 'eval' };
  if (input.lastActivityAt == null) return { eligible: false, reason: 'no_human_activity' };
  return { eligible: true };
}
