/**
 * Model catalog - Registry of available AI models and their capabilities.
 */
import type {
  AIProvider,
  ModelDefinition,
  ModelPricing,
  TokenUsage,
  CostBreakdown,
} from './types.js';
import { builtInModels, retiredModels } from './catalogModels.js';

// ============================================================================
// Model Catalog Interface
// ============================================================================

/**
 * Extended usage input for cost calculation.
 * Token fields come from `TokenUsage`; media fields are optional additions.
 */
export interface CostUsageInput extends TokenUsage {
  /** Number of images generated (for per-image pricing) */
  imageCount?: number;
  /** Total video duration in seconds (for per-second pricing) */
  videoDurationSeconds?: number;
}

/**
 * Model catalog for looking up model definitions.
 */
export interface ModelCatalog {
  /**
   * Get model definition by ID (or alias).
   */
  getModel(modelId: string): ModelDefinition | undefined;

  /**
   * List all models, optionally filtered by provider.
   */
  listModels(provider?: AIProvider): ModelDefinition[];

  /**
   * Calculate cost for usage. Handles token-based, per-image, and per-second
   * pricing automatically based on the model's pricing structure.
   */
  calculateCost(modelId: string, usage: CostUsageInput, at?: Date): CostBreakdown | undefined;

  /**
   * Register a custom model definition.
   */
  registerModel(model: ModelDefinition): void;
}

/**
 * The rates in force for a model at a given instant.
 *
 * A model on introductory pricing carries the successor rates and the date
 * they take effect, so the change lands on its own rather than waiting for
 * someone to notice that spend has been under-reported since the promo lapsed.
 */
export function effectiveModelPricing(pricing: ModelPricing, at: Date = new Date()): ModelPricing {
  const scheduled = pricing.scheduled;
  if (!scheduled || at < new Date(scheduled.effectiveFrom)) return pricing;

  const { effectiveFrom: _effectiveFrom, ...rates } = scheduled;
  return { ...rates, currency: pricing.currency, scheduled };
}

// ============================================================================
// Model Catalog Implementation
// ============================================================================

// Cached singleton — avoids rebuilding the Map on every call.
let _cachedCatalog: ModelCatalog | undefined;

/**
 * Get (or create) the default model catalog.
 * The catalog is a singleton — built once and reused.
 */
export function createDefaultModelCatalog(): ModelCatalog {
  if (_cachedCatalog) return _cachedCatalog;

  const models = new Map<string, ModelDefinition>();
  const aliasMap = new Map<string, string>();

  function registerModel(model: ModelDefinition) {
    models.set(model.id, model);
    if (model.aliases) {
      for (const alias of model.aliases) {
        const existing = aliasMap.get(alias);
        if (existing && existing !== model.id) {
          console.warn(
            `[ModelCatalog] Duplicate alias "${alias}": already maps to "${existing}", overwritten by "${model.id}"`,
          );
        }
        aliasMap.set(alias, model.id);
      }
    }
  }

  for (const model of builtInModels) {
    registerModel(model);
  }

  const catalog: ModelCatalog = {
    getModel(modelId: string) {
      const direct = models.get(modelId) ?? models.get(aliasMap.get(modelId) ?? '');
      if (direct) return direct;
      // A retired id resolves to its successor so refs persisted before the
      // model left the lineup keep naming a runnable model. Single hop: a
      // successor that is itself retired is a chain the contract test rejects.
      const successor = retiredModels[modelId];
      return successor === undefined ? undefined : models.get(successor);
    },

    listModels(provider?: AIProvider) {
      const allModels = Array.from(models.values());
      return provider ? allModels.filter((m) => m.provider === provider) : allModels;
    },

    calculateCost(modelId: string, usage: CostUsageInput, at?: Date): CostBreakdown | undefined {
      const model = this.getModel(modelId);
      if (!model) return undefined;
      // `at` exists so both sides of a scheduled price change are reachable
      // without waiting for the calendar; production callers omit it.
      const pricing = effectiveModelPricing(model.pricing, at);

      let promptCost: number;
      if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
        const basePricePerToken = pricing.promptPer1M / 1_000_000;
        // Providers that price cached reads at a fixed rate (Fireworks,
        // OpenRouter) carry `cachedPromptPer1M`; otherwise use the
        // Anthropic/OpenAI convention of 10% of input.
        const cachedReadPricePerToken =
          pricing.cachedPromptPer1M !== undefined
            ? pricing.cachedPromptPer1M / 1_000_000
            : basePricePerToken * 0.1;
        const cacheRead = usage.cacheReadTokens ?? 0;
        const cacheWrite = usage.cacheWriteTokens ?? 0;
        // `promptTokens` includes cached tokens on OpenAI-compatible providers;
        // prefer the adapter-reported uncached count, else back it out.
        const uncached =
          usage.uncachedPromptTokens ?? Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
        promptCost =
          cacheRead * cachedReadPricePerToken +
          cacheWrite * basePricePerToken * 1.25 +
          uncached * basePricePerToken;
      } else {
        promptCost = (usage.promptTokens / 1_000_000) * pricing.promptPer1M;
      }

      const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionPer1M;

      let mediaCost = 0;
      if (pricing.imagePerImage && usage.imageCount) {
        mediaCost += pricing.imagePerImage * usage.imageCount;
      }
      if (pricing.videoPerSecond && usage.videoDurationSeconds) {
        mediaCost += pricing.videoPerSecond * usage.videoDurationSeconds;
      }

      const result: CostBreakdown = {
        promptCost,
        completionCost,
        totalCost: promptCost + completionCost + mediaCost,
        currency: pricing.currency,
      };
      if (mediaCost > 0) result.mediaCost = mediaCost;
      return result;
    },

    registerModel,
  };

  _cachedCatalog = catalog;
  return catalog;
}

/**
 * The provider a model ref belongs to, or null when nothing in the ref says.
 *
 * The catalog answers first. The prefix rules below exist only for refs the
 * catalog does not carry — a BYOK model an operator names directly — and they
 * are a guess, so they return null rather than a default when the ref matches
 * nothing. A caller that routes credentials on a wrong guess spends the wrong
 * key and reports the wrong provider's error.
 *
 * Shared because the AI executor routes a call on this answer and the readiness
 * endpoint reports on it; two copies drifted apart once already, and the
 * divergence is invisible until a run fails against the surface that said ready.
 */
export function inferProviderForModelRef(modelRef: string): AIProvider | null {
  const catalogEntry = createDefaultModelCatalog().getModel(modelRef);
  if (catalogEntry) return catalogEntry.provider;

  if (modelRef.startsWith('gpt-') || /^o\d/.test(modelRef)) return 'openai';
  if (modelRef.startsWith('claude-')) return 'anthropic';
  if (modelRef.startsWith('gemini-')) return 'google';
  if (modelRef.startsWith('grok-')) return 'xai';
  // OpenRouter ids are `vendor/model`. A Fireworks id is also slash-separated
  // (`accounts/<account>/models/<name>`), so matching any slash sends a
  // Fireworks ref to OpenRouter's key and returns OpenRouter's rejection of a
  // model it was never asked to serve.
  if (/^accounts\/[^/]+\/models\/[^/]+$/.test(modelRef)) return 'fireworks';
  if (/^[^/]+\/[^/]+$/.test(modelRef)) return 'openrouter';

  return null;
}

/**
 * The ids that used to name this model, before whatever it replaced retired.
 *
 * `getModel` resolves these, so a run holding one keeps working — but a picker
 * building its options from the live lineup has no way to recognise one, and
 * would render an operator's perfectly serviceable assignment as a blank
 * select. Offering them alongside the model that answers for them lets the UI
 * agree with what execution already does.
 */
export function retiredRefsFor(modelId: string): string[] {
  return Object.entries(retiredModels)
    .filter(([, successor]) => successor === modelId)
    .map(([retired]) => retired);
}
