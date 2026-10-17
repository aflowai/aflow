import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';

const mockLoadSpaceDirectives = vi.fn();
const mockHasProviderCredential = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadSpaceDirectives: (...args: unknown[]) => mockLoadSpaceDirectives(...args),
}));
vi.mock('../aiClient.js', async () => {
  const actual = await vi.importActual<typeof import('../aiClient.js')>('../aiClient.js');
  return {
    ...actual,
    hasProviderCredential: (...args: unknown[]) => mockHasProviderCredential(...args),
  };
});

import { resolveDecisionModel } from './decisionModel.js';
import type { HandlerDeps } from './types.js';

const ctx = {
  tenantId: 'tenant',
  job: { spaceId: 'space', tenantId: 'tenant', credentialOwnerId: 'user' },
} as unknown as ExecutorContext;
const deps = { db: {} } as unknown as HandlerDeps;

function keysFor(...providers: string[]) {
  mockHasProviderCredential.mockImplementation(async (_ctx: unknown, provider: string) =>
    providers.includes(provider),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSpaceDirectives.mockResolvedValue(null);
});

describe('which decision model a step runs on', () => {
  it('runs the model the step names', async () => {
    keysFor();
    expect(await resolveDecisionModel(ctx, deps, { model: 'jev', readsImages: false })).toBe('jev');
    expect(mockLoadSpaceDirectives).not.toHaveBeenCalled();
  });

  it('runs the space’s decision model when the step names none', async () => {
    mockLoadSpaceDirectives.mockResolvedValue({ modelDefaults: { decision: 'luna-decisions' } });
    expect(await resolveDecisionModel(ctx, deps, { readsImages: false })).toBe('luna-decisions');
  });

  it('otherwise runs the first decision model the space holds a key for', async () => {
    keysFor('openai');
    expect(await resolveDecisionModel(ctx, deps, { readsImages: false })).toBe('luna-decisions');
    keysFor('typesafe', 'openai');
    expect(await resolveDecisionModel(ctx, deps, { readsImages: false })).toBe('jev');
  });

  it('passes over a model that reads no images when the step carries one', async () => {
    keysFor('typesafe', 'openai');
    expect(await resolveDecisionModel(ctx, deps, { readsImages: true })).toBe('luna-decisions');
  });

  it('names the keys that would make it run when the space holds none', async () => {
    keysFor();
    await expect(resolveDecisionModel(ctx, deps, { readsImages: false })).rejects.toThrow(
      /typesafe \(jev\).*openai \(luna-decisions\)/,
    );
  });
});
