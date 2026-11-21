import { z } from 'zod';
import { registerValidator } from '@aflow/schemas';

/**
 * Stable validatorRef for the Daily Trading Cycle's `resolve-theses` output.
 *
 * The decide contract caps a cycle's new theses at `remainingThesesToday`, so
 * that number carries the theses/day cap. It must equal the campaign's
 * `maxThesesPerDay` less the theses earlier slots opened, floored at 0, and 0
 * on after_close. That is arithmetic across fields, which no JSON-Schema
 * projection can express. The output pins `maxThesesPerDay` to the campaign,
 * so this rule ties the reported remainder to `thesesOpenedToday`.
 */
export const TRADING_THESES_BUDGET_VALIDATOR_REF = 'trading.theses-day-budget' as const;

const TradingThesesBudgetSchema = z
  .object({
    slot: z.string(),
    maxThesesPerDay: z.number().int().min(0),
    thesesOpenedToday: z.array(z.string()),
    remainingThesesToday: z.number().int().min(0),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const opened = new Set(data.thesesOpenedToday).size;
    const expected = data.slot === 'after_close' ? 0 : Math.max(0, data.maxThesesPerDay - opened);
    if (data.remainingThesesToday !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remainingThesesToday'],
        message:
          data.slot === 'after_close'
            ? `remainingThesesToday is ${String(data.remainingThesesToday)}, but an after_close cycle opens nothing, so it must be 0.`
            : `remainingThesesToday is ${String(data.remainingThesesToday)}, but maxThesesPerDay ${String(data.maxThesesPerDay)} less the ${String(opened)} distinct thesesOpenedToday is ${String(expected)}. Set it to ${String(expected)}, or correct thesesOpenedToday from the cycle docs of the trading day.`,
      });
    }
  });

registerValidator(TRADING_THESES_BUDGET_VALIDATOR_REF, TradingThesesBudgetSchema);
