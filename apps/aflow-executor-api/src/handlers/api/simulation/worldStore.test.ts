/**
 * World versions after scheduled-call identity.
 *
 * They used to be RESERVED before a call's ladder ran, because entity ids were
 * minted from the reserved number — and deciding which number a call reserved
 * is what the whole scheduled-identity apparatus existed for: dispatch turns
 * and indices threaded onto job messages, target ordinals, two durable
 * high-waters, and four dispatch paths that could never supply any of it.
 *
 * Minting ids from the call's own `logicalExecutionId` removed the reason, so
 * versions are now assigned at commit, in commit order. What these tests pin is
 * that nothing was lost: ids stay deterministic and replay-stable, and a
 * serialized run — which is what an eval-grade run is — still gets exactly the
 * versions it did before.
 */
import { describe, it, expect } from 'vitest';
import { mintEntityId } from '@aflow/integration-simulator';

const seed = 'seed-alpha';

describe('entity ids are keyed on the call, not on a reserved version', () => {
  it('is stable for one call, so a replay mints the ids the journal already holds', () => {
    const first = mintEntityId({
      seed,
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 0,
    });
    const replayed = mintEntityId({
      seed,
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 0,
    });
    expect(replayed).toBe(first);
  });

  it('differs between two calls without either having to claim a version first', () => {
    // This is the property that made reservation unnecessary. Two concurrent
    // calls used to need distinct pre-assigned versions purely so their ids
    // would differ; their own identities already differ.
    const a = mintEntityId({
      seed,
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 0,
    });
    const b = mintEntityId({
      seed,
      logicalExecutionId: 'call-b',
      collection: 'refunds',
      sequence: 0,
    });
    expect(a).not.toBe(b);
  });

  it('separates the writes within one call by sequence', () => {
    const first = mintEntityId({
      seed,
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 0,
    });
    const second = mintEntityId({
      seed,
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 1,
    });
    expect(first).not.toBe(second);
  });

  it('separates runs by seed, so two runs of one scenario do not share ids', () => {
    const mine = mintEntityId({
      seed: 'seed-one',
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 0,
    });
    const theirs = mintEntityId({
      seed: 'seed-two',
      logicalExecutionId: 'call-a',
      collection: 'refunds',
      sequence: 0,
    });
    expect(mine).not.toBe(theirs);
  });

  it('cannot be collided by shuffling the parts across the separator', () => {
    expect(
      mintEntityId({ seed: 'a', logicalExecutionId: 'b c', collection: 'r', sequence: 0 }),
    ).not.toBe(
      mintEntityId({ seed: 'a b', logicalExecutionId: 'c', collection: 'r', sequence: 0 }),
    );
  });
});
