import { and, eq, isNotNull, desc } from 'drizzle-orm';
import { createTenantContext, sessions, withTenantSchema } from '@aflow/database';
import { setWriteApprovalGrant } from '@aflow/redis';
import {
  type ActionCenterItemKind,
  type ActionCenterItemOrigin,
  type ActionCenterResolution,
  type GateContext,
  type OAuthConsentExtension,
  type RelatesToEntry,
  type SessionId,
  type StepExecutionId,
  type ApiWriteApprovalRequestPayload,
  type BrowserWriteApprovalRequestPayload,
  type WriteApprovalExtension,
  BROWSER_PAGE_ACT_OPERATION_ID,
  browserApprovalActionPhrase,
  derivePauseToken,
  WriteApprovalRequestPayloadSchema,
} from '@aflow/schemas';
import type { SessionService } from '../../sessions.js';
import {
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  type ActionCenterSourceDeps,
  ActionCenterResolveError,
} from '../types.js';
import { deriveResolverPolicy } from '@aflow/schemas';

const STEP_ITEM_ID_PREFIX = 'step:';
const GATE_ITEM_ID_PREFIX = 'gate:';

export interface PausedStepSourceDeps extends ActionCenterSourceDeps {
  sessionService: SessionService;
}

export function createPausedStepSource(deps: PausedStepSourceDeps): ActionCenterSource {
  return {
    name: 'pausedStep',
    rowScope: 'space',
    handlesOriginTypes: ['step'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const rows = await listPausedSessions(deps, scope);
      const items: ActionCenterSourceItem[] = [];
      for (const row of rows) {
        const item = await buildItemFromSession(deps, scope, row);
        if (item) items.push(item);
      }
      return items;
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      const stepExecutionId = parseItemId(itemId);
      if (!stepExecutionId) return null;
      const row = await loadSessionByCurrentStep(deps, ctx, stepExecutionId);
      if (!row) return null;
      return buildItemFromSession(deps, ctx, row);
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      const stepExecutionId = parseItemId(item.id);
      if (!stepExecutionId) {
        throw new ActionCenterResolveError(
          'NOT_FOUND',
          `Item id ${item.id} is not a step-backed action.`,
          'permanent',
        );
      }
      // Re-read by stepExecutionId so a re-pause on a different step is
      // detected (the session moved on; this item is stale).
      const row = await loadSessionByCurrentStep(deps, ctx, stepExecutionId);
      if (!row) {
        // The session may have completed, or it re-paused on a different
        // step. Either way the client's item is stale.
        const latest = await tryLoadLatestFromSessionId(deps, ctx, item);
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          `Step ${stepExecutionId} is no longer the session's paused step.`,
          'stale_target',
          `The session has moved on; reload to see the current state.`,
          latest,
        );
      }
      if (row.status !== 'PAUSED') {
        const latest = (await buildItemFromSession(deps, ctx, row)) ?? undefined;
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          `Session ${row.sessionId} is no longer PAUSED (current: ${row.status}).`,
          'stale_target',
          `Re-read the item for the current state.`,
          latest,
        );
      }

      // Plan 253: a write-approval decision is authenticated HERE — this is the
      // only place with the real actor identity. Record it as the grant the
      // orchestrator and executor read, keyed by (tenant, run, requestHash);
      // the resume message that follows carries no trusted decision, so a
      // scheduled or agent-driven resume can never approve a gated write.
      if (item.kind === 'write_approval' && resolution.kind !== 'dismiss') {
        const reqPayload = await loadRequestedInputPayload(deps, row.requestedInputRef);
        const parsedReq = WriteApprovalRequestPayloadSchema.safeParse(reqPayload);
        if (!parsedReq.success) {
          throw new ActionCenterResolveError(
            'NOT_FOUND',
            `Write-approval request payload missing for ${item.id}.`,
            'stale_target',
          );
        }
        const reason =
          resolution.kind === 'reject'
            ? resolution.reason
            : resolution.kind === 'approve'
              ? resolution.comment
              : undefined;
        await setWriteApprovalGrant(deps.redis, ctx.tenantId, row.sessionId, {
          requestHash: parsedReq.data.requestHash,
          decision: resolution.kind === 'approve' ? 'approved' : 'denied',
          approvedBy: ctx.actorUserId,
          decidedAt: new Date().toISOString(),
          ...(reason ? { reason } : {}),
        });
      }

      // Build the resume payload from the resolution kind, then dispatch.
      const resumeInput = buildResumeInput(item, resolution, ctx.actorUserId);
      try {
        await deps.sessionService.resumeSession({
          tenantId: ctx.tenantId,
          sessionId: row.sessionId as SessionId,
          stepExecutionId: stepExecutionId as StepExecutionId,
          input: resumeInput,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ActionCenterResolveError(
          'DISPATCH_FAILED',
          `Failed to resume session ${row.sessionId}: ${message}`,
          'transient',
          message,
        );
      }

      // Best-effort: re-read the requested-input ref to report the original
      // op id (`user.interaction.ask` / `user.interaction.approve` /
      // gateContext.operationId for gate items). Falls back to the kind
      // when payload isn't readable.
      const payload = await loadRequestedInputPayload(deps, row.requestedInputRef);
      const reportedOperationId = inferReportedOperationId(payload, item.kind);

      return {
        resolvedAt: new Date().toISOString(),
        dispatchedOperationId: 'workflow.run.resume',
        reportedOperationId,
      };
    },
  };
}

// ============================================================================
// Item id encoding — origin discriminator in the prefix
// ============================================================================

function parseItemId(itemId: string): string | null {
  if (itemId.startsWith(STEP_ITEM_ID_PREFIX)) return itemId.slice(STEP_ITEM_ID_PREFIX.length);
  if (itemId.startsWith(GATE_ITEM_ID_PREFIX)) return itemId.slice(GATE_ITEM_ID_PREFIX.length);
  return null;
}

// ============================================================================

interface PausedSessionSlim {
  sessionId: string;
  spaceId: string | null;
  status: string;
  currentStepExecutionId: string | null;
  requestedInputRef: string | null;
  pauseReason: string | null;
  startedAt: Date;
  hotStateSnapshot: unknown;
}

/**
 * A harness-routed run (Runner sub-session) surfaces its consent pause as a
 * workflow-run pause that only the run-resume authority (Plan 185 Phase 2b)
 * can clear — `oauthConsentResume` already defers these rather than resuming
 * them step-plane. Plane A must stay consistent: do not build a step-plane
 * "Connect" card for a run whose `workflowExecution` is set, or the operator
 * would complete OAuth against a card whose resume is refused. The signal is
 * read from the flushed `hotStateSnapshot.runHotState.workflowExecution`.
 */
function isHarnessRoutedRun(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const runHotState = (snapshot as { runHotState?: unknown }).runHotState;
  if (!runHotState || typeof runHotState !== 'object') return false;
  return (runHotState as { workflowExecution?: unknown }).workflowExecution != null;
}

/**
 * Cap on paused-session rows pulled per list call. Set conservatively
 * higher than the route's per-request `limit` (default 200, max 500) so
 * the in-memory sort by `requestedAt` (done by the aggregator after this
 * source returns) sees a representative window.
 *
 * Codex P2 (post-merge): the pre-LIMIT ORDER BY uses `sessions.startedAt`
 * because we have no `pausedAt` column — the actual pause-request time
 * only exists inside the `requestedInputRef` payload, which the SQL
 * stage can't access. For long-running sessions that pause much later,
 * `startedAt` understates recency, so a too-small SQL window can
 * exclude recently-paused items from a busy space. The right fix is
 * either (a) over-fetch + sort in memory, or (b) add a `paused_at`
 * column to `sessions`. (a) is the immediate, no-migration fix; (b) is
 * a follow-up.
 */
const PAUSED_SESSION_QUERY_CAP = 1_000;

async function listPausedSessions(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
): Promise<PausedSessionSlim[]> {
  const tenantCtx = createTenantContext(scope.tenantId);
  return withTenantSchema(deps.db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        sessionId: sessions.sessionId,
        spaceId: sessions.spaceId,
        status: sessions.status,
        currentStepExecutionId: sessions.currentStepExecutionId,
        requestedInputRef: sessions.requestedInputRef,
        pauseReason: sessions.pauseReason,
        startedAt: sessions.startedAt,
        hotStateSnapshot: sessions.hotStateSnapshot,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.spaceId, scope.spaceId),
          eq(sessions.status, 'PAUSED'),
          isNotNull(sessions.requestedInputRef),
          isNotNull(sessions.currentStepExecutionId),
        ),
      )
      // `startedAt` is a coarse proxy for pause recency (see PAUSED_SESSION_QUERY_CAP);
      // the authoritative `requestedAt` lives in each row's payload and the
      // aggregator re-sorts on it after buildItemFromSession reads it.
      .orderBy(desc(sessions.startedAt))
      .limit(PAUSED_SESSION_QUERY_CAP);
    return rows;
  });
}

async function loadSessionByCurrentStep(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  stepExecutionId: string,
): Promise<PausedSessionSlim | null> {
  const tenantCtx = createTenantContext(scope.tenantId);
  return withTenantSchema(deps.db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        sessionId: sessions.sessionId,
        spaceId: sessions.spaceId,
        status: sessions.status,
        currentStepExecutionId: sessions.currentStepExecutionId,
        requestedInputRef: sessions.requestedInputRef,
        pauseReason: sessions.pauseReason,
        startedAt: sessions.startedAt,
        hotStateSnapshot: sessions.hotStateSnapshot,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.spaceId, scope.spaceId),
          eq(sessions.currentStepExecutionId, stepExecutionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * On STALE_ACTION_CENTER_ITEM, try to return a fresh item from the session
 * the caller was acting on. Returns undefined if we can't locate one (rare
 * — e.g. session was deleted). Best-effort.
 */
async function tryLoadLatestFromSessionId(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  staleItem: ActionCenterSourceItem,
): Promise<ActionCenterSourceItem | undefined> {
  if (staleItem.origin.type !== 'step') return undefined;
  const sessionId = staleItem.origin.sessionId;
  const tenantCtx = createTenantContext(scope.tenantId);
  const row = await withTenantSchema(deps.db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        sessionId: sessions.sessionId,
        spaceId: sessions.spaceId,
        status: sessions.status,
        currentStepExecutionId: sessions.currentStepExecutionId,
        requestedInputRef: sessions.requestedInputRef,
        pauseReason: sessions.pauseReason,
        startedAt: sessions.startedAt,
        hotStateSnapshot: sessions.hotStateSnapshot,
      })
      .from(sessions)
      .where(and(eq(sessions.spaceId, scope.spaceId), eq(sessions.sessionId, sessionId)))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!row) return undefined;
  const item = await buildItemFromSession(deps, scope, row);
  return item ?? undefined;
}

// ============================================================================
// Session row → ActionCenterSourceItem
// ============================================================================

async function loadRequestedInputPayload(
  deps: ActionCenterSourceDeps,
  ref: string | null,
): Promise<Record<string, unknown> | null> {
  if (!ref) return null;
  try {
    const raw = await deps.payloadStore.retrieve(ref as never);
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  } catch {
    /* malformed or missing payload */
  }
  return null;
}

function inferReportedOperationId(
  payload: Record<string, unknown> | null,
  kind: ActionCenterItemKind,
): string {
  // For gate-derived items, the gated op is the meaningful one to report
  const gateContext = payload?.['gateContext'] as GateContext | undefined;
  if (gateContext?.operationId) return gateContext.operationId;
  return kind === 'human_input' ? 'user.interaction.ask' : 'user.interaction.approve';
}

async function buildItemFromSession(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  row: PausedSessionSlim,
): Promise<ActionCenterSourceItem | null> {
  if (!row.currentStepExecutionId || !row.requestedInputRef) return null;

  const payload = await loadRequestedInputPayload(deps, row.requestedInputRef);
  if (!payload) return null;

  // Discriminate by payload.kind — set by the user executor handler
  // (apps/aflow-executor-user/src/handlers/userInputHandler.ts) for input/
  // approval, and by the integration executor for `oauth_consent` (Plan 185
  // §9.3 Plane A — the "Connect {provider}" pause).
  const rawKind = typeof payload['kind'] === 'string' ? payload['kind'] : null;
  if (
    rawKind !== 'input' &&
    rawKind !== 'approval' &&
    rawKind !== 'oauth_consent' &&
    rawKind !== 'write_approval'
  )
    return null;

  if (rawKind === 'oauth_consent') {
    // Plane A owns only direct-caller consent pauses. Harness-routed runs are
    // surfaced and resumed by the run-plane source (Phase 2b); building a
    // step-plane card for them here would dead-end at resume.
    if (isHarnessRoutedRun(row.hotStateSnapshot)) return null;
    return buildOAuthConsentItem(scope, row, payload);
  }

  if (rawKind === 'write_approval') {
    return buildWriteApprovalItem(scope, row, payload);
  }

  const gateContext = payload['gateContext'] as GateContext | undefined;
  const kind: ActionCenterItemKind = rawKind === 'input' ? 'human_input' : 'human_approval';

  // Title / summary from the payload.
  let title: string;
  let summary: string;
  if (rawKind === 'input') {
    title = typeof payload['title'] === 'string' ? payload['title'] : 'Information requested';
    const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : '';
    summary = prompt.slice(0, 2_000) || 'A skill is waiting for your input.';
  } else {
    title = typeof payload['title'] === 'string' ? payload['title'] : 'Approval requested';
    summary =
      typeof payload['description'] === 'string'
        ? payload['description'].slice(0, 2_000)
        : 'A step needs approval before continuing.';
  }

  // `pauseVersion` says only open-or-closed. What distinguishes two pauses at
  // the same step — the run asking again, about something else — is the token
  // derived from the request itself.
  const pauseVersion = row.status === 'PAUSED' ? 0 : 1;
  const origin: ActionCenterItemOrigin = {
    type: 'step',
    runId: row.sessionId,
    stepExecutionId: row.currentStepExecutionId,
    sessionId: row.sessionId,
    pauseVersion,
    pauseToken: derivePauseToken({
      stepExecutionId: row.currentStepExecutionId,
      requestedInputRef: row.requestedInputRef,
    }),
    operationId: rawKind === 'input' ? 'user.interaction.ask' : 'user.interaction.approve',
  };

  const resolverPolicy = deriveResolverPolicy(payload);

  const relatesTo: RelatesToEntry[] = [];
  if (gateContext) {
    relatesTo.push({
      kind: 'step',
      id: row.currentStepExecutionId,
      label: gateContext.operationId,
    });
    if (gateContext.bindingId) {
      relatesTo.push({
        kind: 'binding',
        id: gateContext.bindingId,
        label: gateContext.bindingId,
      });
    }
  }

  const uiHints =
    payload['uiHints'] && typeof payload['uiHints'] === 'object'
      ? (payload['uiHints'] as ActionCenterSourceItem['uiHints'])
      : undefined;
  const resolutionSchema =
    payload['inputSchema'] && typeof payload['inputSchema'] === 'object'
      ? (payload['inputSchema'] as Record<string, unknown>)
      : undefined;

  const requestedBy = {
    kind: 'agent' as const,
    label: 'Agent',
    sessionId: row.sessionId,
  };

  // Codex P2: use the pause request timestamp (set by the user executor
  // handler in `userInputHandler.ts`) rather than `session.startedAt`.
  // Long-running sessions that pause much later were being sorted as
  // artificially old and skewing latency / audit calculations derived
  // from `requestedAt`. Fall back to session start when the payload
  // pre-dates the field (older paused sessions in the queue).
  const requestedAtRaw = typeof payload['requestedAt'] === 'string' ? payload['requestedAt'] : null;
  const requestedAt = requestedAtRaw ?? row.startedAt.toISOString();

  return {
    id: `${STEP_ITEM_ID_PREFIX}${row.currentStepExecutionId}`,
    spaceId: scope.spaceId,
    kind,
    origin,
    title: title.slice(0, 256),
    summary: summary || 'No description provided.',
    ...(uiHints ? { uiHints } : {}),
    ...(resolutionSchema ? { resolutionSchema } : {}),
    requestedAt,
    requestedBy,
    priority: 'normal',
    ...(gateContext ? { gateContext } : {}),
    ...(resolverPolicy ? { resolverPolicy } : {}),
    relatesTo,
    resolverAuthority: { kind: 'space' },
    status: row.status === 'PAUSED' ? 'open' : 'resolved',
  };
}

// ============================================================================
// OAuth-consent pause → "Connect {provider}" item (Plan 185 §9.3 Plane A)
// ============================================================================

/**
 * Build a `needs_oauth_consent` Action Center item from a paused step whose
 * `requestedInputRef` carries an `OAuthConsentRequestPayload`. The card is a
 * launch affordance, not a resolvable HITL item — resume is callback-driven
 * (the OAuth callback resumes the parked session), so the only allowed action
 * is `connect`.
 */
function buildOAuthConsentItem(
  scope: ActionCenterScope,
  row: PausedSessionSlim,
  payload: Record<string, unknown>,
): ActionCenterSourceItem | null {
  if (!row.currentStepExecutionId) return null;

  const integrationKind = payload['integrationKind'] === 'api' ? 'api' : 'mcp';
  const resourceKey = typeof payload['resourceKey'] === 'string' ? payload['resourceKey'] : '';
  const bindingId = typeof payload['bindingId'] === 'string' ? payload['bindingId'] : '';
  const ownerScope = parseOwnerScope(payload['ownerScope']);
  const reason = payload['reason'] === 'expired' ? 'expired' : 'never_connected';
  const consentUrlHint =
    typeof payload['consentUrlHint'] === 'string' ? payload['consentUrlHint'] : undefined;
  const authorizationUrlHint =
    typeof payload['authorizationUrlHint'] === 'string'
      ? payload['authorizationUrlHint']
      : undefined;

  const providerLabel = resourceKey || bindingId || 'this integration';
  const title = `Connect ${providerLabel}`;
  const summary =
    reason === 'expired'
      ? `Your connection to ${providerLabel} has expired. Reconnect to let the skill continue.`
      : `${providerLabel} needs your authorization before the skill can continue.`;

  const extension: OAuthConsentExtension = {
    kind: 'oauth_consent',
    integrationKind,
    resourceKey,
    bindingId,
    ownerScope,
    reason,
    ...(consentUrlHint ? { consentUrlHint } : {}),
    ...(authorizationUrlHint ? { authorizationUrlHint } : {}),
  };

  const origin: ActionCenterItemOrigin = {
    type: 'step',
    runId: row.sessionId,
    stepExecutionId: row.currentStepExecutionId,
    sessionId: row.sessionId,
    pauseVersion: row.status === 'PAUSED' ? 0 : 1,
    operationId: integrationKind === 'mcp' ? 'mcp.tool.call' : 'api.call.invoke',
  };

  const requestedAtRaw = typeof payload['requestedAt'] === 'string' ? payload['requestedAt'] : null;
  const requestedAt = requestedAtRaw ?? row.startedAt.toISOString();

  return {
    id: `${STEP_ITEM_ID_PREFIX}${row.currentStepExecutionId}`,
    spaceId: scope.spaceId,
    kind: 'needs_oauth_consent',
    origin,
    title: title.slice(0, 256),
    summary: summary.slice(0, 2_000),
    extension,
    requestedAt,
    requestedBy: { kind: 'agent' as const, label: 'Agent', sessionId: row.sessionId },
    priority: 'normal',
    relatesTo: [{ kind: 'binding', id: bindingId || resourceKey, label: providerLabel }],
    resolverAuthority: { kind: 'space' },
    status: row.status === 'PAUSED' ? 'open' : 'resolved',
  };
}

// ============================================================================
// Approval pause → approve/deny item: an API write (Plan 253) or a browser action (Plan 320 D7)
// ============================================================================

const WRITE_TIER_LABEL: Record<string, string> = {
  medium: 'external / not-easily-undone',
  high: 'financial / destructive',
};

/**
 * Build a `write_approval` Action Center item from a paused step whose
 * `requestedInputRef` carries a `WriteApprovalRequestPayload` — an API write
 * or a browser action. Unlike OAuth consent, this IS a resolvable HITL item —
 * approve/reject resolve through the standard route; the resolve writes the
 * grant, the orchestrator re-dispatches on approve, and fails the step on reject.
 */
function buildWriteApprovalItem(
  scope: ActionCenterScope,
  row: PausedSessionSlim,
  payload: Record<string, unknown>,
): ActionCenterSourceItem | null {
  if (!row.currentStepExecutionId) return null;
  const parsed = WriteApprovalRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const req = parsed.data;
  const shown = req.target === 'browser' ? browserApprovalShown(req) : apiWriteApprovalShown(req);

  const origin: ActionCenterItemOrigin = {
    type: 'step',
    runId: row.sessionId,
    stepExecutionId: row.currentStepExecutionId,
    sessionId: row.sessionId,
    pauseVersion: row.status === 'PAUSED' ? 0 : 1,
    operationId: shown.operationId,
  };

  const requestedAtRaw = typeof payload['requestedAt'] === 'string' ? payload['requestedAt'] : null;
  const requestedAt = requestedAtRaw ?? row.startedAt.toISOString();

  return {
    id: `${STEP_ITEM_ID_PREFIX}${row.currentStepExecutionId}`,
    spaceId: scope.spaceId,
    kind: 'write_approval',
    origin,
    title: shown.title.slice(0, 256),
    summary: shown.summary.slice(0, 2_000),
    extension: shown.extension,
    requestedAt,
    requestedBy: { kind: 'agent' as const, label: 'Agent', sessionId: row.sessionId },
    priority: shown.priority,
    relatesTo: shown.relatesTo,
    resolverAuthority: { kind: 'space' },
    status: row.status === 'PAUSED' ? 'open' : 'resolved',
  };
}

interface WriteApprovalShown {
  readonly title: string;
  readonly summary: string;
  readonly extension: WriteApprovalExtension;
  readonly operationId: string;
  readonly priority: 'normal' | 'high';
  readonly relatesTo: RelatesToEntry[];
}

function apiWriteApprovalShown(req: ApiWriteApprovalRequestPayload): WriteApprovalShown {
  const label = req.operationLabel ?? req.endpointName ?? `${req.method} ${req.endpointId}`;
  const tierNote = WRITE_TIER_LABEL[req.writeRiskTier] ?? req.writeRiskTier;
  return {
    title: `Approve write: ${label}`,
    summary: `A skill wants to call ${req.method} ${req.urlHost} (${req.apiId}/${req.endpointId}) — ${tierNote}. Approve to let it send, or deny to stop it.`,
    extension: {
      kind: 'write_approval',
      target: 'api',
      apiId: req.apiId,
      endpointId: req.endpointId,
      method: req.method,
      urlHost: req.urlHost,
      writeRiskTier: req.writeRiskTier,
      ...(req.endpointName ? { endpointName: req.endpointName } : {}),
      ...(req.operationLabel ? { operationLabel: req.operationLabel } : {}),
      ...(req.bodyPreview ? { bodyPreview: req.bodyPreview } : {}),
      ...(req.initiatedBy ? { initiatedBy: req.initiatedBy } : {}),
    },
    operationId: 'api.http.call',
    priority: req.writeRiskTier === 'high' ? 'high' : 'normal',
    relatesTo: [{ kind: 'binding', id: req.apiId, label: req.apiId }],
  };
}

function siteOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function browserApprovalShown(req: BrowserWriteApprovalRequestPayload): WriteApprovalShown {
  const site = siteOf(req.pageOrigin);
  const doing = browserApprovalActionPhrase(req);
  const asked =
    req.askedBy.kind === 'rule'
      ? `The operator's rule \`${req.askedBy.rule}\` asks before actions on this site.`
      : `Browser profile \`${req.profileId}\` asks before every action.`;
  return {
    title: `Approve in the browser: ${doing} on ${site}`,
    summary:
      `An agent wants to ${doing} on “${req.pageTitle}” (${req.pageOrigin}). ${asked} ` +
      'Approve to let it do this once, or deny to stop it.',
    extension: {
      kind: 'write_approval',
      target: 'browser',
      profileId: req.profileId,
      pageOrigin: req.pageOrigin,
      pageTitle: req.pageTitle,
      action: req.action,
      element: { ...req.element },
      askedBy: req.askedBy,
      ...(req.value !== undefined ? { value: { ...req.value } } : {}),
      ...(req.screenshotRef !== undefined ? { screenshotRef: req.screenshotRef } : {}),
    },
    operationId: BROWSER_PAGE_ACT_OPERATION_ID,
    priority: 'normal',
    relatesTo: [],
  };
}

function parseOwnerScope(raw: unknown): OAuthConsentExtension['ownerScope'] {
  if (raw === 'user' || raw === 'space') return raw;
  return 'user';
}

// ============================================================================
// Resume-input construction — turn an ActionCenterResolution into the
// payload sessionService.resumeSession expects for each op kind.
// ============================================================================

function buildResumeInput(
  item: ActionCenterSourceItem,
  resolution: ActionCenterResolution,
  actorUserId: string,
): unknown {
  const now = new Date().toISOString();
  if (item.kind === 'needs_oauth_consent') {
    // Plane A consent is launched out-of-band and resumed by the OAuth
    // callback — it is never resolved through the Action Center resolve route.
    throw new ActionCenterResolveError(
      'INVALID_RESOLUTION',
      `A 'needs_oauth_consent' item is resolved by completing the OAuth flow, not via the resolve route.`,
      'permanent',
    );
  }
  if (item.kind === 'human_input') {
    if (resolution.kind !== 'submit') {
      throw new ActionCenterResolveError(
        'INVALID_RESOLUTION',
        `Human-input items only accept 'submit' resolutions; got '${resolution.kind}'.`,
        'permanent',
      );
    }
    return {
      input: resolution.payload,
      providedAt: now,
      providedBy: actorUserId,
    };
  }

  // human_approval (and gate-derived).
  if (resolution.kind === 'approve') {
    return {
      decision: 'approved' as const,
      ...(resolution.comment ? { comment: resolution.comment } : {}),
      decidedAt: now,
      decidedBy: actorUserId,
    };
  }
  if (resolution.kind === 'reject') {
    return {
      decision: 'rejected' as const,
      ...(resolution.reason ? { comment: resolution.reason } : {}),
      decidedAt: now,
      decidedBy: actorUserId,
    };
  }

  throw new ActionCenterResolveError(
    'INVALID_RESOLUTION',
    `Human-approval items accept 'approve'/'reject'; got '${resolution.kind}'.`,
    'permanent',
  );
}
