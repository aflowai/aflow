import {
  createAIClient,
  inferProviderForModelRef,
  type AIClient,
  type ProviderConfig,
  type BudgetCheckResult,
  type AIProvider,
} from '@aflow/ai-client';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AflowError } from '@aflow/schemas';
import {
  CredentialResolver,
  credentialMissingMessage,
  type CredentialContext,
  type CredentialLoader,
} from '@aflow/credential-resolver';

/**
 * Map AI provider names to credential provider IDs.
 */
const AI_TO_CREDENTIAL_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  openrouter: 'openrouter',
  fireworks: 'fireworks',
  xai: 'xai',
  runware: 'runware',
  typesafe: 'typesafe',
};

// ---------------------------------------------------------------------------
// Client cache: keyed by credentialId → AIClient
// ---------------------------------------------------------------------------

interface CachedClient {
  client: AIClient;
  expiresAt: number;
}

const CLIENT_CACHE = new Map<string, CachedClient>();
const CLIENT_CACHE_TTL_MS = 300_000; // 5 minutes

export class AISetupError extends Error {
  readonly code: string;
  readonly classification: AflowError['classification'];
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    classification: AflowError['classification'],
    retryable: boolean,
    options?: {
      cause?: unknown;
      details?: Record<string, unknown>;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AISetupError';
    this.code = code;
    this.classification = classification;
    this.retryable = retryable;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }

  toAflowError(): AflowError {
    return {
      code: this.code,
      message: this.message,
      classification: this.classification,
      retryable: this.retryable,
      timestamp: new Date().toISOString(),
      ...(this.details ? { details: this.details } : {}),
      ...(this.stack ? { stack: this.stack } : {}),
    };
  }
}

function isCredentialInfraError(message: string): boolean {
  return (
    message.includes('CREDENTIAL_ENCRYPTION_KEY') ||
    message.includes('LocalKmsProvider') ||
    message.includes('Invalid wrapped DEK') ||
    message.includes('Invalid encrypted credential')
  );
}

function normalizeCredentialResolutionError(error: unknown, providerId: string): AISetupError {
  if (error instanceof AISetupError) {
    return error;
  }

  const causeMessage = error instanceof Error ? error.message : String(error);
  if (isCredentialInfraError(causeMessage)) {
    return new AISetupError(
      'Platform credential decryption is unavailable.',
      'AI_CREDENTIAL_DECRYPTION_UNAVAILABLE',
      'internal',
      false,
      {
        cause: error,
        details: { providerId, causeMessage },
      },
    );
  }

  return new AISetupError(
    `Failed to resolve credentials for ${providerId}.`,
    'AI_CREDENTIAL_RESOLUTION_FAILED',
    'internal',
    false,
    {
      cause: error,
      details: { providerId, causeMessage },
    },
  );
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let credentialResolver: CredentialResolver | null = null;

/**
 * Initialize the credential resolver. Call once at executor startup.
 */
export function initCredentialResolver(loader: CredentialLoader): void {
  credentialResolver = new CredentialResolver({ loader });
}

/**
 * Get the credential resolver instance.
 */
export function getCredentialResolver(): CredentialResolver | null {
  return credentialResolver;
}

/**
 * Invalidate all credential caches (resolver + client).
 * Call this from Redis Pub/Sub when credentials are mutated.
 */
export function invalidateAllCredentialCaches(tenantId?: string): void {
  // Clear the resolver's row cache (forces re-query from DB)
  if (credentialResolver) {
    if (tenantId) {
      credentialResolver.invalidate(tenantId);
    } else {
      credentialResolver.clearCache();
    }
  }
  // Clear the AI client cache (forces re-creation with fresh credentials)
  CLIENT_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Budget check (unchanged, still a mock)
// ---------------------------------------------------------------------------

export function checkBudgetMock(params: {
  tenantId: string;
  runId: string;
  stepExecutionId: string;
  estimatedTokens?: number;
}): BudgetCheckResult {
  void params;
  return {
    allowed: true,
    reason: undefined,
    currentUsage: { stepCost: 0, runCost: 0, tenantDailyCost: 0, stepTokens: 0 },
    remaining: { stepCost: null, runCost: null, tenantDailyCost: null, stepTokens: null },
  };
}

// ---------------------------------------------------------------------------
// Provider resolution from model name
// ---------------------------------------------------------------------------

/**
 * Determine which AI provider a model belongs to.
 * Uses the model catalog first, falls back to prefix heuristics.
 */
export function resolveProviderForModel(model: string): AIProvider {
  const provider = inferProviderForModelRef(model);
  if (provider) return provider;

  // Fail closed — don't silently route to a wrong provider's credentials
  throw new AISetupError(
    `Cannot determine AI provider for model "${model}". ` +
      'The model is not in the catalog and does not match any known provider prefix. ' +
      'Use a recognized model name (e.g., gpt-5.6-terra, claude-sonnet-5, gemini-3.8-flash) ' +
      'or configure the model in the operation input with an explicit provider.',
    'AI_MODEL_PROVIDER_UNKNOWN',
    'configuration',
    false,
  );
}

// ---------------------------------------------------------------------------
// Context-aware AI client
// ---------------------------------------------------------------------------

/**
 * Get an AIClient configured with credentials for the model's provider.
 *
 * Resolution:
 * 1. Determine provider from model name (catalog + heuristics)
 * 2. Resolve that single provider's credentials from the scope chain
 * 3. Return a cached or new AIClient
 *
 * @param ctx - Executor context (has job with credentialOwnerId + spaceId)
 * @param model - Model name (e.g., "gpt-4o", "claude-sonnet-4-20250514")
 * @throws Error with actionable guidance if credentials are not configured
 */
export async function getAIClientForContext(
  ctx: ExecutorContext,
  model: string,
): Promise<AIClient> {
  if (!credentialResolver) {
    throw new AISetupError(
      'Credential resolver not initialized. Ensure DATABASE_URL is set ' +
        'and the executor was started correctly.',
      'AI_CREDENTIAL_RESOLVER_UNAVAILABLE',
      'internal',
      false,
    );
  }

  // 1. Determine which provider we need
  const aiProvider = resolveProviderForModel(model);
  const credentialProviderId = AI_TO_CREDENTIAL_PROVIDER[aiProvider];
  if (!credentialProviderId) {
    throw new AISetupError(
      `No credential provider mapping for AI provider: ${aiProvider}`,
      'AI_PROVIDER_MAPPING_MISSING',
      'internal',
      false,
      { details: { aiProvider, model } },
    );
  }

  // 2. Build credential context from the job message (stamped by orchestrator — no Redis lookup)
  const { tenantId, credentialOwnerId, spaceId } = ctx.job;
  if (!credentialOwnerId) {
    throw new AISetupError(
      `Step job for run ${ctx.runId} has no credentialOwnerId. ` +
        'This run may have been created before BYOK credentials were enabled. ' +
        'Re-run the flow to pick up credential context.',
      'AI_CREDENTIAL_CONTEXT_MISSING',
      'internal',
      false,
    );
  }
  if (!spaceId) {
    throw new AISetupError(
      `Step job for run ${ctx.runId} has no spaceId. ` +
        'Ensure the run is associated with a space.',
      'AI_SPACE_CONTEXT_MISSING',
      'internal',
      false,
    );
  }

  const credCtx: CredentialContext = { tenantId, credentialOwnerId, spaceId };

  // 3. Resolve credentials for this single provider
  let resolved: Awaited<ReturnType<CredentialResolver['resolve']>>;
  try {
    resolved = await credentialResolver.resolve(credentialProviderId, credCtx);
  } catch (error) {
    throw normalizeCredentialResolutionError(error, credentialProviderId);
  }
  if (!resolved) {
    throw new AISetupError(
      credentialMissingMessage(credentialProviderId),
      'AI_PROVIDER_CREDENTIAL_MISSING',
      'configuration',
      false,
      { details: { providerId: credentialProviderId } },
    );
  }

  const apiKey = resolved.secrets['api_key'];
  if (!apiKey) {
    throw new AISetupError(
      `Credential for ${credentialProviderId} exists but has no api_key. ` +
        'Update your credentials in Settings → Credentials.',
      'AI_PROVIDER_API_KEY_MISSING',
      'configuration',
      false,
      { details: { providerId: credentialProviderId, credentialId: resolved.credentialId } },
    );
  }

  // 4. Check client cache (keyed by credentialId + updatedAt for rotation safety)
  // When a credential is rotated in-place, updatedAt changes → cache miss → new client
  const cacheKey = `${resolved.credentialId}:${resolved.updatedAt}`;
  const cached = CLIENT_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client;
  }

  // 5. Build single-provider AIClient
  const providerConfig: ProviderConfig = { apiKey };
  if (aiProvider === 'openai' && resolved.config['org_id']) {
    providerConfig.organization = resolved.config['org_id'];
  }

  const providers: Partial<Record<AIProvider, ProviderConfig>> = {
    [aiProvider]: providerConfig,
  };

  const client = createAIClient({ providers, defaultProvider: aiProvider });

  CLIENT_CACHE.set(cacheKey, {
    client,
    expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
  });

  return client;
}
