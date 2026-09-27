/**
 * BYOK AI client for UI artifact generation — resolves the calling context's
 * credential (user → space → tenant) for the requested model's provider.
 * There is deliberately NO environment-key fallback: platform env keys are
 * reserved for the memory-embedding infrastructure.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { TEXT_MODELS } from '@aflow/schemas';
import type { AIClient } from '@aflow/ai-client';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  createByokAiClientFactory,
  ByokCredentialError,
  type ByokAiClientFactory,
  type ByokClientContext,
} from '@aflow/credential-resolver';

let factory: ByokAiClientFactory | null = null;

export function initUiAiClient(db: PostgresJsDatabase): void {
  factory = createByokAiClientFactory(db);
}

function contextFor(ctx: ExecutorContext): ByokClientContext {
  const job = ctx.job as { spaceId?: string; credentialOwnerId?: string };
  return {
    tenantId: ctx.tenantId as string,
    spaceId: job.spaceId ?? '',
    ...(job.credentialOwnerId ? { credentialOwnerId: job.credentialOwnerId } : {}),
  };
}

export async function getAIClientForContext(
  ctx: ExecutorContext,
  model: string,
): Promise<AIClient> {
  if (!factory) throw new Error('UI AI client not initialized — initUiAiClient(db) at boot');
  const { client } = await factory.getClientForModel(model, contextFor(ctx));
  return client;
}

/** Availability probe for optional AI paths (template fallback / repair round). */
export async function hasResolvableProvider(ctx: ExecutorContext, model: string): Promise<boolean> {
  if (!factory) return false;
  return factory.canResolveModel(model, contextFor(ctx));
}

/**
 * The model a UI generation should actually run on, in preference order:
 * what the caller asked for, what the agent scheduling this step is itself
 * running on, the operator's process-wide override, this kind's default, then
 * anything else the space holds a credential for.
 *
 * A fixed default is the wrong shape for a BYOK surface. It names one
 * provider, and a space that has not connected that provider gets a failure
 * *after* the agent committed to the tool call — the generation is lost
 * mid-run for a reason that has nothing to do with the request. Every
 * candidate here is probed for a resolvable credential before it is returned,
 * so the op fails only when the space has no usable provider at all, which is
 * a setup problem an operator can act on rather than a surprise.
 */
export async function resolveGenerationModel(
  ctx: ExecutorContext,
  candidates: ReadonlyArray<string | undefined>,
): Promise<string | null> {
  const seen = new Set<string>();
  const ordered = [...candidates, ...TEXT_MODELS];
  for (const candidate of ordered) {
    if (candidate === undefined || candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await hasResolvableProvider(ctx, candidate)) return candidate;
  }
  return null;
}

export { ByokCredentialError };
