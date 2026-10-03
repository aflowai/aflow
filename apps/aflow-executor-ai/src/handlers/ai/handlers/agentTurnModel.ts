/**
 * Stage 2 — native function calling vs generateJson, normalized execution result.
 */
import { z } from 'zod';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AgentTurnDecision } from '@aflow/schemas';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import type { AIClient, ChatMessage, ProviderReasoning } from '@aflow/ai-client';
import type { AgentTurnInput } from '../schema.js';
import type { HandlerDeps } from './types.js';
import { chatMessageToAiMessage } from './agentMessageConversion.js';
import { toolImageResolver } from './mediaSourceRef.js';
import {
  buildFunctionDeclarations,
  mapToolCallsToDecision,
  buildRawContentFromResponse,
  remapFunctionNamesForNativeFC,
  stripTrailingDecisionJson,
  checkToolResultAdjacency,
  enforceToolResultAdjacency,
} from './agentNativeFunctionCalling.js';
import {
  InvalidAgentTurnDecisionError,
  buildAgentDecisionRawJsonSchema,
  parseGenerateJsonAgentDecision,
} from './agentTurnDecision.js';

// ---------------------------------------------------------------------------
// MetaTagFilter — strips <reasoning>, <thinking>, etc. across chunk boundaries
// ---------------------------------------------------------------------------

/** Large prompts + JSON schema + tool fallback can exceed Google's default 2m cap. */
const GOOGLE_AGENT_TURN_TIMEOUT_MS = 300_000;

const META_TAG_NAMES = ['reasoning', 'thinking', 'internal', 'reflection', 'scratchpad'];
const META_OPEN_PATTERN = new RegExp(`<(${META_TAG_NAMES.join('|')})>`, 'i');
const META_CLOSE_PATTERN = new RegExp(`</(${META_TAG_NAMES.join('|')})>`, 'i');

class MetaTagFilter {
  private inside = false;
  private pending = '';
  private jsonSuppressed = false;

  push(chunk: string): string {
    const input = this.pending + chunk;
    this.pending = '';
    let result = '';
    let pos = 0;

    while (pos < input.length) {
      if (this.jsonSuppressed) {
        pos = input.length;
        continue;
      }

      if (this.inside) {
        const closeMatch = META_CLOSE_PATTERN.exec(input.slice(pos));
        if (closeMatch?.index != null) {
          pos += closeMatch.index + closeMatch[0].length;
          this.inside = false;
        } else {
          this.pending = input.slice(pos);
          pos = input.length;
        }
      } else {
        const openMatch = META_OPEN_PATTERN.exec(input.slice(pos));
        if (openMatch?.index != null) {
          const textBefore = input.slice(pos, pos + openMatch.index);
          result += this.filterJson(textBefore);
          if (this.jsonSuppressed) {
            pos = input.length;
            continue;
          }
          pos += openMatch.index + openMatch[0].length;
          this.inside = true;
        } else {
          const partialIdx = input.lastIndexOf('<', input.length - 1);
          if (partialIdx >= pos && partialIdx > input.length - 15) {
            const textBefore = input.slice(pos, partialIdx);
            result += this.filterJson(textBefore);
            if (!this.jsonSuppressed) {
              this.pending = input.slice(partialIdx);
            }
            pos = input.length;
          } else {
            const textChunk = input.slice(pos);
            result += this.filterJson(textChunk);
            pos = input.length;
          }
        }
      }
    }

    return result;
  }

  private filterJson(text: string): string {
    const jsonMatch = /\{\s*"action"\s*:/.exec(text);
    if (jsonMatch?.index != null) {
      this.jsonSuppressed = true;
      return text.slice(0, jsonMatch.index);
    }

    const braceIdx = text.lastIndexOf('{');
    if (braceIdx >= 0 && braceIdx > text.length - 15) {
      const tail = text.slice(braceIdx);
      if (/^\{\s*"?a?c?t?i?o?n?/.test(tail)) {
        this.pending += tail;
        return text.slice(0, braceIdx);
      }
    }

    return text;
  }
}

export interface AgentModelExecutionResult {
  decision: AgentTurnDecision;
  rawContent: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    uncachedPromptTokens?: number | undefined;
  };
  model: string;
  provider?: string;
  /** Token/currency cost breakdown from the provider (shape varies by model). */
  cost?: {
    promptCost: number;
    completionCost: number;
    totalCost: number;
    currency: string;
    [extra: string]: unknown;
  };
  toolCallSignatures?: string[];
  /** Provider-native reasoning captured this turn for tool-use continuity (Plan 259). */
  providerReasoning?: ProviderReasoning;
  requestSnapshot: Array<ReturnType<typeof chatMessageToAiMessage>>;
  /** Present when native FC mapping failed and generateJson was used instead. */
  nativeFcFallbackReason?: string;
  /** The model exhausted its output budget partway through a tool call's arguments. */
  truncatedToolArgs?: boolean;
  /** High-level markers for audit (Zod repair, FC fallback, persistence repair — applied in coordinator). */
  decisionAttemptSummary?: string[];
}

export async function executeAgentModel(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  sanitizedMessages: ChatMessage[],
  useNativeFC: boolean,
  cacheableSystemBlockCount: number,
): Promise<AgentModelExecutionResult> {
  logWireBridgeIfFiring(
    ctx,
    params,
    sanitizedMessages,
    model,
    client.getModel(model)?.provider ?? 'unknown',
  );
  if (useNativeFC) {
    return await runNativeFunctionCallingPath(
      ctx,
      params,
      deps,
      client,
      model,
      sanitizedMessages,
      cacheableSystemBlockCount,
    );
  }
  return await runGenerateJsonPath(ctx, params, deps, client, model, sanitizedMessages);
}

export function logWireBridgeIfFiring(
  ctx: ExecutorContext,
  params: Pick<AgentTurnInput, 'turnNumber'>,
  messages: ChatMessage[],
  model: string,
  provider: string,
): void {
  const firstNonSystem = messages.find((m) => m.role !== 'system');
  if (firstNonSystem?.role !== 'assistant') return;
  ctx.log.warn('agent_turn_wire_bridge_fired', {
    tenantId: ctx.job.tenantId,
    runId: ctx.runId,
    stepExecutionId: ctx.job.stepExecutionId,
    turnNumber: params.turnNumber,
    model,
    provider,
  });
}

// ---------------------------------------------------------------------------
// Truncation hint — appended as a user message on retry after max_tokens hit
// ---------------------------------------------------------------------------

const TRUNCATION_RETRY_HINT =
  'Your previous response was cut off because it exceeded the output token limit. ' +
  'You MUST call a tool function now. Keep any text brief — put detailed content ' +
  '(code, data, analysis) inside tool call arguments, not in the message text.';

async function runNativeFunctionCallingPath(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  sanitized: ChatMessage[],
  cacheableSystemBlockCount: number,
): Promise<AgentModelExecutionResult> {
  const modelDef = client.getModel(model);
  const provider = modelDef?.provider ?? 'unknown';
  const {
    tools: toolDefinitions,
    fnNameToToolId,
    toolIdToFnNameMap,
  } = buildFunctionDeclarations(
    params.availableTools,
    {
      ...params.policy,
      agentRole: params.agentRole,
      ...(params.requestInputPolicy ? { requestInputPolicy: params.requestInputPolicy } : {}),
      ...(params.voiceMode ? { voiceMode: true } : {}),
    },
    provider,
  );

  const remapped = remapFunctionNamesForNativeFC(sanitized, toolIdToFnNameMap);
  const fcMessages = remapped.map((msg) => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const cleaned = msg.content ? stripTrailingDecisionJson(msg.content) : null;
      return { ...msg, content: cleaned || null };
    }
    return msg;
  });

  let requestMessages = fcMessages;
  const adjacency = checkToolResultAdjacency(requestMessages);
  if (!adjacency.ok) {
    ctx.log.warn('agent_turn_tool_adjacency_violation', {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      model,
      provider,
      violations: adjacency.violations,
    });
    requestMessages = enforceToolResultAdjacency(requestMessages);
    const recheck = checkToolResultAdjacency(requestMessages);
    if (!recheck.ok) {
      const indices = recheck.violations.map((v) => v.assistantIndex).join(', ');
      throw new Error(
        `tool_result adjacency invariant violated before provider request and not ` +
          `repairable (assistant index(es): ${indices}). See agent_turn_tool_adjacency_violation log.`,
      );
    }
  }

  const requestSnapshot = requestMessages.map(chatMessageToAiMessage);

  const canonicalModelId = modelDef?.id ?? model;
  const isGemini3 = /gemini[- ]?3(\.\d+)?/i.test(canonicalModelId);
  // Google explicitly recommends NOT setting temperature/topP/topK on Gemini 3.x.
  // The Google adapter drops these for 3.x models, but we still avoid sending a
  // value here so a non-Gemini provider in the same code path stays explicit.
  const temperature = params.temperature ?? (isGemini3 ? undefined : 0.1);

  const cacheTtl: '5m' | '1h' | undefined =
    provider === 'anthropic' && params.lastTurnCompletedAtMs
      ? Date.now() - params.lastTurnCompletedAtMs < 10 * 60 * 1000
        ? '1h'
        : undefined // let Anthropic default to 5m
      : undefined;
  const cacheStrategy =
    provider === 'anthropic'
      ? {
          toolBreakpoint: { type: 'ephemeral' as const, ...(cacheTtl ? { ttl: cacheTtl } : {}) },
          systemBreakpoint: {
            type: 'ephemeral' as const,
            ...(cacheTtl ? { ttl: cacheTtl } : {}),
          },
          // Only the tiers actually emitted. `applyCacheStrategy` marks the
          // FIRST N system blocks, and `assembleRequest` emits only non-empty
          // tiers — so a fixed count would mark the volatile tail on any turn
          // that ships fewer tiers, paying a cache write every turn for a block
          // that never repeats.
          systemBreakpointCount: cacheableSystemBlockCount,
        }
      : undefined;

  const googleTimeout = provider === 'google' ? { timeoutMs: GOOGLE_AGENT_TURN_TIMEOUT_MS } : {};

  // First attempt
  const reasoning = params.reasoningEffort ? { effort: params.reasoningEffort } : undefined;
  const firstResponse = await streamAndCollect(ctx, client, {
    model,
    messages: requestMessages,
    tools: toolDefinitions,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(cacheStrategy ? { cacheStrategy } : {}),
    ...(reasoning ? { reasoning } : {}),
    turnNumber: params.turnNumber,
    ...googleTimeout,
  });

  logRawResponse(ctx, params.turnNumber, firstResponse);

  // Detect truncation: finishReason === 'length' with no complete tool calls
  const firstToolCount = firstResponse.toolCalls?.length ?? 0;
  if (firstResponse.finishReason === 'length' && firstToolCount === 0) {
    ctx.log.warn('agent_turn_truncated', {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      contentLength: firstResponse.content?.length ?? 0,
      completionTokens: firstResponse.usage?.completionTokens,
    });

    // Retry with truncation hint + truncated content as assistant context
    const retryMessages: ChatMessage[] = [
      ...requestMessages,
      // Include the truncated assistant text so the model has context
      ...(firstResponse.content
        ? [{ role: 'assistant' as const, content: firstResponse.content }]
        : []),
      { role: 'user' as const, content: TRUNCATION_RETRY_HINT },
    ];

    const retryResponse = await streamAndCollect(ctx, client, {
      model,
      messages: retryMessages,
      tools: toolDefinitions,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(cacheStrategy ? { cacheStrategy } : {}),
      ...(reasoning ? { reasoning } : {}),
      turnNumber: params.turnNumber,
      ...googleTimeout,
    });

    logRawResponse(ctx, params.turnNumber, retryResponse, 'retry');

    const retryToolCount = retryResponse.toolCalls?.length ?? 0;
    if (retryResponse.finishReason === 'length' && retryToolCount === 0) {
      // Both attempts truncated — fail with a clear error
      throw new InvalidAgentTurnDecisionError(
        `Agent response truncated after retry (output hit max_tokens limit). ` +
          `The model used all output tokens on text without producing a tool call. ` +
          `Consider increasing maxTokens in the model configuration or simplifying the task.`,
      );
    }

    // Use retry response
    return buildResultFromResponse(
      ctx,
      params,
      retryResponse,
      fnNameToToolId,
      requestSnapshot,
      sanitized,
      deps,
      client,
      model,
      ['truncation_retry'],
    );
  }

  return buildResultFromResponse(
    ctx,
    params,
    firstResponse,
    fnNameToToolId,
    requestSnapshot,
    sanitized,
    deps,
    client,
    model,
  );
}

// ---------------------------------------------------------------------------
// Stream, collect deltas, and return the full response
// ---------------------------------------------------------------------------

interface StreamCallParams {
  model: string;
  messages: ChatMessage[];
  tools: Parameters<AIClient['generateTextStream']>[0]['tools'];
  /** Omitted for Gemini 3.x — Google recommends not setting temperature/topP/topK. */
  temperature?: number;
  maxTokens?: number;
  turnNumber: number;
  cacheStrategy?: Parameters<AIClient['generateTextStream']>[0]['cacheStrategy'];
  timeoutMs?: number;
  /** Reasoning effort override resolved at the dispatch site (per-space directives → catalog default → undefined). */
  reasoning?: { effort?: 'off' | 'low' | 'medium' | 'high' };
}

type CollectedResponse = Awaited<ReturnType<AIClient['generateTextStream']>['response']>;

async function streamAndCollect(
  ctx: ExecutorContext,
  client: AIClient,
  p: StreamCallParams,
): Promise<CollectedResponse> {
  // The idle window is armed when the handler is entered, not when the stream
  // opens, and the only thing that slides it is the provider's chunk loop. That
  // leaves credential decrypt, conversation load, payload hydration AND the
  // model's time-to-first-token sharing one deadline — so a slow first token on
  // a large prompt is cut as though nothing were happening. Ticking here gives
  // the request its own window and the stream a fresh one.
  ctx.reportProgress?.();
  const { stream, response: responsePromise } = client.generateTextStream({
    model: p.model,
    messages: p.messages,
    resolveToolImage: toolImageResolver(ctx),
    tools: p.tools,
    toolChoice: 'auto',
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
    ...(p.cacheStrategy ? { cacheStrategy: p.cacheStrategy } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.reasoning ? { reasoning: p.reasoning } : {}),
    tenantId: ctx.job.tenantId as TenantId,
    runId: ctx.runId,
    stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
    attempt: ctx.job.attempt,
    signal: ctx.signal,
    onStreamProgress: ctx.reportProgress,
    maxRetries: 0, // Agent turns are interactive — let orchestrator handle retries with user feedback
  });

  responsePromise.catch(() => {});

  const metaTagFilter = new MetaTagFilter();
  let deltaBuffer = '';
  const DELTA_FLUSH_MS = 150;
  let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // Thinking deltas — separate buffer, same flush cadence
  let thinkingBuffer = '';
  let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // Both flushes append to the step's live buffer rather than emitting session
  // events. No sequence number rides along: the buffer's own byte offset is the
  // ordering, and appends to one key are already serialized by Redis.

  /**
   * Streaming output is a side channel: it shows a turn happening, it is not
   * what the turn produces. A live plane that refuses an append must not take
   * the turn down with it — the result is still correct and still delivered.
   * The scheduled flushes below call these without awaiting, so swallowing here
   * also keeps a rejection from surfacing as an unhandled one.
   */
  const flushThinkingDeltas = async (): Promise<void> => {
    if (thinkingBuffer.length === 0) return;
    const delta = thinkingBuffer;
    thinkingBuffer = '';
    try {
      await ctx.emitLiveDelta('thinking', delta);
    } catch (err) {
      ctx.log.warn('Live thinking delta dropped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const scheduleThinkingFlush = (): void => {
    if (thinkingFlushTimer) return;
    thinkingFlushTimer = setTimeout(() => {
      thinkingFlushTimer = null;
      void flushThinkingDeltas();
    }, DELTA_FLUSH_MS);
  };

  const flushDeltas = async (): Promise<void> => {
    if (deltaBuffer.length === 0) return;
    const delta = metaTagFilter.push(deltaBuffer);
    deltaBuffer = '';
    if (!delta) return;
    try {
      await ctx.emitLiveDelta('text', delta);
    } catch (err) {
      ctx.log.warn('Live text delta dropped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const scheduleDeltaFlush = (): void => {
    if (deltaFlushTimer) return;
    deltaFlushTimer = setTimeout(() => {
      deltaFlushTimer = null;
      void flushDeltas();
    }, DELTA_FLUSH_MS);
  };

  // Stream diagnostics — only surfaced on error so a stalled-vs-streaming
  // post-mortem (e.g. Gemini 300s timeout) tells us whether any chunks landed.
  const streamStartMs = Date.now();
  let firstChunkMs: number | null = null;
  const chunkCounts: Record<string, number> = {};
  try {
    for await (const chunk of stream) {
      if (firstChunkMs === null) firstChunkMs = Date.now() - streamStartMs;
      chunkCounts[chunk.type] = (chunkCounts[chunk.type] ?? 0) + 1;
      if (chunk.type === 'thinking_delta' && chunk.delta) {
        thinkingBuffer += chunk.delta;
        scheduleThinkingFlush();
      } else if (chunk.type === 'text_delta' && chunk.delta) {
        deltaBuffer += chunk.delta;
        scheduleDeltaFlush();
      }
    }
  } catch (err) {
    ctx.log.warn('agent_turn_stream_failed', {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: p.turnNumber,
      model: p.model,
      firstChunkMs,
      elapsedMs: Date.now() - streamStartMs,
      chunkCounts,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
    if (thinkingFlushTimer) clearTimeout(thinkingFlushTimer);
  }
  await flushThinkingDeltas();
  await flushDeltas();

  return await responsePromise;
}

// ---------------------------------------------------------------------------
// Log raw model response
// ---------------------------------------------------------------------------

function logRawResponse(
  ctx: ExecutorContext,
  turnNumber: number,
  response: CollectedResponse,
  attempt?: string,
): void {
  ctx.log.debug('agent_turn_raw_response', {
    tenantId: ctx.job.tenantId,
    runId: ctx.runId,
    stepExecutionId: ctx.job.stepExecutionId,
    turnNumber,
    ...(attempt ? { attempt } : {}),
    model: response.model,
    provider: response.provider,
    finishReason: response.finishReason,
    hasContent: response.content !== null && response.content !== '',
    contentLength: response.content?.length ?? 0,
    toolCallCount: response.toolCalls?.length ?? 0,
    toolCallNames: response.toolCalls?.map((tc) => tc.function.name) ?? [],
    promptTokens: response.usage?.promptTokens,
    completionTokens: response.usage?.completionTokens,
    totalTokens: response.usage?.totalTokens,
  });
}

// ---------------------------------------------------------------------------
// Map model response → AgentModelExecutionResult (shared by first + retry)
// ---------------------------------------------------------------------------

function buildResultFromResponse(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  response: CollectedResponse,
  fnNameToToolId: Map<string, string>,
  requestSnapshot: Array<ReturnType<typeof chatMessageToAiMessage>>,
  sanitized: ChatMessage[],
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  extraSummary?: string[],
): Promise<AgentModelExecutionResult> | AgentModelExecutionResult {
  const responseForMapping = {
    content: response.content,
    toolCalls: response.toolCalls ?? undefined,
    finishReason: response.finishReason,
  };
  const rawContent = buildRawContentFromResponse(responseForMapping);

  // Warn when the model returned no usable content — critical diagnostic signal
  const hasToolCalls = (response.toolCalls?.length ?? 0) > 0;
  const hasContent = response.content !== null && response.content.trim() !== '';
  if (!hasToolCalls && !hasContent) {
    ctx.log.warn('agent_turn_empty_response', {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      finishReason: response.finishReason,
      model: response.model,
      provider: response.provider,
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
    });
  }

  try {
    const mappingResult = mapToolCallsToDecision(
      responseForMapping,
      fnNameToToolId,
      params.policy.maxToolCallsPerTurn,
      {
        allowComplete: params.policy.allowComplete,
        ...(params.requestInputPolicy ? { requestInputPolicy: params.requestInputPolicy } : {}),
        availableTools: params.availableTools,
      },
    );

    const decisionLogPayload = {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      action: mappingResult.decision.action,
      warnings: mappingResult.warnings.length > 0 ? mappingResult.warnings : undefined,
    };
    if (mappingResult.warnings.length > 0) {
      ctx.log.info('agent_turn_decision_mapped', decisionLogPayload);
    } else {
      ctx.log.debug('agent_turn_decision_mapped', decisionLogPayload);
    }

    const META_FNS = new Set(['pause_for_input', 'complete']);
    const sigs = (response.toolCalls ?? [])
      .filter((tc) => !META_FNS.has(tc.function.name))
      .map((tc) => tc.thoughtSignature);
    let toolCallSignatures: string[] | undefined;
    if (sigs.some((s) => s !== undefined)) {
      toolCallSignatures = sigs.map((s) => s ?? '');
    }

    // Attach native model thinking when present. Safe across the discriminated
    // union — every variant accepts an optional `thinking` field. Today only
    // the non-streaming generateJson path populates `response.thinking`; the
    // streaming path leaves it undefined, in which case this is a no-op.
    const decision: AgentTurnDecision =
      response.thinking !== undefined
        ? ({ ...mappingResult.decision, thinking: response.thinking } as AgentTurnDecision)
        : mappingResult.decision;

    return {
      decision,
      rawContent,
      ...(mappingResult.truncatedToolArgs ? { truncatedToolArgs: true } : {}),
      usage: response.usage,
      model: response.model,
      ...(response.cost !== undefined ? { cost: response.cost } : {}),
      ...(response.provider !== undefined ? { provider: response.provider } : {}),
      ...(toolCallSignatures !== undefined ? { toolCallSignatures } : {}),
      ...(response.providerReasoning !== undefined
        ? { providerReasoning: response.providerReasoning }
        : {}),
      requestSnapshot,
      ...(extraSummary ? { decisionAttemptSummary: extraSummary } : {}),
    };
  } catch (mappingError) {
    const reason = mappingError instanceof Error ? mappingError.message : String(mappingError);
    ctx.log.warn('native_fc_fallback_to_generate_json', {
      reason: 'native_fc_response_mapping_failed',
      message: reason,
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      model: response.model,
      provider: response.provider,
    });

    return (async () => {
      const jsonResult = await runGenerateJsonPath(ctx, params, deps, client, model, sanitized);
      return {
        ...jsonResult,
        nativeFcFallbackReason: 'native_fc_response_mapping_failed' as const,
        decisionAttemptSummary: [
          ...(extraSummary ?? []),
          'native_fc_mapping_failed',
          'fell_back_to_generate_json',
          ...(jsonResult.decisionAttemptSummary ?? []),
        ],
      };
    })();
  }
}

async function runGenerateJsonPath(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  merged: ChatMessage[],
): Promise<AgentModelExecutionResult> {
  const agentDecisionJsonSchema = buildAgentDecisionRawJsonSchema(params);
  const modelDef = client.getModel(model);
  const googleTimeout =
    modelDef?.provider === 'google' ? { timeoutMs: GOOGLE_AGENT_TURN_TIMEOUT_MS } : {};

  const reasoning = params.reasoningEffort ? { effort: params.reasoningEffort } : undefined;
  // `generateJson` is non-streaming on every provider, so `onStreamProgress`
  // below is never called and the deadline cannot slide while the model works —
  // yet `signal` still aborts it. Ticking here is the only thing standing
  // between this fallback and a guaranteed cut on any generation longer than
  // the idle window.
  ctx.reportProgress?.();
  const response = await client.generateJson({
    model,
    messages: merged,
    resolveToolImage: toolImageResolver(ctx),
    schema: z.unknown(),
    schemaName: 'agent_turn_decision',
    rawJsonSchema: agentDecisionJsonSchema,
    strictJsonSchema: false,
    temperature: params.temperature ?? 0.1,
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...googleTimeout,
    tenantId: ctx.job.tenantId as TenantId,
    runId: ctx.runId,
    stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
    attempt: ctx.job.attempt,
    signal: ctx.signal,
    onStreamProgress: ctx.reportProgress,
    maxRetries: 0,
  });

  const rawDecision = response.data as Record<string, unknown>;
  // Native model thinking — chain-of-thought from reasoning-capable models.
  // Surfaces alongside (not as part of) the JSON decision the model produced.
  // Safe to inject post-parse: the JSON schema sent to the model does not
  // include `thinking`, so the model never sees it as a request to fill.
  if (response.thinking !== undefined && rawDecision['thinking'] === undefined) {
    rawDecision['thinking'] = response.thinking;
  }
  const outcome = await parseGenerateJsonAgentDecision(
    ctx,
    deps,
    client,
    model,
    merged,
    params,
    {
      usage: response.usage,
      ...(response.cost !== undefined ? { cost: response.cost } : {}),
      model: response.model,
      provider: response.provider,
    },
    rawDecision,
    response.rawContent,
  );

  return {
    decision: outcome.decision,
    rawContent: outcome.rawContent,
    usage: outcome.usage,
    model: outcome.model,
    ...(outcome.cost !== undefined ? { cost: outcome.cost } : {}),
    provider: outcome.provider,
    requestSnapshot: outcome.requestSnapshot ?? merged.map(chatMessageToAiMessage),
    ...(outcome.attemptNotes.length > 0 ? { decisionAttemptSummary: outcome.attemptNotes } : {}),
  };
}
