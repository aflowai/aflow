/**
 * The space's runtime on the operator's machine, resolved as the AI executor
 * resolves it — same credential chain, same defaults, same machine — so what
 * readiness reports and what the operator's actions reach is the runtime the
 * space's models actually run on (Plan 323).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { localRuntimeClient, type LocalRuntimeClient, type ProviderConfig } from '@aflow/ai-client';
import {
  CredentialResolver,
  createProviderCredentialDbLoader,
  providerConfigFromCredential,
} from '@aflow/credential-resolver';
import { readLocalMachine, type Redis } from '@aflow/redis';

export interface ResolvedLocalRuntime {
  config: ProviderConfig;
  client: LocalRuntimeClient;
}

export async function resolveSpaceLocalRuntime(input: {
  db: PostgresJsDatabase;
  redis: Redis | undefined;
  tenantId: string;
  userId: string;
  spaceId: string;
}): Promise<ResolvedLocalRuntime | null> {
  const resolver = new CredentialResolver({ loader: createProviderCredentialDbLoader(input.db) });
  const resolved = await resolver
    .resolve('ollama', {
      tenantId: input.tenantId,
      credentialOwnerId: input.userId,
      spaceId: input.spaceId,
    })
    .catch(() => null);
  if (!resolved) return null;
  const machine = input.redis
    ? await readLocalMachine(input.redis).catch(() => undefined)
    : undefined;
  const config = providerConfigFromCredential('ollama', resolved, { machine });
  return { config, client: localRuntimeClient(config) };
}
