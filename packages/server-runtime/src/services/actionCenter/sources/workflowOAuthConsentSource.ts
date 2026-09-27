import { and, desc, eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  type WorkflowRunRow,
} from '@aflow/database';
import {
  type ActionCenterItemOrigin,
  type OAuthConsentExtension,
  type OAuthConsentPauseCause,
} from '@aflow/schemas';
import { surfaceWorkflowResumeContract } from '@aflow/cybernetic-runtime';
import {
  type ActionCenterContext,
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  type ActionCenterSourceDeps,
  ActionCenterResolveError,
} from '../types.js';

const ITEM_ID_PREFIX = 'workflow-oauth-consent:';
const LIST_LIMIT = 200;

/**
 * Run-plane "Connect {provider}" Action Center source (Plan 185 §9.3 Plane B).
 *
 * A harness-routed Runner sub-session that can't resolve a pinned OAuth owner
 * parks its tool/API call as a workflow-RUN pause whose `paused_reason` is
 * `needs_oauth_consent` and whose stored `WorkflowResumeContract` carries the
 * typed `oauthConsent` cause. Only the run-resume authority can clear that
 * pause, so the step-plane source (`pausedStepSource`) deliberately drops the
 * step's `oauth_consent` payload for harness-routed runs — this source is the
 * authoritative surface for those pauses and emits the same
 * `needs_oauth_consent` item the existing `OAuthConsentCard` renders unchanged.
 */
export function createWorkflowOAuthConsentSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  return {
    name: 'workflowOAuthConsent',
    rowScope: 'space',
    handlesOriginTypes: ['workflow_task'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const runs = await listOAuthConsentPausedRuns(deps, scope, LIST_LIMIT);
      const items: ActionCenterSourceItem[] = [];
      for (const run of runs) {
        const item = await buildItemFromRun(deps, scope, run);
        if (item) items.push(item);
      }
      return items;
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      const runId = parseItemId(itemId);
      if (!runId) return null;
      const run = await loadOAuthConsentPausedRun(deps, ctx, runId);
      if (!run) return null;
      return buildItemFromRun(deps, ctx, run);
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by the source contract; consent is callback-driven, never resolved here.
    async resolve(
      _ctx: ActionCenterContext,
      _item: ActionCenterSourceItem,
      _resolution,
    ): Promise<ActionCenterResolveOutcome> {
      // The operator launches consent out-of-band (the OAuthConsentCard's
      // `connect` deep-link); the OAuth callback resumes the run. There is no
      // structured-output resolution to dispatch through the resolve route.
      throw new ActionCenterResolveError(
        'INVALID_RESOLUTION',
        `A 'needs_oauth_consent' item is resolved by completing the OAuth flow, not via the resolve route.`,
        'permanent',
      );
    },
  };
}

function parseItemId(itemId: string): string | null {
  if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
  const runId = itemId.slice(ITEM_ID_PREFIX.length);
  return runId.length > 0 ? runId : null;
}

async function listOAuthConsentPausedRuns(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  limit: number,
): Promise<WorkflowRunRow[]> {
  const tenantCtx = createTenantContext(scope.tenantId);
  return withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, scope.spaceId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.pausedReason, 'needs_oauth_consent'),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit),
  );
}

async function loadOAuthConsentPausedRun(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  runId: string,
): Promise<WorkflowRunRow | null> {
  const tenantCtx = createTenantContext(scope.tenantId);
  const rows = await withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, scope.spaceId),
          eq(workflowRuns.runId, runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.pausedReason, 'needs_oauth_consent'),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Read the run's stored `WorkflowResumeContract` and lift its typed
 * `oauthConsent` cause into a `needs_oauth_consent` item. Returns null when the
 * contract is missing / malformed / carries no `oauthConsent` block — a
 * `needs_oauth_consent` pause without the typed cause is unactionable as a
 * "Connect" card, so we drop it rather than render an empty affordance.
 */
async function buildItemFromRun(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  run: WorkflowRunRow,
): Promise<ActionCenterSourceItem | null> {
  const surfaced = await surfaceWorkflowResumeContract(
    deps.db,
    deps.payloadStore,
    scope.tenantId,
    run.runId,
  );
  const consent: OAuthConsentPauseCause | undefined = surfaced?.contract.oauthConsent;
  if (!consent) return null;

  const providerLabel = consent.resourceKey || consent.bindingId || 'this integration';
  const title = `Connect ${providerLabel}`;
  const summary =
    consent.reason === 'expired'
      ? `Your connection to ${providerLabel} has expired. Reconnect to let the skill continue.`
      : `${providerLabel} needs your authorization before the skill can continue.`;

  const extension: OAuthConsentExtension = {
    kind: 'oauth_consent',
    integrationKind: consent.integrationKind,
    resourceKey: consent.resourceKey,
    bindingId: consent.bindingId,
    ownerScope: consent.ownerScope,
    reason: consent.reason,
    ...(consent.consentUrlHint ? { consentUrlHint: consent.consentUrlHint } : {}),
  };

  const origin: ActionCenterItemOrigin = {
    type: 'workflow_task',
    runId: run.runId,
    // The pinned-owner pause is run-scoped, not bound to a specific task row;
    // a stable sentinel keeps the origin id deterministic for CAS comparison.
    taskId: 'oauth_consent',
    pauseVersion: run.pauseVersion,
  };

  return {
    id: `${ITEM_ID_PREFIX}${run.runId}`,
    spaceId: scope.spaceId,
    kind: 'needs_oauth_consent',
    origin,
    title: title.slice(0, 256),
    summary: summary.slice(0, 2_000),
    extension,
    requestedAt: run.startedAt.toISOString(),
    requestedBy: {
      kind: 'workflow',
      label: `Workflow: ${run.workflowSlug}`,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
    priority: 'normal',
    relatesTo: [
      {
        kind: 'binding',
        id: consent.bindingId || consent.resourceKey,
        label: providerLabel,
      },
      {
        kind: 'workflow',
        id: run.workflowSlug,
        label: run.workflowSlug,
      },
    ],
    resolverAuthority: { kind: 'space' },
    status: 'open',
  };
}
