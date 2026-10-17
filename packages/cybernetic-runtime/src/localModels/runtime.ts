/**
 * The space's runtime on the operator's machine, resolved as the AI executor
 * resolves it — same credential chain, same defaults, same machine — so what
 * the operator and Helmsman read and change is the runtime the space's models
 * actually run on (Plan 323).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { localRuntimeClient, type LocalRuntimeClient, type ProviderConfig } from '@aflow/ai-client';
import {
  CredentialResolver,
  createProviderCredentialDbLoader,
  providerConfigFromCredential,
} from '@aflow/credential-resolver';
import { readLocalMachine, type HostMachine, type Redis } from '@aflow/redis';
import { localRuntimeId, type CredentialScope } from '@aflow/schemas';

export interface SpaceLocalRuntime {
  config: ProviderConfig;
  client: LocalRuntimeClient;
  runtimeId: string;
  /** The connection the runtime resolved from, which a change to its window writes to. */
  credential: { id: string; scope: CredentialScope; scopeId: string };
  /** This machine as its host executor last published it; absent where none is paired. */
  hostMachine: HostMachine | undefined;
}

export interface SpaceLocalRuntimeScope {
  db: PostgresJsDatabase;
  redis: Redis | undefined;
  tenantId: string;
  userId: string;
  spaceId: string;
}

export async function resolveSpaceLocalRuntime(
  scope: SpaceLocalRuntimeScope,
): Promise<SpaceLocalRuntime | null> {
  const resolver = new CredentialResolver({ loader: createProviderCredentialDbLoader(scope.db) });
  const resolved = await resolver
    .resolve('ollama', {
      tenantId: scope.tenantId,
      credentialOwnerId: scope.userId,
      spaceId: scope.spaceId,
    })
    .catch(() => null);
  if (!resolved) return null;
  const hostMachine = scope.redis
    ? await readLocalMachine(scope.redis).catch(() => undefined)
    : undefined;
  const config = providerConfigFromCredential('ollama', resolved, { machine: hostMachine });
  return {
    config,
    client: localRuntimeClient(config),
    runtimeId: localRuntimeId(config.baseUrl),
    credential: { id: resolved.credentialId, scope: resolved.scope, scopeId: resolved.scopeId },
    hostMachine,
  };
}
