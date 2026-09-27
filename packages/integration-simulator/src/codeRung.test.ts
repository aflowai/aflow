/**
 * What the isolate guarantees, as opposed to what it asks the author for.
 *
 * The reason a handler is safe is not that authors are careful — it is that the
 * nondeterministic globals are ABSENT and there is no host object to reach
 * through. These tests pin that, because a runtime where `Date` merely
 * "shouldn't" be used is one where the first run that uses it is reproducible
 * until the day it isn't.
 */
import { describe, expect, it } from 'vitest';
import { CodeHandlerError, runCodeHandler } from './codeRung.js';

function run(code: string, over: Partial<Parameters<typeof runCodeHandler>[0]> = {}) {
  return runCodeHandler({
    endpointId: 'getStatement',
    code,
    timeoutMs: 1_000,
    request: { method: 'GET', url: '/statements/p1', params: { purchaseId: 'p1' }, body: null },
    caller: { personaId: 'cus_77' },
    now: 1_788_000_000_000,
    mintId: (collection: string) => `${collection}_minted`,
    world: {
      instalments: [
        { instalmentId: 'i1', purchaseId: 'p1', amount: 80, status: 'paid' },
        { instalmentId: 'i2', purchaseId: 'p1', amount: 80, status: 'paid' },
        { instalmentId: 'i3', purchaseId: 'p1', amount: 80, status: 'scheduled' },
      ],
    },
    ...over,
  });
}

describe('what a handler can compute', () => {
  it('aggregates the world, which is the whole reason the rung exists', async () => {
    // This is `getStatement`: summing four numbers cost 62s of model time on a
    // live run, because no declarative rung can add.
    const result = await run(`
      var mine = world.instalments.filter(function (i) { return i.purchaseId === request.params.purchaseId; });
      var outstanding = mine
        .filter(function (i) { return i.status !== 'paid'; })
        .reduce(function (sum, i) { return sum + i.amount; }, 0);
      return { status: 200, body: { total: mine.length, outstanding: outstanding } };
    `);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ total: 3, outstanding: 80 });
  });

  it('names a created row through `newId`, so the body and the mutation agree', async () => {
    // The handler has to put the SAME id in both. Minting only on the way out
    // left it unable to name what it was creating, and an endpoint whose
    // response schema requires the id then failed its own contract.
    const result = await run(`
      var id = newId('instalments');
      return {
        status: 201,
        body: { instalmentId: id },
        mutations: [{ collection: 'instalments', op: 'create', entityId: id, body: { amount: 40 } }],
      };
    `);
    expect(result.body).toEqual({ instalmentId: 'instalments_minted' });
    expect(result.mutations).toEqual([
      {
        collection: 'instalments',
        op: 'create',
        entityId: 'instalments_minted',
        body: { amount: 40 },
      },
    ]);
  });

  it('reads the virtual clock through `now`, so a date is the run’s, not today’s', async () => {
    const result = await run(`return { status: 200, body: { at: now } };`);
    expect(result.body).toEqual({ at: 1_788_000_000_000 });
  });

  it('sees the caller without the request naming them', async () => {
    const result = await run(`return { status: 200, body: { who: caller.personaId } };`);
    expect(result.body).toEqual({ who: 'cus_77' });
  });
});

describe('what a handler cannot reach', () => {
  it('has a Date frozen to the virtual clock, not the wall-clock one', async () => {
    // Removing Date entirely was deterministic and unusable at once: the
    // collection schemas are full of ISO strings and the handler is given
    // milliseconds. Formatting stays; only the reading of NOW is replaced.
    const result = await run(`
      return {
        status: 200,
        body: {
          fromNow: Date.now(),
          fromCtor: new Date().toISOString(),
          parsed: new Date('2020-01-02T03:04:05.000Z').toISOString(),
        },
      };
    `);
    expect(result.body).toEqual({
      fromNow: 1_788_000_000_000,
      fromCtor: new Date(1_788_000_000_000).toISOString(),
      parsed: '2020-01-02T03:04:05.000Z',
    });
  });

  it('refuses a create whose id the handler chose rather than took', async () => {
    // Minting host-side is only half the guarantee: nothing stopped a handler
    // returning an id it made up. A constant one would have every call to the
    // endpoint write the same row, and a request-derived one hands the caller
    // the world's keys.
    await expect(
      run(`
        return {
          status: 201,
          body: {},
          mutations: [
            { collection: 'instalments', op: 'create', entityId: 'i_chosen', body: { amount: 1 } },
          ],
        };
      `),
    ).rejects.toThrow(/id it was not given/);
  });

  it('takes a create whose id came from newId, and leaves updates alone', async () => {
    // An update or a delete names a row the handler was SHOWN, whose id came
    // from the world — holding those to the minted set would refuse every
    // legitimate write against existing state.
    const result = await run(`
      var fresh = newId('instalments');
      return {
        status: 201,
        body: { instalmentId: fresh },
        mutations: [
          { collection: 'instalments', op: 'create', entityId: fresh, body: { amount: 80 } },
          { collection: 'instalments', op: 'update', entityId: 'i1', body: { status: 'paid' } },
          { collection: 'instalments', op: 'delete', entityId: 'i2' },
        ],
      };
    `);

    expect(result.mutations.map((m) => `${m.op}:${m.entityId}`)).toEqual([
      'create:instalments_minted',
      'update:i1',
      'delete:i2',
    ]);
  });

  it('freezes the constructor reachable through the prototype', async () => {
    // The proxy is not the only handle on the real Date: `Date.prototype` is
    // forwarded to the real prototype, whose `constructor` is unproxied. Two
    // expressions therefore reached wall-clock without ever touching the trap.
    const result = await run(`
      return {
        status: 200,
        body: {
          viaPrototype: new (Date.prototype.constructor)().getTime(),
          viaInstance: new ((new Date()).constructor)().getTime(),
        },
      };
    `);

    expect(result.body).toEqual({
      viaPrototype: 1_788_000_000_000,
      viaInstance: 1_788_000_000_000,
    });
  });

  it('reads local time as UTC, so a handler does not depend on the host zone', async () => {
    // QuickJS takes its zone from the host. A handler formatting local time
    // would answer differently on a laptop than on the executor — the same
    // replay divergence as wall-clock, by a slower route.
    const result = await run(`
      var d = new Date('2026-03-15T10:30:00.000Z');
      return {
        status: 200,
        body: { hours: d.getHours(), offset: d.getTimezoneOffset(), text: d.toString() },
      };
    `);

    expect(result.body).toEqual({
      hours: 10,
      offset: 0,
      text: 'Sun, 15 Mar 2026 10:30:00 GMT',
    });
  });

  it('still parses, formats and does arithmetic — the rung stays usable', async () => {
    // Freezing the clock must not cost the handler the ability to produce the
    // ISO strings collection schemas are full of.
    const result = await run(`
      var d = new Date('2026-03-15T10:30:00.000Z');
      return {
        status: 200,
        body: {
          iso: d.toISOString(),
          plus30d: new Date(d.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
          isDate: d instanceof Date,
        },
      };
    `);

    expect(result.body).toEqual({
      iso: '2026-03-15T10:30:00.000Z',
      plus30d: '2026-04-14T10:30:00.000Z',
      isDate: true,
    });
  });

  it('freezes `Date()` called without `new`, which bypasses the construct trap', async () => {
    // A proxy trapping only construction leaves `Date()` returning the real
    // wall-clock string — enough to make one call's output differ between two
    // replays, which is the property the frozen clock exists to hold.
    // Asserted as an instant, not as a string: the isolate's `toString` omits
    // the long timezone name Node appends, and the property under test is the
    // moment it names.
    const result = await run(`return { status: 200, body: { asFn: Date() } };`);
    const { asFn } = result.body as { asFn: string };
    expect(Date.parse(asFn)).toBe(1_788_000_000_000);
  });

  it('gives every run the same instant, so two runs cannot drift apart', async () => {
    const first = await run(`return { status: 200, body: { at: Date.now() } };`);
    const second = await run(`return { status: 200, body: { at: Date.now() } };`, {
      now: 1_788_000_000_000,
    });
    expect(first.body).toEqual(second.body);
  });

  it('has no Math.random, so two identical runs cannot diverge', async () => {
    const result = await run(`
      return { status: 200, body: { random: typeof (Math && Math.random) } };
    `);
    expect(result.body).toEqual({ random: 'undefined' });
  });

  it('has no way out — no fetch, no require, no process', async () => {
    const result = await run(`
      return {
        status: 200,
        body: {
          fetch: typeof fetch,
          require: typeof require,
          process: typeof process,
          globalThisKeys: typeof globalThis.XMLHttpRequest,
        },
      };
    `);
    expect(result.body).toEqual({
      fetch: 'undefined',
      require: 'undefined',
      process: 'undefined',
      globalThisKeys: 'undefined',
    });
  });

  it('sees only the collections it was given', async () => {
    // The host materializes what the handler declared. Anything else is absent
    // rather than empty, so a typo reads as a mistake instead of as no rows.
    const result = await run(`
      return { status: 200, body: { purchases: typeof world.purchases } };
    `);
    expect(result.body).toEqual({ purchases: 'undefined' });
  });
});

describe('how a handler fails', () => {
  it('is killed rather than allowed to hang the executor', async () => {
    await expect(run(`while (true) {}`, { timeoutMs: 50 })).rejects.toThrow(CodeHandlerError);
  });

  it('names the throw rather than swallowing it', async () => {
    await expect(run(`throw new Error('no such purchase');`)).rejects.toThrow(/no such purchase/);
  });

  it('refuses a return the contract does not accept', async () => {
    await expect(run(`return { body: { ok: true } };`)).rejects.toThrow(
      /must return \{ status, body, mutations\? \}/,
    );
  });

  it('refuses a status outside the HTTP range', async () => {
    await expect(run(`return { status: 42, body: {} };`)).rejects.toThrow(CodeHandlerError);
  });
});
