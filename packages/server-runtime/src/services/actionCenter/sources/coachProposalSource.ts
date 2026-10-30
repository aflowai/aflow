import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import {
  PROPOSAL_DIRS,
  provenanceOf,
  resolveProposalProvenance,
  tryParseStagedChangeDoc,
} from '@aflow/cybernetic-runtime';
import {
  type ActionCenterItemOrigin,
  type ActionCenterRequester,
  type ProposalProvenance,
  type StagedChange,
  type StagedChangeSource,
} from '@aflow/schemas';
import { deriveCoachProposalProjection } from '../../cybernetic/coachProposalProjection.js';
import {
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  type ActionCenterSourceDeps,
  ActionCenterResolveError,
} from '../types.js';
import {
  dismissProposal,
  proposalNotFound,
  ratifyProposal,
  readProposal,
  rejectProposal,
  type ProposalResolutionFailure,
} from '../../cybernetic/proposalResolution.js';

/** Action Center item ids carry an origin-discriminating prefix. */
const PROPOSAL_ITEM_ID_PREFIX = 'proposal:';

export function createCoachProposalSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  return {
    name: 'coachProposal',
    rowScope: 'space',
    handlesOriginTypes: ['proposal'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const docs = await listPendingProposalDocs(deps, scope);
      const provenance = await resolveProposalProvenance(
        deps.db,
        scope.tenantId,
        scope.spaceId,
        docs,
      );
      const items: ActionCenterSourceItem[] = [];
      for (const sc of docs) {
        const item = toActionCenterItem(sc, scope, provenance.get(sc.id));
        if (item) items.push(item);
      }
      return items;
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      if (!itemId.startsWith(PROPOSAL_ITEM_ID_PREFIX)) return null;
      const proposalId = itemId.slice(PROPOSAL_ITEM_ID_PREFIX.length);
      const read = await readProposal(
        deps.db,
        ctx.tenantId,
        ctx.spaceId,
        proposalId,
        'coachProposalSource.getById',
      );
      if (read.ok) return mapOne(deps, read.staged, ctx);
      if (read.reason === 'not_found') return null;
      // A proposal that exists but cannot be shown is not a missing one: say why.
      throw proposalUnreadableError(proposalId, ctx.spaceId, proposalNotFound(read));
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      const proposalId = item.id.slice(PROPOSAL_ITEM_ID_PREFIX.length);
      const serviceDeps = { db: deps.db, redis: deps.redis, payloadStore: deps.payloadStore };
      const serviceCtx = {
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        resolvedBy: ctx.actorUserId,
      };

      switch (resolution.kind) {
        case 'ratify': {
          const result = await ratifyProposal(serviceDeps, serviceCtx, proposalId);
          if (result.ok) {
            return {
              resolvedAt: new Date().toISOString(),
              dispatchedOperationId: 'proposal.ratify',
              reportedOperationId: 'proposal.ratify',
              ...(result.setupChecklist !== undefined
                ? { setupChecklist: result.setupChecklist }
                : {}),
            };
          }
          throw await convertFailureToError(deps, ctx, proposalId, result);
        }

        case 'reject': {
          const result = await rejectProposal(serviceDeps, serviceCtx, proposalId, {
            ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
          });
          if (result.ok) {
            return {
              resolvedAt: new Date().toISOString(),
              dispatchedOperationId: 'proposal.reject',
              reportedOperationId: 'proposal.reject',
            };
          }
          throw await convertFailureToError(deps, ctx, proposalId, result);
        }

        case 'dismiss': {
          const result = await dismissProposal(serviceDeps, serviceCtx, proposalId, {
            ...(resolution.reason !== undefined ? { dismissReason: resolution.reason } : {}),
          });
          if (result.ok) {
            return {
              resolvedAt: new Date().toISOString(),
              dispatchedOperationId: 'proposal.dismiss',
              reportedOperationId: 'proposal.dismiss',
            };
          }
          throw await convertFailureToError(deps, ctx, proposalId, result);
        }

        case 'submit':
        case 'approve':
        case 'reassign':
          throw new ActionCenterResolveError(
            'INVALID_RESOLUTION',
            `Resolution kind '${resolution.kind}' is not valid for a proposal item; use 'ratify' / 'reject' / 'dismiss'.`,
            'permanent',
          );
      }
    },
  };
}

/**
 * Translate a ProposalResolutionFailure from the shared service into the
 * ActionCenterResolveError shape the aggregator + REST routes expect.
 * Re-loads the proposal on stale paths so the caller gets a fresh
 * `latestItem` to render.
 */
async function convertFailureToError(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  proposalId: string,
  failure: { ok: false } & Record<string, unknown>,
): Promise<ActionCenterResolveError> {
  switch (failure['code']) {
    case 'NOT_FOUND': {
      const notFound = failure as unknown as Extract<
        ProposalResolutionFailure,
        { code: 'NOT_FOUND' }
      >;
      if (notFound.reason !== 'not_found') {
        return proposalUnreadableError(proposalId, scope.spaceId, notFound);
      }
      return new ActionCenterResolveError(
        'NOT_FOUND',
        `Proposal ${proposalId} not found.`,
        'permanent',
      );
    }
    case 'ALREADY_RESOLVED':
    case 'STALE': {
      const latest = await loadAndMap(deps, scope, proposalId);
      const msg =
        failure['code'] === 'STALE'
          ? `Proposal ${proposalId} is stale (preconditions failed); regenerate or apply-anyway via the existing route.`
          : `Proposal ${proposalId} is already ${String(failure['status'])}; client must reload.`;
      return new ActionCenterResolveError(
        'STALE_ACTION_CENTER_ITEM',
        msg,
        'stale_target',
        typeof failure['detail'] === 'string' ? failure['detail'] : undefined,
        latest,
      );
    }
    case 'PROPOSAL_NOT_RATIFIABLE':
    case 'PROPOSAL_NOT_DISMISSIBLE':
    case 'USE_DISMISS_FOR_PLATFORM_ISSUE':
      return new ActionCenterResolveError(
        'INVALID_RESOLUTION',
        typeof failure['detail'] === 'string' ? failure['detail'] : (failure['code'] as string),
        'permanent',
      );
    case 'APPLY_FAILED':
      return new ActionCenterResolveError(
        'DISPATCH_FAILED',
        typeof failure['detail'] === 'string'
          ? failure['detail']
          : 'applyRatifiedOps threw — see server logs.',
        'transient',
      );
    case 'RATIFICATION_APPLY_FAILED': {
      const err = failure['error'] as { op: string; detail: string; reason: string };
      const stale =
        err.reason === 'target_skill_missing' ||
        err.reason === 'workflow_not_found' ||
        err.reason === 'platform_artifact_read_only' ||
        err.reason === 'precondition_missing';
      const latest = await loadAndMap(deps, scope, proposalId);
      return new ActionCenterResolveError(
        'RATIFICATION_APPLY_FAILED',
        `Ratification apply failed on op '${err.op}': ${err.detail}`,
        stale ? 'stale_target' : 'transient',
        err.detail,
        latest,
      );
    }
    default:
      return new ActionCenterResolveError(
        'DISPATCH_FAILED',
        `Unhandled proposal failure code: ${String(failure['code'])}`,
        'permanent',
      );
  }
}

async function loadAndMap(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  proposalId: string,
): Promise<ActionCenterSourceItem | undefined> {
  const read = await readProposal(
    deps.db,
    scope.tenantId,
    scope.spaceId,
    proposalId,
    'coachProposalSource.loadAndMap',
  );
  if (!read.ok) return undefined;
  return (await mapOne(deps, read.staged, scope)) ?? undefined;
}

/** The error for a proposal that exists in this space but cannot be shown, naming why. */
function proposalUnreadableError(
  proposalId: string,
  spaceId: string,
  failure: Extract<ProposalResolutionFailure, { code: 'NOT_FOUND' }>,
): ActionCenterResolveError {
  return new ActionCenterResolveError(
    'NOT_FOUND',
    `Proposal ${proposalId} in space ${spaceId} cannot be shown. ${failure.detail}`,
    'permanent',
    failure.reason,
  );
}

// ============================================================================
// Doc helpers — mirror the readProposal / persistProposal pair in
// packages/server-runtime/src/routes/cybernetic/proposals.ts. Local copies keep the
// adapter standalone; a future refactor can extract the shared helper.
// ============================================================================

async function listPendingProposalDocs(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
): Promise<StagedChange[]> {
  const tenantCtx = createTenantContext(scope.tenantId);
  const docRepo = createMemoryDocRepository(deps.db, tenantCtx);
  const arrays = await Promise.all(
    PROPOSAL_DIRS.map((dir) =>
      docRepo.list({
        pathPrefix: dir,
        scope: { spaceId: scope.spaceId },
        filters: { docType: ['json'] },
        limit: 200,
      }),
    ),
  );
  const docs = arrays.flat();
  const out: StagedChange[] = [];
  for (const d of docs) {
    if (!d.path.endsWith('.json')) continue;
    const full = await docRepo.getById(d.id, scope.spaceId);
    if (!full?.inlineContent) continue;
    const parsed = tryParseStagedChangeDoc(full.inlineContent, {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      docId: d.id,
      docPath: d.path,
      reader: 'coachProposalSource.listPendingProposalDocs',
    });
    if (!parsed.ok) continue;
    if (parsed.staged.status === 'proposed') out.push(parsed.staged);
  }
  return out;
}

// ============================================================================
// Mapping — StagedChange → ActionCenterSourceItem
// ============================================================================

async function mapOne(
  deps: ActionCenterSourceDeps,
  sc: StagedChange,
  scope: ActionCenterScope,
): Promise<ActionCenterSourceItem | null> {
  const provenance = await resolveProposalProvenance(deps.db, scope.tenantId, scope.spaceId, [sc]);
  return toActionCenterItem(sc, scope, provenance.get(sc.id));
}

/** Who asked, by the proposal's source. An agent's patch names the agent the record names. */
const REQUESTER_KIND_BY_SOURCE: Record<StagedChangeSource, ActionCenterRequester['kind']> = {
  coach: 'coach',
  agent_patch: 'agent',
  compose_skill: 'workflow',
  bind_capability: 'workflow',
  operator: 'system',
};

function requesterOf(provenance: ProposalProvenance): ActionCenterRequester {
  return {
    kind: REQUESTER_KIND_BY_SOURCE[provenance.source],
    label: provenance.authorRole ?? provenance.sourceLabel,
    ...(provenance.conversation ? { sessionId: provenance.conversation.sessionId } : {}),
  };
}

function toActionCenterItem(
  sc: StagedChange,
  scope: ActionCenterScope,
  resolved: ProposalProvenance | undefined,
): ActionCenterSourceItem | null {
  const provenance = resolved ?? provenanceOf(sc, null);
  const kind =
    sc.resolutionRoute === 'platform_issue'
      ? ('platform_issue' as const)
      : ('ratification' as const);

  // CAS revision: bump on status transition. While proposed, revision is 0;
  // any change to status (or rebaseState) is observed by the client as
  // STALE. Phase 3 keeps it simple — the source's resolve handler re-reads
  // the doc and compares status directly.
  const revision = sc.status === 'proposed' ? 0 : 1;

  const origin: ActionCenterItemOrigin = {
    type: 'proposal',
    proposalId: sc.id,
    proposalRevision: revision,
    resolutionRoute: sc.resolutionRoute,
  };

  const resolutionError = sc.lastRatificationError
    ? {
        reason: sc.lastRatificationError.reason,
        severity: 'transient' as const,
        ...(sc.lastRatificationError.detail ? { detail: sc.lastRatificationError.detail } : {}),
        attempts: 0,
      }
    : undefined;

  return {
    id: `${PROPOSAL_ITEM_ID_PREFIX}${sc.id}`,
    spaceId: scope.spaceId,
    kind,
    origin,
    title:
      sc.proposal.summary.length > 0
        ? sc.proposal.summary.slice(0, 256)
        : kind === 'platform_issue'
          ? 'Platform issue'
          : provenance.sourceLabel,
    summary:
      kind === 'platform_issue'
        ? `A platform-side issue (${sc.kind}). Diagnostic only — dismiss to acknowledge.`
        : `${sc.proposal.summary} (confidence: ${sc.proposal.confidence})`,
    extension: deriveCoachProposalProjection(sc, provenance),
    requestedAt: sc.proposedAt,
    ...(sc.expiresAt ? { expiresAt: sc.expiresAt } : {}),
    requestedBy: requesterOf(provenance),
    priority: 'normal',
    relatesTo: sc.targetWorkflowSlug
      ? [{ kind: 'workflow' as const, id: sc.targetWorkflowSlug, label: sc.targetWorkflowSlug }]
      : [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
    ...(resolutionError ? { resolutionError } : {}),
  };
}
