/**
 * AI Client - Provider-agnostic AI layer for the Aflow platform.
 *
 * Provides:
 * - Unified interface for text/JSON generation and embeddings
 * - Streaming support
 * - Token usage and cost tracking
 * - Error normalization across providers
 * - Model catalog with pricing information
 */

// Core types
export type {
  MessageRole,
  ContentPart,
  ToolCall,
  ToolResult,
  ChatMessage,
  ProviderReasoning,
  ReasoningEffort,
  ReasoningConfig,
  ToolDefinition,
  AIRequestOptions,
  GenerateTextRequest,
  GenerateJsonRequest,
  GenerateEmbeddingRequest,
  DecideRequest,
  DecideResponse,
  ProviderDecisionAnswer,
  GenerateImageRequest,
  ImageReferenceInput,
  EditImageRequest,
  GeneratedImage,
  GenerateImageResponse,
  GenerateVideoRequest,
  GeneratedVideo,
  GenerateVideoResponse,
  VideoJobHandle,
  VideoJobPoll,
  PollVideoJobRequest,
  TokenUsage,
  CostBreakdown,
  FinishReason,
  GenerateTextResponse,
  GenerateJsonResponse,
  GenerateEmbeddingResponse,
  TextStreamChunk,
  StreamingResponse,
  AIProvider,
  ProviderConfig,
  ModelCapabilities,
  ModelPricing,
  ModelDefinition,
  ModelTraits,
  UsageRecord,
  AIErrorCode,
  AIError,
} from './types.js';

export {
  MessageRoleSchema,
  ContentPartSchema,
  ToolCallSchema,
  ToolResultSchema,
  ChatMessageSchema,
  ProviderReasoningSchema,
  ToolDefinitionSchema,
  TokenUsageSchema,
  CostBreakdownSchema,
  FinishReasonSchema,
  AIProviderSchema,
  AIErrorCodeSchema,
} from './types.js';

// Client
export type { AIClient, AIClientConfig } from './client.js';
export { createAIClient } from './client.js';

// Adapter interface
export type { AIProviderAdapter } from './adapter.js';

// Model catalog
export type { ModelCatalog, CostUsageInput } from './catalog.js';
export {
  createDefaultModelCatalog,
  effectiveModelPricing,
  inferProviderForModelRef,
  retiredRefsFor,
} from './catalog.js';

// Media cost (one path — see mediaCost.ts)
export type {
  MediaQuantity,
  MediaSpend,
  MediaSpendInput,
  SettledMediaSpendInput,
} from './mediaCost.js';
export { resolveMediaSpend, settledMediaSpend } from './mediaCost.js';
export { DEFAULT_AI_MODELS } from '@aflow/lib';

// Credential verification
export type { VerifyOutcome, VerifiableProvider } from './verifyCredential.js';
export {
  verifyProviderKey,
  isVerifiableProvider,
  VERIFIABLE_PROVIDERS,
} from './verifyCredential.js';

// Usage tracking
export type { UsageRecorder, UsageSummary, BudgetConfig, BudgetCheckResult } from './usage.js';
export {
  UsageRecordSchema,
  UsageSummarySchema,
  createUsageRecorder,
  buildUsageRecord,
} from './usage.js';

// Errors
export {
  AIClientError,
  normalizeOpenAIError,
  normalizeAnthropicError,
  normalizeUnknownError,
} from './errors.js';

// Streaming persistence
export type {
  StreamChunk,
  StreamSummary,
  StreamWriterConfig,
  StreamWriter,
  StreamReader,
} from './streaming.js';
export { createStreamWriter, createStreamReader, wrapStreamingResponse } from './streaming.js';

// Conversation history
export type { HistoryMessage, HistoryRecord, HistoryConfig, HistoryManager } from './history.js';
export {
  HistoryMessageSchema,
  HistoryRecordSchema,
  DEFAULT_HISTORY_CONFIG,
  createHistoryManager,
  loadHistory,
  historyToChatMessages,
} from './history.js';

// Provider adapters (lazy loaded by client, but exported for direct use)
export { createOpenAIAdapter } from './providers/openai.js';
export { createAnthropicAdapter, toAnthropicMessages } from './providers/anthropic.js';
export { createGoogleAdapter, toGeminiContents } from './providers/google.js';

export {
  checkGeminiContentsWireValidity,
  checkAnthropicMessagesWireValidity,
  TRUNCATED_HISTORY_USER_BRIDGE_TEXT,
} from './providers/wireIntegrity.js';
export type { WireCheckResult } from './providers/wireIntegrity.js';
export { createOpenRouterAdapter } from './providers/openrouter.js';
export type { OpenRouterConfig } from './providers/openrouter.js';
export { createFireworksAdapter } from './providers/fireworks.js';
export { createXaiAdapter } from './providers/xai.js';
export type { FireworksConfig } from './providers/fireworks.js';
export { createRunwareAdapter, runwareTaskUuid } from './providers/runware.js';

// Decisions
export { resolveDecisionAnswers } from './decision.js';
