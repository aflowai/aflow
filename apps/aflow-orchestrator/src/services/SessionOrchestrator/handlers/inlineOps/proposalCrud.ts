import { getDatabase, createTenantContext, createMemoryDocRepository } from '@aflow/database';
import type { TenantId, StagedChange, ProposalListInput, ProposalGetInput } from '@aflow/schemas';
import { PROPOSAL_DIRS, tryParseStagedChangeDoc } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';

// ============================================================================
// Router
// ============================================================================

export async function handleProposalCrudInline(args: InlineHandlerArgs): Promise<void> {
  const operationId = args.stepDef.operation;
  const startTime = Date.now();

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await args.payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input is valid for proposal.list with all defaults */
    }

    if (
      operationId === 'proposal.ratify' ||
      operationId === 'proposal.reject' ||
      operationId === 'proposal.dismiss'
    ) {
      await emitStepError(
        args,
        'PROPOSAL_MUTATION_NOT_PERMITTED',
        `'${operationId}' is not callable as a tool. Call \`human.action_center.focus\` ` +
          `with the proposal's Action Center item id so the operator can resolve it from ` +
          `the Action Center.`,
        startTime,
        'validation',
      );
      return;
    }

    switch (operationId) {
      case 'proposal.list':
        await handleProposalList(args, input as unknown as ProposalListInput, startTime);
        break;
      case 'proposal.get':
        await handleProposalGet(args, input as unknown as ProposalGetInput, startTime);
        break;
      default:
        await emitStepError(
          args,
          'UNKNOWN_OPERATION',
          `Unknown proposal operation: ${operationId}`,
          startTime,
          'validation',
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitStepError(args, 'PROPOSAL_OPERATION_FAILED', message, startTime, 'internal');
  }
}

// ============================================================================
// proposal.list
// ============================================================================

async function handleProposalList(
  args: InlineHandlerArgs,
  input: ProposalListInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const tenantId = args.context.tenantId as string;
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);

  const pendingOnly = (input.pendingOnly as boolean | undefined) ?? true;
  const limit = (input.limit as number | undefined) ?? 50;
  const routeFilter = input.resolutionRoute;

  const docArrays = await Promise.all(
    PROPOSAL_DIRS.map((dir) =>
      docRepo.list({
        pathPrefix: dir,
        scope: { spaceId },
        filters: { docType: ['json'] },
        limit,
      }),
    ),
  );
  const docs = docArrays.flat();

  const proposals: Array<Record<string, unknown>> = [];
  for (const d of docs) {
    if (!d.path.endsWith('.json')) continue;
    const full = await docRepo.getById(d.id, spaceId);
    if (!full?.inlineContent) continue;

    const parsed = tryParseStagedChangeDoc(full.inlineContent, {
      tenantId,
      spaceId,
      docId: d.id,
      docPath: d.path,
      reader: 'proposal.list',
    });
    if (!parsed.ok) continue;
    const sc: StagedChange = parsed.staged;

    if (pendingOnly && sc.status !== 'proposed') continue;
    if (input.workflowSlug && sc.targetWorkflowSlug !== input.workflowSlug) continue;
    if (routeFilter && sc.resolutionRoute !== routeFilter) continue;

    proposals.push({
      id: sc.id,
      kind: sc.kind,
      ...(sc.source ? { source: sc.source } : {}),
      status: sc.status,
      summary: sc.proposal.summary,
      rationale: sc.proposal.rationale,
      confidence: sc.proposal.confidence,
      targetWorkflowSlug: sc.targetWorkflowSlug ?? null,
      opCount: sc.proposal.ops.length,
      opKinds: sc.proposal.ops.map((op) => op.op),
      authorityLevel: sc.authorityLevel,
      resolutionRoute: sc.resolutionRoute,
      ...(sc.evidence.diagnosis?.issueCategory
        ? { issueCategory: sc.evidence.diagnosis.issueCategory }
        : {}),
      proposedAt: sc.proposedAt,
      expiresAt: sc.expiresAt,
      resolvedAt: sc.resolvedAt ?? null,
      resolvedBy: sc.resolvedBy ?? null,
      hasReflectionEvidence: (sc.evidence.reflectionRefs?.length ?? 0) > 0,
      hasDigestEvidence: !!sc.evidence.digestRef,
      ...(sc.lastRatificationError ? { lastRatificationError: sc.lastRatificationError } : {}),
      ...(sc.rebaseState ? { rebaseState: sc.rebaseState } : {}),
      ...(sc.rebaseState === 'stale' && sc.staleDetails
        ? {
            staleSummary: {
              conflictCount: sc.staleDetails.conflicts.length,
              firstOpKind: sc.staleDetails.conflicts[0]?.opKind ?? null,
            },
          }
        : {}),
    });
  }

  // Stable sort: most recent first across both dirs.
  proposals.sort((a, b) => String(b['proposedAt']).localeCompare(String(a['proposedAt'])));
  if (proposals.length > limit) proposals.length = limit;

  await emitStepSuccess(args, { proposals }, startTime);
}

// ============================================================================
// proposal.get
// ============================================================================

async function handleProposalGet(
  args: InlineHandlerArgs,
  input: ProposalGetInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const tenantId = args.context.tenantId as string;
  const sc = await loadProposal(tenantId, spaceId, input.proposalId);
  if (!sc) {
    await emitStepError(
      args,
      'PROPOSAL_NOT_FOUND',
      `Proposal ${input.proposalId} not found in space ${spaceId}.`,
      startTime,
      'validation',
    );
    return;
  }

  await emitStepSuccess(args, { proposal: sc as unknown as Record<string, unknown> }, startTime);
}

// ============================================================================

// ============================================================================
// Helpers
// ============================================================================

async function loadProposal(
  tenantId: string,
  spaceId: string,
  proposalId: string,
): Promise<StagedChange | null> {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  for (const dir of PROPOSAL_DIRS) {
    const path = `${dir}/${proposalId}.json`;
    const doc = await docRepo.getByPath(path, spaceId);
    if (!doc?.inlineContent) continue;
    const parsed = tryParseStagedChangeDoc(doc.inlineContent, {
      tenantId,
      spaceId,
      docPath: path,
      reader: 'proposal.get/loadProposal',
    });
    if (parsed.ok) return parsed.staged;
    // fall through to next dir (matches prior catch behaviour) — the
    // helper has already emitted the warn+counter.
  }
  return null;
}
