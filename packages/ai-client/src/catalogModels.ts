/**
 * Built-in model definitions for the AI client catalog.
 *
 * Naming convention:
 * - Each model has a provider-specific `id` (sent to the API).
 * - Generic aliases (e.g. "gpt", "flash-lite", "opus") point to the latest
 *   version in that class. When a new version ships, move the generic alias.
 * - Version-pinned aliases (e.g. "gpt-6.1", "flash-3.8") let flows lock to a
 *   specific version.
 */
import { mediaRouteReferenceLimits } from '@aflow/schemas';
import type { ModelCapabilities, ModelDefinition, ModelPricing } from './types.js';

// ============================================================================
// Capability Templates
// ============================================================================

const defaultCapabilities: ModelCapabilities = {
  chat: true,
  completion: false,
  embedding: false,
  vision: false,
  audio: false,
  functionCalling: true,
  jsonMode: true,
  streaming: true,
};

/**
 * The Flash tier bills at Google's introductory rate, which reverts to standard
 * on 1 Jan 2027. Scheduled rather than hand-edited later so the increase does
 * not depend on someone remembering.
 */
const GEMINI_FLASH_PRICING: ModelPricing = {
  promptPer1M: 0.75,
  cachedPromptPer1M: 0.075,
  completionPer1M: 3.75,
  currency: 'USD',
  scheduled: {
    effectiveFrom: '2027-01-01T00:00:00Z',
    promptPer1M: 1.5,
    cachedPromptPer1M: 0.15,
    completionPer1M: 7.5,
  },
};

const embeddingCapabilities: ModelCapabilities = {
  chat: false,
  completion: false,
  embedding: true,
  vision: false,
  audio: false,
  functionCalling: false,
  jsonMode: false,
  streaming: false,
};

export const builtInModels: ModelDefinition[] = [
  // ============================================================================
  // OpenAI Text Models
  // ============================================================================
  {
    id: 'gpt-6-astra',
    provider: 'openai',
    displayName: 'GPT-6 Astra',
    description:
      'Frontier tier of the GPT-6 family — the most capable model OpenAI offers, for the most demanding reasoning and coding. 1M context. Vision, web search, file search, computer use.',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      samplingTemperature: false,
      structuredOutputs: true,
      webSearch: true,
    },
    pricing: { promptPer1M: 10, completionPer1M: 50, currency: 'USD' },
    traits: { speed: 2, cost: 5, intelligence: 5, outputType: 'text' },
    aliases: ['astra', 'openai-astra'],
    // Reasoning cannot be disabled on this tier: there is no `none`, so `off`
    // clamps to `low`. No default — the provider's own is the one we want. The
    // family also exposes `xhigh`/`max`, which the shared effort ladder has no
    // rung for.
    reasoning: { supported: ['low', 'medium', 'high'] },
  },
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    displayName: 'GPT-6.1 Sol',
    description:
      'Near-Astra performance for complex work at mid-range pricing. 1M context. Reasoning, vision, web search, file search, computer use.',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      samplingTemperature: false,
      structuredOutputs: true,
      webSearch: true,
    },
    pricing: { promptPer1M: 2, completionPer1M: 10, currency: 'USD' },
    traits: { speed: 3, cost: 3, intelligence: 5, outputType: 'text' },
    aliases: ['gpt', 'openai-gpt', 'sol', 'openai-sol', 'gpt-6.1'],
    // No `none` on this tier either; `off` clamps to `low`.
    reasoning: { supported: ['low', 'medium', 'high'] },
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    displayName: 'GPT-6 Luna',
    description:
      'Cost tier of the GPT-6 family, for focused, high-volume work. Same 1M context and tool surface as its siblings at a fraction of the price. Vision, web search, file search, computer use.',
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      samplingTemperature: false,
      structuredOutputs: true,
      webSearch: true,
    },
    pricing: { promptPer1M: 0.1, completionPer1M: 0.5, currency: 'USD' },
    traits: { speed: 5, cost: 1, intelligence: 4, outputType: 'text' },
    aliases: ['luna', 'openai-luna'],
    // The one tier of the family that accepts `none`, which `off` maps to.
    reasoning: { supported: ['off', 'low', 'medium', 'high'] },
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    displayName: 'GPT-5.4 Mini',
    description:
      'Balanced cost-performance. Strong at coding, instruction following, and structured output.',
    contextWindow: 400000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 0.75, cachedPromptPer1M: 0.075, completionPer1M: 4.5, currency: 'USD' },
    traits: { speed: 4, cost: 2, intelligence: 4, outputType: 'text' },
    aliases: ['gpt-mini', 'openai-mini'],
  },
  {
    id: 'gpt-5.4-nano',
    provider: 'openai',
    displayName: 'GPT-5.4 Nano',
    description:
      'Ultra-cheap model for high-volume simple tasks — classification, extraction, formatting.',
    contextWindow: 400000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 0.2, cachedPromptPer1M: 0.02, completionPer1M: 1.25, currency: 'USD' },
    traits: { speed: 5, cost: 1, intelligence: 3, outputType: 'text' },
    aliases: ['gpt-nano', 'openai-nano'],
  },

  // ============================================================================
  // OpenAI Embedding Models
  // ============================================================================
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    displayName: 'Text Embedding 3 Small',
    description: 'Cost-effective embedding model for semantic search',
    contextWindow: 8191,
    maxOutputTokens: 0,
    capabilities: embeddingCapabilities,
    pricing: { promptPer1M: 0.02, completionPer1M: 0, embeddingPer1M: 0.02, currency: 'USD' },
    traits: { speed: 5, cost: 1, outputType: 'embedding' },
  },
  {
    id: 'text-embedding-3-large',
    provider: 'openai',
    displayName: 'Text Embedding 3 Large',
    description: 'High-performance embedding model for best accuracy',
    contextWindow: 8191,
    maxOutputTokens: 0,
    capabilities: embeddingCapabilities,
    pricing: { promptPer1M: 0.13, completionPer1M: 0, embeddingPer1M: 0.13, currency: 'USD' },
    traits: { speed: 5, cost: 2, outputType: 'embedding' },
  },

  // ============================================================================
  // Decision Models
  // ============================================================================
  // Input is metered and output is not: the answer is a distribution over the
  // labels the caller supplied, not generated tokens.
  {
    id: 'jev-1.13.0',
    provider: 'typesafe',
    displayName: 'Jev 1.13',
    description:
      'Typed decisions about a state — a choice, a rubric score or a yes/no — with calibrated confidence. Writes no text.',
    contextWindow: 64_000,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: false,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      decision: true,
    },
    pricing: { promptPer1M: 0.042, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 5, cost: 1, outputType: 'decision' },
    aliases: ['jev'],
  },

  // ============================================================================
  // Anthropic Models
  // ============================================================================
  // Thinking cannot be disabled on Fable 5.1, Opus 5.5 or Sonnet 5.5 — an
  // explicit `disabled` is a 400 — so none has an `off` rung and `off` clamps
  // to `low`. All three also reject a sampling temperature and a forced tool
  // choice. They expose `xhigh`/`max` too, which the shared effort ladder has
  // no rung for.
  {
    id: 'claude-fable-5-1',
    provider: 'anthropic',
    displayName: 'Claude Fable 5.1',
    description:
      "Anthropic's most capable model, for demanding reasoning and long-horizon agentic work. 1M context, always-on adaptive thinking.",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      samplingTemperature: false,
      forcedToolChoice: false,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 10, cachedPromptPer1M: 0.25, completionPer1M: 50, currency: 'USD' },
    traits: { speed: 2, cost: 5, intelligence: 5, outputType: 'text' },
    aliases: ['fable', 'anthropic-fable', 'claude-fable'],
    reasoning: { supported: ['low', 'medium', 'high'] },
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 5.5',
    description:
      'Anthropic model for long-running agentic coding and knowledge work. 1M context, always-on adaptive thinking.',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      samplingTemperature: false,
      forcedToolChoice: false,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 4, cachedPromptPer1M: 0.2, completionPer1M: 20, currency: 'USD' },
    traits: { speed: 2, cost: 4, intelligence: 5, outputType: 'text' },
    aliases: ['opus', 'anthropic-opus', 'claude-opus'],
    // No default — left unset the provider reasons at `medium` on this model.
    reasoning: { supported: ['low', 'medium', 'high'] },
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5.5',
    description:
      'Balanced Anthropic model — the best combination of speed and intelligence for coding, analysis, and everyday agentic tasks. 1M context, adaptive thinking.',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      samplingTemperature: false,
      forcedToolChoice: false,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 2, cachedPromptPer1M: 0.2, completionPer1M: 10, currency: 'USD' },
    traits: { speed: 3, cost: 3, intelligence: 5, outputType: 'text' },
    aliases: ['sonnet', 'anthropic-sonnet', 'claude-sonnet'],
    reasoning: { supported: ['low', 'medium', 'high'] },
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    description: 'Fast and affordable model for simple tasks',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 1, cachedPromptPer1M: 0.1, completionPer1M: 5, currency: 'USD' },
    traits: { speed: 4, cost: 2, intelligence: 3, outputType: 'text' },
    aliases: ['haiku', 'anthropic-haiku', 'claude-haiku', 'claude-4.5-haiku'],
  },

  // ============================================================================
  // Google Text Models — Gemini (3 tiers: Pro, Flash, Flash Lite)
  // ============================================================================
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    displayName: 'Gemini Pro 3.1 (Preview)',
    description:
      'Most intelligent Gemini model for multimodal understanding, advanced reasoning, and complex agentic tasks. 1M context. Preview.',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      audio: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 2, cachedPromptPer1M: 0.2, completionPer1M: 12, currency: 'USD' },
    traits: { speed: 3, cost: 3, intelligence: 5, outputType: 'text' },
    aliases: [
      'pro',
      'google-pro',
      'gemini-pro',
      'gemini-3-pro',
      'gemini-3-pro-preview',
      'gemini-3.1-pro',
      'pro-3',
      'pro-3.1',
    ],
    // Thinking cannot be disabled on the Pro tier: MINIMAL is rejected outright,
    // so there is no `off` rung and `off` clamps to LOW. No default — Google's
    // own is HIGH.
    reasoning: { supported: ['low', 'medium', 'high'] },
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'google',
    displayName: 'Gemini 3.8 Flash',
    description:
      "Google's current Flash model. Built for long-horizon software engineering, autonomous agents, and complex enterprise workflows — higher quality on software-engineering and agentic benchmarks than 3.7. 1M context, 64k output, thinking. GA.",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      audio: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: GEMINI_FLASH_PRICING,
    traits: { speed: 4, cost: 2, intelligence: 5, outputType: 'text' },
    aliases: ['flash', 'google-flash', 'gemini-flash', 'gemini-3-flash', 'flash-3.8'],
    // MINIMAL is rejected outright on this tier, so there is no `off` rung and
    // `off` clamps to `low`.
    reasoning: { supported: ['low', 'medium', 'high'], default: 'medium' },
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    displayName: 'Gemini Flash Lite 3.5',
    description:
      'Cost-efficient model optimized for high-volume agentic tasks, document parsing, and subagent work. 1M context. GA.',
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      audio: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 0.3, cachedPromptPer1M: 0.03, completionPer1M: 2.5, currency: 'USD' },
    traits: { speed: 5, cost: 1, intelligence: 3, outputType: 'text' },
    aliases: ['flash-lite', 'google-flash-lite', 'flash-lite-3.5'],
    // `off` reaches MINIMAL here, the closest Gemini gets to no thinking.
    reasoning: { supported: ['off', 'low', 'medium', 'high'] },
  },

  // ============================================================================
  // Google Image Generation Models
  // ============================================================================
  {
    id: 'gemini-3.1-flash-image',
    provider: 'google',
    displayName: 'Gemini Flash Image 3.1',
    description:
      'Fast and efficient image generation. Token-based pricing: $0.50/1M input, ~$0.067/image at 1K.',
    contextWindow: 65536,
    maxOutputTokens: 32768,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      imageGeneration: true,
      structuredOutputs: true,
    },
    pricing: {
      promptPer1M: 0.5,
      completionPer1M: 60,
      imagePerImage: 0.067,
      currency: 'USD',
    },
    traits: { speed: 4, cost: 1, outputType: 'image' },
    aliases: ['flash-image', 'google-flash-image', 'nano-banana-2', 'flash-image-3.1'],
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'google',
    displayName: 'Gemini Pro Image 3',
    description:
      'Professional image generation with advanced reasoning, text rendering, thinking mode. Token-based pricing.',
    contextWindow: 65536,
    maxOutputTokens: 32768,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      imageGeneration: true,
      // This route's own ceiling, not the highest any route reaches: the
      // global maximum rises whenever a more generous route is wired, and a
      // model that then accepts more references than it reads drops the extras
      // from a render that has already been paid for.
      imageReferences: mediaRouteReferenceLimits('google-pro-image'),
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 1.25, completionPer1M: 5, currency: 'USD' },
    traits: { speed: 3, cost: 3, intelligence: 4, outputType: 'image' },
    aliases: ['pro-image', 'google-pro-image', 'nano-banana-pro', 'pro-image-3'],
  },

  // ============================================================================
  // Google Video Generation Models (Veo)
  // ============================================================================
  {
    id: 'veo-3.1-generate-preview',
    provider: 'google',
    displayName: 'Veo 3.1',
    description: 'State-of-the-art video generation with native audio. 8s videos at 720p/1080p.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: true,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      videoGeneration: true,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, videoPerSecond: 0.4, currency: 'USD' },
    defaultVideoDurationSeconds: 8,
    traits: { speed: 2, cost: 4, outputType: 'video' },
    aliases: ['veo', 'google-veo', 'veo-3.1', 'veo-3'],
  },
  {
    id: 'veo-3.1-fast-generate-preview',
    provider: 'google',
    displayName: 'Veo 3.1 Fast',
    description: 'Fast video generation optimized for speed and cost. Good for rapid iteration.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      videoGeneration: true,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, videoPerSecond: 0.15, currency: 'USD' },
    defaultVideoDurationSeconds: 8,
    traits: { speed: 3, cost: 3, outputType: 'video' },
    aliases: ['veo-fast', 'google-veo-fast', 'veo-3-fast'],
  },

  // ============================================================================
  // OpenAI Image Generation Models (GPT Image)
  // ============================================================================
  // No per-image rate is recorded for either: a render is reported unpriced
  // rather than at a figure carried over from the model it replaced.
  {
    id: 'gpt-image-2.5-sunburst',
    provider: 'openai',
    displayName: 'GPT-Image-2.5 Sunburst',
    description: "OpenAI's most capable model for image generation and editing.",
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      imageGeneration: true,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 3, cost: 3, outputType: 'image' },
    aliases: ['gpt-image'],
  },
  {
    id: 'gpt-image-2.5-flare',
    provider: 'openai',
    displayName: 'GPT-Image-2.5 Flare',
    description: 'Fast, high-quality everyday image generation.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      imageGeneration: true,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 4, cost: 2, outputType: 'image' },
    aliases: ['gpt-image-flare'],
  },

  // ============================================================================
  // OpenAI Realtime Models
  // ============================================================================
  {
    id: 'gpt-live-1',
    provider: 'openai',
    displayName: 'GPT-Live 1',
    description:
      'Realtime speech-to-speech model for natural, expressive voice conversations with smooth interruption handling.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: false,
      audio: true,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 4, outputType: 'audio' },
    aliases: ['gpt-live'],
  },

  // ============================================================================
  // OpenAI Video Generation Models (Sora)
  // ============================================================================
  // ============================================================================
  // Runware Video Generation Models
  // ============================================================================
  // Rates are per second of output, excluding audio and motion control — both
  // of which the wiring does not request, so neither can reach the bill. What
  // the render actually cost is reported back on the poll and overrides this.
  {
    id: 'klingai:kling-video@3-standard',
    provider: 'runware',
    displayName: 'Kling 3.0 Standard',
    description:
      '720p video from a prompt, a first frame, or a first and last frame. The iteration tier.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      videoGeneration: true,
      imageReferences: mediaRouteReferenceLimits('runware-kling'),
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, videoPerSecond: 0.084, currency: 'USD' },
    defaultVideoDurationSeconds: 5,
    traits: { speed: 3, cost: 2, outputType: 'video' },
    aliases: ['runware-kling', 'kling-standard'],
  },
  {
    id: 'klingai:kling-video@3-pro',
    provider: 'runware',
    displayName: 'Kling 3.0 Pro',
    description:
      '1080p video from a prompt, a first frame, or a first and last frame. The delivery tier.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      videoGeneration: true,
      imageReferences: mediaRouteReferenceLimits('runware-kling-pro'),
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, videoPerSecond: 0.112, currency: 'USD' },
    defaultVideoDurationSeconds: 5,
    traits: { speed: 2, cost: 3, outputType: 'video' },
    aliases: ['runware-kling-pro', 'kling-pro'],
  },
  {
    id: 'sora-2',
    provider: 'openai',
    displayName: 'Sora 2',
    description: 'Video generation for rapid iteration and social media. Up to 12 seconds at 720p.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      videoGeneration: true,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, videoPerSecond: 0.1, currency: 'USD' },
    defaultVideoDurationSeconds: 4,
    traits: { speed: 3, cost: 2, outputType: 'video' },
    aliases: ['sora'],
  },

  // ==========================================================================
  // Open-weight model conventions (applies to Fireworks + OpenRouter sections)
  //
  // Aliases — `{family}-pro` is the flagship, `{family}-flash` is the efficient
  // tier. Generic aliases stay stable across model versions; we only update the
  // catalog `id` (and pricing) when a new revision lands. Callers reference
  // aliases, not version-pinned IDs.
  //
  // OpenRouter routing defaults — uniform across the open-weight entries below:
  //   require_parameters: true   drop hosts that silently ignore tools/json_schema
  //   data_collection: 'deny'    only ZDR-attested providers
  //   allow_fallbacks: true      survive a single host blip on long agent runs
  //   sort: 'throughput'         optimize for tps (cybernetic-agent profile)
  //   quantizations: …           includes fp8 — the native training precision
  //                              for modern MoE models. Excluding fp8 leaves
  //                              zero eligible providers for most flagships.
  //                              Field is omitted when the host pool is small
  //                              enough that any quant restriction empties it.
  // ==========================================================================

  // ==========================================================================
  // OpenRouter — Auto routing
  // Picks the best fit at request time. Catch-all entry for ad-hoc use.
  // ==========================================================================

  // ==========================================================================
  // Fireworks — direct high-throughput hosts
  //
  // Direct routing for cybernetic-agent flagships where Fireworks's dedicated
  // capacity beats aggregator-routed throughput. ZDR by default on chat
  // completions (volatile memory only — see Fireworks docs). Native OpenAI
  // tool calling, streaming text + thinking deltas.
  // ==========================================================================
  {
    id: 'accounts/fireworks/models/deepseek-v4-pro-0813',
    provider: 'fireworks',
    displayName: 'DeepSeek V4 Pro (Fireworks)',
    description:
      'DeepSeek flagship. 1.6T MoE, 49B active. 1M context. MIT license. Reasoning effort: high/xhigh.',
    contextWindow: 1048576,
    maxOutputTokens: 16384,
    capabilities: { ...defaultCapabilities, reasoning: true, structuredOutputs: true },
    pricing: {
      promptPer1M: 1.74,
      cachedPromptPer1M: 0.145,
      completionPer1M: 3.48,
      currency: 'USD',
    },
    traits: { speed: 4, cost: 3, intelligence: 5, outputType: 'text' },
    aliases: ['deepseek-pro'],
    // Fireworks DeepSeek V4 defaults reasoning on; 'off' reaches reasoning_effort 'none'.
    reasoning: { supported: ['off', 'low', 'medium', 'high'], default: 'off' },
  },
  {
    id: 'accounts/fireworks/models/kimi-k3',
    provider: 'fireworks',
    displayName: 'Kimi K3 (Fireworks)',
    description:
      "Moonshot AI's Kimi K3 flagship. 2.8T MoE (Kimi Delta Attention). Native vision, 1M context, function calling. Always-on reasoning (effort low/high/max). Open weights.",
    contextWindow: 1_040_000,
    maxOutputTokens: 16384,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 3.0, cachedPromptPer1M: 0.3, completionPer1M: 15.0, currency: 'USD' },
    traits: { speed: 3, cost: 4, intelligence: 5, outputType: 'text' },
    aliases: ['kimi-pro', 'kimi-k3'],
    // Default low for agent cost control — K3 reasons at every rung, including
    // `off`, so the default is the only thing keeping its spend down.
    reasoning: { supported: ['off', 'low', 'medium', 'high'], default: 'low' },
  },
  {
    id: 'accounts/fireworks/models/minimax-m3',
    provider: 'fireworks',
    displayName: 'MiniMax M3 (Fireworks)',
    description:
      'MiniMax native multimodal flagship. 428B MoE, 23B active. 512K context. Text, image, and video. MSA long-context efficiency.',
    contextWindow: 524288,
    maxOutputTokens: 16384,
    capabilities: { ...defaultCapabilities, vision: true, structuredOutputs: true },
    pricing: { promptPer1M: 0.3, cachedPromptPer1M: 0.06, completionPer1M: 1.2, currency: 'USD' },
    traits: { speed: 4, cost: 1, intelligence: 5, outputType: 'text' },
    aliases: ['minimax-pro'],
  },
  {
    id: 'accounts/fireworks/models/glm-5p3',
    provider: 'fireworks',
    displayName: 'GLM-5.3 (Fireworks)',
    description:
      "Z.ai's GLM-5.3. 743B MoE on the GLM-5.2 base, with every gain coming from post-training: complex coding, long-horizon agentic work, and cyber reasoning. 1M context. Modified MIT.",
    contextWindow: 1048576,
    maxOutputTokens: 16384,
    capabilities: { ...defaultCapabilities, reasoning: true, structuredOutputs: true },
    pricing: { promptPer1M: 1.4, cachedPromptPer1M: 0.26, completionPer1M: 4.4, currency: 'USD' },
    traits: { speed: 4, cost: 3, intelligence: 5, outputType: 'text' },
    aliases: ['glm-pro', 'glm-5.3'],
    // Thinking-only: reasoning_effort 'none' is a 400, so there is no `off` rung
    // and `off` clamps to `low`. Left to its own default the model reasons
    // harder than its top rung, and this is the platform's default agent model.
    reasoning: { supported: ['low', 'medium', 'high'], default: 'low' },
  },
  {
    id: 'accounts/fireworks/models/glm-5p3-flash',
    provider: 'fireworks',
    displayName: 'GLM-5.3 Flash (Fireworks)',
    description:
      "Z.ai's GLM-5.3 Flash — the economy tier. 320B MoE, 18B active, and the first natively multimodal model in the GLM-5 series. Hybrid attention holds long-context precision at a fraction of the serving cost. 1M context.",
    contextWindow: 1048576,
    maxOutputTokens: 16384,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 0.15, cachedPromptPer1M: 0.03, completionPer1M: 0.5, currency: 'USD' },
    traits: { speed: 5, cost: 1, intelligence: 4, outputType: 'text' },
    aliases: ['glm-flash', 'glm-5.3-flash'],
    // Thinking-only like its larger sibling; same clamp and same reason for a
    // low default.
    reasoning: { supported: ['low', 'medium', 'high'], default: 'low' },
  },
  {
    id: 'accounts/fireworks/models/kimi-k2p7-code',
    provider: 'fireworks',
    displayName: 'Kimi K2.7 Code (Fireworks)',
    description:
      "Moonshot AI's Kimi K2.7 Code. 1.02T MoE. 262K context. Coding-focused agentic model — strong on long-horizon software engineering with ~30% lower thinking-token usage than K2.6. Modified MIT.",
    contextWindow: 262144,
    maxOutputTokens: 16384,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 0.95, cachedPromptPer1M: 0.19, completionPer1M: 4.0, currency: 'USD' },
    traits: { speed: 4, cost: 2, intelligence: 4, outputType: 'text' },
    aliases: ['kimi-code'],
    // Fireworks Kimi K2.7 Code defaults to thinking on; 'off' reaches reasoning_effort 'none'.
    reasoning: { supported: ['off', 'low', 'medium', 'high'], default: 'off' },
  },
  {
    id: 'accounts/fireworks/models/qwen3p8-max',
    provider: 'fireworks',
    displayName: 'Qwen3.8 Max (Fireworks)',
    description:
      "Alibaba's Qwen3.8 Max flagship closed model. 262K context. Available exclusively through Fireworks outside Alibaba's own infrastructure.",
    contextWindow: 262144,
    maxOutputTokens: 16384,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 0.4, cachedPromptPer1M: 0.08, completionPer1M: 1.6, currency: 'USD' },
    traits: { speed: 4, cost: 1, intelligence: 4, outputType: 'text' },
    aliases: ['qwen-plus'],
    // Fireworks Qwen3.8 Max defaults thinking on; 'off' reaches reasoning_effort 'none'.
    reasoning: { supported: ['off', 'low', 'medium', 'high'], default: 'off' },
  },

  // ==========================================================================
  // OpenRouter — open-weight frontier models
  //
  // Aggregator-routed for breadth (model not on Fireworks, or breadth of host
  // choice matters more than peak throughput). All entries share the routing
  // defaults documented above; per-entry overrides are only present where a
  // specific filter would empty the eligible host pool.
  // ==========================================================================
  {
    id: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
    displayName: 'DeepSeek V4 Flash (OpenRouter)',
    description:
      'Efficiency-tier sibling of V4 Pro. 284B MoE, 13B active. 1M context. MIT license. Reasoning effort: high/xhigh.',
    contextWindow: 1048576,
    maxOutputTokens: 16384,
    capabilities: { ...defaultCapabilities, reasoning: true, structuredOutputs: true },
    pricing: { promptPer1M: 0.14, completionPer1M: 0.28, currency: 'USD' },
    traits: { speed: 5, cost: 1, intelligence: 4, outputType: 'text' },
    aliases: ['deepseek-flash'],
    openRouterProvider: {
      require_parameters: true,
      // quantizations omitted: several fast hosts (Together, Venice, NovitaAI)
      // do not declare quantization, and a strict allowlist excludes them.
      data_collection: 'deny',
      allow_fallbacks: true,
      sort: 'throughput',
    },
    // Default to 'low' — see deepseek-v4-pro for rationale.
    reasoning: { supported: ['off', 'low', 'medium', 'high'], default: 'low' },
  },
  {
    id: 'mistralai/mistral-large-2512',
    provider: 'openrouter',
    displayName: 'Mistral Large 3 (OpenRouter)',
    description:
      'EU-friendly flagship. 675B MoE, 41B active. Apache 2.0. French company — fits EU compliance constraints. Available on all 3 hyperscalers.',
    contextWindow: 262144,
    maxOutputTokens: 16384,
    capabilities: { ...defaultCapabilities, functionCalling: true, structuredOutputs: true },
    pricing: { promptPer1M: 0.5, completionPer1M: 1.5, currency: 'USD' },
    traits: { speed: 3, cost: 1, intelligence: 4, outputType: 'text' },
    aliases: ['mistral-pro'],
    openRouterProvider: {
      require_parameters: true,
      // quantizations omitted: all three Mistral endpoints declare no
      // quantization, so any allowlist leaves the pool empty.
      data_collection: 'deny',
      allow_fallbacks: true,
      sort: 'throughput',
    },
  },

  // ==========================================================================
  // OpenRouter — fast/cheap pinned routes
  //
  // Latency-critical workloads pinned to a specific high-throughput host.
  // `allow_fallbacks: false` because the whole point is the pinned host's
  // speed — falling over to a slow alternate would defeat the routing intent.
  // ==========================================================================
  {
    id: 'openai/gpt-oss-120b',
    provider: 'openrouter',
    displayName: 'GPT-OSS 120B (OpenRouter / Cerebras)',
    description: 'Open-source 120B parameter model pinned to Cerebras for sub-second latency.',
    contextWindow: 131072,
    maxOutputTokens: 40960,
    capabilities: { ...defaultCapabilities },
    pricing: { promptPer1M: 0.35, completionPer1M: 0.75, currency: 'USD' },
    traits: { speed: 5, cost: 1, intelligence: 3, outputType: 'text' },
    openRouterProvider: { only: ['cerebras'], allow_fallbacks: false },
  },

  // ==========================================================================
  // xAI — Grok
  //
  // One chat model: Grok 4.7 is the current flagship, and there is no separate
  // higher tier. The generic alias `grok` points at it; move the alias when a
  // successor ships. The API also accepts `xhigh`, which the shared effort
  // ladder has no rung for. Left to its own default the model reasons at
  // `high`, so the catalog default is `low` — the same cost control the other
  // agent flagships use. Rates below are the under-200k-token tier; a prompt
  // that reaches 200k tokens is billed at double.
  // ==========================================================================
  {
    id: 'grok-4.7',
    provider: 'xai',
    displayName: 'Grok 4.7',
    description:
      'xAI flagship for code, chat, and agentic work. 500k context. Text and image in, text out. Reasoning efforts low, medium, and high.',
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    capabilities: {
      ...defaultCapabilities,
      vision: true,
      reasoning: true,
      structuredOutputs: true,
    },
    pricing: { promptPer1M: 2, cachedPromptPer1M: 0.5, completionPer1M: 6, currency: 'USD' },
    traits: { speed: 3, cost: 3, intelligence: 5, outputType: 'text' },
    aliases: ['grok'],
    reasoning: { supported: ['low', 'medium', 'high'], default: 'low' },
  },
  {
    id: 'grok-imagine-image-2.0',
    provider: 'xai',
    displayName: 'Grok Imagine Image 2.0',
    description: 'Image generation and editing from a prompt. $0.04 per image.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: true,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
      imageGeneration: true,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, imagePerImage: 0.04, currency: 'USD' },
    traits: { speed: 3, cost: 2, outputType: 'image' },
    aliases: ['grok-image'],
  },
  {
    id: 'grok-voice-think-fast-2.0',
    provider: 'xai',
    displayName: 'Grok Voice Think Fast 2.0',
    description: 'Speech-to-speech voice model. $0.08 per minute of audio.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: false,
      audio: true,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 4, cost: 2, outputType: 'audio' },
    aliases: ['grok-voice'],
  },
  {
    id: 'grok-tts',
    provider: 'xai',
    displayName: 'Grok Text to Speech',
    description:
      'Spoken audio from text via the xAI text-to-speech endpoint. $15 per million characters.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: false,
      audio: false,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 4, cost: 2, outputType: 'audio' },
  },
  {
    id: 'grok-voice-transcribe-2.0',
    provider: 'xai',
    displayName: 'Grok Voice Transcribe 2.0',
    description: 'Speech to text. $0.10 per hour for a file, $0.20 per hour for a live stream.',
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: {
      chat: false,
      completion: false,
      embedding: false,
      vision: false,
      audio: true,
      functionCalling: false,
      jsonMode: false,
      streaming: false,
    },
    pricing: { promptPer1M: 0, completionPer1M: 0, currency: 'USD' },
    traits: { speed: 4, cost: 1, outputType: 'audio' },
    aliases: ['grok-transcribe'],
  },
];

/**
 * Models that have left the lineup, and what serves a request naming them.
 *
 * A model id is not the platform's to reclaim once it is stored: it sits in
 * space directives, workflow task overrides and step configs, none of which a
 * catalog edit can reach. Deleting the entry turns every one of those into a
 * dangling pointer that resolves to nothing here, falls through to the caller's
 * default provider, and surfaces as that vendor's 400 on the next run — with
 * no platform surface reporting anything wrong beforehand.
 *
 * So a replaced model is recorded here instead of deleted, and the catalog
 * resolves a request naming it to its successor. Retirement is lifecycle data
 * about a model, in the same registry as its pricing and its reasoning ladder.
 *
 * An entry belongs here only when the successor is the same model a generation
 * on. A model withdrawn with nothing to take its place stays absent, so a ref
 * naming it fails as the unknown model it is rather than being silently served
 * by something the operator never chose.
 */
export const retiredModels: Readonly<Record<string, string>> = {
  'accounts/fireworks/models/glm-5p2': 'accounts/fireworks/models/glm-5p3',
  'gemini-3.7-flash': 'gemini-3.8-flash',
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'gpt-5.6-sol': 'gpt-6.1-sol',
  'gpt-5.6-frontier': 'gpt-6-astra',
  'gpt-5.6-terra': 'gpt-6.1-sol',
  'gpt-5.6': 'gpt-6.1-sol',
  'gpt-5.6-luna': 'gpt-6-luna',
  'gpt-image-1.5': 'gpt-image-2.5-sunburst',
};
