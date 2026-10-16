/**
 * Ollama provider adapter (Plan 323 D3).
 *
 * Speaks the native `/api/chat` and `/api/embed`, not the OpenAI-compatible
 * `/v1`: only the native API takes a per-request context length, and a local
 * runtime's window is a property of the machine that must be sent every time.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_CONTEXT_TOKENS } from '@aflow/schemas';
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
  AIRequestOptions,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError, buildStreamTruncationError } from '../errors.js';
import { moveToolImagesToUserMessages, toolResultText } from './toolResultContent.js';
import { parseJsonResponse } from './jsonResponseParse.js';
import { MIN_ANSWER_TOKENS, sizePrompt, type PromptSizing } from './ollamaPromptSize.js';
import { localRuntimeClient, servesWithoutLoading } from './ollamaRuntime.js';

interface Fit {
  sizing: PromptSizing;
  /** Tokens the answer may take: what the caller asked for, or what the window has left. */
  numPredict: number;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

interface OllamaTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return moveToolImagesToUserMessages(messages, 'ollama').map((message): OllamaMessage => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user': {
        if (typeof message.content === 'string') return { role: 'user', content: message.content };
        const text: string[] = [];
        const images: string[] = [];
        for (const part of message.content) {
          if (part.type === 'text') text.push(part.text);
          else if (part.source.type === 'base64') images.push(part.source.data);
          else {
            throw new AIClientError(
              'Ollama takes images as bytes, not URLs; the image must be resolved before it is sent.',
              'invalid_request',
              'ollama',
              false,
            );
          }
        }
        return {
          role: 'user',
          content: text.join('\n'),
          ...(images.length > 0 ? { images } : {}),
        };
      }
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content ?? '',
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((tc) => ({
                  function: {
                    name: tc.function.name,
                    arguments: parseArguments(tc.function.arguments),
                  },
                })),
              }
            : {}),
        };
      case 'tool':
        return {
          role: 'tool',
          content: toolResultText(message, 'ollama'),
          ...(message.name ? { tool_name: message.name } : {}),
        };
      default: {
        const exhaustive: never = message;
        throw new Error(`Unknown message role: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
}

/** Ollama carries tool arguments as an object; the platform carries them as JSON text. */
function parseArguments(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toOllamaTools(tools: ToolDefinition[] | undefined): OllamaTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters,
    },
  }));
}

function fromOllamaToolCalls(
  calls: NonNullable<OllamaChatChunk['message']>['tool_calls'],
  offset: number,
): ToolCall[] {
  return (calls ?? []).map((call, i) => ({
    id: call.id ?? `call_${offset + i}`,
    type: 'function',
    function: {
      name: call.function?.name ?? '',
      arguments:
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? {}),
    },
  }));
}

function toFinishReason(doneReason: string | undefined, toolCalls: number): FinishReason {
  if (toolCalls > 0) return 'tool_calls';
  return doneReason === 'length' ? 'length' : 'stop';
}

function toUsage(chunk: OllamaChatChunk): TokenUsage {
  const promptTokens = chunk.prompt_eval_count ?? 0;
  const completionTokens = chunk.eval_count ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * `think` takes `false`, `true` or a level. A model whose only levels are
 * on and off treats any level as on (§9 G1), so an effort above `off` is
 * passed as the level and every model reads it.
 */
function thinkFor(reasoning: AIRequestOptions['reasoning']): boolean | string | undefined {
  const effort = reasoning?.effort;
  if (effort === undefined) return undefined;
  return effort === 'off' ? false : effort;
}

function isPlatformTimeoutAbort(signal: AbortSignal | undefined): { timeoutMs: number } | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason as { marker?: unknown; timeoutMs?: unknown } | undefined;
  if (reason?.marker === 'phoenix.executor.timeout' && typeof reason.timeoutMs === 'number') {
    return { timeoutMs: reason.timeoutMs };
  }
  return null;
}

export function normalizeOllamaError(
  error: unknown,
  ctx: { baseUrl: string; model?: string; signal?: AbortSignal | undefined },
): AIClientError {
  if (error instanceof AIClientError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    const platformTimeout = isPlatformTimeoutAbort(ctx.signal);
    return new AIClientError(
      platformTimeout
        ? `Platform timeout exceeded after ${platformTimeout.timeoutMs}ms (provider=ollama model=${ctx.model ?? 'unknown'}).`
        : `Ollama request aborted (model=${ctx.model ?? 'unknown'}).`,
      'timeout',
      'ollama',
      true,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AIClientError(
    `Ollama is not reachable at ${ctx.baseUrl}: ${message}. Start Ollama on this computer, or correct its URL in Settings → Credentials.`,
    'network_error',
    'ollama',
    true,
    { cause: error },
  );
}

async function httpError(res: Response, model: string): Promise<AIClientError> {
  const body = await res.text().catch(() => '');
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    // The body was not JSON; report it as text.
  }
  if (res.status === 404) {
    return new AIClientError(
      `Ollama has no model ${model} (${detail}). Download it on this computer first: ollama pull ${model}`,
      'model_not_found',
      'ollama',
      false,
      { providerErrorCode: String(res.status) },
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new AIClientError(`Ollama refused the token: ${detail}`, 'auth', 'ollama', false, {
      providerErrorCode: String(res.status),
    });
  }
  return new AIClientError(
    `Ollama error ${res.status}: ${detail}`,
    res.status >= 500 ? 'provider_error' : 'invalid_request',
    'ollama',
    res.status >= 500 && res.status !== 501,
    { providerErrorCode: String(res.status) },
  );
}

const STRUCTURED_OUTPUT_UNAVAILABLE = 'structured output is unavailable';

export function createOllamaAdapter(config: ProviderConfig): AIProviderAdapter {
  const baseUrl = (config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
  // Models whose runner refuses `format` (the MLX runner refuses it outright,
  // §9 G1). Learned from the runtime's own answer rather than written down, so
  // a runner that gains structured output is used the moment it does.
  const refusesFormat = new Set<string>();
  const runtime = localRuntimeClient(config);

  function windowFor(request: AIRequestOptions): number {
    return request.contextWindow ?? config.contextTokens ?? OLLAMA_DEFAULT_CONTEXT_TOKENS;
  }

  function chatBody(
    request: GenerateTextRequest | GenerateJsonRequest,
    messages: OllamaMessage[],
    extra: {
      stream: boolean;
      tools?: OllamaTool[] | undefined;
      format?: unknown;
      numPredict?: number;
    },
  ): Record<string, unknown> {
    const think = thinkFor(request.reasoning);
    return {
      model: request.model,
      messages,
      stream: extra.stream,
      ...(extra.tools ? { tools: extra.tools } : {}),
      ...(extra.format !== undefined ? { format: extra.format } : {}),
      ...(think !== undefined ? { think } : {}),
      ...(config.keepAlive ? { keep_alive: config.keepAlive } : {}),
      options: {
        num_ctx: windowFor(request),
        ...(extra.numPredict !== undefined
          ? { num_predict: extra.numPredict }
          : request.maxTokens
            ? { num_predict: request.maxTokens }
            : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.stopSequences ? { stop: request.stopSequences } : {}),
      },
    };
  }

  async function post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  async function chatOnce(
    body: Record<string, unknown>,
    request: AIRequestOptions,
  ): Promise<OllamaChatChunk> {
    let res: Response;
    try {
      res = await post('/api/chat', body, request.signal);
    } catch (error) {
      throw normalizeOllamaError(error, { baseUrl, model: request.model, signal: request.signal });
    }
    if (!res.ok) throw await httpError(res, request.model);
    const chunk = (await res.json()) as OllamaChatChunk;
    if (chunk.error)
      throw new AIClientError(`Ollama error: ${chunk.error}`, 'provider_error', 'ollama', true);
    return chunk;
  }

  /**
   * A load otherwise happens inside the request's own prefill, where nothing
   * tells it apart from reading the prompt. Loading first, at the window the
   * request uses so it does not load again, is what lets a caller say which
   * silent stretch it is in. Asked only by a caller that listens, since it
   * costs a status read. A load that fails is left for the request itself to
   * report, in the words it would have used anyway.
   */
  async function reportPhases(request: GenerateTextRequest | GenerateJsonRequest): Promise<void> {
    const report = request.onRuntimePhase;
    if (!report) return;
    const window = windowFor(request);
    const loaded = await runtime.loaded();
    if (loaded !== null && !servesWithoutLoading(loaded, request.model, window)) {
      report({ phase: 'loading_model' });
      try {
        await runtime.warm(request.model, window, request.signal);
      } catch (error) {
        if (request.signal?.aborted) {
          throw normalizeOllamaError(error, {
            baseUrl,
            model: request.model,
            signal: request.signal,
          });
        }
      }
      request.onStreamProgress?.();
    }
    report({ phase: 'reading_prompt' });
  }

  /**
   * Plan 323 D5: a request is sent only once it is known to fit. A prompt
   * whose conservative size fits is sent as is; any other is counted exactly
   * by a one-token evaluation, whose prefix the real request then reads from
   * the runtime's cache.
   */
  async function ensureFits(
    request: GenerateTextRequest | GenerateJsonRequest,
    messages: OllamaMessage[],
    tools: OllamaTool[] | undefined,
  ): Promise<Fit> {
    await reportPhases(request);
    const window = windowFor(request);
    const requested = request.maxTokens ?? MIN_ANSWER_TOKENS;
    const sizing = sizePrompt(messages, tools);
    if (!sizing.needsExactCount && sizing.conservativeTokens + requested <= window) {
      return { sizing, numPredict: requested };
    }
    const counted = await chatOnce(
      chatBody(request, messages, { stream: false, tools, numPredict: 1 }),
      request,
    );
    const exact = counted.prompt_eval_count ?? 0;
    // A counted prompt below the floor is one the runtime cut while counting.
    const promptTokens = exact < sizing.lowerBoundTokens ? sizing.lowerBoundTokens : exact;
    const room = window - promptTokens;
    if (exact < sizing.lowerBoundTokens || room < Math.min(requested, MIN_ANSWER_TOKENS)) {
      throw contextExceeded(request.model, {
        promptTokens,
        atLeast: exact < sizing.lowerBoundTokens,
        reserve: Math.min(requested, MIN_ANSWER_TOKENS),
        window,
      });
    }
    // The answer gets what the window has left, so prompt and answer together
    // never pass it — a runner that enforces the window cuts there, and one
    // that does not spends memory nothing accounted for.
    return { sizing, numPredict: Math.min(requested, room) };
  }

  /** The runtime evaluated fewer tokens than the prompt can possibly hold: it truncated. */
  function assertNotTruncated(
    sizing: PromptSizing,
    chunk: OllamaChatChunk,
    request: AIRequestOptions,
  ): void {
    const evaluated = chunk.prompt_eval_count;
    if (evaluated !== undefined && evaluated < sizing.lowerBoundTokens) {
      throw new AIClientError(
        `Ollama read ${evaluated} tokens of a prompt that holds at least ${sizing.lowerBoundTokens}: the runtime cut it to fit its window, and the answer was discarded (model=${request.model}, window=${windowFor(request)}). ` +
          'Raise the context window on the Ollama connection if memory allows, or let the conversation compact.',
        'context_length',
        'ollama',
        false,
        { providerErrorCode: 'context_exceeded' },
      );
    }
  }

  async function generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    const messages = toOllamaMessages(request.messages);
    const tools = toOllamaTools(request.tools);
    const fit = await ensureFits(request, messages, tools);
    const chunk = await chatOnce(
      chatBody(request, messages, { stream: false, tools, numPredict: fit.numPredict }),
      request,
    );
    assertNotTruncated(fit.sizing, chunk, request);
    const toolCalls = fromOllamaToolCalls(chunk.message?.tool_calls, 0);
    const thinking = chunk.message?.thinking;
    return {
      content: chunk.message?.content || null,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: toFinishReason(chunk.done_reason, toolCalls.length),
      usage: toUsage(chunk),
      model: chunk.model ?? request.model,
      provider: 'ollama',
      ...(thinking ? { thinking } : {}),
    };
  }

  return {
    provider: 'ollama',

    generateText,

    generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse> {
      let resolveResponse!: (value: GenerateTextResponse) => void;
      let rejectResponse!: (error: Error) => void;
      const response = new Promise<GenerateTextResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });

      const stream = (async function* (): AsyncIterable<TextStreamChunk> {
        const startMs = Date.now();
        try {
          const messages = toOllamaMessages(request.messages);
          const tools = toOllamaTools(request.tools);
          const fit = await ensureFits(request, messages, tools);
          let res: Response;
          try {
            res = await post(
              '/api/chat',
              chatBody(request, messages, { stream: true, tools, numPredict: fit.numPredict }),
              request.signal,
            );
          } catch (error) {
            throw normalizeOllamaError(error, {
              baseUrl,
              model: request.model,
              signal: request.signal,
            });
          }
          if (!res.ok || !res.body) throw await httpError(res, request.model);

          let content = '';
          let thinking = '';
          const toolCalls: ToolCall[] = [];
          let final: OllamaChatChunk | undefined;
          const decoder = new TextDecoder();
          let buffer = '';
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              const chunk = JSON.parse(line) as OllamaChatChunk;
              request.onStreamProgress?.();
              if (chunk.error) {
                throw new AIClientError(
                  `Ollama error: ${chunk.error}`,
                  'provider_error',
                  'ollama',
                  true,
                );
              }
              const delta = chunk.message;
              if (delta?.thinking) {
                thinking += delta.thinking;
                yield { type: 'thinking_delta', delta: delta.thinking };
              }
              if (delta?.content) {
                content += delta.content;
                yield { type: 'text_delta', delta: delta.content };
              }
              if (delta?.tool_calls && delta.tool_calls.length > 0) {
                // A tool call arrives whole in one chunk rather than as argument deltas.
                for (const call of fromOllamaToolCalls(delta.tool_calls, toolCalls.length)) {
                  toolCalls.push(call);
                  yield {
                    type: 'tool_call_delta',
                    toolCallId: call.id,
                    toolCallName: call.function.name,
                    toolCallArguments: call.function.arguments,
                  };
                }
              }
              if (chunk.done) final = chunk;
            }
          }

          if (!final) {
            throw buildStreamTruncationError({
              provider: 'ollama',
              model: request.model,
              signal: request.signal,
              startMs,
              accumulatedChars: content.length,
              toolCallCount: toolCalls.length,
            });
          }
          assertNotTruncated(fit.sizing, final, request);
          const usage = toUsage(final);
          const finishReason = toFinishReason(final.done_reason, toolCalls.length);
          yield { type: 'usage', usage };
          yield { type: 'done', finishReason };
          resolveResponse({
            content: content || null,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            finishReason,
            usage,
            model: final.model ?? request.model,
            provider: 'ollama',
            ...(thinking ? { thinking } : {}),
          });
        } catch (error) {
          const normalized = normalizeOllamaError(error, {
            baseUrl,
            model: request.model,
            signal: request.signal,
          });
          rejectResponse(normalized);
          throw normalized;
        }
      })();

      return { stream, response };
    },

    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>> {
      const schema =
        request.rawJsonSchema ??
        (zodToJsonSchema(request.schema, { $refStrategy: 'none' }) as Record<string, unknown>);
      const messages = toOllamaMessages(request.messages);

      let chunk: OllamaChatChunk | undefined;
      let rawContent: string | undefined;
      if (!refusesFormat.has(request.model)) {
        try {
          const fit = await ensureFits(request, messages, undefined);
          chunk = await chatOnce(
            chatBody(request, messages, {
              stream: false,
              format: schema,
              numPredict: fit.numPredict,
            }),
            request,
          );
          assertNotTruncated(fit.sizing, chunk, request);
          rawContent = chunk.message?.content ?? '';
        } catch (error) {
          if (!(
            error instanceof AIClientError && error.message.includes(STRUCTURED_OUTPUT_UNAVAILABLE)
          )) {
            throw error;
          }
          refusesFormat.add(request.model);
        }
      }
      if (rawContent === undefined) {
        // The runner cannot constrain output, so the schema rides a tool, as
        // the Anthropic adapter carries it: the model fills the tool's
        // arguments, and those are the response.
        const toolName = request.schemaName ?? 'response';
        const tools: OllamaTool[] = [
          {
            type: 'function',
            function: {
              name: toolName,
              description: request.schemaDescription ?? 'Structured response output',
              parameters: schema,
            },
          },
        ];
        const withInstruction: OllamaMessage[] = [
          ...messages,
          {
            role: 'system',
            content: `Respond by calling the "${toolName}" tool. Do not answer outside the tool call.`,
          },
        ];
        const fit = await ensureFits(request, withInstruction, tools);
        chunk = await chatOnce(
          chatBody(request, withInstruction, { stream: false, tools, numPredict: fit.numPredict }),
          request,
        );
        assertNotTruncated(fit.sizing, chunk, request);
        const call = chunk.message?.tool_calls?.find((c) => c.function?.name === toolName);
        rawContent =
          call !== undefined
            ? typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {})
            : (chunk.message?.content ?? '');
      }

      if (chunk?.done_reason === 'length') {
        throw new AIClientError(
          `Ollama response truncated at the output limit (done_reason='length', eval_count=${chunk.eval_count ?? 0}, model=${request.model}). Increase maxTokens or simplify the requested output.`,
          'output_truncated',
          'ollama',
          true,
        );
      }
      let parsedUnknown: unknown;
      try {
        parsedUnknown = parseJsonResponse(rawContent).parsed;
      } catch (err) {
        throw new AIClientError(
          `Ollama returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          'invalid_request',
          'ollama',
          false,
          { cause: err },
        );
      }
      const parsed = request.schema.safeParse(parsedUnknown);
      if (!parsed.success) {
        throw new AIClientError(
          `Ollama returned JSON that failed schema validation: ${parsed.error.message}`,
          'invalid_request',
          'ollama',
          false,
          { cause: parsed.error },
        );
      }
      const thinking = chunk?.message?.thinking;
      return {
        data: parsed.data,
        rawContent,
        finishReason: 'stop',
        usage: chunk ? toUsage(chunk) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: chunk?.model ?? request.model,
        provider: 'ollama',
        ...(thinking ? { thinking } : {}),
      };
    },

    async generateEmbedding(request: GenerateEmbeddingRequest): Promise<GenerateEmbeddingResponse> {
      let res: Response;
      try {
        res = await post(
          '/api/embed',
          {
            model: request.model,
            input: request.input,
            // The runtime's default cuts an over-long input to its window
            // without a word (§9 G4); refusing it lets the chunker split it.
            truncate: false,
            ...(request.dimensions ? { dimensions: request.dimensions } : {}),
            ...(config.keepAlive ? { keep_alive: config.keepAlive } : {}),
          },
          request.signal,
        );
      } catch (error) {
        throw normalizeOllamaError(error, {
          baseUrl,
          model: request.model,
          signal: request.signal,
        });
      }
      if (!res.ok) throw await httpError(res, request.model);
      const body = (await res.json()) as {
        embeddings: number[][];
        model?: string;
        prompt_eval_count?: number;
      };
      const promptTokens = body.prompt_eval_count ?? 0;
      return {
        embeddings: body.embeddings,
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
        model: body.model ?? request.model,
        provider: 'ollama',
        dimensions: body.embeddings[0]?.length ?? 0,
      };
    },
  };
}

function contextExceeded(
  model: string,
  size: { promptTokens: number; atLeast: boolean; reserve: number; window: number },
): AIClientError {
  const prompt = `${size.atLeast ? 'at least ' : ''}${size.promptTokens} prompt tokens`;
  return new AIClientError(
    `The prompt does not fit this computer's context window: ${prompt} plus ${size.reserve} reserved for the answer exceed the ${size.window}-token window (model=${model}). ` +
      'Raise the context window on the Ollama connection if memory allows, or let the conversation compact.',
    'context_length',
    'ollama',
    false,
    { providerErrorCode: 'context_exceeded' },
  );
}
