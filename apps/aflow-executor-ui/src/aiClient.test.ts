import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext } from '@aflow/executor-runtime';

const canResolveModel = vi.fn();

vi.mock('@aflow/credential-resolver', () => ({
  createByokAiClientFactory: () => ({
    canResolveModel,
    getClientForModel: vi.fn(),
  }),
  ByokCredentialError: class ByokCredentialError extends Error {},
}));

const { initUiAiClient, resolveGenerationModel } = await import('./aiClient.js');

/** Only the space with these connected providers can resolve a model. */
function connectedProviders(...prefixes: string[]): void {
  canResolveModel.mockImplementation((model: string) =>
    Promise.resolve(prefixes.some((p) => model.startsWith(p))),
  );
}

const ctx = {
  tenantId: 'tenant-1',
  job: { spaceId: 'space-1' },
} as unknown as ExecutorContext;

describe('resolveGenerationModel', () => {
  beforeEach(() => {
    canResolveModel.mockReset();
    initUiAiClient({} as PostgresJsDatabase);
  });

  it('honours an explicit caller choice above everything else', async () => {
    connectedProviders('openai', 'anthropic');
    expect(await resolveGenerationModel(ctx, ['openai-gpt', 'anthropic-sonnet'])).toBe(
      'openai-gpt',
    );
  });

  it('falls through a candidate whose provider the space has not connected', async () => {
    // The founding failure: the pin was anthropic, the space had only google.
    connectedProviders('google');
    expect(await resolveGenerationModel(ctx, [undefined, undefined, 'anthropic-sonnet'])).toBe(
      'google-pro',
    );
  });

  it("prefers the scheduling agent's own model over the kind default", async () => {
    connectedProviders('google', 'anthropic');
    expect(await resolveGenerationModel(ctx, [undefined, 'google-flash', 'anthropic-sonnet'])).toBe(
      'google-flash',
    );
  });

  it('reaches past every named candidate to any model the space can resolve', async () => {
    connectedProviders('kimi');
    const chosen = await resolveGenerationModel(ctx, [undefined, undefined, 'anthropic-sonnet']);
    expect(chosen).toBe('kimi-pro');
  });

  it('returns null when the space has no usable provider at all', async () => {
    connectedProviders();
    expect(await resolveGenerationModel(ctx, ['anthropic-sonnet'])).toBeNull();
  });

  it('probes each distinct candidate once', async () => {
    connectedProviders('nothing');
    await resolveGenerationModel(ctx, ['anthropic-sonnet', 'anthropic-sonnet', undefined]);
    const probed = canResolveModel.mock.calls.map((c) => c[0] as string);
    expect(new Set(probed).size).toBe(probed.length);
  });
});
