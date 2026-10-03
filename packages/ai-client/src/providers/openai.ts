/**
 * OpenAI provider adapter.
 *
 * Uses the Responses API (recommended for new development) for text generation,
 * with fallback to Chat Completions for specific use cases.
 */
import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ImageGenerateParams,
  ImageEditParams,
} from 'openai/resources';
import { zodResponseFormat } from 'openai/helpers/zod';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateEmbeddingRequest,
  GenerateEmbeddingResponse,
  GenerateImageRequest,
  GenerateImageResponse,
  EditImageRequest,
  GenerateVideoRequest,
  PollVideoJobRequest,
  VideoJobHandle,
  VideoJobPoll,
  StreamingResponse,
  ProviderConfig,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  TextStreamChunk,
  TokenUsage,
  FinishReason,
  ReasoningConfig,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import type { AsyncReplayGuarantee } from '@aflow/schemas';
import { AIClientError, buildStreamTruncationError, normalizeOpenAIError } from '../errors.js';
import { moveToolImagesToUserMessages, toolResultText } from './toolResultContent.js';
import { refuseImageReferences } from './imageReferences.js';
import { parseJsonResponse } from './jsonResponseParse.js';
import {
  captureResponsesReasoning,
  replayedReasoningItems,
  type ResponsesReasoningProvider,
} from './responsesReasoning.js';

// ============================================================================
// Responses API Input Conversion
// ============================================================================

type ResponsesInputItem = OpenAI.Responses.ResponseInputItem;

/**
 * Convert our ChatMessage array to Responses API input format.
 * Extracts system message as instructions and converts other messages to input items.
 */
function toResponsesInput(
  messages: ChatMessage[],
  retainResponsesReasoning?: ResponsesReasoningProvider,
): {
  instructions: string | undefined;
  input: ResponsesInputItem[];
} {
  const systemBlocks: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const message of moveToolImagesToUserMessages(messages, 'openai')) {
    switch (message.role) {
      case 'system':
        // Every system block, joined — an agent turn sends several (instructions,
        // then context, then any cleared-history summary), and keeping only one
        // drops the agent's instructions on the floor. Matches how the Gemini
        // adapter builds its systemInstruction.
        systemBlocks.push(message.content);
        break;

      case 'user': {
        if (typeof message.content === 'string') {
          input.push({
            type: 'message',
            role: 'user',
            content: message.content,
          });
        } else {
          // Multi-modal content
          const content: OpenAI.Responses.ResponseInputContent[] = message.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'input_text' as const, text: part.text };
            }
            // Image
            if (part.source.type === 'url') {
              return {
                type: 'input_image' as const,
                image_url: part.source.url,
                detail: 'auto' as const,
              };
            }
            // Base64 image
            return {
              type: 'input_image' as const,
              image_url: `data:${part.source.mediaType};base64,${part.source.data}`,
              detail: 'auto' as const,
            };
          });
          input.push({
            type: 'message',
            role: 'user',
            content,
          });
        }
        break;
      }

      case 'assistant': {
        // Before the visible answer and its tool calls, so the model continues
        // the same thought instead of re-deriving it on the next turn.
        input.push(...replayedReasoningItems(message, retainResponsesReasoning));
        if (message.toolCalls && message.toolCalls.length > 0) {
          // Assistant with tool calls - include both message and tool call items
          if (message.content) {
            input.push({
              type: 'message',
              role: 'assistant',
              content: message.content,
            });
          }
          for (const tc of message.toolCalls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        } else {
          input.push({
            type: 'message',
            role: 'assistant',
            content: message.content ?? '',
          });
        }
        break;
      }

      case 'tool':
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: toolResultText(message, 'openai'),
        });
        break;
    }
  }

  return {
    instructions: systemBlocks.length > 0 ? systemBlocks.join('\n\n') : undefined,
    input,
  };
}

/**
 * Convert our ToolDefinition to Responses API function tool format.
 *
 * Not strict. Strict mode requires `additionalProperties: false` and every
 * property listed in `required`, and agent tool schemas are passed through from
 * operation inputs that legitimately have optional fields — `pause_for_input`
 * alone would 400. Enabling it would mean rewriting caller schemas to make
 * optional parameters required, which changes what the tools mean.
 */
function toResponsesTool(tool: ToolDefinition): OpenAI.Responses.Tool {
  return {
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters,
    strict: false,
  };
}

/**
 * Extract tool calls from Responses API output items.
 */
function extractToolCalls(output: OpenAI.Responses.ResponseOutputItem[]): ToolCall[] | undefined {
  const toolCalls: ToolCall[] = [];

  for (const item of output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function' as const,
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    }
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

/**
 * Extract text content from Responses API output items.
 */
function extractTextContent(output: OpenAI.Responses.ResponseOutputItem[]): string | null {
  const textParts: string[] = [];

  for (const item of output) {
    if (item.type === 'message') {
      for (const content of item.content) {
        if (content.type === 'output_text') {
          textParts.push(content.text);
        }
      }
    }
  }

  return textParts.length > 0 ? textParts.join('') : null;
}

/**
 * Read token usage off a Responses result, including the cache and reasoning
 * breakdowns the billing surfaces depend on.
 */
function toResponsesUsage(usage: OpenAI.Responses.ResponseUsage | undefined): TokenUsage {
  if (!usage) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const cached = usage.input_tokens_details.cached_tokens;
  const reasoning = usage.output_tokens_details.reasoning_tokens;

  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(cached > 0
      ? { cacheReadTokens: cached, uncachedPromptTokens: usage.input_tokens - cached }
      : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * The Responses API has no stop-sequence parameter, and this adapter speaks
 * only Responses. Refusing is the honest answer: accepting the request would
 * return text that ignores a boundary the caller asked for.
 */
function rejectUnsupportedStopSequences(request: { stopSequences?: string[] | undefined }): void {
  if (request.stopSequences && request.stopSequences.length > 0) {
    throw new AIClientError(
      'The Responses API has no stop parameter, so stopSequences cannot be applied. ' +
        'Remove stopSequences, or choose an Anthropic, Google, or Fireworks model.',
      'invalid_request',
      'openai',
      false,
    );
  }
}

/**
 * Convert Responses API status to finish reason.
 */
function fromResponsesStatus(status: string): FinishReason {
  switch (status) {
    case 'completed':
      return 'stop';
    case 'failed':
      return 'error';
    case 'incomplete':
      return 'length';
    default:
      return 'stop';
  }
}

/**
 * Read the decision out of a terminal response.
 *
 * A response cut short by `max_output_tokens` can carry a half-written
 * `function_call` item. Neither half of that is safe to pass on: the finish
 * reason must stay `length`, and the partial calls must not be returned at all.
 * Labelling alone is not enough, because the callers that matter branch on
 * `toolCalls` rather than on the finish reason — the agent's own truncation
 * retry only fires when no calls came back, so a truncated call would be
 * executed with whatever arguments happened to arrive.
 */
function readResponsesOutcome(
  status: string | undefined,
  output: OpenAI.Responses.ResponseOutputItem[],
): { finishReason: FinishReason; toolCalls: ToolCall[] | undefined } {
  const fromStatus = fromResponsesStatus(status ?? 'completed');
  if (fromStatus !== 'stop') return { finishReason: fromStatus, toolCalls: undefined };

  const toolCalls = extractToolCalls(output);
  return {
    finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : fromStatus,
    toolCalls,
  };
}

// ============================================================================
// Chat Completions Message Conversion (for legacy/fallback)
// ============================================================================

type OpenAIMessage = OpenAI.ChatCompletionMessageParam;

/**
 * Convert our ChatMessage to OpenAI Chat Completions format.
 */
function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };

    case 'user': {
      if (typeof message.content === 'string') {
        return { role: 'user', content: message.content };
      }
      // Multi-modal content
      const parts: OpenAI.ChatCompletionContentPart[] = message.content.map((part) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        // Image
        if (part.source.type === 'url') {
          return {
            type: 'image_url' as const,
            image_url: { url: part.source.url },
          };
        }
        // Base64 image
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
        content: toolResultText(message, 'openai'),
      };
  }
}

/**
 * Convert OpenAI finish reason to our format.
 */
function fromOpenAIFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
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

// ============================================================================
// OpenAI Adapter Implementation
// ============================================================================

/**
 * Normalize a JSON Schema for OpenAI strict structured outputs.
 * OpenAI requires: additionalProperties: false on all object types,
 * and all properties must be listed in "required".
 */
function normalizeJsonSchemaForOpenAI(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };

  if (result['type'] === 'object') {
    result['additionalProperties'] = false;

    // Ensure all properties are in "required"
    const props = result['properties'] as Record<string, unknown> | undefined;
    if (props) {
      result['required'] = Object.keys(props);

      // Recursively normalize nested object schemas
      const normalizedProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value && typeof value === 'object') {
          normalizedProps[key] = normalizeJsonSchemaForOpenAI(value as Record<string, unknown>);
        } else {
          normalizedProps[key] = value;
        }
      }
      result['properties'] = normalizedProps;
    }
  }

  // Handle arrays with object items
  if (result['type'] === 'array') {
    const items = result['items'] as Record<string, unknown> | undefined;
    if (items && typeof items === 'object') {
      result['items'] = normalizeJsonSchemaForOpenAI(items);
    }
  }

  return result;
}

/**
 * Map Phoenix reasoning effort to OpenAI's reasoning-effort scale.
 *
 * gpt-5.x reasoning models accept `none | low | medium | high`. `off` → `none`
 * (no reasoning performed). Returns undefined when no reasoning config is
 * supplied, leaving the model's own default. The client forwards a reasoning
 * config only for models whose catalog profile accepts the resolved effort.
 */
export function mapOpenAiReasoningEffort(
  reasoning: ReasoningConfig | undefined,
): 'none' | 'low' | 'medium' | 'high' | undefined {
  const effort = reasoning?.effort;
  if (effort === 'off') return 'none';
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return undefined;
}

/**
 * Create an OpenAI provider adapter.
 */
export function createOpenAIAdapter(
  config: ProviderConfig,
  options?: { retainResponsesReasoning?: ResponsesReasoningProvider },
): AIProviderAdapter {
  const retainResponsesReasoning = options?.retainResponsesReasoning;
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    organization: config.organization,
    project: config.project,
    maxRetries: config.maxRetries ?? 1,
    timeout: config.timeoutMs ?? 300_000, // 5 min — streaming can be slow; executor-level timeout is the real control
  });

  return {
    provider: 'openai',

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
      try {
        rejectUnsupportedStopSequences(request);
        const { instructions, input } = toResponsesInput(
          request.messages,
          retainResponsesReasoning,
        );

        const params: OpenAI.Responses.ResponseCreateParams = {
          model: request.model,
          input,
          store: false, // Don't store responses by default
        };

        if (instructions) {
          params.instructions = instructions;
        }
        if (request.maxTokens !== undefined) {
          params.max_output_tokens = request.maxTokens;
        }
        if (request.temperature !== undefined) {
          params.temperature = request.temperature;
        }
        const oaEffort = mapOpenAiReasoningEffort(request.reasoning);
        if (oaEffort) {
          params.reasoning = { effort: oaEffort };
        }

        if (request.tools && request.tools.length > 0) {
          params.tools = request.tools.map(toResponsesTool);
          if (request.toolChoice) {
            if (typeof request.toolChoice === 'string') {
              params.tool_choice = request.toolChoice;
            } else {
              params.tool_choice = {
                type: 'function' as const,
                name: request.toolChoice.function.name,
              };
            }
          }
        }

        const response = (await client.responses.create(params, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        })) as OpenAI.Responses.Response;

        // Check for API-level error
        if (response.status === 'failed' && response.error) {
          throw new AIClientError(response.error.message, 'provider_error', 'openai', false);
        }

        const content = extractTextContent(response.output);
        const { finishReason, toolCalls } = readResponsesOutcome(response.status, response.output);
        const providerReasoning = captureResponsesReasoning(
          response.output,
          retainResponsesReasoning,
          response.model,
        );

        return {
          content,
          toolCalls,
          finishReason,
          usage: toResponsesUsage(response.usage),
          model: response.model,
          provider: 'openai',
          providerRequestId: response.id,
          ...(providerReasoning ? { providerReasoning } : {}),
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenAIError(error);
      }
    },

    generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse> {
      let resolveResponse!: (response: GenerateTextResponse) => void;
      let rejectResponse!: (error: Error) => void;

      const responsePromise = new Promise<GenerateTextResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });

      const streamGenerator = async function* (): AsyncGenerator<TextStreamChunk> {
        let _diagTextLen = 0;
        let _diagUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        let _diagRequestId: string | undefined;
        try {
          rejectUnsupportedStopSequences(request);
          const { instructions, input } = toResponsesInput(
            request.messages,
            retainResponsesReasoning,
          );

          const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
            model: request.model,
            input,
            stream: true,
            store: false,
          };

          if (instructions) {
            params.instructions = instructions;
          }
          if (request.maxTokens !== undefined) {
            params.max_output_tokens = request.maxTokens;
          }
          if (request.temperature !== undefined) {
            params.temperature = request.temperature;
          }
          const oaEffort = mapOpenAiReasoningEffort(request.reasoning);
          if (oaEffort) {
            params.reasoning = { effort: oaEffort };
          }

          if (request.tools && request.tools.length > 0) {
            params.tools = request.tools.map(toResponsesTool);
            if (request.toolChoice) {
              params.tool_choice =
                typeof request.toolChoice === 'string'
                  ? request.toolChoice
                  : { type: 'function' as const, name: request.toolChoice.function.name };
            }
          }

          const stream = await client.responses.create(params, {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          });

          let content = '';
          let toolCallCount = 0;
          let finished: OpenAI.Responses.Response | undefined;
          let usage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          };
          let providerRequestId: string | undefined;
          const streamStartMs = Date.now();

          for await (const event of stream) {
            request.onStreamProgress?.();

            if (event.type === 'response.created') {
              providerRequestId = event.response.id;
              _diagRequestId = providerRequestId;
            } else if (event.type === 'response.output_text.delta') {
              content += event.delta;
              _diagTextLen = content.length;
              yield { type: 'text_delta', delta: event.delta };
            } else if (event.type === 'response.output_item.added') {
              // The call id and name arrive whole on the item and never repeat;
              // only the arguments stream. This is the one chance to surface them.
              if (event.item.type === 'function_call') {
                toolCallCount += 1;
                yield {
                  type: 'tool_call_delta',
                  toolCallId: event.item.call_id,
                  toolCallName: event.item.name,
                };
              }
            } else if (event.type === 'response.function_call_arguments.delta') {
              yield { type: 'tool_call_delta', toolCallArguments: event.delta };
            } else if (
              event.type === 'response.completed' ||
              event.type === 'response.incomplete'
            ) {
              finished = event.response;
            } else if (event.type === 'response.failed') {
              throw new AIClientError(
                event.response.error?.message ?? 'OpenAI response failed',
                'provider_error',
                'openai',
                false,
              );
            }
          }

          // A terminal event carries the assembled output; without one the
          // stream ended early and the text so far is not a complete answer.
          if (!finished) {
            throw buildStreamTruncationError({
              provider: 'openai',
              model: request.model,
              signal: request.signal,
              startMs: streamStartMs,
              accumulatedChars: content.length,
              toolCallCount,
            });
          }

          usage = toResponsesUsage(finished.usage);
          _diagUsage = usage;
          yield { type: 'usage', usage };

          const { finishReason, toolCalls } = readResponsesOutcome(
            finished.status,
            finished.output,
          );
          const providerReasoning = captureResponsesReasoning(
            finished.output,
            retainResponsesReasoning,
            finished.model || request.model,
          );

          yield { type: 'done', finishReason };

          resolveResponse({
            content: extractTextContent(finished.output),
            ...(toolCalls ? { toolCalls } : {}),
            finishReason,
            usage,
            model: finished.model || request.model,
            provider: 'openai',
            providerRequestId: finished.id || providerRequestId,
            ...(providerReasoning ? { providerReasoning } : {}),
          });
        } catch (error) {
          const normalizedError =
            error instanceof AIClientError ? error : normalizeOpenAIError(error);
          (normalizedError as unknown as Record<string, unknown>)['streamDiagnostics'] = {
            model: request.model,
            textLength: _diagTextLen,
            usage: _diagUsage,
            providerRequestId: _diagRequestId,
          };
          rejectResponse(normalizedError);
          throw normalizedError;
        }
      };

      return {
        stream: streamGenerator(),
        response: responsePromise,
      };
    },

    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>> {
      try {
        const messages = moveToolImagesToUserMessages(request.messages, 'openai').map(
          toOpenAIMessage,
        );

        // When rawJsonSchema is provided, use it directly instead of converting from Zod.
        // This supports cases where the caller has a JSON Schema (e.g., from user input)
        // rather than a Zod schema.
        const useStrict = request.strictJsonSchema !== false;
        const responseFormat = request.rawJsonSchema
          ? {
              type: 'json_schema' as const,
              json_schema: {
                name: request.schemaName ?? 'response',
                strict: useStrict,
                schema: useStrict
                  ? normalizeJsonSchemaForOpenAI(request.rawJsonSchema)
                  : request.rawJsonSchema,
              },
            }
          : zodResponseFormat(request.schema, request.schemaName ?? 'response');

        // Use Chat Completions API with structured outputs
        // When using rawJsonSchema, use regular completions.create instead of beta.parse
        // because beta.parse requires a Zod schema for type-safe parsing.
        if (request.rawJsonSchema) {
          const params = {
            model: request.model,
            messages,
            response_format:
              responseFormat as ChatCompletionCreateParamsNonStreaming['response_format'],
          } as ChatCompletionCreateParamsNonStreaming;
          if (request.maxTokens !== undefined) {
            params.max_completion_tokens = request.maxTokens;
          }
          if (request.temperature !== undefined) {
            params.temperature = request.temperature;
          }

          const response = await client.chat.completions.create(params, {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          });
          const firstChoice = response.choices[0];
          const rawJsonContent = firstChoice?.message.content;
          if (firstChoice == null || rawJsonContent == null) {
            throw new AIClientError(
              'No completion choice returned',
              'provider_error',
              'openai',
              false,
            );
          }

          let parsed: T;
          try {
            parsed = parseJsonResponse<T>(rawJsonContent).parsed;
          } catch (err) {
            throw new AIClientError(
              `OpenAI returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
              'invalid_request',
              'openai',
              false,
              { providerRequestId: response.id, cause: err },
            );
          }
          return {
            data: parsed,
            rawContent: rawJsonContent,
            usage: {
              promptTokens: response.usage?.prompt_tokens ?? 0,
              completionTokens: response.usage?.completion_tokens ?? 0,
              totalTokens: response.usage?.total_tokens ?? 0,
            },
            model: response.model,
            finishReason: firstChoice.finish_reason as FinishReason,
            provider: 'openai' as const,
          };
        }

        // Standard Zod-based path using parse for type-safe parsing.
        // openai v6 removed the `beta.chat.completions` namespace — `.parse` is
        // now on `chat.completions` directly.
        const parseParams: Parameters<typeof client.chat.completions.parse>[0] = {
          model: request.model,
          messages,
          response_format: responseFormat as ReturnType<typeof zodResponseFormat>,
        };

        if (request.maxTokens !== undefined) {
          parseParams.max_completion_tokens = request.maxTokens;
        }
        if (request.temperature !== undefined) {
          parseParams.temperature = request.temperature;
        }

        const response = await client.chat.completions.parse(parseParams, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        });

        const choice = response.choices[0];
        if (!choice) {
          throw new AIClientError(
            'No completion choice returned',
            'provider_error',
            'openai',
            false,
          );
        }

        // The parsed property contains the validated response
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- SDK types are incomplete
        if (!('parsed' in choice.message) || choice.message.parsed === null) {
          throw new AIClientError(
            'Failed to parse JSON response',
            'invalid_request',
            'openai',
            false,
          );
        }

        return {
          data: choice.message.parsed as T,
          rawContent: choice.message.content ?? '',
          finishReason: fromOpenAIFinishReason(choice.finish_reason),
          usage: {
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
          },
          model: response.model,
          provider: 'openai',
          providerRequestId: response.id,
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenAIError(error);
      }
    },

    async generateEmbedding(request: GenerateEmbeddingRequest): Promise<GenerateEmbeddingResponse> {
      try {
        const input = Array.isArray(request.input) ? request.input : [request.input];

        const params: OpenAI.EmbeddingCreateParams = {
          model: request.model,
          input,
        };

        if (request.dimensions) {
          params.dimensions = request.dimensions;
        }

        const response = await client.embeddings.create(params);

        const embeddings = response.data.map((d) => d.embedding);
        const dimensions = embeddings[0]?.length ?? 0;

        return {
          embeddings,
          usage: {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: 0,
            totalTokens: response.usage.total_tokens,
          },
          model: response.model,
          provider: 'openai',
          dimensions,
        };
      } catch (error) {
        throw normalizeOpenAIError(error);
      }
    },

    // ========================================================================
    // Image Generation (GPT Image / DALL-E)
    // ========================================================================

    async generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse> {
      try {
        refuseImageReferences(request, 'openai', 'this provider generates from the prompt alone');

        // GPT image models (gpt-image-1, gpt-image-1-mini, gpt-image-1.5)
        // always return base64 and do NOT accept response_format.
        // DALL-E models (dall-e-2, dall-e-3) require response_format.
        const isGptImage = request.model.startsWith('gpt-image');

        const params = {
          model: request.model,
          prompt: request.prompt,
          n: request.n ?? 1,
          ...(isGptImage
            ? {
                output_format: request.outputFormat ?? 'png',
                ...(request.background ? { background: request.background } : {}),
              }
            : { response_format: 'b64_json' }),
          ...(request.size != null ? { size: request.size as ImageGenerateParams['size'] } : {}),
          ...(request.quality !== undefined ? { quality: request.quality } : {}),
        } as ImageGenerateParams;

        // openai v6: images.generate returns ImagesResponse | Stream<…> depending
        // on whether `stream: true` is set. We never set it, so narrow to the
        // non-stream variant.
        const response = (await client.images.generate(params)) as OpenAI.ImagesResponse;

        const outputMime =
          request.outputFormat === 'webp'
            ? 'image/webp'
            : request.outputFormat === 'jpeg'
              ? 'image/jpeg'
              : 'image/png';

        const images: GenerateImageResponse['images'] = [];
        for (const img of response.data ?? []) {
          if (img.b64_json) {
            images.push({
              data: img.b64_json,
              mimeType: outputMime,
              revisedPrompt: img.revised_prompt ?? undefined,
            });
          }
        }

        if (images.length === 0) {
          throw new AIClientError(
            'No images returned from OpenAI image generation',
            'provider_error',
            'openai',
            false,
          );
        }

        return {
          images,
          model: request.model,
          provider: 'openai',
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenAIError(error);
      }
    },

    async editImage(request: EditImageRequest): Promise<GenerateImageResponse> {
      try {
        refuseImageReferences(request, 'openai', 'this provider edits from the prompt alone');

        // Convert base64 to File for the OpenAI API
        const imageBuffer = Buffer.from(request.imageData, 'base64');
        const imageFile = new File([imageBuffer], 'image.png', { type: request.imageMimeType });

        const isGptImage = request.model.startsWith('gpt-image');

        const params = {
          model: request.model,
          prompt: request.prompt,
          image: imageFile,
          n: request.n ?? 1,
          ...(!isGptImage ? { response_format: 'b64_json' } : {}),
          ...(request.size != null ? { size: request.size as ImageEditParams['size'] } : {}),
          ...(request.maskData
            ? {
                mask: new File([Buffer.from(request.maskData, 'base64')], 'mask.png', {
                  type: request.maskMimeType ?? 'image/png',
                }),
              }
            : {}),
        } as ImageEditParams;

        // openai v6: same non-stream narrowing as images.generate above.
        const response = (await client.images.edit(params)) as OpenAI.ImagesResponse;

        const images: GenerateImageResponse['images'] = [];
        for (const img of response.data ?? []) {
          if (img.b64_json) {
            images.push({
              data: img.b64_json,
              mimeType: 'image/png',
              revisedPrompt: img.revised_prompt ?? undefined,
            });
          }
        }

        if (images.length === 0) {
          throw new AIClientError(
            'No images returned from OpenAI image editing',
            'provider_error',
            'openai',
            false,
          );
        }

        return {
          images,
          model: request.model,
          provider: 'openai',
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenAIError(error);
      }
    },

    // ========================================================================
    // Video Generation (Sora)
    // ========================================================================

    replayGuaranteeFor(): AsyncReplayGuarantee {
      return { kind: 'idempotency_key', field: 'Idempotency-Key' };
    },

    async submitVideoJob(request: GenerateVideoRequest): Promise<VideoJobHandle> {
      try {
        // Sora uses the /v1/videos endpoints. Native in openai v6 (was a shim before).
        const params: OpenAI.VideoCreateParams = {
          model: request.model as OpenAI.VideoModel,
          prompt: request.prompt,
        };
        if (request.durationSeconds) {
          (params as unknown as Record<string, unknown>)['seconds'] = String(
            request.durationSeconds,
          );
        }
        if (request.resolution) {
          // Sora only accepts 720x1280 | 1280x720 | 1024x1792 | 1792x1024.
          // "1080p" is not natively supported — map to the closest landscape
          // size (1792x1024) so callers using the advertised preset don't get
          // rejected at the API. Pass any unknown value through and let the
          // server validate.
          const resMap: Record<string, OpenAI.VideoSize> = {
            '720p': '1280x720',
            '1080p': '1792x1024',
            '1024p': '1024x1792',
          };
          const mapped = resMap[request.resolution];
          if (mapped) {
            params.size = mapped;
          } else {
            (params as unknown as Record<string, unknown>)['size'] = request.resolution;
          }
        }
        if (request.imageData) {
          // /v1/videos is a multipart POST; `input_reference` must be a real
          // file part (Uploadable). A `{ image_url: ... }` JSON shape gets
          // flattened by the SDK's form serializer into bracketed fields
          // (`input_reference[image_url]=…`) and silently ignored by the API.
          // Mirror the editImage path above: decode base64 → File.
          const mime = request.imageMimeType ?? 'image/png';
          const ext = mime.split('/')[1] ?? 'png';
          params.input_reference = new File(
            [Buffer.from(request.imageData, 'base64')],
            `reference.${ext}`,
            { type: mime },
          );
        }

        const result = await client.videos.create(params, {
          ...(request.clientRequestId !== undefined
            ? { idempotencyKey: request.clientRequestId }
            : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        return { providerJobId: result.id };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenAIError(error);
      }
    },

    async pollVideoJob(request: PollVideoJobRequest): Promise<VideoJobPoll> {
      try {
        const videoId = request.handle.providerJobId;
        const result = await client.videos.retrieve(videoId, {
          ...(request.signal ? { signal: request.signal } : {}),
        });

        if (result.status === 'failed') {
          return {
            status: 'failed',
            message: result.error?.message ?? 'Sora reported the render as failed',
          };
        }
        if (result.status !== 'completed') {
          return { status: 'pending' };
        }

        // openai v6 returns a Fetch Response from downloadContent; read it as
        // bytes and base64-encode.
        const downloadResponse = await client.videos.downloadContent(videoId);
        const videoData = Buffer.from(await downloadResponse.arrayBuffer()).toString('base64');

        return {
          status: 'succeeded',
          response: {
            videos: [
              {
                data: videoData,
                mimeType: 'video/mp4',
                durationSeconds: request.durationSeconds,
              },
            ],
            model: request.model,
            provider: 'openai',
          },
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeOpenAIError(error);
      }
    },
  };
}
