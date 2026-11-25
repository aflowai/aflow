import { z } from 'zod';
import { registerValidator } from '@aflow/schemas';

/**
 * The rules between the fields of a multi-hypothesis trading campaign, run at
 * campaign start over the whole config. Each field's own JSON Schema cannot
 * see the others: arm ids are unique, the horizon bounds are ordered and the
 * stated confidences rise.
 */
export const TRADING_CAMPAIGN_ARMS_VALIDATOR_REF = 'trading.campaign-arms' as const;

const CampaignArmsSchema = z
  .object({
    hypotheses: z.array(z.object({ id: z.string() }).passthrough()),
    minHorizonTradingDays: z.number(),
    maxHorizonTradingDays: z.number(),
    calibrationRule: z
      .object({ low: z.number(), medium: z.number(), high: z.number() })
      .passthrough(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.hypotheses.forEach((arm, i) => {
      if (seen.has(arm.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hypotheses', i, 'id'],
          message: `hypothesis id "${arm.id}" appears more than once. Every thesis cites one arm by id, so each arm needs its own.`,
        });
      }
      seen.add(arm.id);
    });
    if (config.minHorizonTradingDays > config.maxHorizonTradingDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minHorizonTradingDays'],
        message: `minHorizonTradingDays ${String(config.minHorizonTradingDays)} exceeds maxHorizonTradingDays ${String(config.maxHorizonTradingDays)}.`,
      });
    }
    const { low, medium, high } = config.calibrationRule;
    if (!(low < medium && medium < high)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calibrationRule'],
        message: `the hit rates a stated confidence claims must rise from low to medium to high. They are ${String(low)}, ${String(medium)} and ${String(high)}.`,
      });
    }
  });

registerValidator(TRADING_CAMPAIGN_ARMS_VALIDATOR_REF, CampaignArmsSchema);
