/**
 * OpenRouter provider adapter.
 *
 * OpenRouter provides a unified API gateway for 400+ AI models from 60+ providers.
 * It uses an OpenAI-compatible API, so we extend the OpenAI SDK with custom configuration.
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
  OpenRouterProviderRouting,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError, buildStreamTruncationError } from '../errors.js';
import { moveToolImagesToUserMessages, toolResultText } from './toolResultContent.js';
import { parseJsonResponse } from './jsonResponseParse.js';

// ============================================================================
// OpenRouter Configuration
// ============================================================================

export interface OpenRouterConfig extends ProviderConfig {
  /** Site URL for OpenRouter rankings and rate limits */
  siteUrl?: string | undefined;
  /** Site name for OpenRouter rankings */
  siteName?: string | undefined;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Build OpenRouter provider routing body from model preferences.
 * @see https://openrouter.ai/docs/features/provider-routing
 */
interface OpenRouterProviderBody {
  only?: string[];
  ignore?: string[];
  order?: string[];
  allow_fallbacks?: boolean;
  data_collection?: 'allow' | 'deny';
  require_parameters?: boolean;
  quantizations?: string[];
  sort?: 'price' | 'throughput' | 'latency';
}

function buildOpenRouterProviderBody(routing?: OpenRouterProviderRouting): {
  provider?: OpenRouterProviderBody;
} {
  if (!routing) return {};
  const body: OpenRouterProviderBody = {};
  if (routing.only && routing.only.length > 0) body.only = routing.only;
  if (routing.ignore && routing.ignore.length > 0) body.ignore = routing.ignore;
  if (routing.order && routing.order.length > 0) body.order = routing.order;
  if (routing.allow_fallbacks !== undefined) body.allow_fallbacks = routing.allow_fallbacks;
  if (routing.data_collection !== undefined) body.data_collection = routing.data_collection;
  if (routing.require_parameters !== undefined)
    body.require_parameters = routing.require_parameters;
  if (routing.quantizations && routing.quantizations.length > 0)
    body.quantizations = routing.quantizations;
  if (routing.sort !== undefined) body.sort = routing.sort;
  if (Object.keys(body).length === 0) return {};
  return { provider: body };
}

// ============================================================================
// Message Conversion (reuse OpenAI format)
// ============================================================================

type OpenAIMessage = OpenAI.ChatCompletionMessageParam;

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
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
      return msg;
    }

    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: toolResultText(message, 'openrouter'),
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
  // OpenRouter passes through OpenAI-format calls — only function variants here.
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

/**
 * Build OpenRouter `reasoning` request body field from our `ReasoningConfig`.
 * Returns the body fragment to spread into the request, or `{}` when no
 * reasoning config is set (provider's own default applies).
 *
 * @see https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
function buildOpenRouterReasoningBody(reasoning: unknown): {
  reasoning?: { effort?: 'low' | 'medium' | 'high'; exclude?: boolean };
} {
  const effort = (reasoning as { effort?: string } | undefined)?.effort;
  const body: { effort?: 'low' | 'medium' | 'high'; exclude?: boolean } = {};
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    body.effort = effort;
  }
  // Note: OpenRouter's `exclude: true` only hides the surfaced reasoning text
  // — the upstream model still reasons internally, so compute cost is unchanged.
  // Models routed through Fireworks get a real disable via `reasoning_effort: 'none'`.
  if (effort === 'off') body.exclude = true;
  if (Object.keys(body).length === 0) return {};
  return { reasoning: body };
}

/**
 * Extract native reasoning/thinking text from an OpenRouter chat-completion
 * message. OpenRouter surfaces it as `message.reasoning` for models that
 * expose chain-of-thought (deepseek, kimi, etc.). Returns undefined when the
 * model has no reasoning step or the provider hides the text.
 */
function extractThinking(message: unknown): string | undefined {
  const m = message as { reasoning?: unknown } | undefined;
  if (typeof m?.reasoning === 'string' && m.reasoning.length > 0) return m.reasoning;
  return undefined;
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

/**
 * The completion's choices, or a classified error when the body carries none.
 *
 * OpenRouter answers some refusals — a routing pool its filters emptied, most
 * often — with a 200 whose body holds `error` in place of `choices`. Indexing
 * straight into that throws a TypeError, which `normalizeOpenRouterError` can
 * only read as a generic network fault: the refusal comes back retryable, the
 * caller retries a request that can never succeed, and the message explaining
 * why never reaches the log.
 */
export function choicesOrThrow(
  response: OpenAI.ChatCompletion,
  model: string,
): OpenAI.ChatCompletion['choices'] {
  if (Array.isArray(response.choices)) return response.choices;

  const embedded = (response as unknown as { error?: { message?: string; code?: number } }).error;
  const code = embedded?.code;
  // A pool no host survives is a property of the request, not of the moment.
  const retryable = code !== 404;
  throw new AIClientError(
    `OpenRouter returned no choices for ${model}: ${embedded?.message ?? 'body carried no error detail'}`,
    code === 404 ? 'model_not_found' : 'provider_error',
    'openrouter',
    retryable,
    {
      ...(response.id ? { providerRequestId: response.id } : {}),
      ...(code !== undefined ? { providerErrorCode: String(code) } : {}),
    },
  );
}

/**
 * Context passed to error normalization so we can attribute aborts and
 * include diagnostic detail (model, elapsed time, configured timeout) in
 * the error message instead of an opaque "Request was aborted".
 */
interface NormalizeContext {
  model?: string;
  signal?: AbortSignal | undefined;
  startMs?: number;
  /** Configured platform timeout for this call, if known. */
  configuredTimeoutMs?: number;
}

/**
 * Detect a `withTimeout`-originated abort by inspecting the signal's `reason`
 * for the `phoenix.executor.timeout` marker. Avoids a direct dependency on
 * `@aflow/executor-runtime`; the marker string is a stable public contract.
 */
function isPlatformTimeoutAbort(signal: AbortSignal | undefined): { timeoutMs: number } | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason as { marker?: unknown; timeoutMs?: unknown } | undefined;
  if (reason?.marker === 'phoenix.executor.timeout' && typeof reason.timeoutMs === 'number') {
    return { timeoutMs: reason.timeoutMs };
  }
  return null;
}

/**
 * Normalize OpenRouter errors to AIClientError.
 */
export function normalizeOpenRouterError(
  error: unknown,
  ctx: NormalizeContext = {},
): AIClientError {
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

      let diagnosticMessage: string;
      if (platformTimeout) {
        diagnosticMessage =
          `Platform timeout exceeded after ${platformTimeout.timeoutMs}ms${elapsedLabel} ` +
          `(provider=openrouter${modelLabel}, sdkErrorClass=${sdkErrorClass}). ` +
          `Either the model is genuinely slow on this prompt or the platform timeout is too tight ` +
          `(see DEFAULT_TIMEOUT_MS / step-level timeout).`;
      } else if (sdkErrorClass === 'APIConnectionTimeoutError') {
        diagnosticMessage =
          `OpenRouter SDK request timed out${elapsedLabel} ` +
          `(provider=openrouter${modelLabel}, sdkErrorClass=${sdkErrorClass}). ` +
          `Provider was reached but did not respond within the SDK timeout — ` +
          `provider may be slow or unhealthy.`;
      } else {
        diagnosticMessage =
          `Request aborted${elapsedLabel} ` +
          `(provider=openrouter${modelLabel}, sdkErrorClass=${sdkErrorClass}, ` +
          `cause=${error.message || 'unknown'}). ` +
          `Likely network or upstream interrupt; not a platform-enforced timeout.`;
      }

      return new AIClientError(diagnosticMessage, 'timeout', 'openrouter', true, { cause: error });
    }
  }

  if (error instanceof OpenAI.APIError) {
    // Connection-level failures (no HTTP response → no status). Transient —
    // must be marked retryable so the orchestrator retries instead of failing
    // the agent run on a single network blip.
    if (error instanceof OpenAI.APIConnectionError) {
      const elapsedMs =
        ctx.startMs !== undefined ? Math.round(Date.now() - ctx.startMs) : undefined;
      const elapsedLabel = elapsedMs !== undefined ? ` elapsed=${elapsedMs}ms` : '';
      const modelLabel = ctx.model ? ` model=${ctx.model}` : '';
      const isTimeout = error instanceof OpenAI.APIConnectionTimeoutError;
      return new AIClientError(
        `OpenRouter ${isTimeout ? 'connection timeout' : 'connection error'}${elapsedLabel}` +
          `${modelLabel}: ${error.message}`,
        isTimeout ? 'timeout' : 'network_error',
        'openrouter',
        true,
        { cause: error },
      );
    }
    const status = error.status as number;
    const message = error.message;

    // OpenAI SDK exposes OpenRouter's error body via `error.error` (non-public typing).
    // Capture it so we can surface the actual upstream/provider message in step errors.
    const body = (error as unknown as { error?: unknown }).error;
    const bodyObj = body as
      { code?: unknown; message?: unknown; error?: unknown; metadata?: unknown } | undefined;
    const bodyCode = typeof bodyObj?.code === 'string' ? bodyObj.code : undefined;
    const bodyMessage = typeof bodyObj?.message === 'string' ? bodyObj.message : undefined;
    const headers = error.headers as Record<string, string | string[] | undefined> | undefined;
    const requestId =
      (error as unknown as { request_id?: unknown }).request_id &&
      typeof (error as unknown as { request_id?: unknown }).request_id === 'string'
        ? (error as unknown as { request_id?: string }).request_id!
        : typeof headers?.['x-request-id'] === 'string'
          ? headers['x-request-id']
          : typeof headers?.['x-openrouter-request-id'] === 'string'
            ? headers['x-openrouter-request-id']
            : undefined;

    const formatBodySnippet = (): string | undefined => {
      if (!body) return undefined;
      try {
        const s = JSON.stringify(body);
        return s.length > 1200 ? `${s.slice(0, 1200)}…` : s;
      } catch {
        return undefined;
      }
    };
    const bodySnippet = formatBodySnippet();
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
        `OpenRouter authentication failed: ${bodyMessage ?? message}${suffix}`,
        'auth',
        'openrouter',
        false,
        errOpts(),
      );
    }

    if (status === 429) {
      const retryAfter = headers?.['retry-after'];
      const retryAfterStr = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
      const retryAfterMs = retryAfterStr ? parseInt(retryAfterStr, 10) * 1000 : 60000;
      return new AIClientError(
        `OpenRouter rate limited: ${bodyMessage ?? message}${suffix}`,
        'rate_limit',
        'openrouter',
        true,
        errOpts(retryAfterMs),
      );
    }

    if (status === 400) {
      if (message.includes('context') || message.includes('token')) {
        return new AIClientError(
          `OpenRouter context length exceeded: ${bodyMessage ?? message}${suffix}`,
          'context_length',
          'openrouter',
          false,
          errOpts(),
        );
      }
      return new AIClientError(
        `OpenRouter invalid request: ${bodyMessage ?? message}${
          bodySnippet ? ` | body=${bodySnippet}` : ''
        }${suffix}`,
        'invalid_request',
        'openrouter',
        false,
        errOpts(),
      );
    }

    if (status === 404) {
      return new AIClientError(
        `OpenRouter model not found: ${bodyMessage ?? message}${suffix}`,
        'model_not_found',
        'openrouter',
        false,
        errOpts(),
      );
    }

    if (status === 502 || status === 503 || status === 504) {
      return new AIClientError(
        `OpenRouter upstream error: ${bodyMessage ?? message}${suffix}`,
        'provider_error',
        'openrouter',
        true,
        errOpts(),
      );
    }

    return new AIClientError(
      `OpenRouter error: ${bodyMessage ?? message}${suffix}`,
      'provider_error',
      'openrouter',
      status >= 500,
      errOpts(),
    );
  }

  if (error instanceof Error) {
    return new AIClientError(error.message, 'network_error', 'openrouter', true);
  }

  return new AIClientError(String(error), 'provider_error', 'openrouter', false);
}

// ============================================================================
// OpenRouter Adapter
// ============================================================================

/**
 * Create OpenRouter provider adapter.
 */
export function createOpenRouterAdapter(config: OpenRouterConfig): AIProviderAdapter {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? OPENROUTER_BASE_URL,
    maxRetries: config.maxRetries ?? 1,
    timeout: config.timeoutMs ?? 300_000, // 5 min — streaming can be slow; executor-level timeout is the real control
    defaultHeaders: {
      ...(config.siteUrl ? { 'HTTP-Referer': config.siteUrl } : {}),
      ...(config.siteName ? { 'X-Title': config.siteName } : {}),
    },
  });

  /**
   * Normalize model name for OpenRouter.
   * If the model doesn't contain a provider prefix, use it as-is.
   * OpenRouter uses format: provider/model (e.g., "openai/gpt-5", "anthropic/claude-sonnet-4.5")
   */
  function normalizeModel(model: string): string {
    // If it already has openrouter/ prefix, strip it
    if (model.startsWith('openrouter/')) {
      return model.slice('openrouter/'.length);
    }
    return model;
  }

  return {
    provider: 'openrouter',

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
      const startMs = Date.now();
      try {
        const providerBody = buildOpenRouterProviderBody(request.openRouterProvider);
        const reasoningBody = buildOpenRouterReasoningBody(request.reasoning);
        const response = await client.chat.completions.create(
          {
            model: normalizeModel(request.model),
            messages: moveToolImagesToUserMessages(request.messages, 'openrouter').map(
              toOpenAIMessage,
            ),
            ...providerBody,
            ...reasoningBody,
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
          {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          },
        );

        const choice = choicesOrThrow(response, request.model)[0];
        if (!choice) {
          throw new AIClientError(
            'No response from OpenRouter',
            'provider_error',
            'openrouter',
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
          provider: 'openrouter',
          providerRequestId: response.id,
          ...(thinking !== undefined ? { thinking } : {}),
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenRouterError(error, {
          model: request.model,
          signal: request.signal,
          startMs,
        });
      }
    },

    generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse> {
      // Use a deferred promise pattern
      let resolveResponse!: (value: GenerateTextResponse) => void;
      let rejectResponse!: (error: Error) => void;

      const responsePromise = new Promise<GenerateTextResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });

      const stream = (async function* (): AsyncIterable<TextStreamChunk> {
        const _diagStartMs = Date.now();
        let _diagTextLen = 0;
        let _diagToolCount = 0;
        let _diagUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        let _diagModel = request.model;
        let _diagRequestId: string | undefined;
        try {
          const providerBody = buildOpenRouterProviderBody(request.openRouterProvider);
          const reasoningBody = buildOpenRouterReasoningBody(request.reasoning);
          const streamResponse = await client.chat.completions.create(
            {
              model: normalizeModel(request.model),
              messages: moveToolImagesToUserMessages(request.messages, 'openrouter').map(
                toOpenAIMessage,
              ),
              stream: true,
              stream_options: { include_usage: true },
              ...providerBody,
              ...reasoningBody,
              ...(request.tools && request.tools.length > 0
                ? { tools: toOpenAITools(request.tools) }
                : {}),
              ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.stopSequences ? { stop: request.stopSequences } : {}),
            },
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
            _diagRequestId = requestId;
            model = chunk.model;
            _diagModel = model;

            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              _diagTextLen = content.length;
              yield { type: 'text_delta', delta: delta.content };
            }
            // Reasoning chunks — OpenRouter forwards `delta.reasoning` for
            // upstream models that expose chain-of-thought.
            const reasoningDelta = (delta as unknown as { reasoning?: unknown } | undefined)
              ?.reasoning;
            if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
              thinking += reasoningDelta;
              yield { type: 'thinking_delta', delta: reasoningDelta };
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
              _diagUsage = usage;
              yield { type: 'usage', usage };
            }
            _diagToolCount = toolCalls.length;
          }

          if (!sawFinishReason) {
            throw buildStreamTruncationError({
              provider: 'openrouter',
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
            provider: 'openrouter',
            providerRequestId: requestId,
            ...(thinking.length > 0 ? { thinking } : {}),
          });
        } catch (error) {
          const normalized =
            error instanceof AIClientError
              ? error
              : normalizeOpenRouterError(error, {
                  model: request.model,
                  signal: request.signal,
                  startMs: _diagStartMs,
                });
          (normalized as unknown as Record<string, unknown>)['streamDiagnostics'] = {
            model: _diagModel,
            textLength: _diagTextLen,
            toolCallCount: _diagToolCount,
            usage: _diagUsage,
            providerRequestId: _diagRequestId,
            elapsedMs: Date.now() - _diagStartMs,
          };
          rejectResponse(normalized);
          throw normalized;
        }
      })();

      return { stream, response: responsePromise };
    },

    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>> {
      const startMs = Date.now();
      try {
        const providerBody = buildOpenRouterProviderBody(request.openRouterProvider);
        const reasoningBody = buildOpenRouterReasoningBody(request.reasoning);

        // Use structured outputs (json_schema) when a raw JSON Schema is provided.
        // This constrains the model to valid enum values, required fields, etc.
        // Fall back to plain json_object mode when no schema is available.
        const useStructuredOutputs = Boolean(request.rawJsonSchema);
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
          {
            model: normalizeModel(request.model),
            messages: moveToolImagesToUserMessages(request.messages, 'openrouter').map(
              toOpenAIMessage,
            ),
            ...providerBody,
            ...reasoningBody,
            response_format: responseFormat,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          },
          {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          },
        );

        const choice = choicesOrThrow(response, request.model)[0];
        const content = choice == null ? null : (choice.message.content ?? null);

        // Detect output truncation BEFORE parsing — a truncated JSON would
        // otherwise surface as an opaque "invalid JSON" error. Distinguishing
        // here lets callers raise max_tokens or simplify the prompt instead
        // of guessing why the parse failed.
        if (choice?.finish_reason === 'length') {
          const completion = response.usage?.completion_tokens ?? 0;
          const limitLabel = request.maxTokens ? ` of ${request.maxTokens}` : '';
          throw new AIClientError(
            `OpenRouter response truncated at max_tokens (finish_reason='length', completion_tokens=${completion}${limitLabel}, model=${request.model}). ` +
              `Increase max_tokens or simplify the requested output.`,
            'output_truncated',
            'openrouter',
            true,
            { providerRequestId: response.id },
          );
        }

        if (!content) {
          throw new AIClientError(
            'No JSON content returned from OpenRouter',
            'provider_error',
            'openrouter',
            true,
          );
        }

        const thinking = extractThinking(choice?.message);

        let parsedUnknown: unknown;
        try {
          parsedUnknown = parseJsonResponse(content).parsed;
        } catch (err) {
          throw new AIClientError(
            `OpenRouter returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
            'invalid_request',
            'openrouter',
            false,
            { providerRequestId: response.id, cause: err },
          );
        }

        const parsed = request.schema.safeParse(parsedUnknown);
        if (!parsed.success) {
          throw new AIClientError(
            `OpenRouter returned JSON that failed schema validation: ${parsed.error.message}`,
            'invalid_request',
            'openrouter',
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
          provider: 'openrouter',
          providerRequestId: response.id,
          ...(thinking !== undefined ? { thinking } : {}),
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenRouterError(error, {
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
          model: normalizeModel(request.model),
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
          provider: 'openrouter',
          dimensions: response.data[0]?.embedding.length ?? 0,
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenRouterError(error, { model: request.model, startMs });
      }
    },
  };
}
