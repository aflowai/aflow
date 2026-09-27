import { describe, it, expect } from 'vitest';
import {
  PROVIDER_REGISTRY,
  getAllProviders,
  getProviderDefinition,
  getProvidersByCategory,
  getAllProviderIds,
  getSecretFieldIds,
  getConfigFieldIds,
  getRequiredFieldIds,
} from './registry.js';
import { ProviderDefinitionSchema, ProviderIdSchema } from './provider.js';

describe('Provider Registry', () => {
  it('has all expected providers', () => {
    const ids = getAllProviderIds();
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('google');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('fireworks');
    expect(ids).toContain('xai');
    expect(ids).toContain('zai');
    expect(ids).toContain('brave');
    expect(ids).toContain('jina');
    expect(ids).toContain('deepgram');
    expect(ids).toContain('elevenlabs');
    expect(ids).toContain('ses');
    expect(ids).toContain('runware');
  });

  it('defines every declared provider id, and declares every defined one', () => {
    expect([...getAllProviderIds()].sort()).toEqual([...ProviderIdSchema.options].sort());
  });

  it('all providers validate against the schema', () => {
    for (const provider of PROVIDER_REGISTRY) {
      const result = ProviderDefinitionSchema.safeParse(provider);
      expect(result.success, `Provider ${provider.providerId} failed validation`).toBe(true);
    }
  });

  it('getProviderDefinition returns correct provider', () => {
    const openai = getProviderDefinition('openai');
    expect(openai).toBeDefined();
    expect(openai!.displayName).toBe('OpenAI');
    expect(openai!.category).toBe('llm');
  });

  it('getProviderDefinition returns undefined for unknown provider', () => {
    expect(getProviderDefinition('nonexistent')).toBeUndefined();
  });

  it('getProvidersByCategory filters correctly', () => {
    const llmProviders = getProvidersByCategory('llm');
    expect(llmProviders).toHaveLength(6);
    expect(llmProviders.map((p) => p.providerId).sort()).toEqual([
      'anthropic',
      'fireworks',
      'google',
      'openai',
      'openrouter',
      'xai',
    ]);

    const codingProviders = getProvidersByCategory('coding');
    expect(codingProviders.map((p) => p.providerId)).toEqual(['zai']);

    const searchProviders = getProvidersByCategory('search');
    expect(searchProviders).toHaveLength(2);

    const voiceProviders = getProvidersByCategory('voice');
    expect(voiceProviders).toHaveLength(2);

    const emailProviders = getProvidersByCategory('email');
    expect(emailProviders).toHaveLength(1);
  });

  it('getSecretFieldIds returns only secret fields', () => {
    expect(getSecretFieldIds('openai')).toEqual(['api_key']);
    expect(getSecretFieldIds('ses')).toEqual(['smtp_username', 'smtp_password']);
  });

  it('getConfigFieldIds returns only non-secret fields', () => {
    expect(getConfigFieldIds('openai')).toEqual(['org_id']);
    expect(getConfigFieldIds('elevenlabs')).toEqual(['voice_id']);
    expect(getConfigFieldIds('anthropic')).toEqual([]);
  });

  it('getRequiredFieldIds returns required fields', () => {
    expect(getRequiredFieldIds('openai')).toEqual(['api_key']);
    expect(getRequiredFieldIds('ses')).toEqual([
      'smtp_username',
      'smtp_password',
      'smtp_host',
      'from_address',
    ]);
  });

  it('every provider has at least one secret field', () => {
    for (const provider of getAllProviders()) {
      const secretFields = getSecretFieldIds(provider.providerId);
      // jina is the exception — api_key is optional
      if (provider.providerId === 'jina') {
        continue;
      }
      expect(
        secretFields.length,
        `Provider ${provider.providerId} should have at least one secret field`,
      ).toBeGreaterThan(0);
    }
  });

  it('no provider has duplicate field IDs', () => {
    for (const provider of getAllProviders()) {
      const fieldIds = provider.fields.map((f) => f.fieldId);
      const uniqueIds = new Set(fieldIds);
      expect(uniqueIds.size, `Provider ${provider.providerId} has duplicate field IDs`).toBe(
        fieldIds.length,
      );
    }
  });
});
