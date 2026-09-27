import { describe, expect, it } from 'vitest';
import { deriveRunSeed, mintEntityId } from './identity.js';

const base = {
  seed: 'seed-alpha',
  logicalExecutionId: 'call-3',
  collection: 'refunds',
  sequence: 0,
};

describe('mintEntityId', () => {
  it('is stable for the same (seed, logicalExecutionId, collection, sequence)', () => {
    expect(mintEntityId(base)).toBe(mintEntityId({ ...base }));
  });

  it('names the collection it belongs to', () => {
    expect(mintEntityId(base)).toMatch(/^refunds_[0-9a-f]{20}$/);
  });

  it('differs when any single input differs', () => {
    const minted = mintEntityId(base);

    expect(mintEntityId({ ...base, seed: 'seed-beta' })).not.toBe(minted);
    expect(mintEntityId({ ...base, logicalExecutionId: 'call-4' })).not.toBe(minted);
    expect(mintEntityId({ ...base, collection: 'orders' })).not.toBe(minted);
    expect(mintEntityId({ ...base, sequence: 1 })).not.toBe(minted);
  });

  it('does not collide across the fields it concatenates', () => {
    // Two collections sharing an identity space would break every reference
    // between them, so the derivation must separate the fields it concatenates.
    expect(mintEntityId({ ...base, collection: 'refunds x', sequence: 0 })).not.toBe(
      mintEntityId({ ...base, collection: 'refunds', sequence: 0 }),
    );
    expect(mintEntityId({ ...base, seed: 'seed', logicalExecutionId: 'call-31' })).not.toBe(
      mintEntityId({ ...base, seed: 'seed 3', logicalExecutionId: 'call-1' }),
    );
  });
});

describe('deriveRunSeed', () => {
  it('is stable per run id', () => {
    expect(deriveRunSeed('run_1')).toBe(deriveRunSeed('run_1'));
  });

  it('differs across run ids, so two runs explore differently', () => {
    expect(deriveRunSeed('run_1')).not.toBe(deriveRunSeed('run_2'));
  });

  it('fits the SimulationRunContext seed bound', () => {
    expect(deriveRunSeed('run_1')).toHaveLength(32);
  });
});
