import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { consumeEmbeddingBudget, estimateEmbeddingTokens } from './embeddingBudget.js';

const redis = new RedisMock() as unknown as Redis;

describe('estimateEmbeddingTokens', () => {
  it('estimates ~chars/4 with a floor of 1', () => {
    expect(estimateEmbeddingTokens([''])).toBe(1);
    expect(estimateEmbeddingTokens(['a'.repeat(400)])).toBe(100);
    expect(estimateEmbeddingTokens(['ab', 'cd'])).toBe(1);
  });
});

describe('consumeEmbeddingBudget', () => {
  it('skips redis entirely when no limits are configured', async () => {
    const out = await consumeEmbeddingBudget(redis, {
      tenantId: 't-none',
      spaceId: 's1',
      tokens: 10,
      limits: {},
    });
    expect(out).toEqual({ allowed: true, exceededScope: null });
  });

  it('allows under the per-space bound and rejects over it', async () => {
    const tenantId = `t-${Math.random().toString(36).slice(2)}`;
    const limits = { perSpaceTokens: 100 };
    const first = await consumeEmbeddingBudget(redis, {
      tenantId,
      spaceId: 's1',
      tokens: 80,
      limits,
    });
    expect(first.allowed).toBe(true);
    const second = await consumeEmbeddingBudget(redis, {
      tenantId,
      spaceId: 's1',
      tokens: 80,
      limits,
    });
    expect(second).toEqual({ allowed: false, exceededScope: 'space' });
    // A different space has its own counter
    const other = await consumeEmbeddingBudget(redis, {
      tenantId,
      spaceId: 's2',
      tokens: 80,
      limits,
    });
    expect(other.allowed).toBe(true);
  });

  it('the tenant backstop rejects across spaces', async () => {
    const tenantId = `t-${Math.random().toString(36).slice(2)}`;
    const limits = { perSpaceTokens: 1000, tenantTokens: 150 };
    await consumeEmbeddingBudget(redis, { tenantId, spaceId: 's1', tokens: 100, limits });
    const out = await consumeEmbeddingBudget(redis, {
      tenantId,
      spaceId: 's2',
      tokens: 100,
      limits,
    });
    expect(out).toEqual({ allowed: false, exceededScope: 'tenant' });
  });

  it('null spaceId applies only the tenant bound', async () => {
    const tenantId = `t-${Math.random().toString(36).slice(2)}`;
    const out = await consumeEmbeddingBudget(redis, {
      tenantId,
      spaceId: null,
      tokens: 10,
      limits: { perSpaceTokens: 1 },
    });
    expect(out.allowed).toBe(true);
  });
});
