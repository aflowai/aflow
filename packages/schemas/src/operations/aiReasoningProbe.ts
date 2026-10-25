/**
 * ai.model.probe_reasoning — measure which reasoning efforts one catalog model
 * accepts, against the live provider API, with the space's stored credential.
 *
 * The catalog's `reasoning.supported` set is measured, not researched: docs
 * describe the recommended envelope, not the accepted one. This is the shape
 * of that measurement, shared by the operation and `yarn models:verify-reasoning`
 * because both run the one probe in `@aflow/ai-client`.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const REASONING_PROBE_EFFORTS = ['off', 'low', 'medium', 'high'] as const;
export const ReasoningProbeEffortSchema = z.enum(REASONING_PROBE_EFFORTS);
export type ReasoningProbeEffort = z.infer<typeof ReasoningProbeEffortSchema>;

/**
 * The input refuses every key but `model`: the probe spends the space's stored
 * credential for the model's provider, never a key passed in, and an `apiKey`
 * that validated and was then ignored would read as one that was used.
 */
export const AiModelProbeReasoningInputSchema = z
  .object({
    model: z
      .string()
      .trim()
      .min(1, 'Name the catalog model to probe, e.g. "gpt-6.1-sol" or "claude-sonnet-5-5".')
      .max(200)
      .describe(
        'Catalog id or alias of the model whose reasoning ladder to measure, spelled as the model catalog spells it (e.g. "gpt-6.1-sol", "claude-sonnet-5-5", "gemini-3.8-flash"; OpenRouter ids are "vendor/model").',
      ),
  })
  .strict(
    'This operation takes only `model`. It measures with the credential this space already stores for the model’s provider — never a key passed as input — so drop every other field.',
  );
export type AiModelProbeReasoningInput = z.infer<typeof AiModelProbeReasoningInputSchema>;

/** Exactly what one rung's request asked the provider for. */
export const ReasoningProbeRequestSchema = z.object({
  providerModelId: z.string(),
  effort: ReasoningProbeEffortSchema,
  maxTokens: z.number().int().positive(),
  toolChoice: z.literal('auto'),
  tools: z.array(z.string()),
});
export type ReasoningProbeRequest = z.infer<typeof ReasoningProbeRequestSchema>;

/** The provider's refusal, in its own words where it gave any. */
export const ReasoningProbeErrorSchema = z.object({
  code: z.string(),
  message: z.string().max(2000),
  providerErrorCode: z.string().optional(),
  retryable: z.boolean(),
});
export type ReasoningProbeError = z.infer<typeof ReasoningProbeErrorSchema>;

export const ReasoningProbeUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type ReasoningProbeUsage = z.infer<typeof ReasoningProbeUsageSchema>;

/**
 * Why a rung's outcome says nothing about the rung: the credential was
 * refused, the provider was momentarily unavailable, the model id itself is
 * not served, or the answer was filtered. None of these is evidence that the
 * provider accepts or rejects the effort.
 */
export const ReasoningProbeInconclusiveReasonSchema = z.enum([
  'credential',
  'transient',
  'model_unavailable',
  'content_filter',
]);
export type ReasoningProbeInconclusiveReason = z.infer<
  typeof ReasoningProbeInconclusiveReasonSchema
>;

export const ReasoningProbeRungSchema = z.discriminatedUnion('outcome', [
  z.object({
    effort: ReasoningProbeEffortSchema,
    outcome: z.literal('accepted'),
    request: ReasoningProbeRequestSchema,
    finishReason: z.string(),
    usage: ReasoningProbeUsageSchema.optional(),
    /** Set when the provider took the rung but the answer ran out of output budget. */
    truncated: z.boolean().optional(),
  }),
  z.object({
    effort: ReasoningProbeEffortSchema,
    outcome: z.literal('rejected'),
    request: ReasoningProbeRequestSchema,
    error: ReasoningProbeErrorSchema,
  }),
  z.object({
    effort: ReasoningProbeEffortSchema,
    outcome: z.literal('inconclusive'),
    request: ReasoningProbeRequestSchema,
    reason: ReasoningProbeInconclusiveReasonSchema,
    error: ReasoningProbeErrorSchema,
  }),
]);
export type ReasoningProbeRung = z.infer<typeof ReasoningProbeRungSchema>;

export const ReasoningDriftVerdictSchema = z.enum(['match', 'drift', 'inconclusive']);
export type ReasoningDriftVerdict = z.infer<typeof ReasoningDriftVerdictSchema>;

export const ReasoningProfileShapeSchema = z.object({
  supported: z.array(ReasoningProbeEffortSchema),
  default: ReasoningProbeEffortSchema.optional(),
});
export type ReasoningProfileShape = z.infer<typeof ReasoningProfileShapeSchema>;

/**
 * The measured ladder against the catalog entry. Both directions are named
 * because only one is loud: a rung the catalog offers and the provider rejects
 * fails runs, while a rung the provider accepts and the catalog withholds caps
 * quality with no error anywhere.
 */
export const ReasoningDriftReportSchema = z.object({
  verdict: ReasoningDriftVerdictSchema,
  declared: ReasoningProfileShapeSchema,
  measured: z.array(ReasoningProbeEffortSchema),
  /** Accepted by the provider, absent from the catalog — capped quality, silently. */
  withheld: z.array(ReasoningProbeEffortSchema),
  /** In the catalog, rejected by the provider — runs that ask for it fail. */
  rejectedButDeclared: z.array(ReasoningProbeEffortSchema),
  /** The catalog's default rung was rejected by the provider. */
  defaultRejected: z.boolean(),
  /** Rungs whose outcome was not evidence; any of them makes the verdict inconclusive. */
  inconclusive: z.array(ReasoningProbeEffortSchema),
  /**
   * The profile to write into the catalog when the verdict is `drift` and the
   * provider accepted at least one rung. `default` is kept only where the
   * provider accepted it; otherwise choosing one is the author's call.
   */
  suggestedProfile: ReasoningProfileShapeSchema.optional(),
  summary: z.string().max(4000),
});
export type ReasoningDriftReport = z.infer<typeof ReasoningDriftReportSchema>;

export const ReasoningProbeResultSchema = z.object({
  modelId: z.string(),
  provider: z.string(),
  providerModelId: z.string(),
  probedAt: z.string(),
  rungs: z.array(ReasoningProbeRungSchema),
  accepted: z.array(ReasoningProbeEffortSchema),
  rejected: z.array(ReasoningProbeEffortSchema),
  drift: ReasoningDriftReportSchema,
});
export type ReasoningProbeResult = z.infer<typeof ReasoningProbeResultSchema>;

export const AiModelProbeReasoningOutputSchema = ReasoningProbeResultSchema;
export type AiModelProbeReasoningOutput = ReasoningProbeResult;

export const AiModelProbeReasoningRegistration: OperationRegistration = {
  stepType: 'ai',
  group: 'model',
  verb: 'probe_reasoning',
  name: 'Probe Model Reasoning Ladder',
  actionLabel: 'Measuring the model’s reasoning ladder…',
  groupDisplayName: 'Model measurement',
  groupDescription:
    'Measure what a catalog model accepts against its live provider API, with the credential this space stores for that provider.',
  semanticDescription:
    'Measure which reasoning efforts (off, low, medium, high) one catalog model accepts, by sending one minimal tool-calling request per rung to the live provider API with the credential this space stores for that provider. Returns each rung’s outcome — accepted with its usage, rejected with the provider’s own error, or inconclusive and why — and a drift verdict against the model’s catalog reasoning profile, with the profile to write when they disagree. SPENDS REAL TOKENS: up to four small requests per call, billed to the space’s provider account.',
  tags: ['model', 'catalog', 'reasoning', 'measurement', 'drift', 'cost'],
  idempotency: 'non_idempotent',
  mutates: false,
  usage: {
    oneLine:
      'Measure a model’s reasoning ladder against its provider, with the space’s stored key.',
    whenToUse: [
      'A model was added to the catalog or its version bumped, and its reasoning profile has to be measured before it is written',
      'A review or a run says a model’s reasoning efforts look wrong — a rung failing with a provider 400, or a rung the picker does not offer',
    ],
    whenNotToUse: [
      'Checking whether a credential works — every call spends tokens on up to four requests; a provider key is verified in Settings → Credentials',
      'Choosing a model for a task — the catalog already carries the measured profiles',
    ],
    pitfalls: [
      'Spends real tokens on every call (up to four small requests): run it once per model change, not to poll',
      'Probes reasoning models already in the catalog, by id or alias as the catalog spells it, with the credential this space stores for that provider — with none bound the call fails naming the provider, and no key can be passed in its place',
      'An inconclusive verdict is not a match — a refused credential, a rate limit or an unserved model id says nothing about the rungs; on drift, write the catalog from `drift.suggestedProfile` and record the measured rungs where the change is reviewed, never from vendor docs',
    ],
    minimalExampleInput: { model: 'gemini-3.8-flash' },
  },
  accessMode: 'read',
  inputZod: AiModelProbeReasoningInputSchema,
  outputZod: AiModelProbeReasoningOutputSchema,
};
