/**
 * Fireworks provider adapter.
 *
 * Fireworks is OpenAI-compatible at https://api.fireworks.ai/inference/v1.
 * Used as a direct route to high-throughput hosts for models like
 * DeepSeek V4 Pro and Kimi K2.6 where OpenRouter aggregates slower providers.
 */
import OpenAI from 'openai';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateEmbeddingRequest,
  GenerateEmbeddingResponse,
  StreamingResponse,
  ProviderConfig,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  TextStreamChunk,
  TokenUsage,
  FinishReason,
  ProviderReasoning,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError, buildStreamTruncationError } from '../errors.js';
import { parseJsonResponse } from './jsonResponseParse.js';

// ============================================================================
// Fireworks Configuration
// ============================================================================

export type FireworksConfig = ProviderConfig;

const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

// ============================================================================
// Message Conversion (OpenAI-compatible)
// ============================================================================

type OpenAIMessage = OpenAI.ChatCompletionMessageParam;

export function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };

    case 'user': {
      if (typeof message.content === 'string') {
        return { role: 'user', content: message.content };
      }
      const parts: OpenAI.ChatCompletionContentPart[] = message.content.map((part) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        if (part.source.type === 'url') {
          return {
            type: 'image_url' as const,
            image_url: { url: part.source.url },
          };
        }
        return {
          type: 'image_url' as const,
          image_url: {
            url: `data:${part.source.mediaType};base64,${part.source.data}`,
          },
        };
      });
      return { role: 'user', content: parts };
    }

    case 'assistant': {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: message.content,
      };
      if (message.toolCalls && message.toolCalls.length > 0) {
        msg.tool_calls = message.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      // Plan 259: replay this turn's reasoning_content for tool-use continuity —
      // GLM/DeepSeek continue their reasoning instead of re-deriving it. Only the
      // blocks this adapter captured (provider === 'fireworks') are replayed; the
      // executor's retention already bounded which turns carry it.
      const reasoningContent = fireworksReasoningContent(message.providerReasoning);
      if (reasoningContent) {
        (msg as unknown as Record<string, unknown>)['reasoning_content'] = reasoningContent;
      }
      return msg;
    }

    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };

    default: {
      const _exhaustive: never = message;
      throw new Error(`Unknown message role: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters,
    },
  }));
}

function fromOpenAIToolCalls(
  toolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  // openai v6: ChatCompletionMessageToolCall is a union (function | custom);
  // only function-tool variants carry `.function`. Fireworks only emits functions.
  return toolCalls
    .filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
}

function toFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

interface FireworksReasoningExtras {
  reasoning_effort?: 'low' | 'medium' | 'high' | 'none';
}

/**
 * Build Fireworks reasoning body from our `ReasoningConfig`.
 *
 * A total map: `off` → `reasoning_effort: 'none'`, the rest pass through
 * OpenAI-compatible. Whether a given model tolerates `'none'` is a catalog
 * fact — a model that always reasons omits `off` from its supported set and
 * the client clamps before the effort arrives here.
 */
function buildFireworksReasoningBody(reasoning: unknown): FireworksReasoningExtras {
  const effort = (reasoning as { effort?: string } | undefined)?.effort;
  if (effort === 'off') return { reasoning_effort: 'none' };
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return { reasoning_effort: effort };
  }
  return {};
}

/** OpenAI SDK `ReasoningEffort` omits Fireworks `'none'`; cast at provider boundary. */
function applyFireworksReasoningExtras<
  T extends OpenAI.Chat.Completions.ChatCompletionCreateParams,
>(params: T, extras: FireworksReasoningExtras): T {
  if (Object.keys(extras).length === 0) {
    return params;
  }
  return { ...params, ...extras } as T;
}

/**
 * Extract native reasoning/thinking text from a Fireworks chat-completion
 * message. Fireworks surfaces it as either `message.reasoning` or
 * `message.reasoning_content` depending on the model. Returns undefined when
 * the model has no reasoning step or the provider hides the text.
 */
function extractThinking(message: unknown): string | undefined {
  const m = message as { reasoning?: unknown; reasoning_content?: unknown } | undefined;
  if (typeof m?.reasoning === 'string' && m.reasoning.length > 0) return m.reasoning;
  if (typeof m?.reasoning_content === 'string' && m.reasoning_content.length > 0) {
    return m.reasoning_content;
  }
  return undefined;
}

/**
 * Build the inline continuity artifact (Plan 259) from a Fireworks reasoning
 * string. Stored provider-tagged so it is never replayed to another provider.
 */
function fireworksReasoning(model: string, thinking: string): ProviderReasoning {
  return { provider: 'fireworks', model, blocks: [{ reasoning_content: thinking }] };
}

/** Read the `reasoning_content` string back out of a Fireworks continuity artifact. */
function fireworksReasoningContent(pr: ProviderReasoning | undefined): string | undefined {
  if (pr?.provider !== 'fireworks') return undefined;
  const first = pr.blocks[0] as { reasoning_content?: unknown } | undefined;
  return typeof first?.reasoning_content === 'string' && first.reasoning_content.length > 0
    ? first.reasoning_content
    : undefined;
}

function extractUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage {
  const cached =
    usage == null
      ? 0
      : ((usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
          .prompt_tokens_details?.cached_tokens ?? 0);
  const reasoning =
    usage == null
      ? 0
      : ((usage as unknown as { completion_tokens_details?: { reasoning_tokens?: number } })
          .completion_tokens_details?.reasoning_tokens ?? 0);
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    ...(cached > 0
      ? {
          cacheReadTokens: cached,
          uncachedPromptTokens: (usage?.prompt_tokens ?? 0) - cached,
        }
      : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

interface NormalizeContext {
  model?: string;
  signal?: AbortSignal | undefined;
  startMs?: number;
}

function isPlatformTimeoutAbort(signal: AbortSignal | undefined): { timeoutMs: number } | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason as { marker?: unknown; timeoutMs?: unknown } | undefined;
  if (reason?.marker === 'phoenix.executor.timeout' && typeof reason.timeoutMs === 'number') {
    return { timeoutMs: reason.timeoutMs };
  }
  return null;
}

export function normalizeFireworksError(error: unknown, ctx: NormalizeContext = {}): AIClientError {
  // Aborts must be detected before the APIError branches: APIUserAbortError
  // extends APIError with no status, so the status-based tail would classify
  // it as a terminal provider error. The SDK also leaves `.name` as 'Error',
  // so fall back to the constructor name for diagnostics.
  if (error instanceof Error) {
    const isAbort =
      error instanceof OpenAI.APIUserAbortError ||
      error.name === 'AbortError' ||
      error.name === 'APIUserAbortError' ||
      error.name === 'APIConnectionTimeoutError' ||
      (!(error instanceof OpenAI.APIError) && error.message.includes('abort'));
    if (isAbort) {
      const elapsedMs =
        ctx.startMs !== undefined ? Math.round(Date.now() - ctx.startMs) : undefined;
      const platformTimeout = isPlatformTimeoutAbort(ctx.signal);
      const modelLabel = ctx.model ? ` model=${ctx.model}` : '';
      const elapsedLabel = elapsedMs !== undefined ? ` elapsed=${elapsedMs}ms` : '';
      const sdkErrorClass = error.name === 'Error' ? error.constructor.name : error.name;
      const diagnosticMessage = platformTimeout
        ? `Platform timeout exceeded after ${platformTimeout.timeoutMs}ms${elapsedLabel} ` +
          `(provider=fireworks${modelLabel}, sdkErrorClass=${sdkErrorClass}).`
        : `Fireworks request aborted${elapsedLabel} ` +
          `(provider=fireworks${modelLabel}, sdkErrorClass=${sdkErrorClass}, ` +
          `cause=${error.message || 'unknown'}).`;
      return new AIClientError(diagnosticMessage, 'timeout', 'fireworks', true, { cause: error });
    }
  }

  if (error instanceof OpenAI.APIError) {
    // Connection-level failures (no HTTP response → no status). Transient by
    // nature — DNS hiccup, TCP reset, TLS handshake failure, brief upstream
    // outage. Must be marked retryable so the orchestrator retries instead of
    // failing the whole agent run on a single network blip.
    if (error instanceof OpenAI.APIConnectionError) {
      const elapsedMs =
        ctx.startMs !== undefined ? Math.round(Date.now() - ctx.startMs) : undefined;
      const elapsedLabel = elapsedMs !== undefined ? ` elapsed=${elapsedMs}ms` : '';
      const modelLabel = ctx.model ? ` model=${ctx.model}` : '';
      const isTimeout = error instanceof OpenAI.APIConnectionTimeoutError;
      return new AIClientError(
        `Fireworks ${isTimeout ? 'connection timeout' : 'connection error'}${elapsedLabel}` +
          `${modelLabel}: ${error.message}`,
        isTimeout ? 'timeout' : 'network_error',
        'fireworks',
        true,
        { cause: error },
      );
    }
    const status = error.status as number;
    const message = error.message;
    const body = (error as unknown as { error?: unknown }).error;
    const bodyObj = body as { code?: unknown; message?: unknown } | undefined;
    const bodyCode = typeof bodyObj?.code === 'string' ? bodyObj.code : undefined;
    const bodyMessage = typeof bodyObj?.message === 'string' ? bodyObj.message : undefined;
    const headers = error.headers as Record<string, string | string[] | undefined> | undefined;
    const requestId =
      typeof headers?.['x-request-id'] === 'string' ? headers['x-request-id'] : undefined;

    const suffixParts: string[] = [];
    if (requestId) suffixParts.push(`request_id=${requestId}`);
    if (bodyCode) suffixParts.push(`code=${bodyCode}`);
    const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : '';

    const errOpts = (retryAfterMs?: number) => {
      const opts: {
        retryAfterMs?: number;
        providerErrorCode?: string;
        providerRequestId?: string;
        cause?: unknown;
      } = { cause: error };
      if (retryAfterMs !== undefined) opts.retryAfterMs = retryAfterMs;
      if (bodyCode !== undefined) opts.providerErrorCode = bodyCode;
      if (requestId !== undefined) opts.providerRequestId = requestId;
      return opts;
    };

    if (status === 401 || status === 403) {
      return new AIClientError(
        `Fireworks authentication failed: ${bodyMessage ?? message}${suffix}`,
        'auth',
        'fireworks',
        false,
        errOpts(),
      );
    }
    if (status === 429) {
      const retryAfter = headers?.['retry-after'];
      const retryAfterStr = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
      const retryAfterMs = retryAfterStr ? parseInt(retryAfterStr, 10) * 1000 : 60000;
      return new AIClientError(
        `Fireworks rate limited: ${bodyMessage ?? message}${suffix}`,
        'rate_limit',
        'fireworks',
        true,
        errOpts(retryAfterMs),
      );
    }
    if (status === 400) {
      if (message.includes('context') || message.includes('token')) {
        return new AIClientError(
          `Fireworks context length exceeded: ${bodyMessage ?? message}${suffix}`,
          'context_length',
          'fireworks',
          false,
          errOpts(),
        );
      }
      return new AIClientError(
        `Fireworks invalid request: ${bodyMessage ?? message}${suffix}`,
        'invalid_request',
        'fireworks',
        false,
        errOpts(),
      );
    }
    if (status === 404) {
      return new AIClientError(
        `Fireworks model not found: ${bodyMessage ?? message}${suffix}`,
        'model_not_found',
        'fireworks',
        false,
        errOpts(),
      );
    }
    if (status === 502 || status === 503 || status === 504) {
      return new AIClientError(
        `Fireworks upstream error: ${bodyMessage ?? message}${suffix}`,
        'provider_error',
        'fireworks',
        true,
        errOpts(),
      );
    }
    return new AIClientError(
      `Fireworks error: ${bodyMessage ?? message}${suffix}`,
      'provider_error',
      'fireworks',
      status >= 500,
      errOpts(),
    );
  }

  if (error instanceof Error) {
    return new AIClientError(error.message, 'network_error', 'fireworks', true);
  }

  return new AIClientError(String(error), 'provider_error', 'fireworks', false);
}

// ============================================================================
// Fireworks Adapter
// ============================================================================

export function createFireworksAdapter(config: FireworksConfig): AIProviderAdapter {
  const baseUrl = config.baseUrl ?? FIREWORKS_BASE_URL;
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseUrl,
    maxRetries: config.maxRetries ?? 1,
    timeout: config.timeoutMs ?? 300_000,
  });

  return {
    provider: 'fireworks',

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
      const startMs = Date.now();
      const reasoningBody = buildFireworksReasoningBody(request.reasoning);
      try {
        const response = await client.chat.completions.create(
          applyFireworksReasoningExtras(
            {
              model: request.model,
              messages: request.messages.map(toOpenAIMessage),
              ...(request.tools && request.tools.length > 0
                ? { tools: toOpenAITools(request.tools) }
                : {}),
              ...(request.toolChoice
                ? {
                    tool_choice:
                      typeof request.toolChoice === 'string'
                        ? request.toolChoice
                        : {
                            type: 'function' as const,
                            function: { name: request.toolChoice.function.name },
                          },
                  }
                : {}),
              ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.stopSequences ? { stop: request.stopSequences } : {}),
            },
            reasoningBody,
          ),
          {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          },
        );

        const choice = response.choices[0];
        if (!choice) {
          throw new AIClientError(
            'No response from Fireworks',
            'provider_error',
            'fireworks',
            true,
          );
        }

        const thinking = extractThinking(choice.message);

        return {
          content: choice.message.content,
          toolCalls: fromOpenAIToolCalls(choice.message.tool_calls),
          finishReason: toFinishReason(choice.finish_reason),
          usage: extractUsage(response.usage),
          model: response.model,
          provider: 'fireworks',
          providerRequestId: response.id,
          ...(thinking !== undefined ? { thinking } : {}),
          ...(thinking !== undefined
            ? { providerReasoning: fireworksReasoning(request.model, thinking) }
            : {}),
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeFireworksError(error, {
          model: request.model,
          signal: request.signal,
          startMs,
        });
      }
    },

    generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse> {
      let resolveResponse!: (value: GenerateTextResponse) => void;
      let rejectResponse!: (error: Error) => void;

      const responsePromise = new Promise<GenerateTextResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });

      const reasoningBody = buildFireworksReasoningBody(request.reasoning);

      const stream = (async function* (): AsyncIterable<TextStreamChunk> {
        const _diagStartMs = Date.now();
        try {
          const streamResponse = await client.chat.completions.create(
            applyFireworksReasoningExtras(
              {
                model: request.model,
                messages: request.messages.map(toOpenAIMessage),
                stream: true,
                stream_options: { include_usage: true },
                ...(request.tools && request.tools.length > 0
                  ? { tools: toOpenAITools(request.tools) }
                  : {}),
                ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(request.stopSequences ? { stop: request.stopSequences } : {}),
              },
              reasoningBody,
            ),
            {
              ...(request.signal ? { signal: request.signal } : {}),
              ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
            },
          );

          let content = '';
          let thinking = '';
          const toolCalls: ToolCall[] = [];
          let finishReason: FinishReason = 'stop';
          let sawFinishReason = false;
          let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          let model = request.model;
          let requestId: string | undefined;

          for await (const chunk of streamResponse) {
            request.onStreamProgress?.();
            requestId = chunk.id;
            model = chunk.model;

            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              yield { type: 'text_delta', delta: delta.content };
            }
            // Reasoning chunks — Fireworks emits them as `delta.reasoning` (or
            // `delta.reasoning_content`) for thinking-capable models.
            const reasoningDelta = (
              delta as unknown as { reasoning?: unknown; reasoning_content?: unknown } | undefined
            )?.reasoning;
            const reasoningContentDelta = (
              delta as unknown as { reasoning_content?: unknown } | undefined
            )?.reasoning_content;
            const thinkingChunk =
              typeof reasoningDelta === 'string'
                ? reasoningDelta
                : typeof reasoningContentDelta === 'string'
                  ? reasoningContentDelta
                  : null;
            if (thinkingChunk) {
              thinking += thinkingChunk;
              yield { type: 'thinking_delta', delta: thinkingChunk };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCalls[tc.index];
                if (existing) {
                  if (tc.function?.arguments) {
                    existing.function.arguments += tc.function.arguments;
                  }
                } else {
                  toolCalls[tc.index] = {
                    id: tc.id ?? '',
                    type: 'function',
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  };
                }
                yield {
                  type: 'tool_call_delta',
                  toolCallId: tc.id,
                  toolCallName: tc.function?.name,
                  toolCallArguments: tc.function?.arguments,
                };
              }
            }
            if (chunk.choices[0]?.finish_reason) {
              finishReason = toFinishReason(chunk.choices[0].finish_reason);
              sawFinishReason = true;
            }
            if (chunk.usage) {
              usage = extractUsage(chunk.usage);
              yield { type: 'usage', usage };
            }
          }

          if (!sawFinishReason) {
            throw buildStreamTruncationError({
              provider: 'fireworks',
              model: request.model,
              signal: request.signal,
              startMs: _diagStartMs,
              accumulatedChars: content.length,
              toolCallCount: toolCalls.length,
            });
          }

          yield { type: 'done', finishReason };

          resolveResponse({
            content: content || null,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finishReason,
            usage,
            model,
            provider: 'fireworks',
            providerRequestId: requestId,
            ...(thinking.length > 0 ? { thinking } : {}),
            ...(thinking.length > 0
              ? { providerReasoning: fireworksReasoning(request.model, thinking) }
              : {}),
          });
        } catch (error) {
          const normalized =
            error instanceof AIClientError
              ? error
              : normalizeFireworksError(error, {
                  model: request.model,
                  signal: request.signal,
                  startMs: _diagStartMs,
                });
          rejectResponse(normalized);
          throw normalized;
        }
      })();

      return { stream, response: responsePromise };
    },

    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>> {
      const startMs = Date.now();
      const useStructuredOutputs = Boolean(request.rawJsonSchema);
      const reasoningBody = buildFireworksReasoningBody(request.reasoning);
      try {
        const responseFormat: OpenAI.ChatCompletionCreateParams['response_format'] =
          useStructuredOutputs
            ? {
                type: 'json_schema' as const,
                json_schema: {
                  name: request.schemaName ?? 'response',
                  strict: request.strictJsonSchema !== false,
                  schema: request.rawJsonSchema!,
                },
              }
            : { type: 'json_object' as const };

        const response = await client.chat.completions.create(
          applyFireworksReasoningExtras(
            {
              model: request.model,
              messages: request.messages.map(toOpenAIMessage),
              response_format: responseFormat,
              ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
            reasoningBody,
          ),
          {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          },
        );

        const choice = response.choices[0];
        const content = choice == null ? null : (choice.message.content ?? null);

        if (choice?.finish_reason === 'length') {
          const completion = response.usage?.completion_tokens ?? 0;
          const limitLabel = request.maxTokens ? ` of ${request.maxTokens}` : '';
          throw new AIClientError(
            `Fireworks response truncated at max_tokens (finish_reason='length', completion_tokens=${completion}${limitLabel}, model=${request.model}). ` +
              `Increase max_tokens or simplify the requested output.`,
            'output_truncated',
            'fireworks',
            true,
            { providerRequestId: response.id },
          );
        }

        if (!content) {
          throw new AIClientError(
            'No JSON content returned from Fireworks',
            'provider_error',
            'fireworks',
            true,
          );
        }

        const thinking = extractThinking(choice?.message);

        let parsedUnknown: unknown;
        try {
          parsedUnknown = parseJsonResponse(content).parsed;
        } catch (err) {
          throw new AIClientError(
            `Fireworks returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
            'invalid_request',
            'fireworks',
            false,
            { providerRequestId: response.id, cause: err },
          );
        }

        const parsed = request.schema.safeParse(parsedUnknown);
        if (!parsed.success) {
          throw new AIClientError(
            `Fireworks returned JSON that failed schema validation: ${parsed.error.message}`,
            'invalid_request',
            'fireworks',
            false,
            { providerRequestId: response.id, cause: parsed.error },
          );
        }

        return {
          data: parsed.data,
          rawContent: content,
          finishReason: toFinishReason(choice?.finish_reason),
          usage: extractUsage(response.usage),
          model: response.model,
          provider: 'fireworks',
          providerRequestId: response.id,
          ...(thinking !== undefined ? { thinking } : {}),
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeFireworksError(error, {
          model: request.model,
          signal: request.signal,
          startMs,
        });
      }
    },

    async generateEmbedding(request: GenerateEmbeddingRequest): Promise<GenerateEmbeddingResponse> {
      const startMs = Date.now();
      try {
        const response = await client.embeddings.create({
          model: request.model,
          input: request.input,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        });

        return {
          embeddings: response.data.map((d) => d.embedding),
          usage: {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: 0,
            totalTokens: response.usage.total_tokens,
          },
          model: response.model,
          provider: 'fireworks',
          dimensions: response.data[0]?.embedding.length ?? 0,
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeFireworksError(error, { model: request.model, startMs });
      }
    },
  };
}
