import {
  createDefaultModelCatalog,
  diagnoseLocalRuntime,
  type ModelDefinition,
} from '@aflow/ai-client';
import { readLocalPulls, type Redis } from '@aflow/redis';
import {
  DEFAULT_CYBERNETIC_MODEL,
  LOCAL_MODEL_ROLES,
  OLLAMA_DEFAULT_BASE_URL,
  resolveRoleModel,
  THIS_MACHINE_RUNTIME_HOST,
  type DirectiveModelDefaults,
  type LocalModelPull,
  type LocalModelRole,
  type LocalRuntimeDiagnostics,
} from '@aflow/schemas';
import type { SpaceLocalRuntime } from './runtime.js';

/** The local model each role resolves to; a role on a hosted model is left out. */
export function localRoleModels(
  defaults: DirectiveModelDefaults | undefined,
): Partial<Record<LocalModelRole, string>> {
  const catalog = createDefaultModelCatalog();
  const roles: Partial<Record<LocalModelRole, string>> = {};
  for (const role of LOCAL_MODEL_ROLES) {
    const ref =
      role === 'default'
        ? (defaults?.default ?? DEFAULT_CYBERNETIC_MODEL)
        : resolveRoleModel(defaults, role);
    const model = catalog.getModel(ref);
    if (model?.provider === 'ollama') roles[role] = model.id;
  }
  return roles;
}

/** The lineup — every local model the catalog carries — and any other a role names. */
function lineup(roles: Partial<Record<LocalModelRole, string>>): ModelDefinition[] {
  const catalog = createDefaultModelCatalog();
  const models = catalog.listModels('ollama');
  for (const id of Object.values(roles)) {
    const model = catalog.getModel(id);
    if (model && !models.some((m) => m.id === model.id)) models.push(model);
  }
  return models;
}

/** Reads the runtime once and diagnoses it (Plan 323 D15). */
export async function diagnoseSpaceLocalRuntime(input: {
  runtime: SpaceLocalRuntime;
  redis: Redis | undefined;
  roles: Partial<Record<LocalModelRole, string>>;
}): Promise<LocalRuntimeDiagnostics> {
  const { runtime, redis, roles } = input;
  const models = lineup(roles);
  const tags = models.map((m) => m.providerModelId ?? m.id);
  const [version, installed, loaded, pullsByTag] = await Promise.all([
    runtime.client.version(),
    runtime.client.installed(),
    runtime.client.loaded(),
    redis
      ? readLocalPulls(redis, runtime.runtimeId, tags).catch(
          () => new Map<string, LocalModelPull>(),
        )
      : Promise.resolve(new Map<string, LocalModelPull>()),
  ]);
  const pulls: Record<string, LocalModelPull> = {};
  for (const model of models) {
    const pull = pullsByTag.get(model.providerModelId ?? model.id);
    if (pull) pulls[model.id] = pull;
  }
  // This machine's free disk says nothing about a runtime on another one.
  const onThisMachine = runtime.runtimeId.startsWith(`${THIS_MACHINE_RUNTIME_HOST}:`);
  return diagnoseLocalRuntime({
    observation: {
      baseUrl: runtime.config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      version,
      installed,
      loaded,
    },
    connection: runtime.config,
    models,
    roles,
    freeDiskBytes: onThisMachine ? runtime.hostMachine?.freeDiskBytes : undefined,
    pulls,
  });
}
