/**
 * The core composition root: every HTTP surface the engine serves in every
 * edition.
 *
 * This is the single place a core route module enters the server, and the
 * public core builds from it alone. A surface added here ships in the
 * appliance; one that should not is contributed by the hosted root instead.
 */
import { healthRoutes } from '../routes/health.js';
import { runsRoutes } from '../routes/runs.js';
import { flowsRoutes } from '../routes/flows.js';
import { catalogRoutes } from '../routes/catalog.js';
import { eventsRoutes } from '../routes/events.js';
import { realtimeRoutes } from '../routes/realtime.js';
import { realtimeTokenRoutes } from '../routes/realtimeToken.js';
import { payloadRoutes } from '../routes/payloads.js';
import { adminCapabilityProfileRoutes } from '../routes/adminCapabilityProfiles.js';
import { integrationsRoutes } from '../routes/integrations/index.js';
import { oauthCallbackRoutes } from '../routes/oauth-callback.js';
import { cimdRoutes } from '../routes/cimd.js';
import { usersRoutes } from '../routes/users.js';
import { hostBindingRoutes } from '../routes/hostBindings.js';
import { hostPairingRoutes } from '../routes/hostPairing.js';
import { spaceCrudRoutes } from '../routes/spaceCrudRoutes.js';
import { spacePolicyRoutes } from '../routes/spacePolicyRoutes.js';
import { spaceLifecycleRoutes } from '../routes/spaceLifecycleRoutes.js';
import { activeMemoryRoutes } from '../routes/activeMemory.js';
import { spaceLlmReadinessRoutes } from '../routes/spaceLlmReadiness.js';
import { spaceConnectionsRoutes } from '../routes/spaceConnections.js';
import { cascadesRoutes } from '../routes/cascades.js';
import { workflowsRoutes } from '../routes/workflows/index.js';
import { workflowRunsRoutes } from '../routes/workflowRuns.js';
import { actionCenterRoutes } from '../routes/action-center.js';
import { apiKeysRoutes } from '../routes/api-keys.js';
import { guardrailsRoutes, guardrailLogRoutes } from '../routes/guardrails.js';
import { flowAgentCardRoutes, wellKnownAgentCardRoutes } from '../routes/agentCard.js';
import { interopRoutes } from '../routes/interop.js';
import { a2aRoutes } from '../routes/a2a.js';
import { aguiRoutes } from '../routes/agui.js';
import { surfacesRoutes } from '../routes/surfaces.js';
import { schedulesRoutes } from '../routes/schedules/index.js';
import { tenantSettingsRoutes } from '../routes/tenant-settings.js';
import { credentialRoutes } from '../routes/credentials.js';
import { webhookEndpointRoutes } from '../routes/webhook-endpoints.js';
import { webhookIngestRoutes } from '../routes/webhook-ingest.js';
import { memoryRoutes } from '../routes/memory.js';
import { uiArtifactViewRoutes } from '../routes/uiArtifactViews.js';
import { appletsRoutes } from '../routes/applets.js';
import { appletLifecycleRoutes } from '../routes/appletLifecycle.js';
import { judgeCalibrationRoutes } from '../routes/cybernetic/judgeCalibration.js';
import { proposalRoutes } from '../routes/cybernetic/proposals.js';
import { anomaliesRoutes } from '../routes/cybernetic/anomalies.js';
import { activeSurfaceRoutes } from '../routes/cybernetic/activeSurface.js';
import { userFeedbackRoutes } from '../routes/cybernetic/userFeedback.js';
import { coachHealthRoutes } from '../routes/cybernetic/coachHealth.js';
import { causalInspectorRoutes } from '../routes/cybernetic/causalInspector.js';
import { coachActivityRoutes } from '../routes/cybernetic/coachActivity.js';
import { skillLifecycleRoutes } from '../routes/cybernetic/skillLifecycle.js';
import { storeListingRoutes, storeInstallRoutes } from '../routes/store.js';
import type {
  ServerComposition,
  ServerSurface,
  SurfaceTier,
  V1SurfaceDeps,
} from './surfaceTier.js';

const rootSurfaces: ServerSurface[] = [
  { name: 'health', register: (s) => s.register(healthRoutes, { prefix: '/' }) },
  {
    name: 'well-known-agent-card',
    register: (s) => s.register(wellKnownAgentCardRoutes, { prefix: '/.well-known' }),
  },
  {
    name: 'cimd',
    register: (s) => s.register(cimdRoutes, { prefix: '/.well-known' }),
  },
];

function v1Surfaces({ actionCenterAggregator }: V1SurfaceDeps): ServerSurface[] {
  return [
    {
      name: 'sessions',
      register: (s) => s.register(runsRoutes, { prefix: '/sessions' }),
    },
    {
      name: 'agents',
      register: (s) => s.register(flowsRoutes, { prefix: '/agents' }),
    },
    {
      name: 'catalog',
      register: (s) => s.register(catalogRoutes, { prefix: '/catalog' }),
    },
    {
      name: 'session-events',
      register: (s) => s.register(eventsRoutes, { prefix: '/sessions' }),
    },
    {
      name: 'realtime',
      register: (s) => s.register(realtimeRoutes, { prefix: '/realtime' }),
    },
    {
      name: 'realtime-token',
      register: (s) => s.register(realtimeTokenRoutes, { prefix: '/realtime' }),
    },
    {
      name: 'payloads',
      register: (s) => s.register(payloadRoutes, { prefix: '/payloads' }),
    },

    {
      name: 'admin-capability-profiles',
      register: (s) => s.register(adminCapabilityProfileRoutes, { prefix: '/admin' }),
    },

    {
      name: 'integrations',
      register: (s) => s.register(integrationsRoutes, { prefix: '/integrations' }),
    },
    { name: 'users', register: (s) => s.register(usersRoutes, { prefix: '/users' }) },
    {
      // Core, not enterprise: the local edition is the only one with a host to
      // pair, and the hosted product composes it without ever having a caller.
      name: 'host-pairing',
      register: (s) => s.register(hostPairingRoutes, { prefix: '/host' }),
    },
    {
      name: 'host-bindings',
      register: (s) => s.register(hostBindingRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'spaces',
      register: (s) => s.register(spaceCrudRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'space-policy',
      register: (s) => s.register(spacePolicyRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'space-lifecycle',
      register: (s) => s.register(spaceLifecycleRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'active-memory',
      register: (s) => s.register(activeMemoryRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'space-llm-readiness',
      register: (s) => s.register(spaceLlmReadinessRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'space-connections',
      register: (s) => s.register(spaceConnectionsRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'cascades',
      register: (s) => s.register(cascadesRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'workflows',
      register: (s) => s.register(workflowsRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'workflow-runs',
      register: (s) => s.register(workflowRunsRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'action-center',
      register: (s) =>
        s.register(actionCenterRoutes, { prefix: '/spaces', aggregator: actionCenterAggregator }),
    },
    {
      name: 'tenant-settings',
      register: (s) => s.register(tenantSettingsRoutes, { prefix: '/tenant' }),
    },
    {
      name: 'api-keys',
      register: (s) => s.register(apiKeysRoutes, { prefix: '/api-keys' }),
    },
    {
      name: 'guardrails',
      register: (s) => s.register(guardrailsRoutes, { prefix: '/guardrails' }),
    },
    {
      name: 'guardrail-logs',
      register: (s) => s.register(guardrailLogRoutes, { prefix: '/sessions' }),
    },
    {
      name: 'agent-cards',
      register: (s) => s.register(flowAgentCardRoutes, { prefix: '/agents' }),
    },
    {
      name: 'interop',
      register: (s) => s.register(interopRoutes, { prefix: '/agents' }),
    },
    { name: 'a2a', register: (s) => s.register(a2aRoutes, { prefix: '/a2a' }) },
    {
      name: 'agui',
      register: (s) => s.register(aguiRoutes, { prefix: '/agui/run' }),
    },
    {
      name: 'surfaces',
      register: (s) => s.register(surfacesRoutes, { prefix: '/surfaces' }),
    },
    {
      name: 'schedules',
      register: (s) => s.register(schedulesRoutes, { prefix: '/schedules' }),
    },
    {
      name: 'credentials',
      register: (s) => s.register(credentialRoutes, { prefix: '/credentials' }),
    },
    {
      name: 'webhook-endpoints',
      register: (s) => s.register(webhookEndpointRoutes, { prefix: '/webhook-endpoints' }),
    },
    {
      name: 'memory',
      register: (s) => s.register(memoryRoutes, { prefix: '/memory' }),
    },
    {
      name: 'applets',
      register: (s) => s.register(appletsRoutes, { prefix: '/applets' }),
    },
    {
      name: 'ui-artifacts',
      register: (s) => s.register(uiArtifactViewRoutes, { prefix: '/ui-artifacts' }),
    },
    {
      name: 'applet-lifecycle',
      register: (s) => s.register(appletLifecycleRoutes, { prefix: '/applets' }),
    },
    {
      name: 'judge-calibration',
      register: (s) => s.register(judgeCalibrationRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'proposals',
      register: (s) => s.register(proposalRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'anomalies',
      register: (s) => s.register(anomaliesRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'active-surface',
      register: (s) => s.register(activeSurfaceRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'user-feedback',
      register: (s) => s.register(userFeedbackRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'coach-health',
      register: (s) => s.register(coachHealthRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'causal-inspector',
      register: (s) => s.register(causalInspectorRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'coach-activity',
      register: (s) => s.register(coachActivityRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'skill-lifecycle',
      register: (s) => s.register(skillLifecycleRoutes, { prefix: '/spaces' }),
    },
    {
      name: 'store-listings',
      register: (s) => s.register(storeListingRoutes, { prefix: '/store' }),
    },
    {
      name: 'store-installs',
      register: (s) => s.register(storeInstallRoutes, { prefix: '/spaces' }),
    },

    // Public (no auth), HMAC-verified.
    {
      name: 'webhook-ingest',
      register: (s) => s.register(webhookIngestRoutes, { prefix: '/webhooks/ingest' }),
    },
    { name: 'oauth-callback', register: (s) => s.register(oauthCallbackRoutes) },
  ];
}

export const coreSurfaceTier: SurfaceTier = {
  tier: 'core',
  root: rootSurfaces,
  v1: v1Surfaces,
};

export const coreComposition: ServerComposition = { tiers: [coreSurfaceTier] };
