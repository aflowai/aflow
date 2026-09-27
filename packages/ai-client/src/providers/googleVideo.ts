/**
 * Veo video generation for the Google adapter.
 *
 * Split out because it is a lifecycle of its own — a submit that bills and a
 * poll that reads — and because the text/image adapter has nothing to say
 * about it.
 */
import { GenerateVideosOperation, type GoogleGenAI } from '@google/genai';
import { SsrfBlockedError, safeFetch, validateCredentialedUrl } from '@aflow/network-safety';
import type { AsyncReplayGuarantee } from '@aflow/schemas';
import type {
  GeneratedVideo,
  GenerateVideoRequest,
  GenerateVideoResponse,
  PollVideoJobRequest,
  ProviderConfig,
  VideoJobHandle,
  VideoJobPoll,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError } from '../errors.js';
import {
  DEFAULT_TIMEOUT_MS,
  normalizeGoogleError,
  requestOrConfigTimeout,
  withTimeout,
} from './googleShared.js';

type GoogleVideoAdapter = Required<
  Pick<AIProviderAdapter, 'replayGuaranteeFor' | 'submitVideoJob' | 'pollVideoJob'>
>;

const DEFAULT_VIDEO_MIME_TYPE = 'video/mp4';

/**
 * The only host the adapter's api key authenticates to. A `uri` in a provider
 * response is remote input, and this request carries the key — so the host it
 * may reach is fixed here rather than taken from the response.
 */
const GEMINI_FILES_HOST = 'generativelanguage.googleapis.com';

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * The second hop, uncredentialed. It is still validated — a location is remote
 * input, so it may not name a private address and may not redirect again.
 */
async function followStoredVideoRedirect(
  first: Response,
  uri: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const location = first.headers.get('location');
  if (location === null || location === '') {
    throw new AIClientError(
      `Veo stored the render at ${uri} and answered HTTP ${first.status} naming nowhere to read it`,
      'provider_error',
      'google',
      true,
    );
  }
  const target = await validateCredentialedUrl(new URL(location, uri).toString());
  const followed = await safeFetch(target.url, {
    redirect: 'error',
    ...(signal !== undefined ? { signal } : {}),
  });
  return followed;
}

/**
 * Retrieve a finished render that the provider stored rather than inlined.
 *
 * `ai.files.download` is the SDK's equivalent and it only writes to a path, so
 * it would put a multi-megabyte temp file and its cleanup between a completed
 * render and the caller that wants its bytes. This issues the same GET the SDK
 * would, and keeps the result in memory.
 */
async function retrieveStoredVideo(
  uri: string,
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ data: string; mimeType: string | undefined }> {
  const read = async () => {
    // `safeFetch` admits http and pins it to the validated address, which is
    // not enough for a request carrying a credential — cleartext leaks the key
    // to whoever is on the path, whatever answers.
    const validated = await validateCredentialedUrl(uri);
    const first = await safeFetch(validated.url, {
      allowedHosts: [GEMINI_FILES_HOST],
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'manual',
      ...(signal !== undefined ? { signal } : {}),
    });

    // The download endpoint answers a stored render with a redirect to the
    // storage host holding it. The credential does not follow: a redirect
    // target is chosen by the remote, and the second hop carries its own
    // authorization in the signed url it hands back. Only one hop is honoured —
    // a chain is a remote deciding how far this reaches.
    const response = isRedirect(first.status)
      ? await followStoredVideoRedirect(first, uri, signal)
      : first;

    if (!response.ok) {
      throw new AIClientError(
        `Veo stored the render at ${uri} and retrieving it returned HTTP ${response.status}`,
        'provider_error',
        'google',
        response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get('content-type');
    return {
      data: Buffer.from(await response.arrayBuffer()).toString('base64'),
      mimeType: contentType?.startsWith('video/') ? contentType : undefined,
    };
  };

  try {
    return await withTimeout(read(), timeoutMs, 'retrieveStoredVideo');
  } catch (error) {
    if (error instanceof AIClientError) throw error;
    throw new AIClientError(
      `Veo stored the render at ${uri} and it could not be retrieved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'provider_error',
      'google',
      // A stored render outlives a transient read failure, so retrying is a
      // free re-read. Only a uri this process will never be allowed to reach
      // is terminal.
      !(error instanceof SsrfBlockedError),
      { cause: error },
    );
  }
}

export function createGoogleVideoAdapter(
  client: GoogleGenAI,
  config: ProviderConfig,
): GoogleVideoAdapter {
  return {
    replayGuaranteeFor(): AsyncReplayGuarantee {
      // Veo's generateVideos accepts no caller-supplied dedupe key, so a replay
      // of an accepted submit would buy a second render.
      return { kind: 'unknown_terminal' };
    },

    async submitVideoJob(request: GenerateVideoRequest): Promise<VideoJobHandle> {
      try {
        const videoConfig: Record<string, unknown> = {};
        if (request.negativePrompt) {
          videoConfig['negativePrompt'] = request.negativePrompt;
        }
        if (request.aspectRatio) {
          videoConfig['aspectRatio'] = request.aspectRatio;
        }
        if (request.resolution) {
          videoConfig['resolution'] = request.resolution;
        }
        if (request.durationSeconds) {
          videoConfig['durationSeconds'] = request.durationSeconds;
        }

        const generateParams: Record<string, unknown> = {
          model: request.model,
          prompt: request.prompt,
        };

        // Image-to-video: pass initial frame
        if (request.imageData) {
          generateParams['image'] = {
            imageBytes: request.imageData,
            mimeType: request.imageMimeType ?? 'image/png',
          };
        }

        // Interpolation: pass last frame
        if (request.lastFrameData) {
          videoConfig['lastFrame'] = {
            imageBytes: request.lastFrameData,
            mimeType: request.lastFrameMimeType ?? 'image/png',
          };
        }

        if (Object.keys(videoConfig).length > 0) {
          generateParams['config'] = videoConfig;
        }

        const operation = await withTimeout(
          client.models.generateVideos(
            generateParams as unknown as Parameters<typeof client.models.generateVideos>[0],
          ),
          requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, DEFAULT_TIMEOUT_MS),
          'submitVideoJob',
        );

        const name = operation.name;
        if (name === undefined || name === '') {
          // The operation name is the only address a later poll has. Without it
          // the render is paid for and unreachable, which must not be reported
          // as a successful submit.
          throw new AIClientError(
            'Veo accepted the render but returned no operation name',
            'provider_error',
            'google',
            false,
          );
        }
        return { providerJobId: name };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeGoogleError(error);
      }
    },

    async pollVideoJob(request: PollVideoJobRequest): Promise<VideoJobPoll> {
      try {
        // getVideosOperation calls `_fromAPIResponse` on what it is handed, so
        // it needs a real operation instance rather than a bare `{ name }`.
        const pending = new GenerateVideosOperation();
        pending.name = request.handle.providerJobId;
        const operation = await client.operations.getVideosOperation({ operation: pending });

        if (!operation.done) return { status: 'pending' };
        if (operation.error) {
          const message = (operation.error as { message?: unknown }).message;
          return {
            status: 'failed',
            message: typeof message === 'string' ? message : 'Veo reported the render as failed',
          };
        }

        const videos: GenerateVideoResponse['videos'] = [];
        const responseAny = operation.response as Record<string, unknown> | undefined;
        const generatedVideos = (responseAny?.['generatedVideos'] ?? []) as Array<
          Record<string, unknown>
        >;

        for (const gv of generatedVideos) {
          const video = gv['video'] as Record<string, unknown> | undefined;
          if (!video) continue;

          const declaredMimeType = asNonEmptyString(video['mimeType']);
          const inline = asNonEmptyString(video['videoBytes']);
          const uri = asNonEmptyString(video['uri']);

          let rendered: Pick<GeneratedVideo, 'data' | 'mimeType'>;
          if (inline !== undefined) {
            rendered = { data: inline, mimeType: declaredMimeType ?? DEFAULT_VIDEO_MIME_TYPE };
          } else if (uri !== undefined) {
            if (config.apiKey === undefined || config.apiKey === '') {
              throw new AIClientError(
                'Google API key is required to retrieve a stored render',
                'auth',
                'google',
                false,
              );
            }
            const fetched = await retrieveStoredVideo(
              uri,
              config.apiKey,
              requestOrConfigTimeout(undefined, config.timeoutMs, DEFAULT_TIMEOUT_MS),
              request.signal,
            );
            rendered = {
              data: fetched.data,
              mimeType: declaredMimeType ?? fetched.mimeType ?? DEFAULT_VIDEO_MIME_TYPE,
            };
          } else {
            continue;
          }

          videos.push({ ...rendered, durationSeconds: request.durationSeconds });
        }

        if (videos.length === 0) {
          return { status: 'failed', message: 'Veo completed the render but returned no video' };
        }

        return {
          status: 'succeeded',
          response: { videos, model: request.model, provider: 'google' },
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeGoogleError(error);
      }
    },
  };
}
