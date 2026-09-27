/**
 * Runware — one endpoint, a JSON array of tasks, discriminated by `taskType`.
 *
 * The route is worth its own adapter for one property the others lack: the job
 * id is assigned by the caller. `taskUUID` is both the dedupe key and the
 * address a later poll reads, so a submit whose response is lost is still
 * findable — see `videoJobHandleFor`. Everything else here follows from that.
 */
import { createHash } from 'node:crypto';
import { SsrfBlockedError, safeFetch, validateUrl } from '@aflow/network-safety';
import { findNamedLabels, groupReferencesByEntity } from '@aflow/schemas';
import type { AsyncJobCost, AsyncReplayGuarantee } from '@aflow/schemas';
import type {
  GenerateVideoRequest,
  ImageReferenceInput,
  PollVideoJobRequest,
  ProviderConfig,
  VideoJobHandle,
  VideoJobPoll,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError } from '../errors.js';

type RunwareVideoAdapter = AIProviderAdapter &
  Required<
    Pick<
      AIProviderAdapter,
      'replayGuaranteeFor' | 'submitVideoJob' | 'pollVideoJob' | 'videoJobHandleFor'
    >
  >;

/**
 * The adapter interface requires the text lane, and this route has no text
 * lane to give. Refusing by name beats a silent empty completion: the caller
 * asked a media provider for a chat model, and only it can fix that.
 */
function noTextLane(method: string): never {
  throw new AIClientError(
    `Runware renders images and video; it serves no text model, so ${method} has nothing to call`,
    'model_not_found',
    'runware',
    false,
  );
}

const API_URL = 'https://api.runware.ai/v1';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The frame sizes a route renders, by aspect ratio, and the clip lengths it
 * accepts.
 *
 * Runware's request surface is per-model rather than per-provider: the same
 * `videoInference` task takes `negativePrompt` on one model and rejects it on
 * the next, and each model enumerates its own legal dimensions. Only routes
 * that agree on the whole surface are wired here, so the submit below has no
 * per-model branch to get wrong. A route added with a different surface must
 * bring the branch with it rather than be appended to this table.
 */
interface RunwareVideoRoute {
  dimensions: Readonly<Record<string, { width: number; height: number }>>;
  duration: { min: number; max: number };
  /**
   * The one resolution this route renders. The tier is the route rather than a
   * knob on it, so a caller asking for another one is asking for a different
   * model — and dropping the field would deliver a clip of the wrong size at
   * full price with nothing to show it was ignored.
   */
  resolution: string;
}

const VIDEO_ROUTES: Readonly<Record<string, RunwareVideoRoute>> = {
  'klingai:kling-video@3-standard': {
    dimensions: {
      '16:9': { width: 1280, height: 720 },
      '1:1': { width: 960, height: 960 },
      '9:16': { width: 720, height: 1280 },
    },
    duration: { min: 3, max: 15 },
    resolution: '720p',
  },
  'klingai:kling-video@3-pro': {
    dimensions: {
      '16:9': { width: 1920, height: 1080 },
      '1:1': { width: 1440, height: 1440 },
      '9:16': { width: 1080, height: 1920 },
    },
    duration: { min: 3, max: 15 },
    resolution: '1080p',
  },
};

const DEFAULT_ASPECT_RATIO = '16:9';

/** Where a finished render is served from. Results are read from nowhere else. */
const RESULT_HOSTS = ['vm.runware.ai', 'im.runware.ai'];

/**
 * A duplicate submit of a task that is still running. The provider rejects it
 * rather than billing it, which makes this the one error code that is good
 * news: it is proof the original submit was accepted, so a replay that sees it
 * has found its job rather than lost it.
 */
const CONFLICTING_TASK = 'conflictTaskUUID';

interface RunwareError {
  code?: unknown;
  message?: unknown;
  parameter?: unknown;
  taskUUID?: unknown;
}

interface RunwareEnvelope {
  data?: Array<Record<string, unknown>>;
  errors?: RunwareError[];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The task id a client request id lands under.
 *
 * The provider requires a uuid, and the request id is a long structured key, so
 * the mapping is a digest rather than the string itself. It must stay a pure
 * function of its input in perpetuity: change it and every in-flight job
 * becomes unaddressable, and every recovery buys its render a second time.
 */
export function runwareTaskUuid(clientRequestId: string): string {
  const bytes = Uint8Array.from(
    createHash('sha256').update(clientRequestId).digest().subarray(0, 16),
  );
  // Version 4 and the RFC 4122 variant, so the value passes a uuid check.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The frames a render is conditioned on, in the shape the route reads them.
 *
 * The positions are named rather than left to the provider's own ordering
 * rule: unlabelled images are assigned first-then-last by count, so a request
 * carrying only an end frame would silently render from it as the opening
 * shot.
 */
export function hasFirstFrame<T extends Pick<GenerateVideoRequest, 'imageData'>>(
  request: T,
): request is T & { imageData: string } {
  return request.imageData !== undefined && request.imageData !== '';
}

function buildFrameImages(request: GenerateVideoRequest): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  if (hasFirstFrame(request)) {
    frames.push({
      image: dataUri(request.imageData, request.imageMimeType),
      frame: 'first',
    });
  }
  if (request.lastFrameData !== undefined && request.lastFrameData !== '') {
    frames.push({
      image: dataUri(request.lastFrameData, request.lastFrameMimeType),
      frame: 'last',
    });
  }
  return frames;
}

/** A media type, or nothing. A comma in one ends the type and swallows the data. */
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function dataUri(base64: string, mimeType: string | undefined): string {
  const declared = mimeType !== undefined && MEDIA_TYPE.test(mimeType) ? mimeType : 'image/png';
  return `data:${declared};base64,${base64}`;
}

/** A named identity the prompt refers to, and the marker it is spoken as. */
interface ResolvedElement {
  label: string;
  element: Record<string, unknown>;
}

/**
 * The prompt with every named reference replaced by the marker that stands for
 * it, and the order the route will read those markers in.
 *
 * Where the prompt names each label is decided by the shared scan, so the
 * authoring surface that refuses an unnamed reference and this rewrite cannot
 * disagree about what counts as naming one.
 */
function speakLabels(
  prompt: string,
  labels: readonly string[],
): { prompt: string; order: string[] } {
  const spans = findNamedLabels(prompt, labels);
  const order: string[] = [];
  let spoken = '';
  let at = 0;
  for (const span of spans) {
    const seen = order.indexOf(span.label);
    const index = seen >= 0 ? seen : order.push(span.label) - 1;
    spoken += prompt.slice(at, span.start) + `<<<element_${String(index + 1)}>>>`;
    at = span.end;
  }
  return { prompt: spoken + prompt.slice(at), order };
}

/**
 * The prompt as the route needs to read it, and the elements it names.
 *
 * The route numbers its markers by order of appearance, so the order is taken
 * from the prompt rather than from the order the references arrived in — and a
 * name the prompt never says is refused rather than sent as an element the
 * render will not use.
 */
function encodeElements(
  prompt: string,
  references: readonly ImageReferenceInput[],
): { prompt: string; elements: Array<Record<string, unknown>> } {
  const groups = groupReferencesByEntity(references);
  const spoken = speakLabels(
    prompt,
    groups.map((group) => group.label),
  );

  const missing = groups.filter((group) => !spoken.order.includes(group.label));
  if (missing.length > 0) {
    throw new AIClientError(
      `The prompt never names ${missing.map((group) => `'${group.label}'`).join(', ')}, so the render would be billed without that reference. Use each reference's label in the prompt as the character's name, as a word of its own.`,
      'invalid_request',
      'runware',
      false,
    );
  }

  const resolved: ResolvedElement[] = spoken.order.map((label) => {
    const group = groups.find((candidate) => candidate.label === label)!;
    const [frontal, ...rest] = group.references;
    return {
      label,
      element: {
        // Stable across renders, so the route may recognise a character it has
        // already been shown. The full definition still travels every time —
        // an id the provider has forgotten must not cost us the identity.
        id: elementId(label, group.references),
        description: label,
        frontalImage: dataUri(frontal!.data, frontal!.mimeType),
        // The route requires this list to be non-empty and reads it as the
        // further angles on one identity. A character given a single image has
        // no further angles, so the frontal one stands in for itself.
        images: (rest.length > 0 ? rest : [frontal!]).map((reference) =>
          dataUri(reference.data, reference.mimeType),
        ),
        tags: ['Character'],
      },
    };
  });

  return { prompt: spoken.prompt, elements: resolved.map((entry) => entry.element) };
}

/**
 * One identity, one id — derived from what the identity actually is.
 *
 * Base36 rather than hex because the route caps this at 20 characters, and it
 * reports an overrun as a type error naming neither the cap nor the length.
 */
const MAX_ELEMENT_ID_LENGTH = 20;

function elementId(label: string, references: readonly ImageReferenceInput[]): string {
  // Folded one reference at a time. Concatenating the blobs first would hold a
  // second copy of every image in memory purely to hash them.
  const hash = createHash('sha256').update(label);
  for (const reference of references) hash.update(reference.data);
  const digest = hash.digest('hex');
  return `ref${BigInt(`0x${digest.slice(0, 16)}`).toString(36)}`.slice(0, MAX_ELEMENT_ID_LENGTH);
}

/**
 * The error this task earned, rather than whichever one happens to be first:
 * a batch answers every task in one envelope, and an unrelated failure must
 * not be reported as this render's.
 */
function firstError(envelope: RunwareEnvelope, taskUUID?: string): RunwareError | undefined {
  const errors = envelope.errors;
  if (errors === undefined || errors.length === 0) return undefined;
  if (taskUUID === undefined) return errors[0];
  return errors.find((error) => error.taskUUID === taskUUID);
}

function errorCode(envelope: RunwareEnvelope, taskUUID?: string): string | undefined {
  return asNonEmptyString(firstError(envelope, taskUUID)?.code);
}

function errorMessage(envelope: RunwareEnvelope, taskUUID?: string): string | undefined {
  return asNonEmptyString(firstError(envelope, taskUUID)?.message);
}

/**
 * Whether a failed call is worth repeating. A rejected request is rejected the
 * same way every time — only exhaustion and transport faults change on a retry.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function classify(status: number): 'auth' | 'rate_limit' | 'invalid_request' | 'provider_error' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'provider_error';
}

/**
 * A parsed answer and the status line it came under.
 *
 * Both halves are needed to read one: a rejected task arrives as HTTP 400 with
 * its reason in `errors`, and one of those reasons — a task id already in
 * flight — is the submit succeeding. Deciding that here would make the caller's
 * verdict unreachable, so this reports and the callers decide.
 */
interface RunwareAnswer {
  status: number;
  envelope: RunwareEnvelope;
}

async function callRunware(
  tasks: Array<Record<string, unknown>>,
  config: ProviderConfig,
  signal: AbortSignal | undefined,
): Promise<RunwareAnswer> {
  const apiKey = config.apiKey;
  if (apiKey === undefined || apiKey === '') {
    throw new AIClientError('Runware API key is required', 'auth', 'runware', false);
  }

  // A listener added to an already-aborted signal never fires, so without this
  // check a run cancelled before the call reaches here still buys the render.
  if (signal?.aborted === true) {
    throw new AIClientError(
      'The run was cancelled before Runware was called',
      'timeout',
      'runware',
      false,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abort = () => {
    controller.abort();
  };
  signal?.addEventListener('abort', abort);

  let status: number;
  let text: string;
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tasks),
      signal: controller.signal,
    });
    // Read under the same guard as the request. A body that stalls once its
    // headers have arrived would otherwise be bounded by neither the timeout
    // nor the caller's signal, and a fault mid-body would escape unclassified.
    status = response.status;
    text = await response.text();
  } catch (error) {
    throw new AIClientError(
      `Runware could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      'network',
      'runware',
      true,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }

  try {
    return { status, envelope: JSON.parse(text) as RunwareEnvelope };
  } catch {
    throw new AIClientError(
      `Runware answered HTTP ${String(status)} with a body that is not JSON`,
      classify(status),
      'runware',
      isRetryableStatus(status),
    );
  }
}

/** The error a refused call carries, classified by the status it arrived under. */
function refusal(answer: RunwareAnswer, taskUUID: string): AIClientError {
  const code = errorCode(answer.envelope, taskUUID) ?? errorCode(answer.envelope);
  return new AIClientError(
    errorMessage(answer.envelope, taskUUID) ??
      errorMessage(answer.envelope) ??
      `Runware answered HTTP ${String(answer.status)}`,
    classify(answer.status),
    'runware',
    isRetryableStatus(answer.status),
    code !== undefined ? { providerErrorCode: code } : undefined,
  );
}

/** The first row of the answer to a task, matched by the id it was asked under. */
function rowFor(envelope: RunwareEnvelope, taskUUID: string): Record<string, unknown> | undefined {
  return envelope.data?.find((row) => row['taskUUID'] === taskUUID);
}

/**
 * What the provider says the render cost. Reported in whole dollars as a float,
 * so it is carried as integer micros the moment it is read — money that stays a
 * float long enough to be added to other money stops reconciling.
 */
function reportedCost(row: Record<string, unknown>): AsyncJobCost | undefined {
  const cost = row['cost'];
  // Zero is not a price a paid render reports. Accepting it would stamp the
  // step `priced` at nothing and settle the durable row as free, which is the
  // confident zero the whole spend path exists to refuse.
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return undefined;
  return { currency: 'USD', micros: Math.round(cost * 1_000_000) };
}

/**
 * Fetch a finished render. The url comes from the provider's own response, so
 * it is still validated and pinned to the hosts that serve results — a response
 * field is remote input whoever wrote it.
 */
async function retrieveRendered(
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ data: string; mimeType: string | undefined }> {
  let validated: URL;
  try {
    validated = (await validateUrl(url, RESULT_HOSTS)).url;
    if (validated.protocol !== 'https:') {
      throw new Error(`refusing to read a render over ${validated.protocol}`);
    }
  } catch (error) {
    throw new AIClientError(
      `Runware served the render from ${url}, which this process may not read`,
      'provider_error',
      'runware',
      false,
      { cause: error },
    );
  }
  try {
    const response = await safeFetch(validated, {
      allowedHosts: RESULT_HOSTS,
      redirect: 'error',
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) {
      throw new AIClientError(
        `Runware stored the render at ${url} and retrieving it returned HTTP ${response.status}`,
        'provider_error',
        'runware',
        isRetryableStatus(response.status),
      );
    }
    const contentType = response.headers.get('content-type');
    return {
      data: Buffer.from(await response.arrayBuffer()).toString('base64'),
      mimeType: contentType?.startsWith('video/') ? contentType : undefined,
    };
  } catch (error) {
    if (error instanceof AIClientError) throw error;
    throw new AIClientError(
      `Runware stored the render at ${url} and it could not be retrieved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'provider_error',
      'runware',
      // A stored render outlives a transient read failure, so retrying re-reads
      // it for free. Only a url this process will never be allowed to reach is
      // terminal.
      !(error instanceof SsrfBlockedError),
      { cause: error },
    );
  }
}

export function createRunwareAdapter(config: ProviderConfig): RunwareVideoAdapter {
  return {
    provider: 'runware',

    generateText: () => noTextLane('generateText'),
    generateTextStream: () => noTextLane('generateTextStream'),
    generateJson: () => noTextLane('generateJson'),
    generateEmbedding: () => noTextLane('generateEmbedding'),

    replayGuaranteeFor(): AsyncReplayGuarantee {
      // `taskUUID` is ours and the provider refuses a second submit under one
      // that is still running, so a replay costs nothing and resolves which
      // side of the window the original landed on.
      return { kind: 'idempotency_key', field: 'taskUUID' };
    },

    videoJobHandleFor(clientRequestId: string): VideoJobHandle {
      return { providerJobId: runwareTaskUuid(clientRequestId) };
    },

    async submitVideoJob(request: GenerateVideoRequest): Promise<VideoJobHandle> {
      if (request.clientRequestId === undefined) {
        // `replayGuaranteeFor` promises this route dedupes on `taskUUID`. A
        // random one keeps neither half of that promise: a replay would neither
        // find the job nor be refused, and would buy a second render.
        throw new AIClientError(
          'Runware renders are addressed by a caller-derived task id, and this request carries no client request id to derive one from',
          'invalid_request',
          'runware',
          false,
        );
      }
      const taskUUID = runwareTaskUuid(request.clientRequestId);

      const route = VIDEO_ROUTES[request.model];
      if (route === undefined) {
        throw new AIClientError(
          `'${request.model}' is not a wired Runware video route. Wired routes: ${Object.keys(VIDEO_ROUTES).join(', ')}`,
          'model_not_found',
          'runware',
          false,
        );
      }

      const task: Record<string, unknown> = {
        taskType: 'videoInference',
        taskUUID,
        model: request.model,
        positivePrompt: request.prompt,
        numberResults: 1,
        // The submit returns as soon as the work is accepted; everything after
        // is a poll against `taskUUID`.
        deliveryMethod: 'async',
        // What the provider billed, reported back on the poll. Without it the
        // only figure available is a rate table this side maintains by hand.
        includeCost: true,
      };
      if (request.resolution !== undefined && request.resolution !== route.resolution) {
        throw new AIClientError(
          `'${request.model}' renders ${route.resolution}; '${request.resolution}' was asked for. The resolution is the route — pick the model that renders it.`,
          'invalid_request',
          'runware',
          false,
        );
      }
      if (request.negativePrompt !== undefined && request.negativePrompt !== '') {
        task['negativePrompt'] = request.negativePrompt;
      }
      if (request.durationSeconds !== undefined) {
        const { min, max } = route.duration;
        if (!Number.isInteger(request.durationSeconds)) {
          throw new AIClientError(
            `'${request.model}' renders a whole number of seconds; ${String(request.durationSeconds)} is not one`,
            'invalid_request',
            'runware',
            false,
          );
        }
        if (request.durationSeconds < min || request.durationSeconds > max) {
          throw new AIClientError(
            `'${request.model}' renders clips of ${String(min)}–${String(max)} seconds; ${String(request.durationSeconds)} was asked for`,
            'invalid_request',
            'runware',
            false,
          );
        }
        task['duration'] = request.durationSeconds;
      }

      const frameImages = buildFrameImages(request);
      const references = request.references ?? [];
      if (frameImages.length > 0) {
        const named =
          references.length > 0 ? encodeElements(request.prompt, references) : undefined;
        if (named !== undefined) task['positivePrompt'] = named.prompt;
        task['inputs'] = {
          frameImages,
          ...(named !== undefined ? { elements: named.elements } : {}),
        };
      } else {
        if (references.length > 0) {
          // The route reads an element only while animating a starting frame,
          // and accepts the request without one — so the render would come back
          // billed in full and carrying none of the asked-for identity.
          throw new AIClientError(
            `'${request.model}' reads reference images only when the clip starts from a frame. Give the shot a first frame, or drop the references.`,
            'invalid_request',
            'runware',
            false,
          );
        }
        // Dimensions are the route's to enumerate and are inherited from a
        // source frame when there is one, so they are only ever sent for a
        // render that starts from the prompt alone.
        const ratio = request.aspectRatio ?? DEFAULT_ASPECT_RATIO;
        const size = route.dimensions[ratio];
        if (size === undefined) {
          throw new AIClientError(
            `'${request.model}' renders ${Object.keys(route.dimensions).join(', ')}; '${ratio}' is not among them`,
            'invalid_request',
            'runware',
            false,
          );
        }
        task['width'] = size.width;
        task['height'] = size.height;
      }

      const answer = await callRunware([task], config, request.signal);
      const { envelope } = answer;

      // A replay of a submit the provider is still working on is refused as
      // HTTP 400, and that refusal is this call succeeding: the render exists,
      // it is addressed by this same id, and it was not billed twice to find
      // that out.
      // Matched loosely on purpose: this is the one error that means the render
      // exists, and reading it as a refusal would strand a live paid job. Only
      // our own task id can raise it — it is a digest of our own job key.
      if ((errorCode(envelope, taskUUID) ?? errorCode(envelope)) === CONFLICTING_TASK) {
        return { providerJobId: taskUUID };
      }
      if (answer.status !== 200 || firstError(envelope, taskUUID) !== undefined) {
        throw refusal(answer, taskUUID);
      }
      if (rowFor(envelope, taskUUID) === undefined) {
        throw new AIClientError(
          'Runware accepted the render but did not acknowledge the task id it was submitted under',
          'provider_error',
          'runware',
          false,
        );
      }
      return { providerJobId: taskUUID };
    },

    async pollVideoJob(request: PollVideoJobRequest): Promise<VideoJobPoll> {
      const taskUUID = request.handle.providerJobId;
      // `getResponse`, never `getTaskDetails`: the archive records the last
      // response a task received, which for a job whose replay was rejected is
      // that rejection rather than the render's own outcome.
      const answer = await callRunware(
        [{ taskType: 'getResponse', taskUUID }],
        config,
        request.signal,
      );
      // A read that was refused says nothing about the render. Reporting an
      // expired key or a throttled poll as a failed render would retire a job
      // that is still running and already paid for.
      if (answer.status !== 200) throw refusal(answer, taskUUID);
      const { envelope } = answer;

      const row = rowFor(envelope, taskUUID);
      if (row === undefined) {
        // A render that fails leaves `data` entirely and is reported in
        // `errors`, so the absence of a row is not by itself an absence of an
        // outcome.
        const message = errorMessage(envelope, taskUUID);
        // An unrecognised id reads as pending rather than missing: the provider
        // answers a never-submitted id and a running one identically, and only
        // one of those is safe to conclude.
        return message !== undefined ? { status: 'failed', message } : { status: 'pending' };
      }

      const status = asNonEmptyString(row['status']);
      if (status === 'error') {
        return {
          status: 'failed',
          message: asNonEmptyString(row['error']) ?? 'Runware reported the render as failed',
        };
      }

      const videoURL = asNonEmptyString(row['videoURL']);
      if (videoURL === undefined) return { status: 'pending' };

      const fetched = await retrieveRendered(videoURL, request.signal);
      const cost = reportedCost(row);
      return {
        status: 'succeeded',
        response: {
          videos: [
            {
              data: fetched.data,
              mimeType: fetched.mimeType ?? 'video/mp4',
              ...(request.durationSeconds !== undefined
                ? { durationSeconds: request.durationSeconds }
                : {}),
            },
          ],
          model: request.model,
          provider: 'runware',
          ...(cost !== undefined ? { reportedCost: cost } : {}),
        },
      };
    },
  };
}
