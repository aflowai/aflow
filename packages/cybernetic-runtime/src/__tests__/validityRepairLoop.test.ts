import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { eq } from 'drizzle-orm';
import { configureLogging } from '@aflow/observability';
import {
  createDatabase,
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
  withTenantSchema,
  workflowDocPath,
  memoryDocs,
  spaces,
} from '@aflow/database';
import type { StagedChange, TenantId, Workflow, WorkflowTask } from '@aflow/schemas';
import {
  CoachReviewContextSchema,
  EntityDirectivesSchema,
  WorkflowSchema,
  validateCoachAuthoredProposal,
} from '@aflow/schemas';
import {
  applyRatifiedOps,
  checkPendingRepairFingerprint,
  clearPendingRepairFingerprints,
  computeProposalPreconditions,
  computeValidityRepairFingerprint,
  ensureWorkflowDocValidity,
  hasOpenRepairProposal,
  loadProposalValidationSnapshot,
  materializeAndValidateSkillConfig,
  maybeTriggerValidityRepairReview,
  previewProposalApply,
  rebuildSkillProjection,
  recordPendingRepairFingerprint,
  runWorkflowProposalValidations,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '18390000-0000-4000-8000-000000000001';
const SLUG = 'validity-repair-loop-test-skill';
const FINGERPRINT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // rejectedFingerprintWindow default

const describeDb = DATABASE_URL ? describe : describe.skip;

function agentTask(taskId: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'agent', ...partial } as WorkflowTask;
}

function workflowDoc(tasks: WorkflowTask[]): Record<string, unknown> {
  return {
    id: '18390000-0000-4000-8000-0000000000aa',
    slug: SLUG,
    name: 'Validity Repair Loop Test Skill',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'done' } }],
    mode: 'process',
    tasks,
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    stateVariables: [],
    revision: 1,
    status: 'approved',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
  };
}

// The drift class: `analyze` depends on a task that does not exist.
const BROKEN_TASKS = [agentTask('prepare'), agentTask('analyze', { dependsOn: ['ghost-task'] })];
const VALID_TASKS = [agentTask('prepare'), agentTask('analyze', { dependsOn: ['prepare'] })];

describeDb('Plan 183g — validity repair loop (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const redis = new RedisMock() as unknown as Redis;

  let schemaReady = false;

  async function putDoc(path: string, content: Record<string, unknown>): Promise<void> {
    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const dirRepo = createMemoryDirRepository(db, tenantCtx);
    await dirRepo.ensureParentDirs(path, { spaceId: SPACE_ID });
    const json = JSON.stringify(content, null, 2);
    await docRepo.put({
      path,
      writeMode: 'upsert',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: json,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(json, 'utf8'),
      contentHash: '',
      preview: json.substring(0, 200),
      tags: ['test'],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId: SPACE_ID },
      provenance: { actor: 'system:validity-repair-loop-test' },
    });
  }

  async function readWorkflowDoc(): Promise<Record<string, unknown>> {
    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const doc = await docRepo.getByPath(workflowDocPath(SLUG), SPACE_ID);
    expect(doc?.inlineContent).toBeTruthy();
    return JSON.parse(doc!.inlineContent!) as Record<string, unknown>;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, SPACE_ID));
      await tx.delete(spaces).where(eq(spaces.id, SPACE_ID));
    });
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_docs'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await cleanup();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values({
        id: SPACE_ID,
        name: 'Validity Repair Loop Test Space',
        slug: 'validity-repair-loop-test-space',
        mode: 'cybernetic',
        directives: EntityDirectivesSchema.parse({
          version: 1,
          responsibility: 'Exercise the Plan 183g validity repair loop.',
        }),
      });
    });
  });

  afterAll(async () => {
    if (schemaReady) {
      await cleanup();
    }
    await handle.close();
  });

  it('closes the loop: flip invalid → validity_signal → repair patch → propose gate → ratify → valid → unblocked', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }
    const rateKey = `cybernetic:coach-rate:${SPACE_ID}:${SLUG}`;

    // 1. A fielded, VALID skill: manifest + workflow doc + first reconcile.
    const now = new Date().toISOString();
    await putDoc(`/skills/${SLUG}/manifest.json`, {
      schemaVersion: 2,
      skillId: SLUG,
      name: 'Validity Repair Loop Test Skill',
      goal: { type: 'objective', criteria: [{ id: 'done', description: 'completes cleanly' }] },
      origin: 'operator',
      workflowSlug: SLUG,
      requiredCapabilities: [],
      createdAt: now,
      updatedAt: now,
    });
    await putDoc(workflowDocPath(SLUG), workflowDoc(VALID_TASKS));

    const reconcilerCtx = { db, tenantId: TENANT_ID, spaceId: SPACE_ID, redis };
    const validProjection = await rebuildSkillProjection(reconcilerCtx, SLUG);
    expect(validProjection?.projection.contractValidity?.status).toBe('valid');
    expect(await redis.get(rateKey)).toBeNull(); // no activation for a valid skill

    // 2. Rules-drift simulation: the stored config flips contract-invalid
    //    (direct doc overwrite — the write gates would reject authoring this).
    await putDoc(workflowDocPath(SLUG), workflowDoc(BROKEN_TASKS));
    const verdict = ensureWorkflowDocValidity(await readWorkflowDoc());
    expect(verdict.status).toBe('invalid');
    expect(verdict.diagnostics.some((d) => d.code === 'missing_dep')).toBe(true);
    // The execution-gate predicate (workflowCrud/run/start.ts) blocks on this.
    expect(
      materializeAndValidateSkillConfig({ tasks: BROKEN_TASKS, stateVariables: [] }).validity
        .status,
    ).toBe('invalid');

    // 3. Reconciler seam — the valid→invalid TRANSITION fires exactly one
    //    validity_signal activation through the real trigger pipeline.
    const invalidProjection = await rebuildSkillProjection(reconcilerCtx, SLUG);
    expect(invalidProjection?.projection.contractValidity?.status).toBe('invalid');
    expect(await redis.get(rateKey)).toBe('1'); // one activation, rate-cap counted

    const fingerprint = computeValidityRepairFingerprint(SLUG, verdict.diagnostics);
    expect(
      await checkPendingRepairFingerprint(
        redis,
        SPACE_ID,
        SLUG,
        fingerprint,
        FINGERPRINT_WINDOW_MS,
      ),
    ).toBe(true);

    // The persisted CoachReviewContext carries the repair intent + evidence.
    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const contextDocs = await docRepo.list({
      scope: { spaceId: SPACE_ID },
      pathPrefix: '/coach/contexts',
      limit: 10,
    });
    expect(contextDocs.length).toBe(1);
    const contextDoc = await docRepo.getByPath(contextDocs[0]!.path, SPACE_ID);
    const reviewContext = CoachReviewContextSchema.parse(JSON.parse(contextDoc!.inlineContent!));
    expect(reviewContext.trigger.kind).toBe('validity_signal');
    expect(reviewContext.target.skillSlug).toBe(SLUG);
    expect(reviewContext.validityDiagnostics).toEqual(verdict.diagnostics);

    // 4. Repeated reconciles of the already-invalid skill do NOT re-fire.
    await rebuildSkillProjection(reconcilerCtx, SLUG);
    expect(await redis.get(rateKey)).toBe('1');

    // 5. A second blocked-run attempt (gate seam) while the repair is pending
    //    yields NO new activation (fingerprint suppression).
    const secondAttempt = await maybeTriggerValidityRepairReview({
      db,
      redis,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      diagnostics: verdict.diagnostics,
      anchorRunId: randomUUID(),
    });
    expect(secondAttempt).toBeNull();
    expect(await redis.get(rateKey)).toBe('1');

    // 6. A deliberately-broken patch is rejected AT PROPOSE with structured
    //    diagnostics and never becomes a proposal. This one fixes the dep but
    //    introduces the kind-class break: an op task whose required input no
    //    producer fills (`workflow.learn` without `learnings`).
    const brokenWorkflow = WorkflowSchema.parse(await readWorkflowDoc());
    const brokenPatch = previewProposalApply({
      workflow: brokenWorkflow,
      evalSuites: new Map(),
      ops: [
        { op: 'update_task_dependencies', taskId: 'analyze', dependsOn: ['prepare'] },
        {
          op: 'add_task',
          task: {
            taskId: 'record',
            name: 'record',
            goal: 'g',
            type: 'operation',
            operation: 'workflow.learn',
            dependsOn: ['analyze'],
          },
        },
      ],
      targetSlug: SLUG,
    });
    expect(brokenPatch.ok).toBe(false);
    if (!brokenPatch.ok) {
      expect(brokenPatch.failureCode).toContain('graph_validator');
      expect(brokenPatch.diagnostics).toBeDefined();
      expect(brokenPatch.diagnostics!.some((d) => d.code === 'op_input_missing_required')).toBe(
        true,
      );
      expect(brokenPatch.diagnostics![0]).toHaveProperty('dimension');
    }
    expect(await hasOpenRepairProposal(db, TENANT_ID, SPACE_ID, SLUG)).toBe(false);

    // 7. The good patch clears the diagnostics: propose gate validates it.
    const repairOps: StagedChange['proposal']['ops'] = [
      { op: 'update_task_dependencies', taskId: 'analyze', dependsOn: ['prepare'] },
    ];
    const preview = previewProposalApply({
      workflow: brokenWorkflow,
      evalSuites: new Map(),
      ops: repairOps,
      targetSlug: SLUG,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const snapshot = await loadProposalValidationSnapshot({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
    });
    const validations = runWorkflowProposalValidations(preview.candidateWorkflow, snapshot);
    expect(validations.contract.status).toBe('valid');

    // 8. The repair proposal: workflow_refinement, evidence = the diagnostics
    //    (digest trio waived — there is no run to digest).
    const proposalId = randomUUID();
    const proposalShape = {
      kind: 'workflow_refinement' as const,
      targetWorkflowSlug: SLUG,
      proposal: { ops: repairOps },
    };
    const stagedChange: StagedChange = {
      id: proposalId,
      kind: 'workflow_refinement',
      source: 'coach',
      status: 'proposed',
      targetWorkflowSlug: SLUG,
      proposal: {
        summary: `Repair contract of "${SLUG}"`,
        rationale: 'validity_signal repair: re-point analyze at the real upstream task.',
        confidence: 'high',
        ops: repairOps,
        validations,
      },
      evidence: {
        sourceSessionIds: [randomUUID()],
        validityDiagnostics: verdict.diagnostics,
        diagnosis: { issueCategory: 'procedure' },
        warrant: {
          claim: 'analyze depends on a task that does not exist',
          evidenceSummary: 'The verdict carries a missing_dep diagnostic for analyze.',
          warrant: 'A dangling dependsOn blocks every run at the execution gate.',
          causeStatus: 'observed',
          expectedEffect: 'The verdict recomputes valid and runs are admitted again.',
        },
        applyPreview: {
          attempted: true,
          result: 'ok',
          previewedAt: new Date().toISOString(),
          workflowRevisionAtPreview: preview.workflowRevisionAtPreview,
        },
      },
      authorityLevel: 'require_operator',
      resolutionRoute: 'tenant_ratification',
      proposedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + FINGERPRINT_WINDOW_MS).toISOString(),
      coachSessionId: reviewContext.coachSessionId,
      rebaseState: 'clean',
      pinnedRevision: brokenWorkflow.revision,
      ...(computeProposalPreconditions(proposalShape, { workflow: brokenWorkflow })
        ? {
            preconditions: computeProposalPreconditions(proposalShape, {
              workflow: brokenWorkflow,
            }),
          }
        : {}),
    };

    // Digest trio waived because the diagnostics carry the evidence…
    expect(validateCoachAuthoredProposal(stagedChange)).toEqual([]);
    // …and required without them (a normal Coach proposal still needs the digest).
    const withoutDiagnostics: StagedChange = {
      ...stagedChange,
      evidence: { ...stagedChange.evidence },
    };
    delete (withoutDiagnostics.evidence as Record<string, unknown>)['validityDiagnostics'];
    const issues = validateCoachAuthoredProposal(withoutDiagnostics);
    expect(issues.some((i) => i.field === 'evidence.digestRef')).toBe(true);

    await putDoc(
      `/coach/staged/${proposalId}.json`,
      stagedChange as unknown as Record<string, unknown>,
    );
    expect(await hasOpenRepairProposal(db, TENANT_ID, SPACE_ID, SLUG)).toBe(true);

    // 9. With the proposal open, a new activation is suppressed even after the
    //    fingerprint clears (the StagedChange check is the second guard).
    await clearPendingRepairFingerprints(redis, SPACE_ID, SLUG);
    const whileProposalOpen = await maybeTriggerValidityRepairReview({
      db,
      redis,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      diagnostics: verdict.diagnostics,
      anchorRunId: randomUUID(),
    });
    expect(whileProposalOpen).toBeNull();
    expect(await redis.get(rateKey)).toBe('1');

    // 10. Ratify — the patch lands in place (never a reinstall).
    const applied = await applyRatifiedOps(
      { tenantId: TENANT_ID, spaceId: SPACE_ID, db },
      stagedChange,
    );
    expect(applied.applied).toBe(true);
    expect(applied.stale).toBeUndefined();

    // 11. The verdict recomputes valid — the originally-blocked run's gate
    //     predicate now admits it.
    const repairedDoc = await readWorkflowDoc();
    expect(ensureWorkflowDocValidity(repairedDoc).status).toBe('valid');
    const repairedWorkflow = WorkflowSchema.parse(repairedDoc);
    const gateVerdict = materializeAndValidateSkillConfig({
      tasks: repairedWorkflow.tasks,
      stateVariables: repairedWorkflow.stateVariables,
    });
    expect(gateVerdict.validity.status).toBe('valid');

    // 12. The next reconcile observes invalid→valid and clears the
    //     pending-repair state (a future re-break of the same shape can fire).
    await recordPendingRepairFingerprint(
      redis,
      SPACE_ID,
      SLUG,
      fingerprint,
      Date.now(),
      FINGERPRINT_WINDOW_MS,
    );
    const repairedProjection = await rebuildSkillProjection(reconcilerCtx, SLUG);
    expect(repairedProjection?.projection.contractValidity?.status).toBe('valid');
    expect(
      await checkPendingRepairFingerprint(
        redis,
        SPACE_ID,
        SLUG,
        fingerprint,
        FINGERPRINT_WINDOW_MS,
      ),
    ).toBe(false);
    expect(await redis.get(rateKey)).toBe('1'); // still exactly one activation, ever
  });
});
