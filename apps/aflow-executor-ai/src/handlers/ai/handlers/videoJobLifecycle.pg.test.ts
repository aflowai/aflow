/**
 * The video lane against the real async-job table.
 *
 * A fake repository would prove the handler calls the methods it calls. Only
 * the real compare-and-set rows show that a restarted worker resumes a paid
 * render instead of buying a second one, so these drive the repository the
 * handler actually uses.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  createAsyncJobRepository,
  createMemoryDocRepository,
  withTenantSchema,
  type AsyncJobRepository,
  type MemoryDocRepository,
  type TenantContext,
} from '@aflow/database';
import {
  AiMediaOutputSchema,
  deriveMediaAssetId,
  type AiVideoGenerateInput,
  type AsyncJobIdentity,
  type AsyncReplayGuarantee,
  type StepJobMessage,
  type TenantId,
} from '@aflow/schemas';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { deriveExecutionRunId, deriveLogicalExecutionId } from '@aflow/executor-runtime';
import type {
  AIClient,
  AIProviderAdapter,
  GenerateVideoRequest,
  PollVideoJobRequest,
  VideoJobHandle,
  VideoJobPoll,
} from '@aflow/ai-client';
import { createDefaultModelCatalog } from '@aflow/ai-client';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { getAIClientForContext } from '../aiClient.js';
import { handleVideoGenerate } from './videoGenerate.js';
import { handleVideoFromImage } from './videoFromImage.js';
import { hashMediaRequest } from './mediaRequestIdentity.js';
import { VIDEO_POLL_INTERVAL_MS } from './mediaBudget.js';
import type { HandlerDeps } from './types.js';

vi.mock('../aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
/**
 * This suite's namespaces, and inside each one an id of this execution's own.
 * The namespace is the handle a later run sweeps an aborted one by; the random
 * tail is what keeps two concurrent runs — two worktrees, a re-run started
 * before the last finished — out of each other's rows. Both stay shaped as
 * uuids: a delivered render is filed as a Memory document whose provenance
 * columns are typed `uuid`.
 */
const SPACE_NAMESPACE = 'd0000000-0000-0000-284a-';
const RUN_NAMESPACE = 'd0000000-0000-0000-284d-';

function namespacedId(namespace: string): string {
  return `${namespace}${randomBytes(6).toString('hex')}`;
}

/** Its own space, so nothing here shares a memory path with a real one. */
const SPACE_ID = namespacedId(SPACE_NAMESPACE);
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

/** This execution's own run. */
const RUN = namespacedId(RUN_NAMESPACE);

/** A Veo model: real catalog pricing, and no dedupe key on the submit route. */
const VEO = 'veo-3.1-generate-preview';
/** What the catalog publishes as this model's clip length. Asserted below. */
const VEO_DEFAULT_CLIP_SECONDS = 8;

interface FakeProvider {
  adapter: AIProviderAdapter;
  submits: GenerateVideoRequest[];
  polls: PollVideoJobRequest[];
  /** Polls to answer `pending` before reporting the render finished. */
  pendingPolls: number;
  outcome: 'succeeded' | 'failed';
  durationSeconds: number | undefined;
  submitThrows: Error | undefined;
  replayGuarantee: AsyncReplayGuarantee;
  /**
   * Whether the route can name a submit's handle before making it. Off by
   * default, so the Veo-shaped route stays the one every other case drives.
   */
  handleIsCallerAssigned: boolean;
}

/** The address a caller-assigned handle lands under, for the fake route. */
function derivedHandle(clientRequestId: string): VideoJobHandle {
  return { providerJobId: `derived:${clientRequestId}` };
}

function fakeProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  const state: FakeProvider = {
    adapter: {} as AIProviderAdapter,
    submits: [],
    polls: [],
    pendingPolls: 0,
    outcome: 'succeeded',
    durationSeconds: 8,
    submitThrows: undefined,
    replayGuarantee: { kind: 'unknown_terminal' },
    handleIsCallerAssigned: false,
    ...overrides,
  };

  state.adapter = {
    provider: 'google',
    generateText: () => {
      throw new Error('unused');
    },
    generateTextStream: () => {
      throw new Error('unused');
    },
    generateJson: () => {
      throw new Error('unused');
    },
    generateEmbedding: () => {
      throw new Error('unused');
    },
    replayGuaranteeFor: () => state.replayGuarantee,
    ...(state.handleIsCallerAssigned
      ? { videoJobHandleFor: (clientRequestId: string) => derivedHandle(clientRequestId) }
      : {}),
    submitVideoJob: (request: GenerateVideoRequest): Promise<VideoJobHandle> => {
      state.submits.push(request);
      if (state.submitThrows) return Promise.reject(state.submitThrows);
      if (state.handleIsCallerAssigned && request.clientRequestId !== undefined) {
        return Promise.resolve(derivedHandle(request.clientRequestId));
      }
      return Promise.resolve({ providerJobId: `provider-job-${String(state.submits.length)}` });
    },
    pollVideoJob: (request: PollVideoJobRequest): Promise<VideoJobPoll> => {
      state.polls.push(request);
      if (state.polls.length <= state.pendingPolls) return Promise.resolve({ status: 'pending' });
      if (state.outcome === 'failed') {
        return Promise.resolve({ status: 'failed', message: 'the render was rejected' });
      }
      return Promise.resolve({
        status: 'succeeded',
        response: {
          videos: [
            {
              data: 'ZmFrZQ==',
              mimeType: 'video/mp4',
              ...(state.durationSeconds !== undefined
                ? { durationSeconds: state.durationSeconds }
                : {}),
            },
          ],
          model: VEO,
          provider: 'google',
        },
      });
    },
  } as unknown as AIProviderAdapter;

  return state;
}

/** What a model publishes as its own clip length. `{}` is a model that publishes none. */
interface ClipDefault {
  defaultVideoDurationSeconds?: number;
}

function fakeClient(provider: FakeProvider, clip: ClipDefault, modelId: string = VEO): AIClient {
  const catalog = createDefaultModelCatalog();
  // The catalog entry's own default is cleared first, so `{}` really is a model
  // with nothing to say about clip length.
  const definition = {
    ...catalog.getModel(VEO),
    defaultVideoDurationSeconds: undefined,
    ...clip,
  };
  return {
    modelCatalog: catalog,
    resolveModelId: (key: string) => (key === 'sora' ? 'sora-2' : modelId),
    getAdapter: () => Promise.resolve(provider.adapter),
    getModel: () => definition,
  } as unknown as AIClient;
}

interface JobRow {
  attempt: number;
  state: string;
  provider_job_id: string | null;
  cost_currency: string | null;
  cost_micros: string | null;
}

interface Capture {
  ctx: ExecutorContext;
  outputs: unknown[];
  errors: unknown[];
}

function restoreEnv(name: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

/**
 * Budgets the handler down to `polls` provider polls, so it gives up while the
 * render is still running — what an executor restart looks like from here.
 */
async function withPollBudget<T>(polls: number, fn: () => Promise<T>): Promise<T> {
  const priorMargin = process.env['AI_VIDEO_DELIVERY_MARGIN_MS'];
  const priorBudget = process.env['AI_VIDEO_POLL_BUDGET_MS'];
  process.env['AI_VIDEO_DELIVERY_MARGIN_MS'] = '1';
  process.env['AI_VIDEO_POLL_BUDGET_MS'] = String(VIDEO_POLL_INTERVAL_MS * polls);
  try {
    return await fn();
  } finally {
    restoreEnv('AI_VIDEO_DELIVERY_MARGIN_MS', priorMargin);
    restoreEnv('AI_VIDEO_POLL_BUDGET_MS', priorBudget);
  }
}

interface CtxOptions {
  /** A job carrying no space: its render has nowhere to file its bytes. */
  spaceless?: boolean;
  /**
   * The workflow task this job is an attempt at. A workflow dispatch carries no
   * session and mints its worker session per attempt, so the caller passes a
   * different `stepExecutionId` for each attempt at the same task.
   */
  workflowTaskId?: string;
}

/** The message the orchestrator enqueues, on whichever plane dispatched it. */
function jobMessage(
  stepExecutionId: string,
  attempt: number,
  options: CtxOptions = {},
): StepJobMessage {
  const space = options.spaceless === true ? {} : { spaceId: SPACE_ID };
  const plane =
    options.workflowTaskId === undefined
      ? { sessionId: RUN }
      : {
          workflowExecution: {
            runId: RUN,
            taskId: options.workflowTaskId,
            attempt,
            dispatchAttemptToken: `dispatch:${RUN}:${options.workflowTaskId}:${String(attempt)}`,
          },
        };
  return {
    tenantId: TENANT_ID,
    ...space,
    ...plane,
    stepExecutionId,
    attempt,
    stepId: options.workflowTaskId ?? 'generate-clip',
    stepType: 'ai',
  } as unknown as StepJobMessage;
}

/** The unit of work the runtime derives for a session-dispatched step. */
function logicalStep(stepExecutionId: string): string {
  return deriveLogicalExecutionId(jobMessage(stepExecutionId, 1));
}

/** The unit of work the runtime derives for every attempt at one workflow task. */
function logicalTask(taskId: string): string {
  return deriveLogicalExecutionId(jobMessage(randomUUID(), 1, { workflowTaskId: taskId }));
}

function fakeCtx(stepExecutionId: string, attempt: number, options: CtxOptions = {}): Capture {
  const space = options.spaceless === true ? {} : { spaceId: SPACE_ID };
  const job = jobMessage(stepExecutionId, attempt, options);
  const capture: Capture = { ctx: {} as ExecutorContext, outputs: [], errors: [] };
  capture.ctx = {
    job,
    tenantId: TENANT_ID as TenantId,
    ...space,
    runId: deriveExecutionRunId(job),
    stepExecutionId,
    logicalExecutionId: deriveLogicalExecutionId(job),
    attempt,
    operationId: 'ai.media.video',
    signal: new AbortController().signal,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    writePayload: (kind: string, data: unknown) => {
      if (kind === 'error') capture.errors.push(data);
      else capture.outputs.push(data);
      return Promise.resolve('inline:ref' as never);
    },
    // Enough to resolve an `inline:` frame — the frames have to reach the
    // runner as bytes before it can gate what they are conditioned on.
    readPayload: (ref: string) =>
      Promise.resolve({ data: ref.replace(/^inline:/, ''), mimeType: 'image/png' }),
  } as unknown as ExecutorContext;
  return capture;
}

describeDb('ai.media.video — one paid render per unit of work (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as TenantId);
  const repository: AsyncJobRepository = createAsyncJobRepository(db, tenantCtx);
  const docs: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);

  let schemaReady = false;
  let tenantPresent = false;

  const params: AiVideoGenerateInput = {
    prompt: 'a drone shot over a tropical beach at sunset',
    model: VEO,
    durationSeconds: 8,
  };

  /** Points the credential-resolving client factory at `provider`, and builds its deps. */
  function routeTo(
    provider: FakeProvider,
    clip: ClipDefault = { defaultVideoDurationSeconds: VEO_DEFAULT_CLIP_SECONDS },
    modelId?: string,
  ): HandlerDeps {
    vi.mocked(getAIClientForContext).mockResolvedValue(fakeClient(provider, clip, modelId));
    return {
      payloadStore: createMemoryPayloadStore(),
      db,
      asyncJobs: () => repository,
      handleError: (ctx, label, error) => {
        const message = error instanceof Error ? error.message : String(error);
        return Promise.resolve({
          status: 'FAILED',
          error: { message: `${label}: ${message}` },
        } as unknown as StepResult);
      },
      validateToolArgs: () => null,
    };
  }

  /** The identity the runner derives for this input, including the resolved clip length. */
  function identityFor(
    stepExecutionId: string,
    attempt: number,
    input: AiVideoGenerateInput = params,
  ): AsyncJobIdentity {
    return {
      runId: RUN,
      logicalExecutionId: logicalStep(stepExecutionId),
      attempt,
      operationId: 'ai.media.video',
      provider: 'google',
      model: VEO,
      inputHash: hashMediaRequest(VEO, {
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        durationSeconds: input.durationSeconds ?? VEO_DEFAULT_CLIP_SECONDS,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
      }),
    };
  }

  async function liveJobs(logicalExecutionId: string) {
    return await repository.listLiveJobsForExecution(RUN, logicalExecutionId);
  }

  async function allJobs(logicalExecutionId: string): Promise<JobRow[]> {
    const rows = await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(
        drizzleSql`SELECT attempt, state, provider_job_id, cost_currency, cost_micros
                   FROM async_jobs
                   WHERE run_id = ${RUN} AND step_execution_id = ${logicalExecutionId}
                   ORDER BY attempt`,
      ),
    );
    return rows as unknown as JobRow[];
  }

  /**
   * The job rows are addressed by this execution's own run id and the memory
   * rows by its own space — neither handle can name anything a real session
   * wrote, or anything another execution of this suite is writing.
   */
  async function clearOwnRows(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM async_jobs WHERE run_id = ${RUN}`);
      await tx.execute(drizzleSql`DELETE FROM memory_links WHERE space_id = ${SPACE_ID}::uuid`);
      await tx.execute(drizzleSql`DELETE FROM memory_docs WHERE space_id = ${SPACE_ID}::uuid`);
      await tx.execute(drizzleSql`DELETE FROM memory_dirs WHERE space_id = ${SPACE_ID}::uuid`);
    });
  }

  /**
   * What earlier executions of this suite left behind. Only rows old enough
   * that no live execution could still be writing them — an execution running
   * right now in another checkout is not this one's to clean up.
   */
  async function sweepAbandonedRows(): Promise<void> {
    const staleRuns = `${RUN_NAMESPACE}%`;
    const staleSpaces = `${SPACE_NAMESPACE}%`;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM async_jobs WHERE run_id LIKE ${staleRuns}
                   AND created_at < now() - interval '1 hour'`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_links WHERE space_id::text LIKE ${staleSpaces}
                   AND created_at < now() - interval '1 hour'`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_docs WHERE space_id::text LIKE ${staleSpaces}
                   AND created_at < now() - interval '1 hour'`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_dirs WHERE space_id::text LIKE ${staleSpaces}
                   AND created_at < now() - interval '1 hour'`,
      );
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ tenant: boolean; table: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
        ) AS tenant,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'async_jobs'
        ) AS "table"`;
    tenantPresent = rows[0]?.tenant === true;
    schemaReady = rows[0]?.table === true;
    // These rows live in the real dev tenant. A run that aborts never reaches
    // its own cleanup, so every run also clears what earlier ones left behind.
    if (schemaReady) await sweepAbandonedRows();
  });

  // A tenant that was never created is CI, which seeds no dev schema and where a
  // database-backed suite has nothing to say. A tenant that exists without the
  // table is a checkout that has not migrated, which is worth failing on.
  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip();
      return;
    }
    if (!schemaReady) throw new Error('async_jobs is missing — run yarn db:migrate');
  });

  afterAll(async () => {
    try {
      if (schemaReady) await clearOwnRows();
    } finally {
      await handle.close();
    }
  });

  it('has the table', () => {
    expect(schemaReady).toBe(true);
  });

  it('refuses a render it has nowhere to file rather than paying for it', async () => {
    const step = randomUUID();
    const provider = fakeProvider();

    const result = await handleVideoGenerate(
      fakeCtx(step, 1, { spaceless: true }).ctx,
      params,
      routeTo(provider),
    );

    expect(result.status).toBe('FAILED');
    expect(provider.submits).toHaveLength(0);
    expect(await allJobs(logicalStep(step))).toHaveLength(0);
  });

  it('files the delivered clip in Memory and returns a pinned reference to it', async () => {
    const step = randomUUID();
    const capture = fakeCtx(step, 1);

    const result = await handleVideoGenerate(capture.ctx, params, routeTo(fakeProvider()));
    expect(result.status).toBe('SUCCEEDED');

    const output = AiMediaOutputSchema.parse(capture.outputs[0]);
    const asset = output.assets[0];
    expect(asset?.kind).toBe('video');
    // The leaf is the request's identity and nothing else — `video/mp4` reaches
    // the reader as the document's mimeType.
    expect(asset?.path).toBe(`/media/${RUN}/take-${asset?.assetId ?? ''}`);
    expect(asset?.mimeType).toBe('video/mp4');
    expect(asset?.assetId).toBe(deriveMediaAssetId(output.receipt.execution.requestKey, 0));

    const stored = await docs.getByPath(asset?.path ?? '', SPACE_ID);
    expect(stored?.id).toBe(asset?.docId);
    expect(stored?.sizeBytes).toBe(Buffer.from('ZmFrZQ==', 'base64').byteLength);
  });

  it('a worker restart mid-generation resumes polling and never submits twice', async () => {
    const step = randomUUID();
    const first = fakeProvider({ pendingPolls: 100 });
    const firstCapture = fakeCtx(step, 1);

    const abandoned = await withPollBudget(1, () =>
      handleVideoGenerate(firstCapture.ctx, params, routeTo(first)),
    );
    expect(abandoned.status).toBe('FAILED');

    expect(first.submits).toHaveLength(1);
    const inFlight = await liveJobs(logicalStep(step));
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.state).toBe('polling');
    expect(inFlight[0]?.providerJobId).toBe('provider-job-1');

    // The restarted worker gets the same job message: same run, same step, same
    // attempt — so it derives the same job key.
    const second = fakeProvider();
    const secondCapture = fakeCtx(step, 1);
    const result = await handleVideoGenerate(secondCapture.ctx, params, routeTo(second));

    expect(result.status).toBe('SUCCEEDED');
    expect(second.submits).toHaveLength(0);
    expect(second.polls[0]?.handle.providerJobId).toBe('provider-job-1');

    const settled = await repository.getJob(inFlight[0]?.jobKey ?? '');
    expect(settled?.state).toBe('succeeded');
  });

  it('a retry that mints a new attempt adopts the live render instead of buying a second', async () => {
    const step = randomUUID();
    const first = fakeProvider({ pendingPolls: 100 });

    const abandoned = await withPollBudget(1, () =>
      handleVideoGenerate(fakeCtx(step, 1).ctx, params, routeTo(first)),
    );
    expect(abandoned.status).toBe('FAILED');
    expect(first.submits).toHaveLength(1);

    const second = fakeProvider();
    const result = await handleVideoGenerate(fakeCtx(step, 2).ctx, params, routeTo(second));

    expect(result.status).toBe('SUCCEEDED');
    expect(second.submits).toHaveLength(0);
    expect(second.polls[0]?.handle.providerJobId).toBe('provider-job-1');

    const rows = await allJobs(logicalStep(step));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.state).toBe('succeeded');
  });

  /**
   * Two workers on one live row: the retry that adopted the render, and the
   * earlier worker that outlived its budget and is still polling upstream.
   * Settling the row is the claim on delivering it, and the worker that loses
   * the claim is as often as not the attempt the run is waiting on.
   */
  it('two workers on one live render deliver one production between them', async () => {
    const step = randomUUID();
    const first = fakeProvider({ pendingPolls: 100 });
    const abandoned = await withPollBudget(1, () =>
      handleVideoGenerate(fakeCtx(step, 1).ctx, params, routeTo(first)),
    );
    expect(abandoned.status).toBe('FAILED');
    expect((await liveJobs(logicalStep(step)))[0]?.state).toBe('polling');

    const winner = fakeProvider();
    const winnerCapture = fakeCtx(step, 3);
    let winnerResult: StepResult | undefined;

    // The whole race in one seam: the loser read the row as live and polled a
    // finished render, and the winner settles and delivers in the window before
    // the loser's own settle lands.
    const raced: AsyncJobRepository = {
      ...repository,
      async markTerminal(jobKey, state, opts) {
        winnerResult ??= await handleVideoGenerate(winnerCapture.ctx, params, routeTo(winner));
        return await repository.markTerminal(jobKey, state, opts);
      },
    };

    const loser = fakeProvider();
    const loserCapture = fakeCtx(step, 2);
    const loserResult = await handleVideoGenerate(loserCapture.ctx, params, {
      ...routeTo(loser),
      asyncJobs: () => raced,
    });

    expect(winnerResult?.status).toBe('SUCCEEDED');
    expect(loserResult.status).toBe('SUCCEEDED');
    expect(winner.submits).toHaveLength(0);
    expect(loser.submits).toHaveLength(0);

    const rows = await allJobs(logicalStep(step));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('succeeded');
    expect(Number(rows[0]?.cost_micros)).toBe(3_200_000);

    // Both steps return the same production, and both report the money the row
    // recorded rather than one of them pricing the render a second time.
    const delivered = AiMediaOutputSchema.parse(winnerCapture.outputs[0]);
    const collected = AiMediaOutputSchema.parse(loserCapture.outputs[0]);
    expect(collected).toEqual(delivered);
    for (const result of [winnerResult, loserResult]) {
      const usage = (result as { costJson?: Record<string, unknown> }).costJson;
      expect(usage?.['costBasis']).toBe('priced');
      expect(usage?.['totalCostUsd']).toBeCloseTo(3.2, 6);
    }

    // One delivery, so every document of the production is still at the version
    // that delivery wrote. A second one rewrites the receipt and the note.
    const assetId = deriveMediaAssetId(delivered.receipt.execution.requestKey, 0);
    const stem = assetId.slice(0, assetId.lastIndexOf('-'));
    for (const path of [
      `/media/${RUN}/take-${assetId}`,
      `/media/${RUN}/take-${stem}.receipt.json`,
      `/media/${RUN}/take-${stem}.md`,
    ]) {
      expect((await docs.getByPath(path, SPACE_ID))?.currentVersion).toBe(1);
    }
  });

  /**
   * The session-dispatched cases above re-dispatch one step execution id, which
   * is the one thing a workflow retry does not do: it claims the task under a
   * worker session of its own. Both attempts here are handed a step execution
   * id nothing else has seen, so only an identity taken from the task can find
   * the render the first attempt paid for.
   */
  it('a workflow task retry, dispatched under a new worker session, adopts the paid render', async () => {
    const taskId = 'render-clip';
    const first = fakeProvider({ pendingPolls: 100 });

    const abandoned = await withPollBudget(1, () =>
      handleVideoGenerate(
        fakeCtx(randomUUID(), 1, { workflowTaskId: taskId }).ctx,
        params,
        routeTo(first),
      ),
    );
    expect(abandoned.status).toBe('FAILED');
    expect(first.submits).toHaveLength(1);

    const second = fakeProvider();
    const retry = fakeCtx(randomUUID(), 2, { workflowTaskId: taskId });
    expect(retry.ctx.stepExecutionId).not.toBe(first.submits[0]?.stepExecutionId);

    const result = await handleVideoGenerate(retry.ctx, params, routeTo(second));

    expect(result.status).toBe('SUCCEEDED');
    expect(second.submits).toHaveLength(0);
    expect(second.polls[0]?.handle.providerJobId).toBe('provider-job-1');

    const rows = await allJobs(logicalTask(taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.state).toBe('succeeded');

    // The receipt names the work rather than either worker session, so the
    // assets the retry delivers are the ones the first attempt paid for.
    const output = AiMediaOutputSchema.parse(retry.outputs[0]);
    expect(output.receipt.execution.logicalExecutionId).toBe(logicalTask(taskId));
  });

  it('records cost on success, on the job row and on the step', async () => {
    const step = randomUUID();
    const provider = fakeProvider({ durationSeconds: 8 });
    const capture = fakeCtx(step, 1);

    const result = await handleVideoGenerate(capture.ctx, params, routeTo(provider));
    expect(result.status).toBe('SUCCEEDED');

    const usage = (result as { costJson?: Record<string, unknown> }).costJson;
    expect(usage?.['costBasis']).toBe('priced');
    // Veo 3.1 is priced at $0.40/second in the catalog.
    expect(usage?.['totalCostUsd']).toBeCloseTo(3.2, 6);
    expect(usage?.['mediaCostUsd']).toBeCloseTo(3.2, 6);

    const row = (await allJobs(logicalStep(step)))[0];
    expect(row?.state).toBe('succeeded');
    expect(row?.cost_currency).toBe('USD');
    expect(Number(row?.cost_micros)).toBe(3_200_000);
  });

  it("the default call — a prompt and nothing else — is billed at the model's clip length", async () => {
    expect(createDefaultModelCatalog().getModel(VEO)?.defaultVideoDurationSeconds).toBe(
      VEO_DEFAULT_CLIP_SECONDS,
    );

    const step = randomUUID();
    // The route echoes back only what it was asked for, so a render nobody sized
    // reports no length at all.
    const provider = fakeProvider({ durationSeconds: undefined });
    const minimal: AiVideoGenerateInput = { prompt: params.prompt, model: VEO };

    const result = await handleVideoGenerate(fakeCtx(step, 1).ctx, minimal, routeTo(provider));
    expect(result.status).toBe('SUCCEEDED');

    // The length is settled before the submit, so the provider renders exactly
    // what the row is billed for.
    expect(provider.submits[0]?.durationSeconds).toBe(VEO_DEFAULT_CLIP_SECONDS);

    const usage = (result as { costJson?: Record<string, unknown> }).costJson;
    expect(usage?.['costBasis']).toBe('priced');
    expect(usage?.['totalCostUsd']).toBeCloseTo(3.2, 6);
    expect(Number((await allJobs(logicalStep(step)))[0]?.cost_micros)).toBe(3_200_000);
  });

  it('a model that publishes no clip length is unpriced, not free', async () => {
    const step = randomUUID();
    const provider = fakeProvider({ durationSeconds: undefined });
    const minimal: AiVideoGenerateInput = { prompt: params.prompt, model: VEO };

    const result = await handleVideoGenerate(fakeCtx(step, 1).ctx, minimal, routeTo(provider, {}));
    expect(result.status).toBe('SUCCEEDED');
    expect(provider.submits[0]?.durationSeconds).toBeUndefined();

    const usage = (result as { costJson?: Record<string, unknown> }).costJson;
    expect(usage?.['costBasis']).toBe('unpriced');
    expect(usage?.['totalCostUsd']).toBe(0);

    const row = (await allJobs(logicalStep(step)))[0];
    // NULL, not 0 — the row must not claim the render was free.
    expect(row?.cost_currency).toBeNull();
    expect(row?.cost_micros).toBeNull();
  });

  it('an undeduped route that died after `submitting` is stranded, not re-paid', async () => {
    const step = randomUUID();
    const provider = fakeProvider();
    const capture = fakeCtx(step, 1);

    // Reproduce the crash window: the row says a call may have reached the
    // provider, and nothing recorded whether it did.
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: { kind: 'unknown_terminal' },
    });
    expect(await repository.markSubmitting(reserved.record.jobKey, 'reserved')).toBe(true);

    const result = await handleVideoGenerate(capture.ctx, params, routeTo(provider));

    expect(result.status).toBe('FAILED');
    expect(provider.submits).toHaveLength(0);
    const settled = await repository.getJob(reserved.record.jobKey);
    expect(settled?.state).toBe('unknown');
    // Terminal for automation, and still reconcilable by a human.
    expect(
      await repository.reconcileUnknownJob(reserved.record.jobKey, 'succeeded', {
        reconciledBy: 'operator',
        providerJobId: 'discovered-by-listing',
        actualCost: { currency: 'USD', micros: 3_200_000 },
      }),
    ).toBe(true);
  });

  it('a retry whose input changed is different work and buys its own render', async () => {
    const step = randomUUID();
    const first = fakeProvider({ pendingPolls: 100 });

    await withPollBudget(1, () =>
      handleVideoGenerate(fakeCtx(step, 1).ctx, params, routeTo(first)),
    );
    expect(first.submits).toHaveLength(1);

    const second = fakeProvider();
    const rewritten: AiVideoGenerateInput = { ...params, prompt: 'a static shot of an empty room' };
    const result = await handleVideoGenerate(fakeCtx(step, 2).ctx, rewritten, routeTo(second));

    expect(result.status).toBe('SUCCEEDED');
    expect(second.submits).toHaveLength(1);
    const rows = await allJobs(logicalStep(step));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
  });

  it('a deduped route replays the submit under the request id the provider already saw', async () => {
    const step = randomUUID();
    const deduped: AsyncReplayGuarantee = { kind: 'idempotency_key', field: 'Idempotency-Key' };

    // The crash window again, on a route that does offer a dedupe key: replaying
    // the submit returns the original job rather than buying a second one.
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: deduped,
    });
    expect(await repository.markSubmitting(reserved.record.jobKey, 'reserved')).toBe(true);

    const provider = fakeProvider({ replayGuarantee: deduped });
    const result = await handleVideoGenerate(fakeCtx(step, 2).ctx, params, routeTo(provider));

    expect(result.status).toBe('SUCCEEDED');
    expect(provider.submits).toHaveLength(1);
    // Derived by the attempt that reserved the row, not by this one — a fresh
    // key would be a fresh job to the provider, and a second charge.
    expect(provider.submits[0]?.clientRequestId).toBe(reserved.record.clientRequestId);

    const rows = await allJobs(logicalStep(step));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('succeeded');
  });

  it('a route that can name its handle reads the finished render instead of replaying the submit', async () => {
    const step = randomUUID();
    const deduped: AsyncReplayGuarantee = { kind: 'idempotency_key', field: 'taskUUID' };

    // The crash window on a route whose dedupe key is also the job's address.
    // The render finished while nothing was watching, and the provider's own
    // dedupe has lapsed with it — replaying the submit here buys a second one.
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: deduped,
    });
    expect(await repository.markSubmitting(reserved.record.jobKey, 'reserved')).toBe(true);

    const provider = fakeProvider({
      replayGuarantee: deduped,
      handleIsCallerAssigned: true,
    });
    const result = await handleVideoGenerate(fakeCtx(step, 2).ctx, params, routeTo(provider));

    expect(result.status).toBe('SUCCEEDED');
    expect(provider.submits).toHaveLength(0);
    // Found at the address derived from the request id the row was reserved
    // under, not one this attempt made up.
    expect(provider.polls[0]?.handle).toEqual(derivedHandle(reserved.record.clientRequestId));

    const rows = await allJobs(logicalStep(step));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('succeeded');
    expect(rows[0]?.provider_job_id).toBe(
      derivedHandle(reserved.record.clientRequestId).providerJobId,
    );
  });

  it('a render still running when the handle is read is replayed, not abandoned', async () => {
    const step = randomUUID();
    const deduped: AsyncReplayGuarantee = { kind: 'idempotency_key', field: 'taskUUID' };
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: deduped,
    });
    expect(await repository.markSubmitting(reserved.record.jobKey, 'reserved')).toBe(true);

    // A route answers a running render and a never-submitted id identically, so
    // a pending read settles nothing and the submit is replayed — which the
    // provider's own dedupe makes free when the work is already there.
    const provider = fakeProvider({
      replayGuarantee: deduped,
      handleIsCallerAssigned: true,
      pendingPolls: 1,
    });
    const result = await handleVideoGenerate(fakeCtx(step, 2).ctx, params, routeTo(provider));

    expect(result.status).toBe('SUCCEEDED');
    expect(provider.submits).toHaveLength(1);
    expect(provider.submits[0]?.clientRequestId).toBe(reserved.record.clientRequestId);
    expect(await allJobs(logicalStep(step))).toHaveLength(1);
  });

  it('a handle that reads back as failed is replayed, not settled on', async () => {
    const step = randomUUID();
    const deduped: AsyncReplayGuarantee = { kind: 'idempotency_key', field: 'taskUUID' };
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: deduped,
    });
    expect(await repository.markSubmitting(reserved.record.jobKey, 'reserved')).toBe(true);

    // A submit that never reached the provider leaves a row in `submitting` and
    // a handle the provider has never seen. A route may answer that handle with
    // a failure, and settling on it would report a render that was never bought
    // as one the provider rejected — the shot would never be made.
    const provider = fakeProvider({
      replayGuarantee: deduped,
      handleIsCallerAssigned: true,
      outcome: 'failed',
    });
    const result = await handleVideoGenerate(fakeCtx(step, 2).ctx, params, routeTo(provider));

    expect(provider.submits).toHaveLength(1);
    expect(result.status).toBe('FAILED');
    const rows = await allJobs(logicalStep(step));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('failed');
  });

  it('refuses a last frame the route drops, before the clip is bought uninterpolated', async () => {
    const provider = fakeProvider();
    // Sora reads the first frame and never the last one. Nothing downstream
    // could tell the delivered clip from an interpolated one, and it bills the
    // same — so the refusal has to happen before the submit.
    const result = await handleVideoFromImage(
      fakeCtx(randomUUID(), 1).ctx,
      {
        prompt: params.prompt,
        model: 'sora',
        imageRef: 'inline:c3RhcnQ=',
        lastFrameRef: 'inline:ZW5k',
      } as never,
      routeTo(provider, { defaultVideoDurationSeconds: 4 }, 'sora-2'),
    );

    expect(result.status).toBe('FAILED');
    expect(provider.submits).toHaveLength(0);
    const message = result.status === 'FAILED' ? JSON.stringify(result.error) : '';
    expect(message).toContain('first frame');
  });

  it('a replay of a settled render reports the money the row recorded', async () => {
    const step = randomUUID();
    const first = fakeCtx(step, 1);
    const done = await handleVideoGenerate(
      first.ctx,
      params,
      routeTo(fakeProvider({ durationSeconds: 8 })),
    );
    expect(done.status).toBe('SUCCEEDED');
    expect(Number((await allJobs(logicalStep(step)))[0]?.cost_micros)).toBe(3_200_000);

    // The settled row is the record of what was paid. A route that now reports a
    // shorter clip — or a catalog rate that has moved since — must not restate it.
    const replay = fakeProvider({ durationSeconds: 2 });
    const capture = fakeCtx(step, 1);
    const result = await handleVideoGenerate(capture.ctx, params, routeTo(replay));

    expect(result.status).toBe('SUCCEEDED');
    expect(replay.submits).toHaveLength(0);
    const usage = (result as { costJson?: Record<string, unknown> }).costJson;
    expect(usage?.['costBasis']).toBe('priced');
    expect(usage?.['totalCostUsd']).toBeCloseTo(3.2, 6);

    // The production is what makes the render deliverable, so the replay reads
    // it instead of asking the route for a result it already delivered — and
    // the documents it returns are the ones the first delivery wrote.
    expect(replay.polls).toHaveLength(0);
    const delivered = AiMediaOutputSchema.parse(first.outputs[0]);
    expect(AiMediaOutputSchema.parse(capture.outputs[0])).toEqual(delivered);
    expect((await docs.getByPath(delivered.receiptRef.path, SPACE_ID))?.currentVersion).toBe(1);
  });

  it('a stale `unknown` cannot settle a render another worker has moved on', async () => {
    const step = randomUUID();
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: { kind: 'unknown_terminal' },
    });
    const { jobKey } = reserved.record;
    expect(await repository.markSubmitting(jobKey, 'reserved')).toBe(true);
    // A live worker records its submit while a stalled one still holds the
    // `submitting` it read.
    expect(await repository.markSubmitted(jobKey, 'provider-job-live')).toBe(true);

    expect(
      await repository.markTerminal(jobKey, 'unknown', { expectedStates: ['submitting'] }),
    ).toBe(false);
    expect((await repository.getJob(jobKey))?.state).toBe('submitted');
    // Naming the state read is the whole guard: without it the same write lands.
    expect(await repository.markTerminal(jobKey, 'unknown')).toBe(true);
  });

  it('a stale worker cannot record `unknown` over the render a live one submitted', async () => {
    const step = randomUUID();
    const reserved = await repository.reserveJob({
      identity: identityFor(step, 1),
      replayGuarantee: { kind: 'unknown_terminal' },
    });
    const { jobKey } = reserved.record;
    expect(await repository.markSubmitting(jobKey, 'reserved')).toBe(true);

    // The live worker records its submit in the window between this worker
    // reading the row and acting on what it read.
    const staleRead: AsyncJobRepository = {
      ...repository,
      async listLiveJobsForExecution(runId, logicalExecutionId) {
        const rows = await repository.listLiveJobsForExecution(runId, logicalExecutionId);
        expect(await repository.markSubmitted(jobKey, 'provider-job-live')).toBe(true);
        return rows;
      },
    };

    const stalled = fakeProvider();
    const result = await handleVideoGenerate(fakeCtx(step, 1).ctx, params, {
      ...routeTo(stalled),
      asyncJobs: () => staleRead,
    });

    expect(result.status).toBe('FAILED');
    expect(stalled.submits).toHaveLength(0);
    const row = await repository.getJob(jobKey);
    expect(row?.state).toBe('submitted');
    expect(row?.providerJobId).toBe('provider-job-live');

    // Still in flight, so the next worker finds the render and drives it to its
    // end rather than a job somebody else declared unresolvable.
    const resumed = fakeProvider();
    const done = await handleVideoGenerate(fakeCtx(step, 1).ctx, params, routeTo(resumed));
    expect(done.status).toBe('SUCCEEDED');
    expect(resumed.submits).toHaveLength(0);
    expect(resumed.polls[0]?.handle.providerJobId).toBe('provider-job-live');
  });
});
