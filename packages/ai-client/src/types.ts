/**
 * Core types for the AI client layer.
 */
import { z } from 'zod';
import { StepImageSchema } from '@aflow/schemas';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  ImageReferenceRole,
  AsyncJobCost,
  StepImage,
  DecisionEntry,
  DecisionQuestions,
} from '@aflow/schemas';

// ============================================================================
// Message Types (Chat History)
// ============================================================================

/**
 * Role of a message in the conversation.
 */
export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * Content part for multi-modal messages.
 */
export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    /** Base64-encoded image data or URL */
    source: z.union([
      z.object({ type: z.literal('base64'), mediaType: z.string(), data: z.string() }),
      z.object({ type: z.literal('url'), url: z.string() }),
    ]),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

/**
 * An image a tool returned, still behind its payload reference. The client
 * turns each one into an `image` part or into text before any adapter sees the
 * request, so adapters only ever render `text` and `image`.
 */
export const ToolImageRefPartSchema = z.object({
  type: z.literal('image_ref'),
  image: StepImageSchema,
});
export type ToolImageRefPart = z.infer<typeof ToolImageRefPartSchema>;

/** Content part of a tool message. */
export const ToolContentPartSchema = z.discriminatedUnion('type', [
  ...ContentPartSchema.options,
  ToolImageRefPartSchema,
]);
export type ToolContentPart = z.infer<typeof ToolContentPartSchema>;

/** What reading a tool image's bytes produced. */
export type ToolImageResolution =
  { ok: true; data: string; mediaType: string } | { ok: false; reason: string };

/** Reads a tool image's bytes from its payload reference, as base64. */
export type ToolImageResolver = (image: StepImage) => Promise<ToolImageResolution>;

/**
 * Tool call made by the assistant.
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(), // JSON string
  }),
  /** Gemini 3 thought signature — must be preserved and replayed for function calling to work. */
  thoughtSignature: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Provider-native reasoning retained from an assistant turn (Plan 259).
 * `blocks` are opaque outside the producing provider's adapter codec — the
 * adapter that captured them is the only code that interprets and replays them.
 * Bound to `provider`+`model`; never replayed to a different provider/model.
 */
export const ProviderReasoningSchema = z.object({
  provider: z.enum(['anthropic', 'google', 'fireworks', 'openrouter', 'xai']),
  model: z.string(),
  blocks: z.array(z.unknown()),
});
export type ProviderReasoning = z.infer<typeof ProviderReasoningSchema>;

/**
 * Tool result from executing a tool.
 */
export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * A message in the conversation history.
 */
export const ChatMessageSchema = z.discriminatedUnion('role', [
  // System message
  z.object({
    role: z.literal('system'),
    content: z.string(),
  }),
  // User message (can be multi-modal)
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(ContentPartSchema)]),
  }),
  // Assistant message (may include tool calls)
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    toolCalls: z.array(ToolCallSchema).optional(),
    /**
     * Provider-native reasoning for this turn, replayed by the owning adapter
     * within an active tool-use exchange (Plan 259). Ignored by adapters other
     * than the one that produced it.
     */
    providerReasoning: ProviderReasoningSchema.optional(),
  }),
  // Tool result message (text, or text and images)
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string().optional(),
    content: z.union([z.string(), z.array(ToolContentPartSchema)]),
  }),
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * Tool definition for function calling.
 */
export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()), // JSON Schema
  }),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// ============================================================================

/**
 * Cache breakpoint configuration for prompt caching.
 * Currently used by Anthropic for explicit breakpoints.
 */
export interface CacheBreakpoint {
  type: 'ephemeral';
  /** Anthropic cache TTL — '5m' (default) or '1h' for longer-lived sessions */
  ttl?: '5m' | '1h' | undefined;
}

/**
 * Provider-aware prompt caching strategy.
 * When set on a request, the provider adapter applies cache_control markers
 * to stabilize the prompt prefix across turns.
 *
 * - `toolBreakpoint`: marks the last tool definition as a cache boundary
 * - `systemBreakpoint`: marks the last stable system block as a cache boundary
 * - `automatic`: enables request-level automatic caching for the growing tail
 */
export interface CacheStrategy {
  /** Enable automatic caching at request level (Anthropic beta header) */
  automatic?: CacheBreakpoint | undefined;
  /** Cache breakpoint on the last tool definition */
  toolBreakpoint?: CacheBreakpoint | undefined;
  /** Cache breakpoint on the last system block (instructions or stable context) */
  systemBreakpoint?: CacheBreakpoint | undefined;
  systemBreakpointCount?: number | undefined;
}

// ============================================================================
// Request Types
// ============================================================================

/**
 * OpenRouter provider routing preferences.
 * Used when provider is 'openrouter' to restrict which upstream providers handle the request.
 * @see https://openrouter.ai/docs/features/provider-routing
 */
export interface OpenRouterProviderRouting {
  /** Hard allowlist — only these provider slugs are eligible (e.g. ["cerebras", "groq"]). */
  only?: string[];
  /** Hard blocklist — these provider slugs are excluded. */
  ignore?: string[];
  /** Soft preference order — tried first, with fallbacks unless allow_fallbacks=false. */
  order?: string[];
  /** Whether to allow fallback to other providers when primary is unavailable. */
  allow_fallbacks?: boolean;
  /** Per-request data retention policy. 'deny' = only route to providers that don't log. */
  data_collection?: 'allow' | 'deny';
  /** Drop providers that silently ignore unsupported request params (tools, structured output, etc). */
  require_parameters?: boolean;
  /** Quantization allowlist (e.g. ["bf16","fp16"]) — excludes lower-precision hosts. */
  quantizations?: string[];
  /** Sort axis when no explicit order is given. */
  sort?: 'price' | 'throughput' | 'latency';
}

// ============================================================================
// Reasoning Configuration
// ============================================================================

/**
 * Reasoning effort level for reasoning-capable models.
 * Each provider maps this to its own param:
 * - OpenAI → `reasoning.effort` (Responses API)
 * - OpenRouter → `reasoning.effort`
 * - Fireworks → `reasoning_effort`
 * - Anthropic → adaptive thinking + `output_config.effort`
 * - Google → `thinkingConfig.thinkingLevel`
 *
 * Which rungs a given model accepts is a per-model fact carried by
 * `ModelReasoningProfile.supported`, not a property of this type — Gemini Pro
 * rejects `off`, for instance. Providers are handed an already-clamped effort
 * and map it total.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

/** The effort ladder in ascending order — the rungs `clampReasoningEffort` walks. */
export const REASONING_EFFORT_LADDER = ['off', 'low', 'medium', 'high'] as const;

/**
 * Per-call reasoning configuration. Resolution order at the call site:
 * `request.reasoning` (caller override) → `modelDefinition.reasoning` (catalog default).
 * When neither is set, the provider's own default applies.
 */
export interface ReasoningConfig {
  /**
   * Effort level — providers map to their own params. Adapters receive this
   * already clamped to the model's profile and map it total; an adapter that
   * second-guesses the value here would undo the clamp.
   */
  effort?: ReasoningEffort | undefined;
}

/**
 * What a specific model accepts on the effort ladder.
 *
 * `supported` is the authority every surface reads: the client clamps to it,
 * the catalog API publishes it, and the operator UI offers only its rungs.
 *
 * A rung belongs here when the provider accepts it for this model, and nowhere
 * else — omitting one the provider does accept caps quality with no error
 * anywhere, which is why these sets are measured by
 * `yarn models:verify-reasoning` rather than written from documentation.
 */
export interface ModelReasoningProfile {
  /**
   * Rungs the provider accepts for this model. Non-empty by construction: an
   * empty set would leave `clampReasoningEffort` with nothing to snap to, and
   * it would forward the unsupported rung — the provider 400 this exists to
   * prevent.
   */
  supported: readonly [ReasoningEffort, ...ReasoningEffort[]];
  /**
   * Rung applied when the caller names none. Omit to let the provider pick its
   * own default, which is the right choice when the provider's default is
   * already the one we want.
   */
  default?: ReasoningEffort;
}

/**
 * Common options for all AI requests.
 */
export interface AIRequestOptions {
  /** Model identifier (e.g., "gpt-4o", "claude-3-5-sonnet") */
  model: string;

  /** Provider to use (if not specified, inferred from model) */
  provider?: AIProvider | undefined;

  /** Maximum tokens to generate */
  maxTokens?: number | undefined;

  /** Temperature (0-2) */
  temperature?: number | undefined;

  /** Stop sequences */
  stopSequences?: string[] | undefined;

  /** Timeout in milliseconds */
  timeoutMs?: number | undefined;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /**
   * Called on every streamed chunk (content, tool-call, or thinking delta).
   * Lets the platform's stall detector distinguish a working stream from a
   * hung one — without it, a slow-but-live generation and a dead connection
   * are indistinguishable and both die at the flat wall clock.
   */
  onStreamProgress?: (() => void) | undefined;

  /** Per-request max retries override (SDK-level). Defaults to provider config. */
  maxRetries?: number | undefined;

  /** Tenant context */
  tenantId: TenantId;

  /** Run ID for usage tracking */
  runId: SessionId;

  /** Step execution context (for usage tracking) */
  stepExecutionId: StepExecutionId;

  /** Attempt number */
  attempt?: number | undefined;

  /**
   * OpenRouter provider routing. When set, restricts which upstream providers
   * handle the request. Populated from model catalog when using OpenRouter.
   */
  openRouterProvider?: OpenRouterProviderRouting | undefined;

  cacheStrategy?: CacheStrategy | undefined;

  /**
   * Reasoning configuration for reasoning-capable models. Caller override —
   * takes precedence over the catalog model's `reasoning` default. Has no
   * effect on models without `capabilities.reasoning`.
   */
  reasoning?: ReasoningConfig | undefined;
}

/**
 * Request for text generation.
 */
export interface GenerateTextRequest extends AIRequestOptions {
  messages: ChatMessage[];
  /** Reads the bytes of tool images the model is shown. Required when a tool message carries one. */
  resolveToolImage?: ToolImageResolver | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?:
    'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } } | undefined;
}

/**
 * Request for structured JSON generation.
 */
export interface GenerateJsonRequest<T = unknown> extends AIRequestOptions {
  messages: ChatMessage[];
  /** Reads the bytes of tool images the model is shown. Required when a tool message carries one. */
  resolveToolImage?: ToolImageResolver | undefined;
  /**
   * Parses and validates the model's JSON. The input type is left open so a
   * schema may COERCE what a provider actually sent — a nested array handed
   * over as JSON text, say — instead of discarding a whole response over a
   * serialisation difference the model does not control.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaName?: string | undefined;
  schemaDescription?: string | undefined;
  /**
   * Raw JSON Schema object. When provided, this is used instead of converting
   * the Zod schema for the provider's response_format. The Zod schema is still
   * used for response parsing/validation.
   */
  rawJsonSchema?: Record<string, unknown> | undefined;
  /**
   * Whether to enforce strict mode for the JSON Schema.
   * When true (default), OpenAI requires additionalProperties: false and
   * all properties in required. Set to false for flexible schemas.
   */
  strictJsonSchema?: boolean | undefined;
}

/**
 * Request for embeddings.
 */
export interface GenerateEmbeddingRequest extends AIRequestOptions {
  input: string | string[];
  dimensions?: number | undefined;
}

// ============================================================================
// Response Types
// ============================================================================

export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Tokens served from prompt cache (Anthropic cache_read, OpenAI cached_tokens) */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /** Tokens written to prompt cache on this request (Anthropic cache_creation) */
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  /** Tokens that were neither cached nor cache-written (Anthropic input_tokens) */
  uncachedPromptTokens: z.number().int().nonnegative().optional(),
  /**
   * Tokens spent on internal reasoning / chain-of-thought (subset of
   * `completionTokens`). Surfaced via
   * `usage.completion_tokens_details.reasoning_tokens` by OpenAI o-series,
   * OpenRouter, and Fireworks. Zero or undefined for non-reasoning models.
   */
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Cost breakdown.
 */
export const CostBreakdownSchema = z.object({
  promptCost: z.number().nonnegative(),
  completionCost: z.number().nonnegative(),
  mediaCost: z.number().nonnegative().optional(),
  totalCost: z.number().nonnegative(),
  currency: z.string().default('USD'),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

/**
 * Finish reason for generation.
 */
export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

/**
 * Response from text generation.
 */
export interface GenerateTextResponse {
  content: string | null;
  thinking?: string | undefined;
  toolCalls?: ToolCall[] | undefined;
  /**
   * Provider-native reasoning captured from this response for tool-use continuity
   * (Plan 259). Distinct from `thinking` (human-readable summary): these are the
   * exact opaque fragments the owning adapter replays on the next request. Set
   * only when the model emitted replayable reasoning.
   */
  providerReasoning?: ProviderReasoning | undefined;
  finishReason: FinishReason;
  usage: TokenUsage;
  cost?: CostBreakdown | undefined;
  model: string;
  provider: AIProvider;
  providerRequestId?: string | undefined;
}

/**
 * Response from JSON generation.
 */
export interface GenerateJsonResponse<T> {
  data: T;
  rawContent: string;
  /**
   * Native reasoning / thinking text from reasoning-capable models (deepseek,
   * Claude extended thinking, etc.). Distinct from any `reasoning` field the
   * caller may have included in the schema — this is the model's internal
   * chain-of-thought, surfaced when the provider exposes it. Undefined when
   * the model has no reasoning step or when the provider hides it (OpenAI
   * o-series exposes only token counts, not text).
   */
  thinking?: string | undefined;
  finishReason: FinishReason;
  usage: TokenUsage;
  cost?: CostBreakdown | undefined;
  model: string;
  provider: AIProvider;
  providerRequestId?: string | undefined;
}

/**
 * Response from embedding generation.
 */
export interface GenerateEmbeddingResponse {
  embeddings: number[][];
  usage: TokenUsage;
  cost?: CostBreakdown | undefined;
  model: string;
  provider: AIProvider;
  dimensions: number;
}

// ============================================================================
// Decision Types
// ============================================================================

export interface DecideRequest extends AIRequestOptions {
  state: DecisionEntry;
  questions: DecisionQuestions;
}

/**
 * A decision model's answer as the provider reports it. Whether the answer
 * clears a question's `minConfidence` is the operation's call, not the
 * provider's, so nothing here says so.
 */
export type ProviderDecisionAnswer =
  | {
      type: 'choice';
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: 'score';
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | { type: 'yes_no'; probability: number };

export interface DecideResponse {
  answers: Record<string, ProviderDecisionAnswer>;
  usage: TokenUsage;
  cost?: CostBreakdown | undefined;
  model: string;
  provider: AIProvider;
  providerRequestId?: string | undefined;
}

// ============================================================================
// Image Generation Types
// ============================================================================

/**
 * Request for image generation.
 */
/**
 * A reference image supplied to condition generation, already resolved to
 * bytes. Order is meaningful — providers address references positionally.
 */
export interface ImageReferenceInput {
  /** Base64-encoded reference image data */
  data: string;
  /** MIME type of the reference image */
  mimeType: string;
  /** What the model should take from this image */
  role: ImageReferenceRole;
  /** Name the prompt uses for this reference */
  label?: string | undefined;
}

export interface GenerateImageRequest extends AIRequestOptions {
  /** Text prompt describing the desired image */
  prompt: string;
  /** Reference images conditioning the generation, in reading order */
  references?: readonly ImageReferenceInput[] | undefined;
  /** Image size (e.g., "1024x1024", "1536x1024") */
  size?: string | undefined;
  /** Number of images to generate (1-10) */
  n?: number | undefined;
  /** Quality level (auto/low/medium/high for most; standard/hd for DALL-E 3) */
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd' | undefined;
  /** Aspect ratio (for providers that use it, e.g. Google: "1:1", "16:9") */
  aspectRatio?: string | undefined;
  /** Output format */
  outputFormat?: 'png' | 'jpeg' | 'webp' | undefined;
  /** Background transparency (OpenAI) */
  background?: 'transparent' | 'opaque' | 'auto' | undefined;
}

/**
 * Request for image editing.
 */
export interface EditImageRequest extends GenerateImageRequest {
  /** Base64-encoded source image data */
  imageData: string;
  /** MIME type of the source image */
  imageMimeType: string;
  /** Optional base64-encoded mask for inpainting */
  maskData?: string | undefined;
  /** MIME type of the mask */
  maskMimeType?: string | undefined;
}

/**
 * A single generated image result.
 */
export interface GeneratedImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g., "image/png") */
  mimeType: string;
  /** Revised prompt (if provider modified it) */
  revisedPrompt?: string | undefined;
}

/**
 * Response from image generation/editing.
 */
export interface GenerateImageResponse {
  images: GeneratedImage[];
  model: string;
  provider: AIProvider;
  /** Provider-specific metadata */
  providerMetadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// Video Generation Types
// ============================================================================

/**
 * Request for video generation.
 */
export interface GenerateVideoRequest extends AIRequestOptions {
  /** Text prompt describing the desired video */
  prompt: string;
  /** Negative prompt (what to avoid) */
  negativePrompt?: string | undefined;
  /** Duration in seconds */
  durationSeconds?: number | undefined;
  /** Aspect ratio (e.g., "16:9", "9:16") */
  aspectRatio?: string | undefined;
  /** Resolution (e.g., "720p", "1080p") */
  resolution?: string | undefined;
  /** Base64-encoded initial frame image */
  imageData?: string | undefined;
  /** MIME type of the initial frame image */
  imageMimeType?: string | undefined;
  /** Base64-encoded last frame image (for interpolation) */
  lastFrameData?: string | undefined;
  /** MIME type of the last frame image */
  lastFrameMimeType?: string | undefined;
  /**
   * Reference images conditioning the render, in reading order. A route that
   * groups them into named entities does so by `label`, so two images of one
   * character share a label rather than arriving as two identities.
   */
  references?: readonly ImageReferenceInput[] | undefined;
  /**
   * Deterministic dedupe key for the submit call. Only routes whose
   * `replayGuaranteeFor` names a mechanism act on it; the rest ignore it, which
   * is why a caller may never read idempotence into its mere presence.
   */
  clientRequestId?: string | undefined;
}

/**
 * A provider-side video job that outlives the request that created it.
 * `providerJobId` is the address a later poll uses, and it is all a fresh
 * process gets — anything a resume needs must be derivable from it.
 */
export interface VideoJobHandle {
  providerJobId: string;
}

/**
 * The state of a submitted video job. A poll is a read: it never bills, and it
 * never advances the provider's work.
 */
export type VideoJobPoll =
  | { status: 'pending' }
  | { status: 'succeeded'; response: GenerateVideoResponse }
  | { status: 'failed'; message: string };

export interface PollVideoJobRequest {
  handle: VideoJobHandle;
  model: string;
  /**
   * Echoed onto the returned videos. Neither Veo nor Sora reports the rendered
   * duration, so what the caller asked for is the only figure that exists.
   */
  durationSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * A single generated video result.
 */
export interface GeneratedVideo {
  /** Base64-encoded video data */
  data: string;
  /** MIME type (e.g., "video/mp4") */
  mimeType: string;
  /** Duration in seconds */
  durationSeconds?: number | undefined;
}

/**
 * Response from video generation.
 */
export interface GenerateVideoResponse {
  videos: GeneratedVideo[];
  model: string;
  provider: AIProvider;
  /**
   * What the provider states it billed, for the routes that state it at all.
   * It outranks anything this side derives from the catalog: the catalog is a
   * transcription of the provider's rate card, and a transcription goes stale
   * without anyone noticing. Absent for a route that reports no figure.
   */
  reportedCost?: AsyncJobCost | undefined;
  /** Provider-specific metadata */
  providerMetadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// Streaming Types
// ============================================================================

/**
 * Streaming chunk for text generation.
 */
export interface TextStreamChunk {
  type: 'text_delta' | 'thinking_delta' | 'tool_call_delta' | 'usage' | 'done';
  delta?: string | undefined;
  toolCallId?: string | undefined;
  toolCallName?: string | undefined;
  toolCallArguments?: string | undefined;
  usage?: TokenUsage | undefined;
  finishReason?: FinishReason | undefined;
}

/**
 * Streaming response wrapper.
 */
export interface StreamingResponse<T> {
  /** Async iterator for chunks */
  stream: AsyncIterable<TextStreamChunk>;

  /** Promise that resolves to final response */
  response: Promise<T>;
}

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Supported AI providers.
 */
export const AIProviderSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'fireworks',
  'xai',
  'runware',
  'typesafe',
  'local',
]);
export type AIProvider = z.infer<typeof AIProviderSchema>;

/**
 * Provider configuration.
 */
export interface ProviderConfig {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  project?: string | undefined;
  defaultModel?: string | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
}

// ============================================================================
// Model Catalog Types
// ============================================================================

/**
 * Model capability flags.
 */
export interface ModelCapabilities {
  /** Supports chat/conversation format */
  chat: boolean;
  /** Supports completion format (legacy) */
  completion: boolean;
  /** Supports embedding generation */
  embedding: boolean;
  /** Supports image input (vision) */
  vision: boolean;
  /** Supports audio input */
  audio: boolean;
  /** Supports function/tool calling */
  functionCalling: boolean;
  /** Supports JSON mode output */
  jsonMode: boolean;
  /** Supports streaming responses */
  streaming: boolean;
  /** Advanced reasoning capabilities (o3, o4-mini, Claude extended thinking) */
  reasoning?: boolean | undefined;
  /**
   * `false` when the provider **rejects** a sampling temperature for this model
   * — the whole GPT-6 family 400s on one, with or without a reasoning effort.
   * Absent means accepted. This is refusal, not advice: Gemini 3.x merely
   * recommends against setting temperature and its adapter handles that
   * separately, because a recommendation and a rejection want different
   * treatment.
   */
  samplingTemperature?: boolean | undefined;
  /**
   * `false` when the provider **rejects** a tool choice that forces a call —
   * `required` or a named tool — and accepts only `auto` or `none`. Absent
   * means accepted. The client degrades a forced choice to `auto` for such a
   * model rather than forwarding it and failing the request.
   */
  forcedToolChoice?: boolean | undefined;
  /** Tools can be used within chain-of-thought (o3/o4-mini) */
  toolInCoT?: boolean | undefined;
  /** Native structured outputs with JSON schema */
  structuredOutputs?: boolean | undefined;
  /** Built-in code interpreter/execution */
  codeInterpreter?: boolean | undefined;
  /** Built-in web search capability */
  webSearch?: boolean | undefined;
  /** Supports image generation/editing (output) */
  imageGeneration?: boolean | undefined;
  /** Supports video generation (output) */
  videoGeneration?: boolean | undefined;
  /**
   * Answers typed questions about a state (a choice, a rubric score, a yes/no)
   * with calibrated probabilities, and writes no text. A decision model serves
   * `decide` and nothing else.
   */
  decision?: boolean | undefined;
  /**
   * How many reference images the model honours per role. Absent when the
   * model conditions on the prompt alone — passing references to such a model
   * returns a plausible image with none of the requested consistency, so the
   * caller must refuse rather than drop them.
   */
  imageReferences?: Readonly<Record<ImageReferenceRole, number>> | undefined;
}

/**
 * Model pricing.
 *
 * Token-based models use `promptPer1M` / `completionPer1M`.
 * Media models may use `imagePerImage` / `videoPerSecond` instead (or in addition).
 */
/** The rates themselves, separated so a scheduled change can restate them. */
export interface ModelPriceRates {
  promptPer1M: number;
  completionPer1M: number;
  /**
   * Price per 1M cached-input (prompt-cache read) tokens, when the provider
   * meters cached reads at a fixed rate (Fireworks, OpenRouter). When unset,
   * cost falls back to the Anthropic/OpenAI convention of 10% of `promptPer1M`.
   */
  cachedPromptPer1M?: number;
  embeddingPer1M?: number;
  /** Cost per generated image in USD (standard quality / 1024×1024) */
  imagePerImage?: number;
  /** Cost per second of generated video in USD */
  videoPerSecond?: number;
}

export interface ModelPricing extends ModelPriceRates {
  currency: string;
  /**
   * Rates that replace the ones above from `effectiveFrom` onward.
   *
   * Introductory pricing reverts on an announced date, and a catalog that
   * knows only today's number goes quietly wrong the morning it lapses —
   * under-reporting spend on the surfaces that feed budgets. Encoding the
   * successor rates makes the change arrive on its own.
   */
  scheduled?: ModelPriceRates & {
    /** ISO-8601 instant the successor rates take effect. */
    effectiveFrom: string;
  };
}

/**
 * Qualitative traits that help users pick the right model at a glance.
 * Each numeric trait is on a 1–5 scale (1 = lowest, 5 = highest).
 */
export interface ModelTraits {
  /** 1 = very slow, 5 = blazing fast */
  speed?: number;
  /** 1 = very cheap, 5 = very expensive */
  cost?: number;
  /** 1 = basic, 5 = frontier intelligence */
  intelligence?: number;
  /** Primary output modality */
  outputType?: 'text' | 'image' | 'video' | 'audio' | 'embedding' | 'decision';
}

/**
 * Model definition in the catalog.
 */
export interface ModelDefinition {
  /** Unique key in the catalog (e.g., "gpt-6.1-sol", "openai/gpt-oss-120b") */
  id: string;
  /** Provider to route requests to */
  provider: AIProvider;
  /**
   * Actual model ID to send to the provider's API.
   * Defaults to `id` if not specified.
   * For OpenRouter, this is the full model path (e.g., "openai/gpt-oss-120b")
   */
  providerModelId?: string;
  displayName: string;
  description?: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  /** Qualitative traits for quick comparison (speed, cost, intelligence) */
  traits?: ModelTraits;
  /**
   * Clip length in seconds sent when the caller names none. Video bills per
   * second and no route reports the rendered length back, so without a figure
   * here the ordinary call — a prompt and nothing else — has no billable
   * quantity and records no cost at all. A model whose default length is not
   * known omits this and stays honestly unpriced.
   */
  defaultVideoDurationSeconds?: number;
  deprecated?: boolean;
  aliases?: string[];
  /**
   * OpenRouter provider routing. When set, restricts which upstream providers
   * handle requests for this model (e.g. only Cerebras, only Groq).
   */
  openRouterProvider?: OpenRouterProviderRouting;
  /**
   * Which reasoning efforts this model accepts, and which one applies when the
   * caller names none. Required on a chat model that declares
   * `capabilities.reasoning`, and absent everywhere else — a profile the client
   * never forwards is config that silently does nothing, and the effort ladder
   * is a text-generation control that no image or embedding path reads.
   */
  reasoning?: ModelReasoningProfile;
}

// ============================================================================
// Usage Tracking Types
// ============================================================================

/**
 * Usage record for a single AI call.
 */
export interface UsageRecord {
  id: string;
  tenantId: string;
  runId: string;
  stepExecutionId: string;
  attempt: number;
  provider: AIProvider;
  model: string;
  operation?:
    | 'generate_text'
    | 'generate_json'
    | 'generate_embedding'
    | 'generate_image'
    | 'generate_video'
    | 'decide'
    | 'call_tool'
    | undefined;
  usage: TokenUsage;
  cost: CostBreakdown;
  durationMs?: number | undefined;
  timestamp: string;
  providerRequestId?: string | undefined;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * AI-specific error codes.
 */
export const AIErrorCodeSchema = z.enum([
  'rate_limit',
  'auth',
  'invalid_request',
  'timeout',
  'content_filter',
  'context_length',
  'output_truncated', // Response hit max_tokens before completing (finish_reason='length')
  'model_not_found',
  'provider_error',
  'network_error',
  'network', // Low-level network failure
  'budget_exceeded', // Budget/quota exceeded
]);
export type AIErrorCode = z.infer<typeof AIErrorCodeSchema>;

/**
 * Normalized AI error.
 */
export interface AIError {
  code: AIErrorCode;
  message: string;
  provider?: AIProvider | undefined;
  providerErrorCode?: string | undefined;
  providerRequestId?: string | undefined;
  retryable: boolean;
  retryAfterMs?: number | undefined;
}
