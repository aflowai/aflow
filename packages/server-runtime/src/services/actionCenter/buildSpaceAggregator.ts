import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type { SessionService } from '../sessions.js';
import type { ActionCenterAuditRecorder } from './types.js';
import { buildAggregator, type ActionCenterAggregator } from './aggregator.js';
import { createDecisionPlaneStore } from './decisionPlane.js';
import { createPausedStepSource } from './sources/pausedStepSource.js';
import { createCoachProposalSource } from './sources/coachProposalSource.js';
import { createComputeEgressSource } from './sources/computeEgressSource.js';
import { createIntegrationHostRequestSource } from './sources/integrationHostRequestSource.js';
import { createCoachActivitySource } from './sources/coachActivitySource.js';
import { createTriggerArmedSource } from './sources/triggerArmedSource.js';
import { createWorkflowHumanTaskSource } from './sources/workflowHumanTaskSource.js';
import { createWorkflowOAuthConsentSource } from './sources/workflowOAuthConsentSource.js';
import { createSessionInvitationSource } from './sources/sessionInvitationSource.js';
import { createBrowserHandoffSource } from './sources/browserHandoffSource.js';

export interface BuildSpaceActionCenterAggregatorDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
  sessionService: SessionService;
  audit?: ActionCenterAuditRecorder;
}

export function buildSpaceActionCenterAggregator(
  deps: BuildSpaceActionCenterAggregatorDeps,
): ActionCenterAggregator {
  const sourceDeps = {
    db: deps.db,
    redis: deps.redis,
    payloadStore: deps.payloadStore,
    ...(deps.audit ? { audit: deps.audit } : {}),
  };
  return buildAggregator({
    db: deps.db,
    decisionPlane: createDecisionPlaneStore(deps.db),
    sources: [
      createPausedStepSource({ ...sourceDeps, sessionService: deps.sessionService }),
      createCoachProposalSource(sourceDeps),
      createComputeEgressSource(sourceDeps),
      createIntegrationHostRequestSource(sourceDeps),
      createCoachActivitySource(sourceDeps),
      createTriggerArmedSource(sourceDeps),
      createWorkflowHumanTaskSource(sourceDeps),
      createWorkflowOAuthConsentSource(sourceDeps),
      createSessionInvitationSource(sourceDeps),
      createBrowserHandoffSource(sourceDeps),
    ],
  });
}
