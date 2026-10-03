/**
 * AIClient - Unified interface for AI operations.
 */
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateEmbeddingRequest,
  GenerateEmbeddingResponse,
  DecideRequest,
  DecideResponse,
  StreamingResponse,
  AIProvider,
  ProviderConfig,
  UsageRecord,
  ModelDefinition,
  TextStreamChunk,
  ReasoningConfig,
  ReasoningEffort,
  ChatMessage,
  ToolImageResolver,
} from './types.js';
import type { AIProviderAdapter } from './adapter.js';
import { type ModelCatalog, createDefaultModelCatalog } from './catalog.js';
import { type UsageRecorder, createUsageRecorder } from './usage.js';
import { AIClientError } from './errors.js';
import { resolveReasoningForModel } from './reasoningEffort.js';
import { resolveMaxOutputTokens } from './outputBudget.js';
import { prepareToolImages } from './toolImages.js';

/**
 * A clamp repeats for every call a space makes with the same settings, so it is
 * reported once per distinct outcome — enough to notice a misconfigured space,
 * quiet enough to leave in a hot path.
 */
const reportedClamps = new Set<string>();

function warnOnceOnClamp(
  model: string,
  requested: ReasoningEffort,
  applied: ReasoningEffort | undefined,
): void {
  const key = `${model}:${requested}:${applied ?? 'none'}`;
  if (reportedClamps.has(key)) return;
  reportedClamps.add(key);
  console.warn(
    `[AIClient] Model "${model}" does not accept reasoning effort "${requested}" — using "${applied}" instead.`,
  );
}

// ============================================================================
// AIClient Configuration
// ============================================================================

/**
 * Configuration for creating an AIClient.
 */
export interface AIClientConfig {
  /** Provider configurations */
  providers: Partial<Record<AIProvider, ProviderConfig>>;

  /** Default provider to use */
  defaultProvider?: AIProvider;

  /** Custom model catalog (optional) */
  modelCatalog?: ModelCatalog;

  /** Usage recorder (optional) */
  usageRecorder?: UsageRecorder;

  /** Enable request logging */
  debug?: boolean;
}

// ============================================================================
// AIClient Interface
// ============================================================================

/**
 * Unified AI client interface.
 */
export interface AIClient {
  /**
   * Generate text (chat completion).
   */
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;

  /**
   * Generate text with streaming.
   */
  generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse>;

  /**
   * Generate structured JSON output.
   */
  generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>>;

  /**
   * Generate embeddings.
   */
  generateEmbedding(request: GenerateEmbeddingRequest): Promise<GenerateEmbeddingResponse>;

  /**
   * Answer typed questions about a state with a decision model.
   */
  decide(request: DecideRequest): Promise<DecideResponse>;

  /**
   * The catalog this client prices against. Exposed so a caller that computes
   * cost outside a `generate*` call (media, which bills on quantities no
   * provider reports) prices against the same table this client used.
   */
  readonly modelCatalog: ModelCatalog;

  /**
   * Get model definition from catalog.
   */
  getModel(modelId: string): ModelDefinition | undefined;

  /**
   * List available models for a provider.
   */
  listModels(provider?: AIProvider): ModelDefinition[];

  /**
   * Get usage records (if recorder is configured).
   */
  getUsageRecords(): UsageRecord[];

  /**
   * Get the provider adapter for a model (for direct access to image/video generation).
   * The adapter is resolved from the model catalog or explicit provider.
   */
  getAdapter(modelId: string, explicitProvider?: AIProvider): Promise<AIProviderAdapter>;

  /**
   * Resolve a model alias/key to its provider model ID.
   * Use this when calling adapter methods directly (e.g. generateImage)
   * to ensure the actual provider model ID is sent, not the alias.
   */
  resolveModelId(modelKey: string, explicitProvider?: AIProvider): string;
}

// ============================================================================
// AIClient Implementation
// ============================================================================

/**
 * Create an AIClient instance.
 */
export function createAIClient(config: AIClientConfig): AIClient {
  const adapters = new Map<AIProvider, AIProviderAdapter>();
  const catalog = config.modelCatalog ?? createDefaultModelCatalog();
  const usageRecorder = config.usageRecorder ?? createUsageRecorder();

  /**
   * Get or create adapter for a provider.
   */
  async function getAdapter(provider: AIProvider): Promise<AIProviderAdapter> {
    let adapter = adapters.get(provider);
    if (adapter) {
      return adapter;
    }

    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      throw new AIClientError(
        `Provider ${provider} is not configured`,
        'invalid_request',
        provider,
        false,
      );
    }

    // Dynamically import the adapter
    switch (provider) {
      case 'openai': {
        const { createOpenAIAdapter } = await import('./providers/openai.js');
        adapter = createOpenAIAdapter(providerConfig);
        break;
      }
      case 'anthropic': {
        const { createAnthropicAdapter } = await import('./providers/anthropic.js');
        adapter = createAnthropicAdapter(providerConfig);
        break;
      }
      case 'google': {
        const { createGoogleAdapter } = await import('./providers/google.js');
        adapter = createGoogleAdapter(providerConfig);
        break;
      }
      case 'openrouter': {
        const { createOpenRouterAdapter } = await import('./providers/openrouter.js');
        adapter = createOpenRouterAdapter(providerConfig);
        break;
      }
      case 'fireworks': {
        const { createFireworksAdapter } = await import('./providers/fireworks.js');
        adapter = createFireworksAdapter(providerConfig);
        break;
      }
      case 'xai': {
        const { createXaiAdapter } = await import('./providers/xai.js');
        adapter = createXaiAdapter(providerConfig);
        break;
      }
      case 'runware': {
        const { createRunwareAdapter } = await import('./providers/runware.js');
        adapter = createRunwareAdapter(providerConfig);
        break;
      }
      case 'typesafe': {
        const { createTypeSafeAdapter } = await import('./providers/typesafe.js');
        adapter = createTypeSafeAdapter(providerConfig);
        break;
      }
      case 'local':
        throw new AIClientError(
          `Provider ${provider} is not yet supported`,
          'invalid_request',
          provider,
          false,
        );
    }

    adapters.set(provider, adapter);
    return adapter;
  }

  /**
   * Resolved model info from catalog lookup.
   */
  interface ResolvedModel {
    provider: AIProvider;
    providerModelId: string;
    openRouterProvider?: ModelDefinition['openRouterProvider'];
    /**
     * Which reasoning efforts this model accepts, and its default. Absent for
     * models not in the catalog (custom ids) — the caller is trusted there —
     * and for catalog models that do not declare `capabilities.reasoning`, so a
     * non-reasoning model never receives thinking config it would reject.
     */
    reasoning?: ModelDefinition['reasoning'];
    /** False when the provider rejects a sampling temperature for this model. */
    acceptsTemperature?: boolean;
    /**
     * The most output tokens this model will emit in one call. Absent for
     * models outside the catalog, where the caller is trusted.
     */
    maxOutputTokens?: number | undefined;
    /** True once the catalog has been consulted, whether or not it had an entry. */
    fromCatalog?: boolean;
    /**
     * Whether the model is shown tool images. Catalog data only: a model
     * outside the catalog gets each image's description instead.
     */
    vision?: boolean;
  }

  /**
   * Resolve provider and model ID from the catalog.
   *
   * The model key maps to exactly one { provider, providerModelId }.
   * No guessing from prefixes - if it's not in the catalog, you must specify provider explicitly.
   */
  function resolveModel(modelKey: string, explicitProvider?: AIProvider): ResolvedModel {
    // Look up in catalog first
    const model = catalog.getModel(modelKey);

    if (model) {
      return {
        provider: explicitProvider ?? model.provider,
        providerModelId: model.providerModelId ?? model.id,
        openRouterProvider: model.openRouterProvider,
        ...(model.capabilities.reasoning === true && model.reasoning
          ? { reasoning: model.reasoning }
          : {}),
        acceptsTemperature: model.capabilities.samplingTemperature !== false,
        maxOutputTokens: model.maxOutputTokens,
        fromCatalog: true,
        vision: model.capabilities.vision,
      };
    }

    // Model not in catalog - use key as-is with explicit or default provider
    if (explicitProvider) {
      return {
        provider: explicitProvider,
        providerModelId: modelKey,
      };
    }

    if (config.defaultProvider) {
      return {
        provider: config.defaultProvider,
        providerModelId: modelKey,
      };
    }

    throw new AIClientError(
      `Model "${modelKey}" not found in catalog. Either register it in the catalog or specify an explicit provider.`,
      'model_not_found',
      undefined,
      false,
    );
  }

  /** Build adapter request with model-specific options (e.g. OpenRouter provider routing, reasoning defaults) */
  async function buildAdapterRequest<
    T extends { model: string; openRouterProvider?: unknown; reasoning?: unknown },
  >(request: T, resolved: ResolvedModel): Promise<T & { model: string }> {
    // The one place a reasoning effort is reconciled with the model that has to
    // honour it. Providers reject rungs their model does not implement — as a
    // 400 mid-run — so an effort the model cannot take is snapped to the
    // nearest it can rather than forwarded and failed on. Models outside the
    // catalog have no profile to check against, so the caller is trusted.
    const requested = request.reasoning as ReasoningConfig | undefined;
    const resolvedReasoning = resolved.fromCatalog
      ? resolveReasoningForModel(requested, resolved.reasoning)
      : { reasoning: requested };

    if (resolvedReasoning.clampedFrom) {
      warnOnceOnClamp(
        resolved.providerModelId,
        resolvedReasoning.clampedFrom,
        resolvedReasoning.reasoning?.effort,
      );
    }

    // `reasoning` and `temperature` are dropped from the spread and re-added
    // only when the model takes them: re-spreading the caller's values would
    // hand thinking config to a model with no reasoning profile, or a
    // temperature to one that 400s on it — the rejections this guards.
    const {
      reasoning: _requested,
      temperature: _temperature,
      resolveToolImage,
      ...rest
    } = request as typeof request & {
      temperature?: number;
      messages?: ChatMessage[];
      resolveToolImage?: ToolImageResolver;
    };
    // Also the one place a model's `vision` decides whether tool images are
    // read: every adapter receives images or text, never a reference.
    const messages = rest.messages
      ? await prepareToolImages(rest.messages, {
          vision: resolved.vision === true,
          resolve: resolveToolImage,
          provider: resolved.provider,
        })
      : undefined;
    // Thinking is paid for out of the SAME output budget as the answer, so a
    // request that names no ceiling gets whatever the provider defaults to —
    // and on a thinking-only model that default is spent reasoning, returning
    // an empty message with an ordinary stop reason rather than an error. The
    // catalog already carries what each model will emit, so it is the ceiling
    // here too: absent, it becomes the default; present but larger than the
    // model accepts, it is clamped rather than forwarded and 400-ed.
    const maxTokens = resolveMaxOutputTokens(
      (rest as { maxTokens?: number }).maxTokens,
      resolved.maxOutputTokens,
    );

    const base = {
      ...rest,
      ...(messages ? { messages } : {}),
      model: resolved.providerModelId,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(resolvedReasoning.reasoning !== undefined
        ? { reasoning: resolvedReasoning.reasoning }
        : {}),
      ...(_temperature !== undefined && resolved.acceptsTemperature !== false
        ? { temperature: _temperature }
        : {}),
    };
    if (resolved.provider === 'openrouter' && resolved.openRouterProvider) {
      return {
        ...base,
        openRouterProvider: request.openRouterProvider ?? resolved.openRouterProvider,
      } as T & { model: string };
    }
    return base as T & { model: string };
  }

  /**
   * Validate that a model supports required capabilities.
   * Throws AIClientError if any capability is missing.
   */
  function validateCapabilities(
    modelId: string,
    provider: AIProvider,
    requiredCapabilities: Array<keyof ModelDefinition['capabilities']>,
  ): void {
    const model = catalog.getModel(modelId);
    if (!model) {
      // Unknown model - skip validation (will fail at provider level if invalid)
      return;
    }

    const missing = requiredCapabilities.filter((cap) => {
      const value = model.capabilities[cap];
      return value === false || value === undefined;
    });

    if (missing.length > 0) {
      throw new AIClientError(
        `Model ${modelId} does not support required capabilities: ${missing.join(', ')}`,
        'invalid_request',
        provider,
        false,
      );
    }
  }

  return {
    modelCatalog: catalog,

    async generateText(request) {
      const resolved = resolveModel(request.model, request.provider);

      // Validate required capabilities
      validateCapabilities(request.model, resolved.provider, ['chat']);
      if (request.tools && request.tools.length > 0) {
        validateCapabilities(request.model, resolved.provider, ['functionCalling']);
      }

      const adapter = await getAdapter(resolved.provider);
      const startTime = Date.now();

      // Use providerModelId when calling the adapter
      const adapterRequest = await buildAdapterRequest(request, resolved);
      const response = await adapter.generateText(adapterRequest);

      // Record usage
      const model = catalog.getModel(request.model);
      const cost = model ? catalog.calculateCost(request.model, response.usage) : undefined;

      usageRecorder.record({
        id: `usage_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
        tenantId: request.tenantId as string,
        runId: request.runId as string,
        stepExecutionId: request.stepExecutionId as string,
        attempt: request.attempt ?? 1,
        provider: resolved.provider,
        model: request.model,
        operation: 'generate_text',
        usage: response.usage,
        cost: cost ?? {
          promptCost: 0,
          completionCost: 0,
          totalCost: 0,
          currency: 'USD',
        },
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        providerRequestId: response.providerRequestId,
      });

      return {
        ...response,
        cost,
        provider: resolved.provider,
      };
    },

    generateTextStream(request) {
      const resolved = resolveModel(request.model, request.provider);

      // Validate required capabilities
      validateCapabilities(request.model, resolved.provider, ['chat', 'streaming']);
      if (request.tools && request.tools.length > 0) {
        validateCapabilities(request.model, resolved.provider, ['functionCalling']);
      }

      // Create a promise that will be resolved when streaming completes
      let resolveResponse: (response: GenerateTextResponse) => void;
      let rejectResponse: (error: Error) => void;

      const responsePromise = new Promise<GenerateTextResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      // Same hazard the adapter's promise is guarded against below, one level
      // up: a provider error rejects BOTH the stream and this promise, and the
      // caller's `for await` throws before it reaches `await response`. Nobody
      // is attached here, so the rejection is unhandled and Node takes the
      // whole executor process down — a single bad request killing every other
      // step in flight. Attaching a sink does not swallow it: a caller that
      // does await still sees the rejection.
      responsePromise.catch(() => {});

      // Create async generator for streaming
      const streamGenerator = async function* (): AsyncGenerator<TextStreamChunk> {
        const adapter = await getAdapter(resolved.provider);
        const startTime = Date.now();

        try {
          // Use providerModelId when calling the adapter
          const adapterRequest = await buildAdapterRequest(request, resolved);
          const streamResponse = adapter.generateTextStream(adapterRequest);

          // Prevent unhandled rejection crash if stream fails before response is awaited.
          // The response promise is also rejected when the stream errors, but if the
          // stream error propagates first, responsePromise is never awaited → Node crashes.
          streamResponse.response.catch(() => {});

          for await (const chunk of streamResponse.stream) {
            yield chunk;
          }

          // Adapters assemble the authoritative final response (text, tool calls,
          // usage, provider metadata). The wrapper must not rebuild from chunks —
          // that dropped tool calls for several providers.
          const adapterResponse = await streamResponse.response;

          const model = catalog.getModel(request.model);
          const cost = model
            ? catalog.calculateCost(request.model, adapterResponse.usage)
            : undefined;

          const finalResponse: GenerateTextResponse = {
            ...adapterResponse,
            cost,
            model: request.model,
            provider: resolved.provider,
          };

          // Record usage
          usageRecorder.record({
            id: `usage_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
            tenantId: request.tenantId as string,
            runId: request.runId as string,
            stepExecutionId: request.stepExecutionId as string,
            attempt: request.attempt ?? 1,
            provider: resolved.provider,
            model: request.model,
            operation: 'generate_text',
            usage: adapterResponse.usage,
            cost: cost ?? {
              promptCost: 0,
              completionCost: 0,
              totalCost: 0,
              currency: 'USD',
            },
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          });

          resolveResponse(finalResponse);
        } catch (error) {
          rejectResponse(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      };

      return {
        stream: streamGenerator(),
        response: responsePromise,
      };
    },

    async generateJson<T>(request: GenerateJsonRequest<T>) {
      const resolved = resolveModel(request.model, request.provider);

      // Validate required capabilities - prefer structuredOutputs, fall back to jsonMode
      const modelDef = catalog.getModel(request.model);
      if (modelDef) {
        const hasStructuredOutputs = modelDef.capabilities.structuredOutputs === true;
        const hasJsonMode = modelDef.capabilities.jsonMode;
        if (!hasStructuredOutputs && !hasJsonMode) {
          throw new AIClientError(
            `Model ${request.model} does not support JSON generation (requires jsonMode or structuredOutputs)`,
            'invalid_request',
            resolved.provider,
            false,
          );
        }
      }

      const adapter = await getAdapter(resolved.provider);
      const startTime = Date.now();

      // Use providerModelId when calling the adapter
      const adapterRequest = await buildAdapterRequest(request, resolved);
      const response = await adapter.generateJson(adapterRequest);

      // Record usage
      const model = modelDef ?? catalog.getModel(request.model);
      const cost = model ? catalog.calculateCost(request.model, response.usage) : undefined;

      usageRecorder.record({
        id: `usage_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
        tenantId: request.tenantId as string,
        runId: request.runId as string,
        stepExecutionId: request.stepExecutionId as string,
        attempt: request.attempt ?? 1,
        provider: resolved.provider,
        model: request.model,
        operation: 'generate_json',
        usage: response.usage,
        cost: cost ?? {
          promptCost: 0,
          completionCost: 0,
          totalCost: 0,
          currency: 'USD',
        },
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        providerRequestId: response.providerRequestId,
      });

      return {
        ...response,
        cost,
        provider: resolved.provider,
      };
    },

    async generateEmbedding(request) {
      const resolved = resolveModel(request.model, request.provider);

      // Validate required capabilities
      validateCapabilities(request.model, resolved.provider, ['embedding']);

      const adapter = await getAdapter(resolved.provider);
      const startTime = Date.now();

      // Use providerModelId when calling the adapter
      const adapterRequest = await buildAdapterRequest(request, resolved);
      const response = await adapter.generateEmbedding(adapterRequest);

      // Record usage
      const model = catalog.getModel(request.model);
      const cost = model ? catalog.calculateCost(request.model, response.usage) : undefined;

      usageRecorder.record({
        id: `usage_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
        tenantId: request.tenantId as string,
        runId: request.runId as string,
        stepExecutionId: request.stepExecutionId as string,
        attempt: request.attempt ?? 1,
        provider: resolved.provider,
        model: request.model,
        operation: 'generate_embedding',
        usage: response.usage,
        cost: cost ?? {
          promptCost: 0,
          completionCost: 0,
          totalCost: 0,
          currency: 'USD',
        },
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });

      return {
        ...response,
        cost,
        provider: resolved.provider,
      };
    },

    async decide(request) {
      const resolved = resolveModel(request.model, request.provider);
      validateCapabilities(request.model, resolved.provider, ['decision']);

      const adapter = await getAdapter(resolved.provider);
      if (!adapter.decide) {
        throw new AIClientError(
          `Provider ${resolved.provider} serves no decision model`,
          'model_not_found',
          resolved.provider,
          false,
        );
      }
      const startTime = Date.now();
      const response = await adapter.decide({ ...request, model: resolved.providerModelId });

      const model = catalog.getModel(request.model);
      const cost = model ? catalog.calculateCost(request.model, response.usage) : undefined;

      usageRecorder.record({
        id: `usage_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
        tenantId: request.tenantId as string,
        runId: request.runId as string,
        stepExecutionId: request.stepExecutionId as string,
        attempt: request.attempt ?? 1,
        provider: resolved.provider,
        model: request.model,
        operation: 'decide',
        usage: response.usage,
        cost: cost ?? {
          promptCost: 0,
          completionCost: 0,
          totalCost: 0,
          currency: 'USD',
        },
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        providerRequestId: response.providerRequestId,
      });

      return {
        ...response,
        cost,
        provider: resolved.provider,
      };
    },

    getModel(modelId) {
      return catalog.getModel(modelId);
    },

    listModels(provider) {
      return catalog.listModels(provider);
    },

    getUsageRecords() {
      return usageRecorder.getRecords();
    },

    async getAdapter(modelId: string, explicitProvider?: AIProvider): Promise<AIProviderAdapter> {
      const resolved = resolveModel(modelId, explicitProvider);
      return await getAdapter(resolved.provider);
    },

    resolveModelId(modelKey: string, explicitProvider?: AIProvider): string {
      const resolved = resolveModel(modelKey, explicitProvider);
      return resolved.providerModelId;
    },
  };
}
