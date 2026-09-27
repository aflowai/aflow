import { describe, expect, it } from 'vitest';
import {
  createLeasedWorkConsumer,
  type LeasedWorkConsumer,
  type LeasedWorkConsumerConfig,
  type LeasedWorkEvent,
  type LeasedWorkResult,
} from '../leasedWork/consumer.js';

interface Item {
  id: string;
}

/**
 * A scripted substrate that records every call in order, so each test can
 * assert not only what the runner touched but what it touched first.
 */
function makeHarness(items: Item[]) {
  const calls: string[] = [];
  const events: LeasedWorkEvent<Item>[] = [];
  const results = new Map<string, () => Promise<LeasedWorkResult> | LeasedWorkResult>();
  let ackAnswer: (item: Item) => boolean | Promise<boolean> = () => true;
  let retireAnswer: (item: Item) => boolean | Promise<boolean> = () => true;
  let validateAnswer: ((item: Item) => { ok: true } | { ok: false; reason: string }) | undefined;
  let afterCompleted: ((item: Item) => Promise<void>) | undefined;
  let discardAnswer: ((item: Item) => void | Promise<void>) | undefined;
  let onEventThrows = false;

  const config: LeasedWorkConsumerConfig<Item> = {
    name: 'test',
    claim: async (limit) => {
      calls.push(`claim:${String(limit)}`);
      return items.slice(0, limit);
    },
    validate: (item) => {
      const answer = validateAnswer?.(item) ?? { ok: true };
      calls.push(`validate:${item.id}:${answer.ok ? 'ok' : 'reject'}`);
      return answer;
    },
    discard: async (item) => {
      calls.push(`discard:${item.id}`);
      await discardAnswer?.(item);
    },
    work: async (item) => {
      calls.push(`work:${item.id}`);
      const scripted = results.get(item.id);
      if (!scripted) return { kind: 'completed' };
      return scripted();
    },
    ack: async (item) => {
      calls.push(`ack:${item.id}`);
      return ackAnswer(item);
    },
    retire: async (item) => {
      calls.push(`retire:${item.id}`);
      return retireAnswer(item);
    },
    afterCompleted: async (item) => {
      calls.push(`afterCompleted:${item.id}`);
      await afterCompleted?.(item);
    },
    onEvent: (event) => {
      events.push(event);
      if (onEventThrows) throw new Error('observer broke');
    },
  };

  return {
    calls,
    events,
    consumer: createLeasedWorkConsumer(config),
    scriptWork(id: string, result: () => Promise<LeasedWorkResult> | LeasedWorkResult) {
      results.set(id, result);
    },
    setAck(answer: typeof ackAnswer) {
      ackAnswer = answer;
    },
    setRetire(answer: typeof retireAnswer) {
      retireAnswer = answer;
    },
    setValidate(answer: NonNullable<typeof validateAnswer>) {
      validateAnswer = answer;
    },
    setAfterCompleted(fn: NonNullable<typeof afterCompleted>) {
      afterCompleted = fn;
    },
    setDiscard(fn: NonNullable<typeof discardAnswer>) {
      discardAnswer = fn;
    },
    setOnEventThrow() {
      onEventThrows = true;
    },
  };
}

describe('completed work', () => {
  it('acknowledges with the exact claim and counts a refusal without touching anything else', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.setAck(() => false);
    const stats = await h.consumer.runBatch(10);

    expect(stats.completed).toBe(1);
    expect(stats.ackRefused).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('retire:'))).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith('discard:'))).toHaveLength(0);
  });

  it('leaves the item leased when the acknowledgement throws', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.setAck(() => {
      throw new Error('redis gone');
    });
    const stats = await h.consumer.runBatch(10);

    expect(stats.ackErrors).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('retire:'))).toHaveLength(0);
  });

  it('runs afterCompleted whatever the acknowledgement answered', async () => {
    const h = makeHarness([{ id: 'a' }, { id: 'b' }]);
    h.setAck((item) => item.id !== 'a');
    await h.consumer.runBatch(10);

    expect(h.calls).toContain('afterCompleted:a');
    expect(h.calls).toContain('afterCompleted:b');
  });
});

describe('items that cannot name themselves', () => {
  it('discards a validate rejection unguarded and never works, acks, or retires it', async () => {
    const h = makeHarness([{ id: 'bad' }, { id: 'good' }]);
    h.setValidate((item) =>
      item.id === 'bad' ? { ok: false, reason: 'not a uuid' } : { ok: true },
    );
    const stats = await h.consumer.runBatch(10);

    expect(stats.discarded).toBe(1);
    expect(stats.completed).toBe(1);
    expect(h.calls).toContain('discard:bad');
    expect(
      h.calls.filter((c) => c === 'work:bad' || c === 'ack:bad' || c === 'retire:bad'),
    ).toHaveLength(0);
    expect(h.calls).toContain('work:good');
  });
});

describe('pre-claimed batches', () => {
  it('processes handed items without touching claim', async () => {
    const h = makeHarness([{ id: 'ignored' }]);
    const stats = await h.consumer.runClaimed([{ id: 'x' }, { id: 'y' }]);

    expect(stats.claimed).toBe(2);
    expect(stats.completed).toBe(2);
    expect(h.calls.filter((c) => c.startsWith('claim:'))).toHaveLength(0);
    expect(h.calls).toContain('ack:x');
    expect(h.calls).toContain('ack:y');
  });

  it('refuses runBatch on a consumer built without claim', async () => {
    // The overload keeps this uncompilable; the cast reaches the runtime
    // backstop behind it.
    const consumer = createLeasedWorkConsumer<{ id: string }>({
      name: 'claimless',
      work: async () => ({ kind: 'completed' }),
      ack: async () => true,
      retire: async () => true,
    }) as LeasedWorkConsumer<{ id: string }>;
    await expect(consumer.runBatch(5)).rejects.toThrow(/no claim/);
  });
});

describe('batch gates and settled failures', () => {
  it('releases the remainder unworked when the gate closes', async () => {
    const released: string[] = [];
    let worked = 0;
    const consumer = createLeasedWorkConsumer<{ id: string }>({
      name: 'gated',
      work: async () => {
        worked++;
        return { kind: 'completed' };
      },
      ack: async () => true,
      retire: async () => true,
      release: async (c) => {
        released.push(c.id);
      },
    });
    const stats = await consumer.runClaimed([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
      shouldContinue: () => worked < 1,
    });

    expect(worked).toBe(1);
    expect(released).toEqual(['b', 'c']);
    expect(stats.released).toBe(2);
    expect(stats.completed).toBe(1);
  });

  it('acknowledges a settled failure and counts it apart from completions', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.scriptWork('a', () => ({ kind: 'failed_settled' }));
    const stats = await h.consumer.runBatch(10);

    expect(stats.failedSettled).toBe(1);
    expect(stats.completed).toBe(0);
    expect(h.calls).toContain('ack:a');
    expect(h.calls).not.toContain('afterCompleted:a');
  });
});

describe('fenced edges', () => {
  it('does not count a failed discard as a removal, and the item stays', async () => {
    const h = makeHarness([{ id: 'bad' }]);
    h.setValidate(() => ({ ok: false, reason: 'not a uuid' }));
    h.setDiscard(() => {
      throw new Error('redis gone');
    });
    const stats = await h.consumer.runBatch(10);

    expect(stats.discarded).toBe(0);
    expect(stats.discardErrors).toBe(1);
    expect(h.events.some((e) => e.kind === 'discard_error')).toBe(true);
    expect(h.events.some((e) => e.kind === 'discarded')).toBe(false);
  });

  it('reports a rejection with no discard as an error, never as a removal', async () => {
    const consumer = createLeasedWorkConsumer<{ id: string }>({
      name: 'no-discard',
      validate: () => ({ ok: false, reason: 'unnameable' }),
      work: async () => ({ kind: 'completed' }),
      ack: async () => true,
    });
    const stats = await consumer.runClaimed([{ id: 'a' }]);

    expect(stats.discarded).toBe(0);
    expect(stats.discardErrors).toBe(1);
  });

  it('leaves the item leased when validate itself throws, never reaching discard', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.setValidate(() => {
      throw new Error('classifier broke');
    });
    const stats = await h.consumer.runBatch(10);

    expect(stats.workErrors).toBe(1);
    expect(h.calls.filter((c) => /^(discard|work|ack|retire):/.test(c))).toHaveLength(0);
  });

  it('finishes the batch when the event observer throws', async () => {
    const h = makeHarness([{ id: 'a' }, { id: 'b' }]);
    h.setAck(() => false);
    h.setOnEventThrow();
    const stats = await h.consumer.runBatch(10);

    expect(stats.completed).toBe(2);
    expect(stats.ackRefused).toBe(2);
  });
});

describe('unworkable items', () => {
  it('commits the disposition strictly before the guarded retirement', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.scriptWork('a', () => ({
      kind: 'unworkable',
      disposition: async () => {
        h.calls.push('disposition:a');
        return true;
      },
    }));
    const stats = await h.consumer.runBatch(10);

    expect(stats.retired).toBe(1);
    expect(h.calls.indexOf('disposition:a')).toBeLessThan(h.calls.indexOf('retire:a'));
  });

  it('leaves the item leased when the disposition is unauthorized or throws', async () => {
    const h = makeHarness([{ id: 'unauthorized' }, { id: 'throws' }]);
    h.scriptWork('unauthorized', () => ({ kind: 'unworkable', disposition: async () => false }));
    h.scriptWork('throws', () => ({
      kind: 'unworkable',
      disposition: async () => {
        throw new Error('pg gone');
      },
    }));
    const stats = await h.consumer.runBatch(10);

    expect(stats.dispositionsFailed).toBe(2);
    expect(stats.retired).toBe(0);
    expect(h.calls.filter((c) => c.startsWith('retire:'))).toHaveLength(0);
  });

  it('keeps the item when the guarded retirement is refused', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.scriptWork('a', () => ({ kind: 'unworkable', disposition: async () => true }));
    h.setRetire(() => false);
    const stats = await h.consumer.runBatch(10);

    expect(stats.retireRefused).toBe(1);
    expect(stats.retired).toBe(0);
  });
});

describe('failed work', () => {
  it('spends the budget and leaves the item leased short of eviction', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.scriptWork('a', () => ({ kind: 'failed', budget: async () => ({ evict: false }) }));
    const stats = await h.consumer.runBatch(10);

    expect(stats.failures).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('retire:') || c.startsWith('ack:'))).toHaveLength(0);
  });

  it('retires through the guard on eviction, and a refusal keeps the item', async () => {
    const h = makeHarness([{ id: 'evicted' }, { id: 'kept' }]);
    h.scriptWork('evicted', () => ({ kind: 'failed', budget: async () => ({ evict: true }) }));
    h.scriptWork('kept', () => ({ kind: 'failed', budget: async () => ({ evict: true }) }));
    h.setRetire((item) => item.id === 'evicted');
    const stats = await h.consumer.runBatch(10);

    expect(stats.evicted).toBe(2);
    expect(stats.retired).toBe(1);
    expect(stats.retireRefused).toBe(1);
  });

  it('leaves the item leased when the budget itself fails', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.scriptWork('a', () => ({
      kind: 'failed',
      budget: async () => {
        throw new Error('pg gone');
      },
    }));
    const stats = await h.consumer.runBatch(10);

    expect(stats.failures).toBe(0);
    expect(stats.evicted).toBe(0);
    expect(stats.budgetErrors).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('retire:'))).toHaveLength(0);
    expect(h.events.some((e) => e.kind === 'budget_error')).toBe(true);
  });
});

describe('yield and escaped throws', () => {
  it('touches nothing on a yield', async () => {
    const h = makeHarness([{ id: 'a' }]);
    h.scriptWork('a', () => ({ kind: 'yield', reason: 'not mine' }));
    const stats = await h.consumer.runBatch(10);

    expect(stats.yielded).toBe(1);
    expect(h.calls.filter((c) => /^(ack|retire|discard):/.test(c))).toHaveLength(0);
  });

  it('leaves the item leased when work throws past its own classifier', async () => {
    const h = makeHarness([{ id: 'a' }, { id: 'b' }]);
    h.scriptWork('a', () => {
      throw new Error('unclassified');
    });
    const stats = await h.consumer.runBatch(10);

    expect(stats.workErrors).toBe(1);
    expect(stats.completed).toBe(1);
    expect(h.calls.filter((c) => c === 'ack:a' || c === 'retire:a')).toHaveLength(0);
    expect(h.calls).toContain('ack:b');
  });
});
