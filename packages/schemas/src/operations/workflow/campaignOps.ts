import { z } from 'zod';
import { CampaignSchema, CampaignEndedReasonSchema } from '../../cybernetic/campaign.js';

// ============================================================================
// Shared shapes
// ============================================================================

const MAX_CAMPAIGN_CONFIG_KEYS = 40;
const MAX_CAMPAIGN_CONFIG_SERIALIZED_BYTES = 32 * 1024;

/**
 * Operator-supplied campaign config values, keyed by contract field key.
 * Bounded like `ParentInputsRecordSchema`: campaign config is hot-state
 * adjacent (it rides the campaign row and `$campaign` resolution) — large
 * values belong in memory docs, referenced by path.
 */
export const CampaignConfigRecordSchema = z
  .record(z.string().min(1).max(64), z.unknown())
  .refine((v) => Object.keys(v).length <= MAX_CAMPAIGN_CONFIG_KEYS, {
    message: `config may have at most ${String(MAX_CAMPAIGN_CONFIG_KEYS)} keys.`,
  })
  .refine(
    (v) => {
      try {
        return Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_CAMPAIGN_CONFIG_SERIALIZED_BYTES;
      } catch {
        return false;
      }
    },
    {
      message: `config must serialize to at most ${String(MAX_CAMPAIGN_CONFIG_SERIALIZED_BYTES)} bytes. Stage large values through memory.store and pass a reference.`,
    },
  );
export type CampaignConfigRecord = z.infer<typeof CampaignConfigRecordSchema>;

/** One scored run in the campaign's series (mirrors `CampaignSeriesPoint`). */
export const CampaignScoreSeriesPointSchema = z
  .object({
    runId: z.string(),
    score: z.number(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();
export type CampaignScoreSeriesPoint = z.infer<typeof CampaignScoreSeriesPointSchema>;

/**
 * Compact score-series summary (derived from `getCampaignScoreSeries`).
 * `bestScore` is direction-aware (max for maximize, min for minimize).
 */
export const CampaignScoreSummarySchema = z
  .object({
    scoredRunCount: z.number().int().min(0),
    bestScore: z.number().optional(),
    latestScore: z.number().optional(),
    latestRunId: z.string().optional(),
  })
  .strict();
export type CampaignScoreSummary = z.infer<typeof CampaignScoreSummarySchema>;

/** Campaign + its score summary — the list/get read shape. */
export const WorkflowCampaignViewSchema = z
  .object({
    campaign: CampaignSchema,
    scoreSummary: CampaignScoreSummarySchema,
    /** Bounded tail of the campaign's scored runs (oldest-first) — the series
     *  the Skill Designer plots per campaign. Already loaded to derive the
     *  summary, so surfacing it costs no extra query. */
    recentSeries: z.array(CampaignScoreSeriesPointSchema),
  })
  .strict();
export type WorkflowCampaignView = z.infer<typeof WorkflowCampaignViewSchema>;

// ============================================================================
// workflow.campaign.start
// ============================================================================

export const WorkflowCampaignStartInputSchema = z.object({
  /** The skill's workflow slug. */
  slug: z.string().min(1).max(64),
  /**
   * The campaign contract values (every declared field, validated against the
   * skill's `manifest.campaign` per-field JSON Schemas). Omit for skills
   * without a campaign contract (config-less campaigns).
   */
  config: CampaignConfigRecordSchema.optional(),
});
export type WorkflowCampaignStartInput = z.infer<typeof WorkflowCampaignStartInputSchema>;

export const WorkflowCampaignStartOutputSchema = z.object({
  campaign: CampaignSchema,
  /** False when an identical active campaign already existed (idempotent-on-identity). */
  created: z.boolean(),
});
export type WorkflowCampaignStartOutput = z.infer<typeof WorkflowCampaignStartOutputSchema>;

// ============================================================================
// workflow.campaign.get / list
// ============================================================================

export const WorkflowCampaignGetInputSchema = z.object({
  campaignId: z.string().uuid(),
});
export type WorkflowCampaignGetInput = z.infer<typeof WorkflowCampaignGetInputSchema>;

export const WorkflowCampaignGetOutputSchema = z.object({
  campaign: CampaignSchema,
  scoreSummary: CampaignScoreSummarySchema,
  /** The most recent scored runs (bounded tail of the series, oldest first). */
  recentSeries: z.array(CampaignScoreSeriesPointSchema),
});
export type WorkflowCampaignGetOutput = z.infer<typeof WorkflowCampaignGetOutputSchema>;

export const WorkflowCampaignListInputSchema = z.object({
  /** Filter to one skill's campaigns. */
  slug: z.string().min(1).max(64).optional(),
  status: z.enum(['active', 'ended', 'all']).default('active'),
});
export type WorkflowCampaignListInput = z.infer<typeof WorkflowCampaignListInputSchema>;

export const WorkflowCampaignListOutputSchema = z.object({
  campaigns: z.array(WorkflowCampaignViewSchema),
});
export type WorkflowCampaignListOutput = z.infer<typeof WorkflowCampaignListOutputSchema>;

// ============================================================================
// workflow.campaign.update
// ============================================================================

export const WorkflowCampaignUpdateInputSchema = z.object({
  campaignId: z.string().uuid(),
  /**
   * Partial config patch — `mutable` non-identity contract fields only.
   * Identity fields are immutable for the life of a campaign (different
   * identity values ARE a different campaign — start one instead).
   */
  config: CampaignConfigRecordSchema,
});
export type WorkflowCampaignUpdateInput = z.infer<typeof WorkflowCampaignUpdateInputSchema>;

export const WorkflowCampaignUpdateOutputSchema = z.object({
  campaign: CampaignSchema,
  /** The keys whose values actually changed (ledger-stamped on the campaign). */
  changedKeys: z.array(z.string()),
});
export type WorkflowCampaignUpdateOutput = z.infer<typeof WorkflowCampaignUpdateOutputSchema>;

// ============================================================================
// workflow.campaign.end
// ============================================================================

export const WorkflowCampaignEndInputSchema = z.object({
  campaignId: z.string().uuid(),
  reason: CampaignEndedReasonSchema.default('explicit'),
});
export type WorkflowCampaignEndInput = z.infer<typeof WorkflowCampaignEndInputSchema>;

export const WorkflowCampaignEndOutputSchema = z.object({
  campaign: CampaignSchema,
});
export type WorkflowCampaignEndOutput = z.infer<typeof WorkflowCampaignEndOutputSchema>;

// ============================================================================
// workflow.campaign.refresh
// ============================================================================

export const WorkflowCampaignRefreshInputSchema = z
  .object({
    /** Explicit campaign. Or pass `slug` to target the single active campaign. */
    campaignId: z.string().uuid().optional(),
    /** Resolve the active campaign for this skill (ambiguous when several are active). */
    slug: z.string().min(1).max(64).optional(),
    /** Restrict clearing to these task ids; omit to clear all memo entries. */
    taskIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .refine((v) => v.campaignId !== undefined || v.slug !== undefined, {
    message: 'Pass campaignId or slug.',
  });
export type WorkflowCampaignRefreshInput = z.infer<typeof WorkflowCampaignRefreshInputSchema>;

export const WorkflowCampaignRefreshOutputSchema = z.object({
  campaignId: z.string().uuid(),
  /** Memo entries cleared (campaign-scoped setup tasks that will re-execute). */
  clearedTaskIds: z.array(z.string()),
});
export type WorkflowCampaignRefreshOutput = z.infer<typeof WorkflowCampaignRefreshOutputSchema>;

// ============================================================================

/**
 * `error.details` for `CAMPAIGN_REQUIRED` (mirrors `PARENT_INPUTS_INVALID`'s
 * teach-by-schema shape): the campaign contract rides the error as a JSON
 * Schema plus a `WorkflowSuggestedAction`-shaped pointer back at
 * `workflow.run.start` with `campaignConfig` — the caller collects the fields
 * once (chat `human.chat.ask` or a `<SchemaForm>`) and re-issues `run.start`,
 * which creates the campaign and starts the run in one call.
 */
export const CampaignRequiredErrorDetailsSchema = z
  .object({
    /** JSON Schema (object form) of the contract fields — collect and pass as `campaignConfig`. */
    campaignContract: z.record(z.unknown()),
    suggestedAction: z
      .object({
        op: z.literal('workflow.run.start'),
        args: z
          .object({
            slug: z.string().min(1).max(64),
            campaignConfig: CampaignConfigRecordSchema.optional(),
          })
          .strict(),
        preconditions: z.string().max(500).optional(),
      })
      .strict(),
  })
  .strict();
export type CampaignRequiredErrorDetails = z.infer<typeof CampaignRequiredErrorDetailsSchema>;

/** `error.details` for `CAMPAIGN_AMBIGUOUS` — the candidate campaigns to pick from. */
export const CampaignAmbiguousErrorDetailsSchema = z
  .object({
    activeCampaigns: z.array(
      z
        .object({
          campaignId: z.string().uuid(),
          goalRef: z.string(),
          config: z.record(z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type CampaignAmbiguousErrorDetails = z.infer<typeof CampaignAmbiguousErrorDetailsSchema>;
