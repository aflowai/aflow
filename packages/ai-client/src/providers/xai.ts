/**
 * xAI (Grok) provider adapter.
 *
 * Chat goes through the OpenAI-compatible Responses API at api.x.ai. Image
 * generation and editing use xAI's own JSON image endpoints — their edit
 * route is not the OpenAI SDK's multipart `images.edit`.
 */
import { AIClientError, normalizeOpenAIError } from '../errors.js';
import type { AIProviderAdapter } from '../adapter.js';
import type {
  EditImageRequest,
  GenerateEmbeddingRequest,
  GenerateEmbeddingResponse,
  GenerateImageRequest,
  GenerateImageResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderConfig,
  StreamingResponse,
  TextStreamChunk,
} from '../types.js';
import { createOpenAIAdapter } from './openai.js';
import { refuseImageReferences } from './imageReferences.js';

export const XAI_API_BASE = 'https://api.x.ai/v1';

interface XaiImageItem {
  b64_json?: string | null;
  url?: string | null;
  revised_prompt?: string | null;
}

interface XaiImageBody {
  data?: XaiImageItem[] | null;
}

function asXaiError(error: unknown): never {
  if (error instanceof AIClientError && error.provider === 'xai') throw error;
  if (error instanceof AIClientError) retagError(error);
  retagError(normalizeOpenAIError(error));
}

function retagError(error: unknown): never {
  if (error instanceof AIClientError) {
    throw new AIClientError(error.message, error.code, 'xai', error.retryable, {
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.providerErrorCode !== undefined
        ? { providerErrorCode: error.providerErrorCode }
        : {}),
      ...(error.providerRequestId !== undefined
        ? { providerRequestId: error.providerRequestId }
        : {}),
      cause: error,
    });
  }
  throw error;
}

async function* retagStream(
  request: GenerateTextRequest,
  stream: AsyncIterable<TextStreamChunk>,
): AsyncGenerator<TextStreamChunk> {
  try {
    for await (const chunk of stream) {
      // The executor's idle window only moves when the stream it is reading
      // reports progress. The inner adapter's tick happens before this yield.
      request.onStreamProgress?.();
      yield chunk;
    }
  } catch (error) {
    retagError(error);
  }
}

function xaiHttpError(status: number, body: string): AIClientError {
  let message = `xAI returned HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    if (body.trim().length > 0) message = body.slice(0, 500);
  }
  const retryable = status === 429 || status >= 500;
  const code =
    status === 429
      ? 'rate_limit'
      : status === 401 || status === 403
        ? 'auth'
        : status === 400
          ? 'invalid_request'
          : 'provider_error';
  return new AIClientError(message, code, 'xai', retryable);
}

async function readImageBytes(item: XaiImageItem): Promise<string | undefined> {
  if (item.b64_json) return item.b64_json;
  if (!item.url) return undefined;
  const res = await fetch(item.url);
  if (!res.ok) return undefined;
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

async function imagesFromBody(body: XaiImageBody, model: string): Promise<GenerateImageResponse> {
  const images: GenerateImageResponse['images'] = [];
  for (const item of body.data ?? []) {
    const data = await readImageBytes(item);
    if (!data) continue;
    images.push({
      data,
      mimeType: 'image/jpeg',
      ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    });
  }
  if (images.length === 0) {
    throw new AIClientError('No images returned from xAI', 'provider_error', 'xai', false);
  }
  return { images, model, provider: 'xai' };
}

function imageExtras(request: GenerateImageRequest): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (request.aspectRatio) extras['aspect_ratio'] = request.aspectRatio;
  if (
    request.model === 'grok-imagine-image-2.0' &&
    (request.quality === 'low' || request.quality === 'medium' || request.quality === 'auto')
  ) {
    extras['quality'] = request.quality;
  }
  return extras;
}

/**
 * Create an xAI provider adapter.
 */
export function createXaiAdapter(config: ProviderConfig): AIProviderAdapter {
  const baseUrl = config.baseUrl ?? XAI_API_BASE;
  const apiKey = config.apiKey ?? '';
  const text = createOpenAIAdapter({ ...config, baseUrl }, { retainResponsesReasoning: 'xai' });

  async function postJson(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<XaiImageBody> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof AIClientError) throw error;
      throw normalizeOpenAIError(error);
    }
    if (!res.ok) throw xaiHttpError(res.status, await res.text());
    return (await res.json()) as XaiImageBody;
  }

  return {
    provider: 'xai',

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
      try {
        const response = await text.generateText(request);
        return { ...response, provider: 'xai' };
      } catch (error) {
        retagError(error);
      }
    },

    generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse> {
      const inner = text.generateTextStream(request);
      return {
        stream: retagStream(request, inner.stream),
        response: inner.response.then(
          (response) => ({ ...response, provider: 'xai' }),
          (error: unknown) => retagError(error),
        ),
      };
    },

    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>> {
      try {
        const response = await text.generateJson(request);
        return { ...response, provider: 'xai' };
      } catch (error) {
        retagError(error);
      }
    },

    generateEmbedding(_request: GenerateEmbeddingRequest): Promise<GenerateEmbeddingResponse> {
      return Promise.reject(
        new AIClientError(
          'xAI does not offer an embedding model. Use an OpenAI or Google embedding model.',
          'invalid_request',
          'xai',
          false,
        ),
      );
    },

    async generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse> {
      refuseImageReferences(request, 'xai', 'this model generates from the prompt alone');
      try {
        const body = await postJson(
          '/images/generations',
          {
            model: request.model,
            prompt: request.prompt,
            n: request.n ?? 1,
            response_format: 'b64_json',
            ...imageExtras(request),
          },
          request.signal,
        );
        return await imagesFromBody(body, request.model);
      } catch (error) {
        asXaiError(error);
      }
    },

    async editImage(request: EditImageRequest): Promise<GenerateImageResponse> {
      refuseImageReferences(request, 'xai', 'this model edits from the prompt and source image');
      if (request.maskData) {
        throw new AIClientError(
          `Model "${request.model}" does not accept an inpaint mask. Edit with the prompt and source image.`,
          'invalid_request',
          'xai',
          false,
        );
      }
      try {
        const body = await postJson(
          '/images/edits',
          {
            model: request.model,
            prompt: request.prompt,
            n: request.n ?? 1,
            response_format: 'b64_json',
            image: {
              url: `data:${request.imageMimeType};base64,${request.imageData}`,
              type: 'image_url',
            },
            ...imageExtras(request),
          },
          request.signal,
        );
        return await imagesFromBody(body, request.model);
      } catch (error) {
        asXaiError(error);
      }
    },
  };
}
