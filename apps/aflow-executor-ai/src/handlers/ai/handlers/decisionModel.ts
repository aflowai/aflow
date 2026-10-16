/**
 * Which decision model a step runs on.
 *
 * A decision model is never the space's chat model — a chat model cannot
 * answer one — so an unset space setting does not inherit the default. It
 * resolves to the first decision model whose provider the space holds a key
 * for, in catalog order, so a space with only an OpenAI key or only a
 * TypeSafe key runs decision steps with no configuration.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import { createDefaultModelCatalog, type ModelDefinition } from '@aflow/ai-client';
import { loadSpaceDirectives } from '@aflow/cybernetic-runtime';
import { AISetupError, hasProviderCredential } from '../aiClient.js';
import type { HandlerDeps } from './types.js';

function storedRef(model: ModelDefinition): string {
  return model.aliases?.[0] ?? model.id;
}

export async function resolveDecisionModel(
  ctx: ExecutorContext,
  deps: HandlerDeps,
  requested: { model?: string | undefined; readsImages: boolean },
): Promise<string> {
  if (requested.model !== undefined) return requested.model;

  if (deps.db && ctx.job.spaceId) {
    const directives = await loadSpaceDirectives(deps.db, ctx.tenantId, ctx.job.spaceId);
    const assigned = directives?.modelDefaults?.decision;
    if (assigned !== undefined) return assigned;
  }

  const candidates = createDefaultModelCatalog()
    .listModels()
    .filter((m) => m.capabilities.decision === true && m.decision !== undefined)
    .filter((m) => !requested.readsImages || m.decision?.imageContext === true);
  for (const candidate of candidates) {
    if (await hasProviderCredential(ctx, candidate.provider)) return storedRef(candidate);
  }

  throw new AISetupError(
    `No decision model can run in this space${requested.readsImages ? ' over images' : ''}: ` +
      `add a key for one of ${candidates.map((m) => `${m.provider} (${storedRef(m)})`).join(', ')} ` +
      'in Settings → Credentials.',
    'AI_PROVIDER_CREDENTIAL_MISSING',
    'configuration',
    false,
  );
}
