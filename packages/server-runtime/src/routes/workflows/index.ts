import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerListAndGetRoutes } from './listAndGet.js';
import { registerEvalsAndCoachRoutes } from './evalsAndCoach.js';
import { registerGoldenDatasetRoutes } from './goldenDataset.js';
import { registerEvalBatchRoutes } from './evalBatches.js';
import { registerEvalBaselineRoutes } from './evalBaseline.js';
import { registerEvalLabelQueueRoutes } from './evalLabelQueue.js';
import { registerWorkflowRunRoutes } from './runs.js';
import { registerWorkflowMutationRoutes } from './mutations.js';
import { registerCapabilityRoutes } from './capabilities.js';
import { registerWorkflowCampaignRoutes } from './campaigns.js';
import { registerSkillCreateRoute } from './create.js';
import { registerAuthoringSnapshotRoute } from './authoringSnapshot.js';
import { registerAuthoringSaveRoute } from './authoringSave.js';

export { platformWorkflowUuid } from './shared.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const workflowsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  registerListAndGetRoutes(fastify);
  registerEvalsAndCoachRoutes(fastify);
  registerGoldenDatasetRoutes(fastify);
  registerEvalBatchRoutes(fastify);
  registerEvalBaselineRoutes(fastify);
  registerEvalLabelQueueRoutes(fastify);
  registerWorkflowRunRoutes(fastify);
  registerWorkflowMutationRoutes(fastify);
  registerCapabilityRoutes(fastify);
  registerWorkflowCampaignRoutes(fastify);
  registerSkillCreateRoute(fastify);
  registerAuthoringSnapshotRoute(fastify);
  registerAuthoringSaveRoute(fastify);
};
