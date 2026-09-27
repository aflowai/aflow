// Campaign read/write helpers and operations live in the engine
// (`@aflow/cybernetic-runtime`) so the inline-ops (agent path) and the
// server's REST routes (operator path) share one authority. Re-exported here
// for the handlers and `run.start` that import them from this module.
export {
  getCampaignInSpace,
  summarizeScoreSeries,
  recentSeriesTail,
  buildCampaignView,
  resolveCampaignSkill,
  materializeNumericCampaignGoal,
  createContractedCampaign,
  startCampaign,
  updateCampaign,
  endCampaignInSpace,
} from '@aflow/cybernetic-runtime';
export type {
  CampaignSkillResolution,
  MaterializedNumericGoal,
  CreateContractedCampaignResult,
} from '@aflow/cybernetic-runtime';
