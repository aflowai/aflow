/**
 * The campaign a trading model reads.
 * A campaign's config is frozen at its start, so a campaign started under an
 * older contract still stores fields the contract has since dropped. A model
 * handed the whole config reads those fields as live rules. The read projects
 * only the fields the contract declares now, derived from the contract.
 */
import { DAILY_TRADING_CYCLE_CAMPAIGN } from './dailyTradingCycleCampaign.js';
import { bind, out } from './localPrShepherdWiring.js';

export const CAMPAIGN_CONTRACT_FIELDS = Object.keys(DAILY_TRADING_CYCLE_CAMPAIGN.fields);

const fieldKey = (field: string) => `config_${field}`;

/** The workflow.campaign.list projection: each declared field of the first campaign, null where absent. */
export const CAMPAIGN_CONTRACT_PROJECTION = Object.fromEntries(
  CAMPAIGN_CONTRACT_FIELDS.map((field) => [
    fieldKey(field),
    { path: `campaigns[0].campaign.config.${field}`, onMissing: 'null' as const },
  ]),
);

/** The input bindings a task reads the declared fields through, from the read task's projection. */
export function campaignContractBindings(readTaskId: string) {
  return Object.fromEntries(
    CAMPAIGN_CONTRACT_FIELDS.map((field) => [
      `campaign_${field}`,
      out(readTaskId, fieldKey(field)),
    ]),
  );
}

/** The campaign object a harness input carries: the declared fields, under their own names. */
export const CAMPAIGN_CONTRACT_INPUT = Object.fromEntries(
  CAMPAIGN_CONTRACT_FIELDS.map((field) => [field, bind(`campaign_${field}`)]),
);
