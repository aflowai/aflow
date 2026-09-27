/**
 * Anthropic provider adapter.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateEmbeddingResponse,
  StreamingResponse,
  ProviderConfig,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  TextStreamChunk,
  TokenUsage,
  FinishReason,
  CacheStrategy,
  CacheBreakpoint,
  ReasoningConfig,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError, buildStreamTruncationError, normalizeAnthropicError } from '../errors.js';
import { TRUNCATED_HISTORY_USER_BRIDGE_TEXT } from './wireIntegrity.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ============================================================================
// Message Conversion
// ============================================================================

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;

export function toAnthropicMessages(
  messages: ChatMessage[],
  opts?: { replayReasoning?: boolean },
): {
  systemBlocks: Anthropic.TextBlockParam[];
  messages: AnthropicMessage[];
} {
  // Replaying thinking blocks is only valid when thinking is enabled on this
  // request — Anthropic rejects thinking blocks in history otherwise. The caller
  // (generateText/stream) sets this from the resolved reasoning config.
  const replayReasoning = opts?.replayReasoning ?? false;
  const systemBlocks: Anthropic.TextBlockParam[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        // Collect each system message as a separate block for independent caching
        systemBlocks.push({ type: 'text', text: message.content });
        break;

      case 'user': {
        if (typeof message.content === 'string') {
          anthropicMessages.push({ role: 'user', content: message.content });
        } else {
          // Multi-modal content
          const content: AnthropicContent[] = message.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text };
            }
            // Image
            if (part.source.type === 'url') {
              // Anthropic requires base64 for images, not URLs directly
              // For now, we'll need to fetch the URL (or throw an error)
              throw new AIClientError(
                'Anthropic requires base64 images, URL images are not supported',
                'invalid_request',
                'anthropic',
                false,
              );
            }
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: part.source.mediaType as
                  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: part.source.data,
              },
            };
          });
          anthropicMessages.push({ role: 'user', content });
        }
        break;
      }

      case 'assistant': {
        const content: AnthropicContent[] = [];

        // Provider-native reasoning continuity (Plan 259): replay this turn's
        // thinking / redacted_thinking blocks, unchanged and with signatures
        // intact, BEFORE text and tool_use. Anthropic requires this ordering
        // within a tool-use turn or it rejects the request. Only the blocks this
        // adapter captured (provider === 'anthropic') are replayed.
        if (replayReasoning && message.providerReasoning?.provider === 'anthropic') {
          for (const block of message.providerReasoning.blocks) {
            content.push(block as AnthropicContent);
          }
        }

        if (message.content) {
          content.push({ type: 'text', text: message.content });
        }

        if (message.toolCalls) {
          for (const tc of message.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
            });
          }
        }

        if (content.length > 0) {
          anthropicMessages.push({ role: 'assistant', content });
        }
        break;
      }

      case 'tool': {
        // Anthropic uses tool_result blocks inside user messages. Coalesce a
        // contiguous run of tool messages into one user message so an assistant's
        // parallel results all land in the single message after it (§7.2).
        const toolResultBlock: AnthropicContent = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        };
        const last = anthropicMessages[anthropicMessages.length - 1];
        const lastIsToolResultUser =
          last?.role === 'user' &&
          Array.isArray(last.content) &&
          last.content.length > 0 &&
          last.content.every((block) => (block as { type?: string }).type === 'tool_result');
        if (lastIsToolResultUser) {
          (last.content as AnthropicContent[]).push(toolResultBlock);
        } else {
          anthropicMessages.push({ role: 'user', content: [toolResultBlock] });
        }
        break;
      }
    }
  }

  // Anthropic requires the first message to use the user role; a windowed
  // history can open on an assistant turn (its leading user atom evicted).
  if (anthropicMessages[0]?.role === 'assistant') {
    anthropicMessages.unshift({ role: 'user', content: TRUNCATED_HISTORY_USER_BRIDGE_TEXT });
  }

  return { systemBlocks, messages: anthropicMessages };
}

/**
 * Sanitize a JSON Schema for use as an Anthropic tool's `input_schema`.
 *
 * Anthropic's API has two hard requirements for `tools[*].input_schema`:
 *   - `type` must be `"object"` (the platform may omit it, so set if missing)
 *   - Top-level `oneOf` / `allOf` / `anyOf` are NOT supported (deep is fine)
 *
 * Some Phoenix operations declare their input as `z.union([...])` (e.g.
 * `mcp.tool.call`) which `zodToJsonSchema` emits as top-level `anyOf`. We
 * can't keep that on the wire, so we downgrade to a permissive
 * `{ type: 'object', additionalProperties: true }` and rely on the
 * runtime Zod parse (in `validateStepInput`) to catch shape errors. The
 * tool's `description` is the LLM's only structural hint in that case —
 * keep descriptions for these ops informative.
 *
 * Used by both message-streaming tool-use (`toAnthropicTool`) and the
 * structured-output tool construction in `generateJson`.
 */
function sanitizeAnthropicInputSchema(
  raw: Record<string, unknown> | undefined,
): Anthropic.Tool['input_schema'] {
  const params = { ...(raw ?? {}) };
  delete params['$schema'];

  if (params['oneOf'] || params['allOf'] || params['anyOf']) {
    return {
      type: 'object',
      additionalProperties: true,
    } as Anthropic.Tool['input_schema'];
  }

  if (!params['type']) {
    params['type'] = 'object';
  }
  return params as Anthropic.Tool['input_schema'];
}

/**
 * Convert our ToolDefinition to Anthropic format.
 */
function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.function.name,
    description: tool.function.description ?? '',
    input_schema: sanitizeAnthropicInputSchema(tool.function.parameters),
  };
}

/**
 * Convert Anthropic stop reason to our format.
 */
function fromAnthropicStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    case null:
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

// ============================================================================

/**
 * Normalize Anthropic usage into canonical TokenUsage.
 *
 * Anthropic reports:
 * - `input_tokens`: uncached suffix tokens
 * - `cache_read_input_tokens`: tokens served from cache
 * - `cache_creation_input_tokens`: tokens newly written to cache
 *
 * Our `promptTokens` = total input = all three summed.
 */
function normalizeAnthropicUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number } | null;
}): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const uncached = usage.input_tokens;
  const totalPrompt = cacheRead + cacheWrite + uncached;
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? 0;

  return {
    promptTokens: totalPrompt,
    completionTokens: usage.output_tokens,
    totalTokens: totalPrompt + usage.output_tokens,
    // Only include cache fields when caching is active (non-zero values)
    ...(cacheRead > 0 || cacheWrite > 0
      ? {
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          uncachedPromptTokens: uncached,
        }
      : {}),
    // Anthropic reports thinking tokens as a read-only slice of output_tokens.
    ...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
  };
}

// ============================================================================

/** Anthropic rejects a request carrying more `cache_control` markers than this. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Apply cache_control breakpoints to tools and system blocks based on strategy.
 * Mutates the arrays in place for efficiency (they are fresh copies per request).
 */
export function applyCacheStrategy(
  strategy: CacheStrategy | undefined,
  tools: Anthropic.ToolUnion[] | undefined,
  systemBlocks: Anthropic.TextBlockParam[],
): void {
  if (!strategy) return;

  // Build the cache_control object, including ttl when specified
  const buildCacheControl = (bp: CacheBreakpoint): Record<string, unknown> => {
    const cc: Record<string, unknown> = { type: bp.type };
    if (bp.ttl) cc['ttl'] = bp.ttl;
    return cc;
  };

  // Anthropic rejects a request carrying more than this many cache_control
  // markers. The budget is shared across tools and system blocks, so the tool
  // breakpoint is spent first and the system tiers get whatever is left —
  // over-requesting silently drops the shortest-lived tier instead of failing
  // the whole turn.
  let remainingBreakpoints = MAX_CACHE_BREAKPOINTS;

  // Tool breakpoint: mark the last tool definition
  if (strategy.toolBreakpoint && tools && tools.length > 0) {
    const lastTool = tools[tools.length - 1]!;
    (lastTool as unknown as Record<string, unknown>)['cache_control'] = buildCacheControl(
      strategy.toolBreakpoint,
    );
    remainingBreakpoints -= 1;
  }

  // System breakpoint: mark stable system blocks for caching.
  // systemBreakpointCount marks the first N blocks (prompt + the longer-lived
  // context tiers), leaving the volatile tail at the end uncached.
  const sysBp = strategy.systemBreakpoint ?? { type: 'ephemeral' as const };
  if (strategy.systemBreakpointCount != null && strategy.systemBreakpointCount > 0) {
    const count = Math.min(
      strategy.systemBreakpointCount,
      systemBlocks.length,
      remainingBreakpoints,
    );
    for (let i = 0; i < count; i++) {
      (systemBlocks[i] as unknown as Record<string, unknown>)['cache_control'] =
        buildCacheControl(sysBp);
    }
  } else if (strategy.systemBreakpoint && systemBlocks.length > 0) {
    // Fallback: mark only the last system block
    const lastBlock = systemBlocks[systemBlocks.length - 1]!;
    (lastBlock as unknown as Record<string, unknown>)['cache_control'] = buildCacheControl(
      strategy.systemBreakpoint,
    );
  }
}

// ============================================================================
// Claude Sonnet 5.x sampling helpers
// ============================================================================

/**
 * Claude Sonnet 5.x (and later) models reject an explicit `temperature` —
 * the API returns "`temperature` is deprecated for this model." Older
 * Claude models (Sonnet 4.x and earlier) still accept and expect it.
 */
function isTemperatureUnsupportedModel(modelId: string): boolean {
  return /claude-sonnet-5/i.test(modelId);
}

/**
 * Map Phoenix reasoning config to Anthropic thinking + effort params.
 *
 * Reasoning-capable Claude models (Sonnet 5, Opus 4.6+) take adaptive thinking
 * plus `output_config.effort` — `budget_tokens` is removed on these and 400s.
 * `off` / `disabled` explicitly disables thinking: on some models adaptive is
 * the on-by-omission default, so leaving `thinking` unset is not "off".
 * `display: 'summarized'` returns readable thinking text while still emitting the
 * signed blocks that reasoning continuity replays.
 *
 * `enabled` signals the caller to drop `temperature` — Anthropic rejects a
 * non-1 temperature while thinking is on. This function only runs for models the
 * client has already confirmed declare `capabilities.reasoning`.
 */
export function buildAnthropicReasoning(reasoning: ReasoningConfig | undefined): {
  thinking?: Anthropic.ThinkingConfigParam;
  outputConfig?: Anthropic.OutputConfig;
  enabled: boolean;
} {
  if (!reasoning) return { enabled: false };
  const effort = reasoning.effort;
  if (!effort || effort === 'off') {
    return { thinking: { type: 'disabled' }, enabled: false };
  }
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    outputConfig: { effort },
    enabled: true,
  };
}

/**
 * Accumulates exact thinking / redacted_thinking blocks from an Anthropic
 * streaming response so they can be replayed verbatim for tool-use continuity
 * (Plan 259). Stateful across content-block events: a `thinking` block spans
 * `content_block_start` → N×`thinking_delta` + N×`signature_delta` →
 * `content_block_stop`; a `redacted_thinking` block arrives whole at start.
 * Extracted so the signature-accumulation invariant is unit-testable without an
 * SDK stream.
 */
export class AnthropicReasoningCapture {
  private readonly blocks: unknown[] = [];
  private current: { thinking: string; signature: string } | undefined;

  startBlock(block: { type?: string; data?: string }): void {
    if (block.type === 'thinking') {
      this.current = { thinking: '', signature: '' };
    } else if (block.type === 'redacted_thinking' && block.data) {
      this.blocks.push({ type: 'redacted_thinking', data: block.data });
    }
  }

  delta(delta: { type?: string; thinking?: string; signature?: string }): void {
    if (!this.current) return;
    if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
      this.current.thinking += delta.thinking;
    } else if (delta.type === 'signature_delta' && delta.signature !== undefined) {
      this.current.signature += delta.signature;
    }
  }

  stopBlock(): void {
    if (this.current) {
      this.blocks.push({
        type: 'thinking',
        thinking: this.current.thinking,
        signature: this.current.signature,
      });
      this.current = undefined;
    }
  }

  finish(): unknown[] {
    return this.blocks;
  }
}

// ============================================================================
// Anthropic Adapter Implementation
// ============================================================================

/**
 * Create an Anthropic provider adapter.
 */
export function createAnthropicAdapter(config: ProviderConfig): AIProviderAdapter {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: config.maxRetries ?? 1,
    timeout: config.timeoutMs ?? 300_000, // 5 min — streaming can be slow; executor-level timeout is the real control
  });

  return {
    provider: 'anthropic',

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
      try {
        const reasoningCfg = buildAnthropicReasoning(request.reasoning);
        const { systemBlocks, messages } = toAnthropicMessages(request.messages, {
          replayReasoning: reasoningCfg.enabled,
        });

        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: request.model,
          messages,
          max_tokens: request.maxTokens ?? 8192,
        };

        if (reasoningCfg.thinking) params.thinking = reasoningCfg.thinking;
        if (reasoningCfg.outputConfig) params.output_config = reasoningCfg.outputConfig;

        if (
          request.temperature !== undefined &&
          !isTemperatureUnsupportedModel(request.model) &&
          !reasoningCfg.enabled
        ) {
          params.temperature = request.temperature;
        }
        if (request.stopSequences !== undefined) {
          params.stop_sequences = request.stopSequences;
        }
        if (systemBlocks.length > 0) {
          params.system = systemBlocks;
        }

        if (request.tools && request.tools.length > 0) {
          params.tools = request.tools.map(toAnthropicTool);
          if (request.toolChoice) {
            if (request.toolChoice === 'auto') {
              params.tool_choice = { type: 'auto' };
            } else if (request.toolChoice === 'required') {
              params.tool_choice = { type: 'any' };
            } else if (request.toolChoice === 'none') {
              // Anthropic doesn't have "none", we just don't send tools
              delete params.tools;
            } else {
              params.tool_choice = {
                type: 'tool',
                name: request.toolChoice.function.name,
              };
            }
          }
        }

        applyCacheStrategy(request.cacheStrategy, params.tools, systemBlocks);

        const response = await client.messages.create(params, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        });

        // Extract text, thinking, and tool calls from content blocks
        let textContent = '';
        let thinkingContent = '';
        const toolCalls: ToolCall[] = [];
        // Exact ordered thinking / redacted_thinking blocks for continuity replay.
        const reasoningBlocks: unknown[] = [];

        for (const block of response.content) {
          const blockType = (block as { type: string }).type;
          if (blockType === 'thinking') {
            const tb = block as unknown as { thinking: string; signature?: string };
            thinkingContent += tb.thinking;
            reasoningBlocks.push({
              type: 'thinking',
              thinking: tb.thinking,
              signature: tb.signature ?? '',
            });
          } else if (blockType === 'redacted_thinking') {
            reasoningBlocks.push({
              type: 'redacted_thinking',
              data: (block as unknown as { data: string }).data,
            });
          } else if (block.type === 'text') {
            textContent += block.text;
          } else if (block.type === 'tool_use') {
            // The non-streaming content union now includes server tools and
            // thinking variants; only plain tool_use becomes a callable tool.
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        return {
          content: textContent || null,
          thinking: thinkingContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(reasoningBlocks.length > 0
            ? {
                providerReasoning: {
                  provider: 'anthropic' as const,
                  model: request.model,
                  blocks: reasoningBlocks,
                },
              }
            : {}),
          finishReason: fromAnthropicStopReason(response.stop_reason),
          usage: normalizeAnthropicUsage(
            response.usage as Parameters<typeof normalizeAnthropicUsage>[0],
          ),
          model: response.model,
          provider: 'anthropic',
          providerRequestId: response.id,
        };
      } catch (error) {
        throw normalizeAnthropicError(error);
      }
    },

    generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse> {
      let resolveResponse: (response: GenerateTextResponse) => void;
      let rejectResponse: (error: Error) => void;

      const responsePromise = new Promise<GenerateTextResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });

      const streamGenerator = async function* (): AsyncGenerator<TextStreamChunk> {
        // Track streaming progress for diagnostics on error
        let _diagTextLen = 0;
        let _diagToolCount = 0;
        let _diagUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        let _diagRequestId: string | undefined;
        try {
          const reasoningCfg = buildAnthropicReasoning(request.reasoning);
          const { systemBlocks, messages } = toAnthropicMessages(request.messages, {
            replayReasoning: reasoningCfg.enabled,
          });

          const params: Anthropic.MessageCreateParamsStreaming = {
            model: request.model,
            messages,
            max_tokens: request.maxTokens ?? 8192,
            stream: true,
          };

          if (reasoningCfg.thinking) params.thinking = reasoningCfg.thinking;
          if (reasoningCfg.outputConfig) params.output_config = reasoningCfg.outputConfig;

          if (
            request.temperature !== undefined &&
            !isTemperatureUnsupportedModel(request.model) &&
            !reasoningCfg.enabled
          ) {
            params.temperature = request.temperature;
          }
          if (request.stopSequences !== undefined) {
            params.stop_sequences = request.stopSequences;
          }
          if (systemBlocks.length > 0) {
            params.system = systemBlocks;
          }

          if (request.tools && request.tools.length > 0) {
            params.tools = request.tools.map(toAnthropicTool);
          }

          applyCacheStrategy(request.cacheStrategy, params.tools, systemBlocks);

          const stream = client.messages.stream(params, {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
          });

          let textContent = '';
          let thinkingContent = '';
          const toolCalls: ToolCall[] = [];
          let finishReason: FinishReason = 'stop';
          let sawFinishReason = false;
          let usage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          };
          let providerRequestId: string | undefined;
          const streamStartMs = Date.now();

          // Track in-progress tool use blocks for assembly
          let currentToolId: string | undefined;
          let currentToolName: string | undefined;
          let currentToolArgs = '';

          // Exact ordered thinking / redacted_thinking blocks for continuity replay.
          const reasoningCapture = new AnthropicReasoningCapture();

          for await (const event of stream) {
            request.onStreamProgress?.();
            if (event.type === 'message_start') {
              providerRequestId = (event as { message: { id: string } }).message.id;
              _diagRequestId = providerRequestId;
              const msg = event as {
                message: {
                  usage: {
                    input_tokens: number;
                    output_tokens: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                };
              };
              usage = normalizeAnthropicUsage(msg.message.usage);
              _diagUsage = usage;
            }

            // content_block_start: begins a new text, thinking, or tool_use block
            if (event.type === 'content_block_start') {
              const block = (
                event as {
                  content_block: { type: string; id?: string; name?: string; data?: string };
                }
              ).content_block;
              if (block.type === 'tool_use' && block.id && block.name) {
                currentToolId = block.id;
                currentToolName = block.name;
                currentToolArgs = '';
              } else {
                reasoningCapture.startBlock(block);
              }
            }

            if (event.type === 'content_block_delta') {
              const delta = (
                event as {
                  delta: {
                    type: string;
                    text?: string;
                    thinking?: string;
                    signature?: string;
                    partial_json?: string;
                  };
                }
              ).delta;
              if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
                thinkingContent += delta.thinking;
                reasoningCapture.delta(delta);
                yield { type: 'thinking_delta', delta: delta.thinking };
              } else if (delta.type === 'signature_delta' && delta.signature !== undefined) {
                reasoningCapture.delta(delta);
              } else if (delta.type === 'text_delta' && delta.text !== undefined) {
                textContent += delta.text;
                _diagTextLen = textContent.length;
                yield { type: 'text_delta', delta: delta.text };
              } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
                currentToolArgs += delta.partial_json;
                yield {
                  type: 'tool_call_delta',
                  toolCallArguments: delta.partial_json,
                };
              }
            }

            // content_block_stop: finalize the current tool call or thinking block
            if (event.type === 'content_block_stop') {
              reasoningCapture.stopBlock();
              if (currentToolId && currentToolName) {
                toolCalls.push({
                  id: currentToolId,
                  type: 'function' as const,
                  function: { name: currentToolName, arguments: currentToolArgs || '{}' },
                });
                _diagToolCount = toolCalls.length;
                currentToolId = undefined;
                currentToolName = undefined;
                currentToolArgs = '';
              }
            }

            if (event.type === 'message_delta') {
              const deltaEvent = event as {
                delta: { stop_reason?: string };
                usage: {
                  output_tokens: number;
                  output_tokens_details?: { thinking_tokens?: number } | null;
                };
              };
              finishReason = fromAnthropicStopReason(deltaEvent.delta.stop_reason);
              sawFinishReason = true;
              const thinkingTokens = deltaEvent.usage.output_tokens_details?.thinking_tokens ?? 0;
              // Preserve cache fields from message_start, update completion count
              usage = {
                ...usage,
                completionTokens: deltaEvent.usage.output_tokens,
                totalTokens: usage.promptTokens + deltaEvent.usage.output_tokens,
                ...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
              };
              _diagUsage = usage;
              yield { type: 'usage', usage };
            }
          }

          if (!sawFinishReason) {
            throw buildStreamTruncationError({
              provider: 'anthropic',
              model: request.model,
              signal: request.signal,
              startMs: streamStartMs,
              accumulatedChars: textContent.length,
              toolCallCount: toolCalls.length,
            });
          }

          yield { type: 'done', finishReason };

          const reasoningBlocks = reasoningCapture.finish();
          resolveResponse({
            content: textContent || null,
            thinking: thinkingContent || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            ...(reasoningBlocks.length > 0
              ? {
                  providerReasoning: {
                    provider: 'anthropic' as const,
                    model: request.model,
                    blocks: reasoningBlocks,
                  },
                }
              : {}),
            finishReason,
            usage,
            model: request.model,
            provider: 'anthropic',
            providerRequestId,
          });
        } catch (error) {
          const normalizedError = normalizeAnthropicError(error, _diagRequestId);
          // Attach streaming diagnostics so callers can log how far the stream got
          (normalizedError as unknown as Record<string, unknown>)['streamDiagnostics'] = {
            model: request.model,
            textLength: _diagTextLen,
            toolCallCount: _diagToolCount,
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
        const { systemBlocks, messages } = toAnthropicMessages(request.messages);

        // Use tool use pattern for structured output.
        // When rawJsonSchema is provided, use it directly instead of converting from Zod.
        // This supports cases where the caller has a JSON Schema (e.g., agent decision repair)
        // rather than a Zod schema.
        //
        // Both branches go through `sanitizeAnthropicInputSchema` so a Zod
        // top-level `z.union([...])` (which translates to top-level `anyOf`)
        // gets downgraded to a permissive object schema instead of
        // tripping Anthropic's "no top-level oneOf/allOf/anyOf" rule.
        let jsonSchema: Anthropic.Tool['input_schema'];
        if (request.rawJsonSchema) {
          jsonSchema = sanitizeAnthropicInputSchema(request.rawJsonSchema);
        } else {
          // $refStrategy 'none' avoids $ref wrappers so the schema has
          // top-level `type: "object"` as Anthropic requires.
          const raw = zodToJsonSchema(request.schema, {
            $refStrategy: 'none',
          }) as Record<string, unknown>;
          jsonSchema = sanitizeAnthropicInputSchema(raw);
        }

        // Structured output rides a tool, but `tool_choice` stays `auto`.
        // Both forcing modes — `{type:'tool'}` and `{type:'any'}` — suppress
        // extended thinking outright (measured at 0 thinking tokens even with
        // `thinking: adaptive` set explicitly), so an agent turn taken through
        // a forced tool answers with no reasoning at all. Under `auto` the
        // model still calls the tool and thinking survives.
        //
        // The tool carries the schema rather than `output_config.format`
        // because native structured outputs demand `additionalProperties:
        // false` on every object, and the agent decision schema has to keep a
        // free-form `args` object — the tool arguments are not known when the
        // schema is built.
        const reasoningCfg = buildAnthropicReasoning(request.reasoning);
        const toolName = request.schemaName ?? 'response';

        const jsonSystemBlocks: Anthropic.TextBlockParam[] = [
          ...systemBlocks,
          {
            type: 'text',
            text: `You must respond using the "${toolName}" tool. Do not include any text outside the tool call.`,
          },
        ];

        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: request.model,
          messages,
          max_tokens: request.maxTokens ?? 8192,
          ...(jsonSystemBlocks.length > 0 ? { system: jsonSystemBlocks } : {}),
          ...(reasoningCfg.thinking ? { thinking: reasoningCfg.thinking } : {}),
          ...(reasoningCfg.outputConfig ? { output_config: reasoningCfg.outputConfig } : {}),
          tools: [
            {
              name: toolName,
              description: request.schemaDescription ?? 'Structured response output',
              input_schema: jsonSchema,
            },
          ],
          tool_choice: { type: 'auto' },
        };

        // Anthropic rejects a non-1 temperature while thinking is on.
        if (
          request.temperature !== undefined &&
          !reasoningCfg.enabled &&
          !isTemperatureUnsupportedModel(request.model)
        ) {
          params.temperature = request.temperature;
        }

        const response = await client.messages.create(params, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
        });

        let toolInput: unknown = null;
        let thinkingContent = '';
        for (const block of response.content) {
          if (block.type === 'tool_use' && block.name === toolName) {
            toolInput = block.input;
          } else if (block.type === 'thinking') {
            thinkingContent += (block as unknown as { thinking: string }).thinking;
          }
        }

        // `auto` leaves the model free to answer in prose instead of calling
        // the tool. It rarely does against the instruction above, but when it
        // does the payload is still JSON — read it rather than failing the turn.
        if (toolInput === null) {
          const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();
          const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
          const candidate = (fenced?.[1] ?? text).trim();
          if (candidate.length > 0) {
            try {
              toolInput = JSON.parse(candidate);
            } catch {
              toolInput = null;
            }
          }
        }

        if (toolInput === null) {
          // The failure modes here are indistinguishable from the outside — a
          // truncated tool call, a refusal, a prose answer that is not JSON —
          // and they call for different fixes, so the message names which one.
          const blockTypes = response.content.map((block) => block.type).join(', ');
          throw new AIClientError(
            `Anthropic returned no usable "${toolName}" tool call (stop_reason: ${
              response.stop_reason ?? 'none'
            }; content blocks: ${blockTypes.length > 0 ? blockTypes : 'none'}; output tokens: ${String(
              response.usage.output_tokens,
            )}). ${
              response.stop_reason === 'max_tokens'
                ? 'The answer was cut off by maxTokens — raise it or constrain the schema to a smaller answer.'
                : 'The model answered outside the tool and the text was not JSON.'
            }`,
            'invalid_request',
            'anthropic',
            false,
          );
        }

        // Validate with the schema
        const parsed = request.schema.safeParse(toolInput);
        if (!parsed.success) {
          throw new AIClientError(
            `JSON validation failed: ${parsed.error.message}`,
            'invalid_request',
            'anthropic',
            false,
          );
        }

        return {
          data: parsed.data,
          rawContent: JSON.stringify(toolInput),
          ...(thinkingContent.length > 0 ? { thinking: thinkingContent } : {}),
          finishReason: fromAnthropicStopReason(response.stop_reason),
          usage: normalizeAnthropicUsage(
            response.usage as Parameters<typeof normalizeAnthropicUsage>[0],
          ),
          model: response.model,
          provider: 'anthropic',
          providerRequestId: response.id,
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeAnthropicError(error);
      }
    },

    generateEmbedding() /* _request: GenerateEmbeddingRequest - unused, Anthropic doesn't support embeddings */
    : Promise<GenerateEmbeddingResponse> {
      // Anthropic doesn't have an embeddings API
      return Promise.reject(
        new AIClientError(
          'Anthropic does not support embeddings',
          'invalid_request',
          'anthropic',
          false,
        ),
      );
    },
  };
}
