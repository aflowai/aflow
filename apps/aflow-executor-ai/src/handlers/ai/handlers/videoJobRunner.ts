/**
 * Drives a video render through the durable async-job lifecycle.
 *
 * The provider is paid at submit and delivers minutes later, so the dangerous
 * window is between acceptance and this side recording it. `submitting` is
 * written before the call; a replay therefore always finds evidence that a call
 * may have happened, and what it does about that is decided by the guarantee
 * the resolved route actually offered — never by an assumption.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, successWithData } from '@aflow/executor-runtime';
import { providerError, validationError, internalError } from '@aflow/executor-runtime';
import {
  checkMediaRouteConditioning,
  mediaRenderParameters,
  mediaRouteCapability,
  resolveAsyncJobRecovery,
  MEDIA_ROUTE_CAPABILITIES,
  type MediaConditioningRequest,
  type MediaRouteCapability,
  type AsyncJobCost,
  type AsyncJobIdentity,
  type AsyncJobRecord,
  type AsyncReplayGuarantee,
  type MediaBoundEntity,
  type MediaRenderedFormat,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import type { AsyncJobRepository } from '@aflow/database';
import {
  DEFAULT_AI_MODELS,
  settledMediaSpend,
  type AIClient,
  type AIProviderAdapter,
  type GenerateVideoRequest,
  type GenerateVideoResponse,
  type MediaSpend,
  type VideoJobHandle,
  type VideoJobPoll,
} from '@aflow/ai-client';
import { getAIClientForContext } from '../aiClient.js';
import type { HandlerDeps } from './types.js';
import { resolveVideoBudget, VIDEO_POLL_INTERVAL_MS } from './mediaBudget.js';
import { mediaQuote, videoSpend } from './mediaSpend.js';
import {
  collectMediaProduction,
  deliverMediaProduction,
  resolveMediaPersistence,
  type MediaCandidateBytes,
  type MediaPersistenceTarget,
} from './mediaPersist.js';
import { probeRenderedFormat } from './mediaProbe.js';
import { mediaCapabilityRoute, mediaRequestIdentity } from './mediaRequestIdentity.js';

/** Everything the route needs that is not lifecycle bookkeeping. */
export interface VideoJobSpec {
  modelKey: string | undefined;
  /**
   * The memory documents the frames were read from, pinned. Held outside
   * `request` because it is provenance rather than a render field: the frames
   * themselves already reach the job identity as bytes, and hashing the pins
   * alongside them would make one paid render two.
   */
  boundEntityVersions: MediaBoundEntity[];
  /**
   * The render itself. Every field of it reaches both the provider and the job
   * identity, so a knob the provider ignores does not belong here — and one it
   * acts on cannot be routed around the hash.
   */
  request: Pick<
    GenerateVideoRequest,
    | 'prompt'
    | 'negativePrompt'
    | 'durationSeconds'
    | 'aspectRatio'
    | 'resolution'
    | 'imageData'
    | 'imageMimeType'
    | 'lastFrameData'
    | 'lastFrameMimeType'
    | 'references'
  >;
}

/**
 * The wired descriptor for a caller's model key.
 *
 * A key reaches here as whatever the caller wrote — a selection key, a catalog
 * alias, or a raw model id — while a descriptor is filed under the selection
 * key. The catalog already knows which of those name the same model, so the
 * match is resolved through it rather than by a second table of spellings.
 */
function routeCapabilityFor(client: AIClient, modelKey: string): MediaRouteCapability | undefined {
  // Descriptors are keyed across both media, so the direct hit is only this
  // route's when it is a video one — an image key would otherwise be gated
  // against an image descriptor that knows nothing about named entities.
  const direct = mediaRouteCapability(modelKey);
  if (direct?.medium === 'video') return direct;
  const resolved = client.resolveModelId(modelKey);
  return MEDIA_ROUTE_CAPABILITIES.find(
    (route) => route.medium === 'video' && client.resolveModelId(route.routeKey) === resolved,
  );
}

/** One delivered clip: the bytes, and what those bytes state about themselves. */
interface RenderedCandidate extends MediaCandidateBytes {
  rendered: MediaRenderedFormat;
}

/**
 * The delivered clips, read once. Both the price and the receipt are taken from
 * this same read, so a receipt cannot bill one length and record another.
 */
function readCandidates(response: GenerateVideoResponse): RenderedCandidate[] {
  return response.videos.map((video) => {
    const bytes = Buffer.from(video.data, 'base64');
    return {
      bytes,
      mimeType: video.mimeType,
      rendered: probeRenderedFormat('video', bytes),
      // No video route offers in-place extension at all, so there is no handle
      // this poll could have carried back. The clip is re-generable, never
      // extendable.
      providerNative: { status: 'none', reason: 'route_issues_none' },
    };
  });
}

/** A finished render this worker is holding, read off one poll. */
interface HeldRender {
  response: GenerateVideoResponse;
  candidates: RenderedCandidate[];
}

function heldRender(response: GenerateVideoResponse): HeldRender {
  return { response, candidates: readCandidates(response) };
}

/**
 * One poll interval. The listener is dropped when the timer wins, not only when
 * the abort does: a render polls for as long as its budget allows, and a
 * listener per interval accumulates on a signal that lives as long as the step.
 */
export async function pollDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal.addEventListener('abort', settle);
  });
}

interface ResolvedRoute {
  client: AIClient;
  model: string;
  modelKey: string;
  submitVideoJob: NonNullable<AIProviderAdapter['submitVideoJob']>;
  pollVideoJob: NonNullable<AIProviderAdapter['pollVideoJob']>;
  /** Present only where the job's address is ours to compute. */
  videoJobHandleFor: AIProviderAdapter['videoJobHandleFor'];
}

/** Everything the lifecycle carries from the first refusal check to delivery. */
interface VideoLane {
  ctx: ExecutorContext;
  spec: VideoJobSpec;
  route: ResolvedRoute;
  repository: AsyncJobRepository;
  target: MediaPersistenceTarget;
  pollBudgetMs: number;
  /** Priced before the submit, against the catalog in effect at that moment. */
  quoted: AsyncJobCost | undefined;
}

/**
 * Whether a live row is the same paid work as this attempt.
 *
 * `attempt` is deliberately not compared. It is part of the job key, so a retry
 * derives a different key and reserves a second row — and a step is retried
 * precisely when its worker died with the render still running upstream, which
 * is the one case where a second row means a second charge. `inputHash` is what
 * keeps a genuine change out: a retry with a different prompt is different work
 * and buys its own render.
 */
function isSamePaidWork(job: AsyncJobRecord, identity: AsyncJobIdentity): boolean {
  return (
    job.operationId === identity.operationId &&
    job.provider === identity.provider &&
    job.model === identity.model &&
    job.inputHash === identity.inputHash
  );
}

export async function runVideoJob(
  ctx: ExecutorContext,
  spec: VideoJobSpec,
  deps: HandlerDeps,
  label: string,
): Promise<StepResult> {
  try {
    const modelKey = spec.modelKey ?? DEFAULT_AI_MODELS.video;
    const client = await getAIClientForContext(ctx, modelKey);
    const model = client.resolveModelId(modelKey);
    const adapter = await client.getAdapter(modelKey);

    if (!adapter.submitVideoJob || !adapter.pollVideoJob) {
      return await failureWithError(
        ctx,
        validationError(`Provider for model "${model}" does not support video generation`),
      );
    }

    const repository = deps.asyncJobs?.(ctx.tenantId);
    if (!repository) {
      // A render with no durable row is unrecoverable by construction: nothing
      // records that the provider was paid. Refusing costs nothing; submitting
      // costs money that cannot be traced.
      return await failureWithError(
        ctx,
        internalError(
          'Video generation needs a durable job record and this executor has no database connection',
          { retryable: false },
        ),
      );
    }

    // Resolved before anything is submitted: a render whose bytes have nowhere
    // to land is refused rather than paid for and dropped.
    const persistence = resolveMediaPersistence(ctx, deps);
    if (!persistence.ok) return await failureWithError(ctx, persistence.error);

    const budget = resolveVideoBudget(ctx.stepDefinition?.timeout?.executionTimeoutMs);
    if (budget.pollBudgetMs < VIDEO_POLL_INTERVAL_MS) {
      return await failureWithError(
        ctx,
        validationError(
          `This step's timeout (${String(budget.stepBudgetMs)}ms) leaves no room to wait for a render. ` +
            `Raise the step timeout or AI_VIDEO_POLL_BUDGET_MS.`,
        ),
      );
    }

    const route: ResolvedRoute = {
      client,
      model,
      modelKey,
      submitVideoJob: adapter.submitVideoJob.bind(adapter),
      pollVideoJob: adapter.pollVideoJob.bind(adapter),
      videoJobHandleFor: adapter.videoJobHandleFor?.bind(adapter),
    };

    // The length is settled here rather than left to the provider's own
    // default, so the submit and the pre-dispatch quote name the same clip. What
    // the render is finally billed at is read off the delivered file.
    const clipSeconds =
      spec.request.durationSeconds ?? client.getModel(modelKey)?.defaultVideoDurationSeconds;
    const resolved: VideoJobSpec = {
      ...spec,
      request: { ...spec.request, durationSeconds: clipSeconds },
    };

    // Refused before the submit rather than after the bill. A route that cannot
    // read what a render is conditioned on still renders: it returns a clip
    // carrying none of what was asked for, and nothing downstream can tell that
    // apart from one that carries it.
    //
    // Every conditioning a request expresses is checked, not only the
    // references. A last frame handed to a route that reads only the first is
    // dropped before submit and the clip bills in full uninterpolated, which is
    // the same silent drop by a different door.
    const references = resolved.request.references ?? [];
    const conditionings: MediaConditioningRequest[] = [];
    if (references.length > 0) {
      conditionings.push({
        mode: 'reference',
        references,
        hasFirstFrame: resolved.request.imageData !== undefined,
      });
    }
    if (resolved.request.imageData !== undefined) {
      conditionings.push({
        mode: 'frames',
        lastFrame: resolved.request.lastFrameData !== undefined,
      });
    }
    if (conditionings.length > 0) {
      const capability = routeCapabilityFor(client, modelKey);
      for (const conditioning of conditionings) {
        const verdict =
          capability === undefined
            ? {
                ok: false as const,
                reason: `'${modelKey}' declares no conditioning of its own, so it would render from the prompt alone and drop what this shot asks to be conditioned on.`,
              }
            : checkMediaRouteConditioning({ route: capability, conditioning });
        if (!verdict.ok) return await failureWithError(ctx, validationError(verdict.reason));
      }
    }

    const identity: AsyncJobIdentity = mediaRequestIdentity(ctx, {
      provider: adapter.provider,
      model,
      request: resolved.request,
    });
    const replayGuarantee: AsyncReplayGuarantee = adapter.replayGuaranteeFor?.(model) ?? {
      kind: 'unknown_terminal',
    };

    // A render already in flight for this work is driven to its end rather than
    // reserved again: one unit of work, one payment. The lookup names the
    // identity the row was reserved under — keying it on the step execution
    // would find nothing on the path that gives every attempt its own.
    const live = await repository.listLiveJobsForExecution(ctx.runId, identity.logicalExecutionId);
    const adopted = live.find((job) => isSamePaidWork(job, identity));
    const record = adopted ?? (await repository.reserveJob({ identity, replayGuarantee })).record;

    return await driveJob(
      {
        ctx,
        spec: resolved,
        route,
        repository,
        target: persistence.target,
        pollBudgetMs: budget.pollBudgetMs,
        quoted: mediaQuote({
          client,
          modelKey,
          provider: adapter.provider,
          model,
          quantity: { videoDurationSeconds: clipSeconds },
        }),
      },
      record,
    );
  } catch (error) {
    return await deps.handleError(ctx, label, error);
  }
}

async function driveJob(lane: VideoLane, record: AsyncJobRecord): Promise<StepResult> {
  const { ctx, spec, route, repository } = lane;
  const { jobKey } = record;
  const action = resolveAsyncJobRecovery(record.state, record.replayGuarantee);

  if (action === 'mark_unknown') {
    // Guarded to the state this decision was made from: another worker may have
    // moved the row on to `submitted` since, and stranding its live render is
    // exactly the outcome this branch exists to avoid.
    await repository.markTerminal(jobKey, 'unknown', {
      expectedStates: ['submitting'],
      lastError:
        'A submit to this route may have reached the provider, and the route offers no dedupe key to replay it safely.',
    });
    return await failureWithError(
      ctx,
      providerError(
        'A previous attempt may already have submitted this render, and this provider offers no way to replay a submit safely. ' +
          'The job is recorded as unresolved rather than paid for twice.',
        { retryable: false, details: { jobKey } },
      ),
    );
  }

  if (action === 'complete') {
    if (record.state !== 'succeeded') {
      return await failureWithError(
        ctx,
        providerError(`This render already finished as '${record.state}' and cannot be re-run.`, {
          retryable: false,
          details: {
            jobKey,
            ...(record.lastError !== undefined ? { reason: record.lastError } : {}),
          },
        }),
      );
    }
    // What makes a settled render deliverable is its filed production, not the
    // provider's retention of the result — so the route is asked for bytes only
    // when a settlement left none behind.
    const collected = await collectSettledProduction(lane, record);
    if (collected !== null) return collected;
    if (record.providerJobId === undefined) {
      return await failureWithError(
        ctx,
        internalError(
          'This render is recorded as finished, and it has neither a filed production nor a provider job id to re-read it from.',
          { retryable: false, details: { jobKey } },
        ),
      );
    }
    // Re-fetching a finished render is a read, not a second submit, and the
    // row is already settled — nothing here writes to it again.
    const poll = await route.pollVideoJob({
      handle: { providerJobId: record.providerJobId },
      model: route.model,
      ...(spec.request.durationSeconds !== undefined
        ? { durationSeconds: spec.request.durationSeconds }
        : {}),
      signal: ctx.signal,
    });
    if (poll.status !== 'succeeded') {
      return await failureWithError(
        ctx,
        providerError('This render finished, but the provider no longer serves the result.', {
          retryable: false,
          details: { jobKey, providerJobId: record.providerJobId },
        }),
      );
    }
    const held = heldRender(poll.response);
    // The row already holds what this render cost. Pricing it again would let a
    // catalog rate that moved since settlement contradict it.
    return await deliver(
      lane,
      record,
      held.response,
      settledSpend(record, held.response),
      held.candidates,
    );
  }

  if (action === 'resubmit_deduped' && route.videoJobHandleFor !== undefined) {
    const adopted = await adoptRenderAlreadyBought(lane, record);
    if (adopted !== null) return adopted;
  }

  let handle: VideoJobHandle;
  if (action === 'submit' || action === 'resubmit_deduped') {
    const expectedState = action === 'submit' ? 'reserved' : 'submitting';
    const claimed = await repository.markSubmitting(jobKey, expectedState);
    if (!claimed) {
      // Another worker owns the transition. Retrying would mint a new attempt
      // and a new paid job, so this attempt stops here.
      return await failureWithError(
        ctx,
        providerError('Another worker already owns this render.', {
          retryable: false,
          details: { jobKey },
        }),
      );
    }

    const submitted = await route.submitVideoJob({
      ...spec.request,
      model: route.model,
      // Read off the row rather than re-derived: an adopted job was reserved by
      // an earlier attempt, and a dedupe key derived from this attempt would
      // not match the submit the provider already accepted.
      clientRequestId: record.clientRequestId,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });
    if (!(await repository.markSubmitted(jobKey, submitted.providerJobId))) {
      // We won the claim, so only a writer outside this lane can have moved the
      // row. The render is paid for and its id is now unrecorded.
      ctx.log.error('A submitted render could not be recorded against its job', {
        jobKey,
        providerJobId: submitted.providerJobId,
      });
    }
    handle = submitted;
  } else {
    if (record.providerJobId === undefined) {
      await repository.markTerminal(jobKey, 'unknown', {
        expectedStates: ['submitted', 'polling'],
        lastError: 'The job reached a polling state without a provider job id.',
      });
      return await failureWithError(
        ctx,
        internalError('This render has no provider job id to poll.', {
          retryable: false,
          details: { jobKey },
        }),
      );
    }
    handle = { providerJobId: record.providerJobId };
  }

  return await pollToCompletion(lane, record, handle);
}

/**
 * The step result of a render an earlier attempt already bought, or null when
 * there is no evidence of one.
 *
 * A dedupe key only protects a submit while the provider still considers the
 * work live; once the render finishes, replaying the key buys a second one. The
 * window between those two is exactly where a retried step lands, so a route
 * whose handle this side can compute reads the job before it replays the
 * submit. A poll never bills, so the check is free and the render it finds is
 * one that has already been paid for.
 */
async function adoptRenderAlreadyBought(
  lane: VideoLane,
  record: AsyncJobRecord,
): Promise<StepResult | null> {
  const { ctx, spec, route, repository } = lane;
  const derive = route.videoJobHandleFor;
  if (derive === undefined) return null;
  const handle = derive(record.clientRequestId);

  const seen = await route.pollVideoJob({
    handle,
    model: route.model,
    ...(spec.request.durationSeconds !== undefined
      ? { durationSeconds: spec.request.durationSeconds }
      : {}),
    signal: ctx.signal,
  });
  // Only a finished render proves one was bought. A route answers for an id it
  // has never seen the same way it answers for one still running, and a failure
  // is just as ambiguous — settling on it would report a render that may never
  // have been submitted as one the provider rejected, and the shot would never
  // be made. Anything short of `succeeded` falls through to the replay, which
  // the dedupe key makes free whenever the work really is live.
  if (seen.status !== 'succeeded') return null;

  if (!(await repository.markSubmitted(record.jobKey, handle.providerJobId))) return null;
  // Handed on rather than re-polled: this read already downloaded the clip and
  // carries what the provider said it charged.
  return await pollToCompletion(lane, record, handle, seen);
}

async function pollToCompletion(
  lane: VideoLane,
  record: AsyncJobRecord,
  handle: VideoJobHandle,
  /** A read already taken of this job, consumed instead of taking another. */
  held?: VideoJobPoll,
): Promise<StepResult> {
  const { ctx, spec, route, repository } = lane;
  const { jobKey } = record;
  const deadline = Date.now() + lane.pollBudgetMs;
  const signal = ctx.signal;
  let carried = held;

  for (;;) {
    if (!(await repository.recordPoll(jobKey))) {
      // The row left the pollable states, so some other actor settled this job.
      // Continuing would poll a render nothing is tracking.
      return await failureWithError(
        ctx,
        providerError('This render was settled by another worker.', {
          retryable: false,
          details: { jobKey, providerJobId: handle.providerJobId },
        }),
      );
    }
    const poll =
      carried ??
      (await route.pollVideoJob({
        handle,
        model: route.model,
        ...(spec.request.durationSeconds !== undefined
          ? { durationSeconds: spec.request.durationSeconds }
          : {}),
        signal,
      }));
    carried = undefined;

    if (poll.status === 'succeeded') {
      const held = heldRender(poll.response);
      const spend = videoSpend({
        client: route.client,
        modelKey: route.modelKey,
        response: poll.response,
        rendered: held.candidates.map((candidate) => candidate.rendered),
        requestedSeconds: spec.request.durationSeconds,
      });
      // Settling the row is the claim on delivering it. Two workers reach this
      // line on one render — a step that outlived its budget is retried, the
      // retry adopts the live job, and the earlier worker is still polling — so
      // only the one that moved the row files the production.
      const settled = await repository.markTerminal(jobKey, 'succeeded', {
        ...(spend.actualCost !== undefined ? { actualCost: spend.actualCost } : {}),
      });
      if (!settled) return await deliverSettledElsewhere(lane, record, held);
      if (spend.usageBreakdown.costBasis === 'unpriced') {
        ctx.log.warn('A render completed with no priced quantity', {
          jobKey,
          model: poll.response.model,
          provider: poll.response.provider,
        });
      }
      return await deliver(lane, record, poll.response, spend, held.candidates);
    }
    if (poll.status === 'failed') {
      // A lost claim here means the row already carries an outcome, and the row
      // is the record of the render — reporting this poll's verdict over it
      // would let one paid render end two different ways.
      if (!(await repository.markTerminal(jobKey, 'failed', { lastError: poll.message }))) {
        return await deliverSettledElsewhere(lane, record, undefined);
      }
      return await failureWithError(
        ctx,
        providerError(poll.message, { retryable: false, details: { jobKey } }),
      );
    }

    if (signal.aborted || Date.now() + VIDEO_POLL_INTERVAL_MS > deadline) {
      // The render is real and paid for, so the row stays in `polling` and this
      // attempt refuses to be retried: a retry mints a new attempt, a new job
      // key, and a second charge for work that is still running upstream.
      return await failureWithError(
        ctx,
        providerError(
          'The render is still running at the provider and outlived this step. It stays recorded as in flight.',
          {
            retryable: false,
            details: { jobKey, providerJobId: handle.providerJobId },
          },
        ),
      );
    }

    ctx.reportProgress?.();
    await pollDelay(VIDEO_POLL_INTERVAL_MS, signal);
  }
}

/**
 * What a settled render cost, taken from the row that settled it. The route and
 * the catalog can both have moved since, and neither may restate the money the
 * durable record holds.
 */
function settledSpend(
  row: AsyncJobRecord,
  reported: { provider: string; model: string },
): MediaSpend {
  return settledMediaSpend({
    provider: reported.provider,
    reportedModel: reported.model,
    ...(row.actualCost !== undefined ? { actualCost: row.actualCost } : {}),
  });
}

/** The step result of a render whose production is already filed, or null when none is. */
async function collectSettledProduction(
  lane: VideoLane,
  row: AsyncJobRecord,
): Promise<StepResult | null> {
  const filed = await collectMediaProduction({
    ctx: lane.ctx,
    target: lane.target,
    requestKey: row.jobKey,
  });
  if (filed === null) return null;
  return await successWithData(lane.ctx, filed, {
    costJson: settledSpend(row, filed.receipt).usageBreakdown,
  });
}

/**
 * What a worker that did not settle the row delivers.
 *
 * Losing the claim is not losing the work, and the loser is as often as not the
 * attempt the run is actually waiting on — the winner may be a zombie whose
 * step result nothing reads any more. So this reaches the same outcome from the
 * settled row instead: the production is addressed by the request rather than
 * by the worker that filed it, so it is read back rather than written a second
 * time, and the money reported is the money the row recorded.
 *
 * `held` is the only thing that files anything, and only for a settled row with
 * no production behind it — a winner that died between the two writes, or one
 * still filing. Bytes the provider has been paid for are worth more filed twice
 * than dropped, and the assets are content-addressed, so the duplicate costs a
 * receipt version rather than a second copy.
 */
async function deliverSettledElsewhere(
  lane: VideoLane,
  record: AsyncJobRecord,
  held: HeldRender | undefined,
): Promise<StepResult> {
  const { ctx, repository } = lane;
  const { jobKey } = record;
  const settled = (await repository.getJob(jobKey)) ?? record;
  if (settled.state !== 'succeeded') {
    return await failureWithError(
      ctx,
      providerError(`Another worker settled this render as '${settled.state}'.`, {
        retryable: false,
        details: {
          jobKey,
          ...(settled.lastError !== undefined ? { reason: settled.lastError } : {}),
        },
      }),
    );
  }
  const collected = await collectSettledProduction(lane, settled);
  if (collected !== null) return collected;
  if (held === undefined) {
    return await failureWithError(
      ctx,
      providerError(
        'Another worker settled this render, and nothing has filed its assets. The render is paid ' +
          'for and recorded either way: retrying this step derives a fresh request and buys a ' +
          'second one rather than collecting this one.',
        { retryable: false, details: { jobKey } },
      ),
    );
  }
  return await deliver(
    lane,
    settled,
    held.response,
    settledSpend(settled, held.response),
    held.candidates,
  );
}

/**
 * The bytes are filed in Memory and the step returns references to them.
 *
 * The whole execution block is read off the durable row, never off this
 * attempt: an adopted job was reserved and submitted by an earlier attempt, and
 * naming this one alongside that one's request key would make the receipt
 * contradict itself about who issued the request that was paid for.
 */
async function deliver(
  lane: VideoLane,
  record: AsyncJobRecord,
  response: GenerateVideoResponse,
  spend: MediaSpend,
  candidates: RenderedCandidate[],
): Promise<StepResult> {
  const { ctx, spec, route, target } = lane;
  const { jobKey } = record;
  const settled = await lane.repository.getJob(jobKey);
  if (settled === null) {
    ctx.log.warn('A settled render has no job row to receipt against', { jobKey });
  }
  const issuer = settled ?? record;

  return await deliverMediaProduction({
    ctx,
    target,
    kind: 'video',
    candidates,
    spend,
    failureDetails: { jobKey },
    receipt: {
      execution: {
        runId: issuer.runId,
        logicalExecutionId: issuer.logicalExecutionId,
        attempt: issuer.attempt,
        requestKey: jobKey,
        ...(issuer.providerJobId !== undefined ? { providerJobId: issuer.providerJobId } : {}),
      },
      request: {
        prompt: spec.request.prompt,
        ...(spec.request.negativePrompt !== undefined
          ? { negativePrompt: spec.request.negativePrompt }
          : {}),
        parameters: mediaRenderParameters(spec.request),
        boundEntityVersions: spec.boundEntityVersions,
      },
      provider: response.provider,
      model: response.model,
      capabilityRoute: mediaCapabilityRoute(ctx, {
        provider: response.provider,
        model: route.model,
        requestedModel: spec.modelKey,
      }),
      cost: {
        ...(lane.quoted !== undefined ? { quoted: lane.quoted } : {}),
        ...(issuer.actualCost !== undefined ? { actual: issuer.actualCost } : {}),
      },
      // Candidates of one request share the receipt, and a route renders them
      // to one format — the first one is what the whole set was delivered at.
      rendered: candidates[0]?.rendered ?? {},
      createdAt: new Date().toISOString(),
    },
  });
}
