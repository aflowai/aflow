import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { eq } from 'drizzle-orm';
import { configureLogging } from '@aflow/observability';
import {
  causalMeasurements,
  coachActivity,
  createDatabase,
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
  memoryDocs,
  spaces,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import { appendSessionEvent, readEntityEvents } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { TenantId } from '@aflow/schemas';
import { CoachReviewContextSchema, EntityDirectivesSchema } from '@aflow/schemas';
import {
  captureRunnerReflectionForSession,
  compileCoachFacts,
  loadAppliedChangeOutcomes,
  loadReflections,
  markReflectionExpected,
  readReflectionCompleteness,
  reflectionsFromEntityEvents,
  shouldActivateCoach,
  triggerCoachReview,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '18320000-0000-4000-8000-000000000002';
const SLUG = 'capture-condition-loop-test-skill';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 183 Group 2 — capture & condition loop (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const redis = new RedisMock() as unknown as Redis;
  // The reflections-first digest never dereferences payloads; persistDigest
  // writes memory docs through `db`. A throwing stub proves it.
  const payloadStore = {
    retrieve: async () => {
      throw new Error('reflections-first digest must not retrieve payloads');
    },
  } as unknown as PayloadStore;

  const directives = EntityDirectivesSchema.parse({
    version: 1,
    responsibility: 'Exercise the Plan 183 Group 2 capture & condition loop.',
  });

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
      provenance: { actor: 'system:capture-condition-loop-test' },
    });
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, SPACE_ID));
      await tx.delete(causalMeasurements).where(eq(causalMeasurements.spaceId, SPACE_ID));
      await tx.delete(coachActivity).where(eq(coachActivity.spaceId, SPACE_ID));
      // workflow_run_tasks rows are removed by the DB-level ON DELETE CASCADE
      // on workflow_run_tasks.run_id (migration050) — the drizzle pgTable does
      // not declare the FK. Never delete task rows by bare taskId here: it
      // would hit other runs across the shared tenant schema.
      await tx.delete(workflowRuns).where(eq(workflowRuns.workflowSlug, SLUG));
      await tx.delete(spaces).where(eq(spaces.id, SPACE_ID));
    });
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'workflow_run_tasks'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await cleanup();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values({
        id: SPACE_ID,
        name: 'Capture Condition Loop Test Space',
        slug: 'capture-condition-loop-test-space',
        mode: 'cybernetic',
        directives,
      });
    });
  });

  afterAll(async () => {
    if (schemaReady) {
      await cleanup();
    }
    await handle.close();
  });

  it('closes the loop: submit_output capture → reflection + condition persisted → agent_signal activation → reflections-first context with applied-change evidence → replayable → rate-capped', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    const runId = randomUUID();
    const analyzeSessionId = randomUUID();
    const fetchSessionId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);

    // 1. A completed run with two Runner-executed tasks.
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(workflowRuns).values({
        spaceId: SPACE_ID,
        workflowSlug: SLUG,
        runId,
        status: 'completed',
        workflowRevision: 1,
        startedAt,
        completedAt: new Date(),
      });
      await tx.insert(workflowRunTasks).values([
        { runId, taskId: 'analyze', status: 'succeeded', attempt: 1, startedAt },
        { runId, taskId: 'fetch', status: 'paused', attempt: 1, startedAt },
      ]);
    });

    // 2. The analyze Runner's session events — 3 tool steps, none failed
    //    (→ complexity routine, progress advancing under default knobs).
    for (let i = 0; i < 3; i++) {
      await appendSessionEvent(redis, TENANT_ID, analyzeSessionId, {
        eventId: randomUUID(),
        eventType: 'StepScheduled',
        timestamp: Date.now(),
        sessionId: analyzeSessionId,
      });
    }

    // 3. Capture exactly as the submit_output handler does: expected marker
    //    (sync) + the async capture. The Runner reported straining on what
    //    derived as a ROUTINE task → disposition `struggling` (§4.3).
    await markReflectionExpected(redis, TENANT_ID, runId);
    const reflection = await captureRunnerReflectionForSession({
      db,
      redis,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      runnerSessionId: analyzeSessionId,
      workflowExecution: { runId, taskId: 'analyze', attempt: 1 },
      workflowSlug: SLUG,
      source: 'submit_output',
    });
    expect(reflection.condition).toMatchObject({
      progress: 'advancing',
      complexity: 'routine',
      disposition: 'steady',
      trace: { stepCount: 3, failedStepCount: 0 },
    });

    // 3b. The fetch Runner blocks via signal_blocked — the reflection carries
    //     the concrete asks; no condition (the category encodes it).
    await markReflectionExpected(redis, TENANT_ID, runId);
    const blockedReflection = await captureRunnerReflectionForSession({
      db,
      redis,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      runnerSessionId: fetchSessionId,
      workflowExecution: { runId, taskId: 'fetch', attempt: 1 },
      workflowSlug: SLUG,
      source: 'signal_blocked',
      blocked: {
        category: 'missing_input',
        reason: 'No API key available for the data source',
        needed: 'data_source_api_key',
      },
    });
    expect(blockedReflection.condition).toBeUndefined();
    expect(blockedReflection.missingInputs).toEqual(['data_source_api_key']);

    // 4. Persisted: ONE read returns both; the completeness marker is full.
    const loaded = await loadReflections(db, TENANT_ID, runId);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((r) => r.taskId === 'analyze')?.condition?.disposition).toBe('struggling');
    expect(await readReflectionCompleteness(redis, TENANT_ID, runId)).toEqual({
      expected: 2,
      captured: 2,
    });

    // 4b. The deterministic facts compiler consumes the concrete asks.
    const facts = await compileCoachFacts({
      db,
      redis,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      runId,
      workflowSlug: SLUG,
    });
    expect(facts.missingInputs).toEqual([
      expect.objectContaining({
        taskId: 'fetch',
        inputKey: 'data_source_api_key',
        source: 'runner_reflection',
      }),
    ]);
    // confidence / critique no longer exist anywhere in the diagnostic input.
    expect(JSON.stringify(facts)).not.toContain('confidence');
    expect(JSON.stringify(loaded)).not.toContain('critique');

    // 5. A recently-ratified proposal for this skill with a measured outcome
    //    (the shipped causal substrate) + its staged warrant.
    const proposalId = randomUUID();
    const ratifiedAt = new Date(Date.now() - 60 * 60 * 1000);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(causalMeasurements).values({
        spaceId: SPACE_ID,
        proposalId,
        subjectKind: 'skill',
        subjectId: SLUG,
        ratifiedAt,
        baselineWindowStart: new Date(ratifiedAt.getTime() - 86_400_000),
        baselineWindowEnd: ratifiedAt,
        postWindowStart: ratifiedAt,
        postWindowEnd: new Date(ratifiedAt.getTime() + 86_400_000),
        baselineMetrics: { avgOverall: 0.5, sampleCount: 3, scores: [0.4, 0.5, 0.6] },
        postMetrics: { avgOverall: 0.5, sampleCount: 2, scores: [0.5, 0.5] },
        deltaComputedAt: new Date(),
        metadata: { issueCategory: 'procedure' },
      });
    });
    await putDoc(`/coach/staged/${proposalId}.json`, {
      kind: 'workflow_refinement',
      proposal: { summary: 'Tighten the analyze task goal' },
      evidence: {
        warrant: { expectedEffect: 'Next run completes analyze without rendering errors.' },
      },
    });

    const outcomes = await loadAppliedChangeOutcomes({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      limit: directives.learningPolicy.appliedChangeEvidenceLimit,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      proposalId,
      kind: 'workflow_refinement',
      issueCategory: 'procedure',
      expectedEffect: 'Next run completes analyze without rendering errors.',
      measured: { baselineAvg: 0.5, postAvg: 0.5, delta: 0, finalized: true },
    });

    // 6. The REAL trigger pipeline: barrier resolves 'complete', the gate
    //    fires on the agent_signal producer (struggling on routine), the
    //    digest assembles reflections-first, and the persisted context
    //    carries the typed evidence.
    const totalRuns = 10; // past the bootstrap window
    const coachSessionId = await triggerCoachReview({
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      runId,
      totalRuns,
      directives,
      db,
      redis,
      payloadStore,
    });
    expect(coachSessionId).not.toBeNull();
    expect(await redis.get(`cybernetic:coach-rate:${SPACE_ID}:${SLUG}`)).toBe('1');

    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const contextDoc = await docRepo.getByPath(`/coach/contexts/${coachSessionId}.json`, SPACE_ID);
    const reviewContext = CoachReviewContextSchema.parse(JSON.parse(contextDoc!.inlineContent!));
    expect(reviewContext.trigger.kind).toBe('agent_signal');
    expect(reviewContext.trigger.rationale).toContain('disposition=struggling');
    expect(reviewContext.target.runId).toBe(runId);
    expect(reviewContext.appliedChangeOutcomes).toHaveLength(1);
    expect(reviewContext.appliedChangeOutcomes?.[0]?.proposalId).toBe(proposalId);

    // 6b. The activation event records the evidence-snapshot identity.
    const { events } = await readEntityEvents(redis, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      count: 200,
    });
    const activated = events.find((e) => e.eventType === 'entity.coach.activated');
    expect(activated?.payload['triggerSource']).toBe('agent_signal');
    expect(activated?.payload['evidenceSnapshot']).toEqual({
      runId,
      reflectionCompleteness: 'complete',
    });

    // 7. §5.4 replay — the decision re-derives identically from the
    //    entity-event stream alone (no DB read).
    const replayedReflections = reflectionsFromEntityEvents(events, runId);
    expect(replayedReflections).toHaveLength(2);
    const replayedDecision = await shouldActivateCoach({
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      runId,
      totalRuns,
      directives,
      reflections: replayedReflections,
      db,
      redis,
    });
    expect(replayedDecision?.activate).toBe(true);
    expect(replayedDecision?.source).toBe('agent_signal');
    expect(replayedDecision?.reason).toBe(reviewContext.trigger.rationale);

    // 8. The agent signal respects the EXISTING per-skill rate cap — no bypass.
    const maxActivations = directives.learningPolicy.maxCoachActivationsPerSkillPerWindow;
    await redis.set(`cybernetic:coach-rate:${SPACE_ID}:${SLUG}`, String(maxActivations));
    const suppressed = await triggerCoachReview({
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      runId,
      totalRuns,
      directives,
      db,
      redis,
      payloadStore,
    });
    expect(suppressed).toBeNull();
    const { events: afterEvents } = await readEntityEvents(redis, {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      count: 300,
    });
    expect(
      afterEvents.some(
        (e) => e.eventType === 'entity.coach.suppressed' && e.payload['reason'] === 'rate_cap',
      ),
    ).toBe(true);
  });
});
