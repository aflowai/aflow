/**
 * `eval.case.propose` — the one eval-plane operation a skill may call.
 *
 * It writes an `eval_case_draft` StagedChange and nothing else. No case lands
 * here: ratification re-runs the authoring gate against the skill revision the
 * cases name, and refuses the ones whose checks cannot fail. That is what makes
 * this safe to expose to a skill at all — the subject still cannot change a
 * ruler, it can only ask a person to.
 */
import { randomUUID } from 'node:crypto';

import {
  createMemoryDirRepository,
  createMemoryDocRepository,
  createTenantContext,
  getDatabase,
} from '@aflow/database';
import { EvalCaseProposeInputSchema, StagedChangeSchema } from '@aflow/schemas';
import { findPolarityMismatches, proposalDirForRoute } from '@aflow/cybernetic-runtime';

import { emitStepError, emitStepSuccess, readInlineOpInputRecord } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import type { InlineHandlerArgs } from './types.js';

const PROPOSAL_TTL_DAYS = 30;

export async function handleEvalCaseProposeInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const tenantId = args.context.tenantId;
  const spaceId = requireSpaceId(args.context);

  const opInput = await readInlineOpInputRecord(args);
  if (!opInput) {
    await emitStepError(
      args,
      'EVAL_CASE_PROPOSE_NO_INPUT',
      'Operation input is missing or unparseable. The propose task expects inputBindings resolved by the workflow engine.',
      startTime,
      'validation',
    );
    return;
  }

  const parsed = EvalCaseProposeInputSchema.safeParse(opInput);
  if (!parsed.success) {
    await emitStepError(
      args,
      'EVAL_CASE_PROPOSE_INVALID_INPUT',
      `The drafted cases do not match the golden-case contract: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      startTime,
      'validation',
    );
    return;
  }

  const { workflowSlug, cases, rationale } = parsed.data;

  // Polarity is a property of the case alone — which way a check comes out
  // against its own requirement — so it is decidable here, while the drafting
  // run can still act on the answer. Ratification would catch it too, but only
  // after the turn has ended, and it refuses the whole suite for one bad case.
  const polarityProblems = cases.flatMap((content, i) =>
    findPolarityMismatches(content).map(
      (m) => `cases.${String(i)} ("${content.title}"): ${m.detail}`,
    ),
  );
  if (polarityProblems.length > 0) {
    await emitStepError(
      args,
      'EVAL_CASE_PROPOSE_CHECK_POLARITY',
      `A check fails when its requirement is MET, which measures the opposite of what it claims: ${polarityProblems.join('; ')}`,
      startTime,
      'validation',
    );
    return;
  }
  const proposalId = randomUUID();
  const now = new Date().toISOString();

  const ops = cases.map((content) => ({
    op: 'eval_case_draft' as const,
    workflowSlug,
    content,
    authoredBySkillId: 'eval-suite-design',
  }));
  // Not `resolveProposalRoute`: it reads targetSlug as the artifact being
  // CHANGED, and here it names the skill being MEASURED. A suite for a
  // platform-owned skill would route to platform_issue and then be refused as
  // non-ratifiable — but a golden dataset is a tenant artifact whoever wrote
  // the skill it measures.
  const route = 'tenant_ratification' as const;

  const summary =
    cases.length === 1
      ? `Add a golden case to ${workflowSlug}: ${cases[0]!.title}`
      : `Add ${String(cases.length)} golden cases to ${workflowSlug}`;

  const stagedChange = {
    id: proposalId,
    kind: 'eval_case_draft' as const,
    source: 'compose_skill' as const,
    status: 'proposed' as const,
    targetWorkflowSlug: workflowSlug,
    proposal: { summary, rationale, confidence: 'medium' as const, ops },
    // The workflow run, not `context.runId` — for an inline workflow task that
    // is the synthetic worker session, which no run lookup resolves.
    evidence: { sourceSessionIds: [args.workflowExecution?.runId ?? args.context.runId] },
    coachSessionId: args.workflowExecution?.runId ?? args.context.runId,
    authorityLevel: 'require_operator' as const,
    resolutionRoute: route,
    proposedAt: now,
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };

  // Every reader parses this document and skips it silently when it does not
  // match, so an unparseable write is a proposal that succeeded and is
  // invisible. Fail here instead, where the reason is still in hand.
  const validated = StagedChangeSchema.safeParse(stagedChange);
  if (!validated.success) {
    await emitStepError(
      args,
      'EVAL_CASE_PROPOSE_UNSTORABLE',
      `The proposal does not match the staged-change contract and would be invisible to every reader: ${validated.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      startTime,
      'configuration',
    );
    return;
  }

  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  const path = `${proposalDirForRoute(route)}/${proposalId}.json`;
  await dirRepo.ensureParentDirs(path, { spaceId });

  const content = JSON.stringify(stagedChange, null, 2);
  await docRepo.put({
    path,
    writeMode: 'create',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: content,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    contentHash: '',
    preview: content.substring(0, 200),
    tags: ['staged', 'eval_case_draft'],
    summary,
    semanticType: 'staged_change',
    indexing: 'disabled',
    scope: { spaceId },
    provenance: { actor: 'system:eval-suite-design' },
  });

  // The Action Center rebuilds on this channel rather than polling, so an
  // operator with the page already open sees nothing until some other wake
  // without it. Best-effort: a proposal that landed is worth reporting even if
  // the notification does not.
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.proposal',
        spaceId,
        tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: { stagedChangeId: proposalId, kind: 'eval_case_draft', targetSlug: workflowSlug },
        summary,
      },
    });
  } catch {
    // Best-effort event emission
  }

  await emitStepSuccess(
    args,
    { stagedChangeId: proposalId, caseCount: cases.length, summary },
    startTime,
  );
}
