import { describe, expect, it } from 'vitest';
import {
  localRuntimeSettings,
  missingRequiredSecrets,
  providerConfigFromCredential,
} from './providerConfig.js';
import type { ResolvedProvider } from './types.js';

const resolved = (
  secrets: Record<string, string>,
  config: Record<string, string> = {},
): ResolvedProvider => ({
  secrets,
  config,
  scope: 'tenant',
  scopeId: 'tenant',
  credentialId: 'cred',
  updatedAt: '2026-10-16T00:00:00Z',
});

describe('providerConfigFromCredential', () => {
  it('reaches the runtime the registry describes when the connection sets nothing', () => {
    // No window: the client sizes one from the machine, per model.
    expect(providerConfigFromCredential('ollama', resolved({}))).toEqual({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
      keepAlive: '30m',
      parallel: 1,
    });
  });

  it('takes what the connection sets over the defaults', () => {
    const config = providerConfigFromCredential(
      'ollama',
      resolved(
        { token: 'proxy' },
        { base_url: 'http://host.docker.internal:11434', context_tokens: '65536' },
      ),
    );
    expect(config).toMatchObject({
      apiKey: 'proxy',
      baseUrl: 'http://host.docker.internal:11434',
      contextTokens: 65_536,
    });
  });

  it('always sets a key, so no SDK falls back to the platform key in its environment', () => {
    expect(providerConfigFromCredential('openai', resolved({})).apiKey).toBe('');
  });

  it('carries the OpenAI organization only for OpenAI', () => {
    expect(
      providerConfigFromCredential('openai', resolved({ api_key: 'sk' }, { org_id: 'org-1' })),
    ).toEqual({
      apiKey: 'sk',
      organization: 'org-1',
    });
  });
});

describe('missingRequiredSecrets', () => {
  it('asks a cloud provider for its key and a local runtime for nothing', () => {
    expect(missingRequiredSecrets('openai', resolved({}))).toEqual(['api_key']);
    expect(missingRequiredSecrets('ollama', resolved({}))).toEqual([]);
  });
});

describe('localRuntimeSettings', () => {
  it('admits one request at a time unless the connection says otherwise', () => {
    expect(localRuntimeSettings('ollama', resolved({}))).toEqual({ maxParallel: 1 });
    expect(localRuntimeSettings('ollama', resolved({}, { max_parallel: '2' })).maxParallel).toBe(2);
  });
});
