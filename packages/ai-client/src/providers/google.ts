/**
 * Google Gemini provider adapter.
 * Uses the @google/genai SDK for Gemini 2.0+ models.
 */
import { GoogleGenAI, type Content, type Part, type FunctionDeclaration } from '@google/genai';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateEmbeddingResponse,
  GenerateImageRequest,
  GenerateImageResponse,
  EditImageRequest,
  StreamingResponse,
  ProviderConfig,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  TextStreamChunk,
  TokenUsage,
  FinishReason,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { createDefaultModelCatalog } from '../catalog.js';
import { AIClientError, buildStreamTruncationError } from '../errors.js';
import { moveToolImagesToUserMessages, toolResultText } from './toolResultContent.js';
import {
  DEFAULT_TIMEOUT_MS,
  EMBED_TIMEOUT_MS,
  STREAM_INIT_TIMEOUT_MS,
  normalizeGoogleError,
  requestOrConfigTimeout,
  withTimeout,
} from './googleShared.js';
import { createGoogleVideoAdapter } from './googleVideo.js';
import { refuseImageReferences } from './imageReferences.js';
import { parseJsonResponse } from './jsonResponseParse.js';
import { TRUNCATED_HISTORY_USER_BRIDGE_TEXT } from './wireIntegrity.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export { normalizeGoogleError } from './googleShared.js';

/**
 * Normalize a Gemini `functionCall` content part to our ToolCall shape.
 * Shared by non-streaming and streaming generation.
 */
function toolCallFromGeminiPart(part: Part): ToolCall | undefined {
  // `'key' in part` is true even when the value is null/undefined —
  // Gemini/Vertex responses can include the property with a nullish
  // value (codex P1 review). Require a truthy `functionCall` before
  // dereferencing.
  if (!('functionCall' in part) || !part.functionCall) {
    return undefined;
  }
  const fc = part.functionCall;
  const rawArgs = fc.args;
  // `typeof null === 'object'` (JS quirk) — a Gemini function call with
  // no args (common for no-arg tools) returns `args: null`, and without
  // the explicit `rawArgs !== null` guard we'd emit `JSON.stringify(null)
  // === '"null"'` and break downstream tool-call validation (codex P1
  // review). Treat null/undefined as "no args" and synthesize an empty
  // object fallback.
  const normalizedArgs: Record<string, unknown> =
    rawArgs !== undefined &&
    rawArgs !== null &&
    typeof rawArgs === 'object' &&
    !Array.isArray(rawArgs)
      ? rawArgs
      : { value: rawArgs ?? {} };
  const thoughtSig =
    'thoughtSignature' in part && typeof part.thoughtSignature === 'string'
      ? part.thoughtSignature
      : undefined;
  return {
    id: fc.id ?? `call_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
    type: 'function',
    function: {
      name: fc.name ?? '',
      arguments: JSON.stringify(normalizedArgs),
    },
    ...(thoughtSig !== undefined ? { thoughtSignature: thoughtSig } : {}),
  };
}

// ============================================================================
// JSON Schema Helpers
// ============================================================================

/**
 * Sanitise a JSON Schema for Gemini's `responseJsonSchema` endpoint.
 *
 * 1. Remove unsupported keywords ($ref, $defs, $schema, $id, definitions, $comment).
 * 2. Convert `type: ["string", "null"]` shorthand into explicit
 *    `anyOf: [{ type: "string" }, { type: "null" }]` — Gemini's backend
 *    does not accept array-valued `type` fields.
 * 3. Normalize `oneOf` → `anyOf` (Gemini accepts `anyOf`, not `oneOf`).
 * 4. Ensure every property object has an explicit `type` (Gemini requires it).
 */
export function sanitizeJsonSchemaForGemini(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const unsupported = new Set(['$ref', '$defs', '$schema', '$id', 'definitions', '$comment']);

  function clean(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(clean);
    if (typeof obj !== 'object') return obj;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (unsupported.has(key)) continue;
      result[key] = clean(value);
    }

    // Gemini accepts `anyOf` but not `oneOf` — normalize (branches cleaned above).
    if (Array.isArray(result['oneOf'])) {
      const existing = Array.isArray(result['anyOf']) ? (result['anyOf'] as unknown[]) : [];
      result['anyOf'] = [...existing, ...(result['oneOf'] as unknown[])];
      delete result['oneOf'];
    }

    // Convert type arrays → anyOf
    // e.g. { type: ["string", "null"], description: "..." }
    //   →  { anyOf: [{type:"string"},{type:"null"}], description: "..." }
    if (Array.isArray(result['type'])) {
      const types = result['type'] as string[];
      if (types.length === 1) {
        // Single-element array — just unwrap
        result['type'] = types[0];
      } else {
        // Multi-type → anyOf
        const { type: _removed, ...rest } = result;
        const anyOf = types.map((t) => ({ type: t }));
        return { anyOf, ...rest };
      }
    }

    return result;
  }

  return clean(schema) as Record<string, unknown>;
}

// ============================================================================
// Message Conversion
// ============================================================================

// ============================================================================
// Gemini 3.x sampling / thinking helpers
// ============================================================================

/**
 * Gemini 3.x models are optimized for default sampling — Google explicitly
 * recommends NOT passing temperature, topP, or topK on Gemini 3 and 3.5.
 * They still use `thinkingConfig.thinkingLevel` (the replacement for the
 * deprecated `thinkingBudget`) to control reasoning depth.
 */
function isGemini3xModel(modelId: string): boolean {
  return /gemini[- ]?3(\.\d+)?/i.test(modelId);
}

/**
 * Map our `ReasoningEffort` to Gemini's `thinking_level` enum.
 *
 * Gemini cannot stop thinking on any 3.x model, so `off` means the lowest level
 * the model offers rather than none. Which levels those are is a catalog fact —
 * the Pro tier takes only LOW and HIGH — and the effort arrives here already
 * clamped to the model's supported set.
 */
function toGeminiThinkingLevel(
  effort: 'off' | 'low' | 'medium' | 'high' | undefined,
): 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  switch (effort) {
    case 'off':
      return 'MINIMAL';
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
    case undefined:
      return undefined;
  }
}

interface GeminiCommonRequest {
  model: string;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stopSequences?: string[] | undefined;
  reasoning?: { effort?: 'off' | 'low' | 'medium' | 'high' | undefined } | undefined;
}

/**
 * Build the base `generateConfig` shared by generateText, generateTextStream,
 * and generateJson. Applies Gemini 3.x sampling rules and maps reasoning effort
 * to `thinkingConfig.thinkingLevel`.
 */
function buildGeminiGenerateConfig(request: GeminiCommonRequest): Record<string, unknown> {
  const generateConfig: Record<string, unknown> = {};
  const isGemini3x = isGemini3xModel(request.model);

  if (request.maxTokens !== undefined) {
    generateConfig['maxOutputTokens'] = request.maxTokens;
  }
  // Per Google's Gemini 3.x guidance, temperature/topP/topK are no longer
  // recommended — the model is tuned for default sampling. We pass through
  // only for older Gemini (2.x) models.
  if (request.temperature !== undefined && !isGemini3x) {
    generateConfig['temperature'] = request.temperature;
  }
  if (request.stopSequences !== undefined) {
    generateConfig['stopSequences'] = request.stopSequences;
  }

  // `thinkingLevel` is a 3.x field. Gemini 2.5 sizes thinking with
  // `thinkingBudget` instead and does not read this one, so sending it there
  // configures nothing while looking like it did.
  const thinkingLevel = isGemini3x ? toGeminiThinkingLevel(request.reasoning?.effort) : undefined;
  if (thinkingLevel) {
    generateConfig['thinkingConfig'] = { thinkingLevel };
  }

  return generateConfig;
}

/**
 * Convert our ChatMessage to Gemini Content format.
 * Returns system instruction separately as Gemini handles it differently.
 */
export function toGeminiContents(
  input: ChatMessage[],
  options?: { nativeFunctionCalling?: boolean },
): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  const nativeFC = options?.nativeFunctionCalling === true;
  const messages = moveToolImagesToUserMessages(input, 'google');
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  // Sigs go stale after context drift; keep real sig only on last asst FC turn.
  // (Plan 259 note: widening this window to the active tool loop was reverted —
  // Phoenix keeps only `keepRecentTurns` verbatim, and clearing/compaction drift
  // the pre-context of older windowed turns, so their replayed signatures would
  // 400. Safe widening needs the deferred clearing-range-aligned reasoning
  // retention; until then Gemini tool_loop continuity is capability-gated off.)
  let lastAsstFCIdx = -1;
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k]!;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      lastAsstFCIdx = k;
      break;
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    switch (message.role) {
      case 'system':
        // Concatenate all system messages (e.g., main prompt + context blocks)
        // into a single systemInstruction. Previously this was an overwrite,
        // which caused the main agent instructions to be silently lost when
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${message.content}`
          : message.content;
        break;

      case 'user': {
        const parts: Part[] = [];
        if (typeof message.content === 'string') {
          parts.push({ text: message.content });
        } else {
          for (const part of message.content) {
            if (part.type === 'text') {
              parts.push({ text: part.text });
            } else {
              if (part.source.type === 'base64') {
                parts.push({
                  inlineData: {
                    mimeType: part.source.mediaType,
                    data: part.source.data,
                  },
                });
              } else {
                parts.push({
                  fileData: {
                    mimeType: 'image/jpeg',
                    fileUri: part.source.url,
                  },
                });
              }
            }
          }
        }
        contents.push({ role: 'user', parts });
        break;
      }

      case 'assistant': {
        const parts: Part[] = [];
        if (message.content) {
          parts.push({ text: message.content });
        }
        if (message.toolCalls) {
          if (nativeFC) {
            // Native function calling: produce functionCall parts
            for (const tc of message.toolCalls) {
              // Gemini requires args to be a Struct (JSON object), never an array.
              // Defensive: if the model returned non-object args, wrap them.
              let parsedArgs: Record<string, unknown>;
              try {
                const raw: unknown = JSON.parse(tc.function.arguments) as unknown;
                parsedArgs =
                  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
                    ? (raw as Record<string, unknown>)
                    : { value: raw };
              } catch {
                parsedArgs = {};
              }
              parts.push({
                functionCall: { name: tc.function.name, args: parsedArgs },
                thoughtSignature:
                  (i === lastAsstFCIdx && tc.thoughtSignature) ||
                  'skip_thought_signature_validator',
              });
            }
          } else {
            // No tools declared: render tool calls as text so the model
            // sees the history without Gemini rejecting functionCall parts.
            for (const tc of message.toolCalls) {
              parts.push({
                text: `[Called ${tc.function.name}(${tc.function.arguments})]`,
              });
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
        break;
      }

      case 'tool': {
        if (nativeFC) {
          // Native function calling: produce functionResponse parts.
          // Gemini requires ALL function responses for a turn in a single
          // Content. Collect consecutive tool messages into one user Content.
          const toolParts: Part[] = [];
          let j = i;
          while (j < messages.length && messages[j]!.role === 'tool') {
            const toolMsg = messages[j] as Extract<ChatMessage, { role: 'tool' }>;
            toolParts.push({
              functionResponse: {
                id: toolMsg.toolCallId,
                name: toolMsg.name ?? toolMsg.toolCallId,
                response: { result: toolResultText(toolMsg, 'google') },
              },
            });
            j++;
          }
          contents.push({ role: 'user', parts: toolParts });
          i = j - 1; // outer loop will increment
        } else {
          // No tools declared: render tool results as plain user text.
          // Collect consecutive tool messages to avoid multiple user Contents.
          const textParts: string[] = [];
          let j = i;
          while (j < messages.length && messages[j]!.role === 'tool') {
            const toolMsg = messages[j] as Extract<ChatMessage, { role: 'tool' }>;
            const name = toolMsg.name ?? toolMsg.toolCallId;
            textParts.push(`[Result from ${name}]: ${toolResultText(toolMsg, 'google')}`);
            j++;
          }
          contents.push({ role: 'user', parts: [{ text: textParts.join('\n\n') }] });
          i = j - 1;
        }
        break;
      }
    }
  }

  // Gemini requires strictly alternating user/model roles. Merge consecutive
  const merged: Content[] = [];
  for (const content of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === content.role) {
      const prevHasFR = prev.parts?.some((p) => 'functionResponse' in p);
      const curHasFR = content.parts?.some((p) => 'functionResponse' in p);
      if (prevHasFR !== curHasFR) {
        // Can't merge functionResponse with non-functionResponse content.
        // Insert a synthetic model turn to maintain strict role alternation.
        // Use minimal descriptive text — empty string risks teaching the model
        // to produce empty responses.
        const bridgeRole = prev.role === 'user' ? 'model' : 'user';
        merged.push({ role: bridgeRole, parts: [{ text: '[Processed tool results]' }] });
        merged.push({ ...content, parts: [...(content.parts ?? [])] });
      } else {
        prev.parts = [...(prev.parts ?? []), ...(content.parts ?? [])];
      }
    } else {
      merged.push({ ...content, parts: [...(content.parts ?? [])] });
    }
  }

  // A windowed history can open on an assistant turn (its leading user atom
  // evicted), and all system messages are hoisted into systemInstruction — so
  // contents[0] would be a model turn. Gemini requires the first content to be
  // user-role, and rejects a functionCall turn that does not immediately follow
  // a user or functionResponse turn (live 400, run e4c5061e). Bridge with a
  // neutral user turn instead of mutating stored history.
  if (merged[0]?.role === 'model') {
    merged.unshift({ role: 'user', parts: [{ text: TRUNCATED_HISTORY_USER_BRIDGE_TEXT }] });
  }

  return { systemInstruction, contents: merged };
}

/**
 * Build the image-generation turn. Each reference is announced by a text part
 * before its bytes — Gemini addresses references positionally, and an
 * unannounced stack of images gives the prompt no way to say which one is the
 * character and which is the palette.
 *
 * A model that declares no `imageReferences` capability is refused rather than
 * sent the prompt alone: the response would be a plausible image carrying none
 * of the requested consistency, and nothing downstream can tell the difference.
 */
export function toReferenceConditionedContents(request: GenerateImageRequest): string | Content[] {
  const references = request.references ?? [];
  if (references.length === 0) return request.prompt;

  if (
    createDefaultModelCatalog().getModel(request.model)?.capabilities.imageReferences === undefined
  ) {
    refuseImageReferences(request, 'google', 'this model generates from the prompt alone');
  }

  const parts: Part[] = [];
  for (const reference of references) {
    const announcement =
      reference.label === undefined
        ? `${reference.role} reference:`
        : `${reference.role} reference — ${reference.label}:`;
    parts.push({ text: announcement });
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data } });
  }
  parts.push({ text: request.prompt });

  return [{ role: 'user', parts }];
}

/**
 * Convert our ToolDefinition to Gemini FunctionDeclaration.
 */
function toGeminiFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
  const decl: FunctionDeclaration = {
    name: tool.function.name,
    parametersJsonSchema: tool.function.parameters,
  };
  if (tool.function.description !== undefined) {
    decl.description = tool.function.description;
  }
  return decl;
}

/**
 * Convert Gemini finish reason to our format.
 */
function fromGeminiFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    case 'RECITATION':
      return 'content_filter';
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

/**
 * Reasons a retry cannot change. Each names a judgement the model made about
 * the content itself, so the identical request gets the identical answer.
 *
 * Everything outside this set — an unspecified failure, or none reported at
 * all — states no cause a retry could not clear, and the same request has been
 * observed succeeding on a later attempt. Refusing to retry those turns a
 * transient answer into a failed run.
 */
const TERMINAL_IMAGE_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'RECITATION',
  'IMAGE_RECITATION',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'LANGUAGE',
]);

/**
 * The refusal an image turn that produced no image has to carry.
 *
 * The reason lives on the candidate and the model's own explanation lives in
 * the text parts, so an error reporting neither says only that nothing came
 * back — which is the one thing the caller already knows.
 */
export function noImageReturned(params: {
  response: { candidates?: Array<{ finishReason?: string }> | undefined };
  revisedPrompt: string | undefined;
  surface: string;
}): AIClientError {
  const finishReason = params.response.candidates?.[0]?.finishReason;
  const said = params.revisedPrompt?.trim();
  const detail = [
    finishReason === undefined ? undefined : `finishReason ${finishReason}`,
    said === undefined || said.length === 0 ? undefined : `the model said: ${said}`,
  ].filter((part): part is string => part !== undefined);

  return new AIClientError(
    `Gemini ${params.surface} returned no image` +
      (detail.length > 0 ? ` — ${detail.join('; ')}` : ''),
    'provider_error',
    'google',
    finishReason === undefined || !TERMINAL_IMAGE_FINISH_REASONS.has(finishReason),
  );
}

// ============================================================================
// Google Adapter Implementation
// ============================================================================

/**
 * Create a Google Gemini provider adapter.
 */
export function createGoogleAdapter(config: ProviderConfig): AIProviderAdapter {
  if (!config.apiKey) {
    throw new AIClientError('Google API key is required', 'auth', 'google', false);
  }

  const client = new GoogleGenAI({
    apiKey: config.apiKey,
  });

  return {
    provider: 'google',

    async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
      try {
        const hasTools = request.tools !== undefined && request.tools.length > 0;
        const { systemInstruction, contents } = toGeminiContents(request.messages, {
          nativeFunctionCalling: hasTools,
        });

        const generateConfig = buildGeminiGenerateConfig(request);

        // Add tools if provided
        if (request.tools && request.tools.length > 0) {
          generateConfig['tools'] = [
            {
              functionDeclarations: request.tools.map(toGeminiFunctionDeclaration),
            },
          ];
        }

        if (systemInstruction) {
          generateConfig['systemInstruction'] = systemInstruction;
        }

        const response = await withTimeout(
          client.models.generateContent({
            model: request.model,
            contents,
            config: generateConfig,
          }),
          requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, DEFAULT_TIMEOUT_MS),
          'generateText',
        );

        // Extract text and function calls from response.
        // Preserve the model's function call IDs — Gemini uses them to match responses.
        let textContent = '';
        let thinkingContent = '';
        const toolCalls: ToolCall[] = [];

        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('text' in part && part.text && (part as { thought?: boolean }).thought) {
                thinkingContent += part.text;
              } else if ('text' in part && part.text) {
                textContent += part.text;
              }
              const tc = toolCallFromGeminiPart(part);
              if (tc) {
                toolCalls.push(tc);
              }
            }
          }
        }

        const geminiCached = (response.usageMetadata as Record<string, unknown> | undefined)?.[
          'cachedContentTokenCount'
        ] as number | undefined;
        const usage: TokenUsage = {
          promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
          ...(geminiCached && geminiCached > 0
            ? {
                cacheReadTokens: geminiCached,
                uncachedPromptTokens:
                  (response.usageMetadata?.promptTokenCount ?? 0) - geminiCached,
              }
            : {}),
        };

        const finishReason = response.candidates?.[0]?.finishReason;

        return {
          content: textContent || null,
          thinking: thinkingContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: fromGeminiFinishReason(finishReason),
          usage,
          model: request.model,
          provider: 'google',
        };
      } catch (error) {
        throw normalizeGoogleError(error);
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
        try {
          const hasTools = request.tools !== undefined && request.tools.length > 0;
          const { systemInstruction, contents } = toGeminiContents(request.messages, {
            nativeFunctionCalling: hasTools,
          });

          const generateConfig = buildGeminiGenerateConfig(request);

          if (request.tools && request.tools.length > 0) {
            generateConfig['tools'] = [
              {
                functionDeclarations: request.tools.map(toGeminiFunctionDeclaration),
              },
            ];
          }

          if (systemInstruction) {
            generateConfig['systemInstruction'] = systemInstruction;
          }

          const stream = await withTimeout(
            client.models.generateContentStream({
              model: request.model,
              contents,
              config: generateConfig,
            }),
            requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, STREAM_INIT_TIMEOUT_MS),
            'generateTextStream',
          );

          let textContent = '';
          let thinkingContent = '';
          /** Latest tool call per id — streaming may repeat or refine parts. */
          const toolCallsById = new Map<string, ToolCall>();
          let finishReason: FinishReason = 'stop';
          let sawFinishReason = false;
          let usage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          };
          const streamStartMs = Date.now();

          for await (const chunk of stream) {
            request.onStreamProgress?.();
            // Extract text from chunk
            if (chunk.candidates && chunk.candidates.length > 0) {
              const candidate = chunk.candidates[0];
              if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                  if ('text' in part && part.text && (part as { thought?: boolean }).thought) {
                    thinkingContent += part.text;
                    yield { type: 'thinking_delta', delta: part.text };
                  } else if ('text' in part && part.text) {
                    textContent += part.text;
                    yield { type: 'text_delta', delta: part.text };
                  }
                  const tc = toolCallFromGeminiPart(part);
                  if (tc) {
                    toolCallsById.set(tc.id, tc);
                    yield {
                      type: 'tool_call_delta',
                      toolCallId: tc.id,
                      toolCallName: tc.function.name,
                      toolCallArguments: tc.function.arguments,
                    };
                  }
                }
              }
              if (candidate?.finishReason) {
                finishReason = fromGeminiFinishReason(candidate.finishReason);
                sawFinishReason = true;
              }
            }

            if (chunk.usageMetadata) {
              const streamCached = (chunk.usageMetadata as Record<string, unknown>)[
                'cachedContentTokenCount'
              ] as number | undefined;
              usage = {
                promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
                totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
                ...(streamCached && streamCached > 0
                  ? {
                      cacheReadTokens: streamCached,
                      uncachedPromptTokens:
                        (chunk.usageMetadata.promptTokenCount ?? 0) - streamCached,
                    }
                  : {}),
              };
            }
          }

          if (!sawFinishReason) {
            throw buildStreamTruncationError({
              provider: 'google',
              model: request.model,
              signal: request.signal,
              startMs: streamStartMs,
              accumulatedChars: textContent.length,
              toolCallCount: toolCallsById.size,
            });
          }

          const streamedToolCalls =
            toolCallsById.size > 0 ? Array.from(toolCallsById.values()) : undefined;

          yield { type: 'usage', usage };
          yield { type: 'done', finishReason };

          resolveResponse({
            content: textContent || null,
            thinking: thinkingContent || undefined,
            toolCalls: streamedToolCalls,
            finishReason,
            usage,
            model: request.model,
            provider: 'google',
          });
        } catch (error) {
          const normalizedError = normalizeGoogleError(error);
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
        const { systemInstruction, contents } = toGeminiContents(request.messages);

        // Build JSON Schema for Gemini's responseSchema.
        // Gemini does NOT support $ref, $defs, $schema, or $id — the schema
        // must be fully inlined.
        let jsonSchema: Record<string, unknown>;

        if (request.rawJsonSchema) {
          // Caller provided a pre-built JSON Schema (e.g., agent turn handler).
          // Sanitize: strip unsupported keywords & convert type arrays to anyOf.
          jsonSchema = sanitizeJsonSchemaForGemini(request.rawJsonSchema);
        } else {
          // Convert from Zod — use $refStrategy "none" to avoid $ref references.
          jsonSchema = sanitizeJsonSchemaForGemini(
            zodToJsonSchema(request.schema, { $refStrategy: 'none' }) as Record<string, unknown>,
          );
        }

        const generateConfig: Record<string, unknown> = {
          ...buildGeminiGenerateConfig(request),
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
        };

        if (systemInstruction) {
          generateConfig['systemInstruction'] = systemInstruction;
        }

        const response = await withTimeout(
          client.models.generateContent({
            model: request.model,
            contents,
            config: generateConfig,
          }),
          requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, DEFAULT_TIMEOUT_MS),
          'generateJson',
        );

        // Extract JSON from response
        let jsonText = '';
        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('text' in part && part.text) {
                jsonText += part.text;
              }
            }
          }
        }

        // Parse and validate with Zod
        let parsed: unknown;
        try {
          parsed = parseJsonResponse(jsonText).parsed;
        } catch (err) {
          throw new AIClientError(
            `Failed to parse JSON response from Gemini: ${err instanceof Error ? err.message : String(err)}`,
            'invalid_request',
            'google',
            false,
            { cause: err },
          );
        }

        const validated = request.schema.safeParse(parsed);
        if (!validated.success) {
          throw new AIClientError(
            `JSON validation failed: ${validated.error.message}`,
            'invalid_request',
            'google',
            false,
          );
        }

        const jsonCached = (response.usageMetadata as Record<string, unknown> | undefined)?.[
          'cachedContentTokenCount'
        ] as number | undefined;
        const usage: TokenUsage = {
          promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
          ...(jsonCached && jsonCached > 0
            ? {
                cacheReadTokens: jsonCached,
                uncachedPromptTokens: (response.usageMetadata?.promptTokenCount ?? 0) - jsonCached,
              }
            : {}),
        };

        return {
          data: validated.data,
          rawContent: jsonText,
          finishReason: fromGeminiFinishReason(response.candidates?.[0]?.finishReason),
          usage,
          model: request.model,
          provider: 'google',
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeGoogleError(error);
      }
    },

    async generateEmbedding(request): Promise<GenerateEmbeddingResponse> {
      try {
        const inputs = Array.isArray(request.input) ? request.input : [request.input];

        // Gemini uses embedContent for embeddings
        const embeddings: number[][] = [];

        for (const text of inputs) {
          const response = await withTimeout(
            client.models.embedContent({
              model: request.model,
              contents: text,
            }),
            requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, EMBED_TIMEOUT_MS),
            'embedContent',
          );

          if (response.embeddings && response.embeddings.length > 0) {
            const embedding = response.embeddings[0];
            if (embedding?.values) {
              embeddings.push(embedding.values);
            }
          }
        }

        const dimensions = embeddings[0]?.length ?? 0;

        return {
          embeddings,
          usage: {
            promptTokens: inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
            completionTokens: 0,
            totalTokens: inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
          },
          model: request.model,
          provider: 'google',
          dimensions,
        };
      } catch (error) {
        throw normalizeGoogleError(error);
      }
    },

    // ========================================================================
    // Image Generation (Gemini Native / Nano Banana)
    // ========================================================================

    async generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse> {
      try {
        // Gemini image generation uses generateContent with responseModalities
        const generateConfig: Record<string, unknown> = {
          responseModalities: ['TEXT', 'IMAGE'],
        };

        // Image configuration
        const imageConfig: Record<string, unknown> = {};
        if (request.aspectRatio) {
          imageConfig['aspectRatio'] = request.aspectRatio;
        }
        if (request.size) {
          // Map size string to Gemini imageSize (1K, 2K, 4K)
          const sizeMap: Record<string, string> = {
            '1024x1024': '1K',
            '2048x2048': '2K',
            '4096x4096': '4K',
            '1K': '1K',
            '2K': '2K',
            '4K': '4K',
          };
          const mappedSize = sizeMap[request.size];
          if (mappedSize) {
            imageConfig['imageSize'] = mappedSize;
          }
        }
        if (request.n) {
          imageConfig['numberOfImages'] = request.n;
        }
        if (Object.keys(imageConfig).length > 0) {
          generateConfig['imageConfig'] = imageConfig;
        }

        if (request.temperature !== undefined) {
          generateConfig['temperature'] = request.temperature;
        }

        const response = await withTimeout(
          client.models.generateContent({
            model: request.model,
            contents: toReferenceConditionedContents(request),
            config: generateConfig,
          }),
          requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, DEFAULT_TIMEOUT_MS),
          'generateImage',
        );

        // Extract images from response parts
        const images: GenerateImageResponse['images'] = [];
        let revisedPrompt: string | undefined;

        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('text' in part && part.text) {
                revisedPrompt = part.text;
              }
              // `'inlineData' in part` is true even when the value is
              // null/undefined — guard before dereferencing (codex P1 review).
              if ('inlineData' in part && part.inlineData) {
                const { inlineData } = part;
                images.push({
                  data: inlineData.data ?? '',
                  mimeType: inlineData.mimeType ?? 'image/png',
                  revisedPrompt,
                });
              }
            }
          }
        }

        if (images.length === 0) {
          throw noImageReturned({ response, revisedPrompt, surface: 'image generation' });
        }

        return {
          images,
          model: request.model,
          provider: 'google',
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeGoogleError(error);
      }
    },

    async editImage(request: EditImageRequest): Promise<GenerateImageResponse> {
      try {
        // An edit turn already carries one unannounced image — the one being
        // edited. Adding references to it gives the model no way to tell which
        // image it is meant to change, so this surface refuses them even on a
        // model whose generation surface accepts them.
        refuseImageReferences(
          request,
          'google',
          'an edit conditions on the image being edited, and a reference is indistinguishable from it',
        );

        // Gemini image editing: send image + text prompt, get back edited image
        const generateConfig: Record<string, unknown> = {
          responseModalities: ['TEXT', 'IMAGE'],
        };

        const imageConfig: Record<string, unknown> = {};
        if (request.aspectRatio) {
          imageConfig['aspectRatio'] = request.aspectRatio;
        }
        if (Object.keys(imageConfig).length > 0) {
          generateConfig['imageConfig'] = imageConfig;
        }

        // Build multi-modal content: text + image
        const contents: Content[] = [
          {
            role: 'user',
            parts: [
              { text: request.prompt },
              {
                inlineData: {
                  mimeType: request.imageMimeType,
                  data: request.imageData,
                },
              },
            ],
          },
        ];

        const response = await withTimeout(
          client.models.generateContent({
            model: request.model,
            contents,
            config: generateConfig,
          }),
          requestOrConfigTimeout(request.timeoutMs, config.timeoutMs, DEFAULT_TIMEOUT_MS),
          'editImage',
        );

        const images: GenerateImageResponse['images'] = [];
        let revisedPrompt: string | undefined;

        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if ('text' in part && part.text) {
                revisedPrompt = part.text;
              }
              // `'inlineData' in part` is true even when the value is
              // null/undefined — guard before dereferencing (codex P1 review).
              if ('inlineData' in part && part.inlineData) {
                const { inlineData } = part;
                images.push({
                  data: inlineData.data ?? '',
                  mimeType: inlineData.mimeType ?? 'image/png',
                  revisedPrompt,
                });
              }
            }
          }
        }

        if (images.length === 0) {
          throw noImageReturned({ response, revisedPrompt, surface: 'image editing' });
        }

        return {
          images,
          model: request.model,
          provider: 'google',
        };
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        throw normalizeGoogleError(error);
      }
    },

    ...createGoogleVideoAdapter(client, config),
  };
}
