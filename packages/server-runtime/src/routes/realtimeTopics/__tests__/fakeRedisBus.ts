/**
 * In-memory stand-in for the entity-event substrate: one XADD/XRANGE stream
 * plus a Pub/Sub bus whose delivery can be switched off independently of the
 * writes.
 *
 * The topics under test recover from a lost wake by re-reading the durable
 * stream, so a fake that only records `publish` calls would prove nothing —
 * the stream and the channel have to be the same substrate, and a test has to
 * be able to break one without breaking the other.
 */
import type { Redis } from 'ioredis';

interface StreamEntry {
  id: string;
  fields: string[];
}

type MessageListener = (channel: string, raw: string) => void;
type ReadyListener = () => void;

export interface FakeSubscriber {
  /** Channels this connection currently holds a SUBSCRIBE on. */
  subscribed: Set<string>;
  quitCalls: number;
  /** Re-emit `ready`, as ioredis does after it reconnects and re-subscribes. */
  emitReady(): void;
  /** Deliver a raw payload as if Redis had pushed it on `channel`. */
  fireMessage(channel: string, raw: string): void;
}

export interface FakeRedisBus {
  /** Client handle to pass as the topic handler's `redis` dependency. */
  client: Redis;
  /** Every subscriber connection minted through `createSubscriberConnection`. */
  subscribers: FakeSubscriber[];
  mintSubscriber(): Redis;
  /** When false a PUBLISH is accepted but reaches nobody — a Pub/Sub blip. */
  setPublishDelivery(deliver: boolean): void;
  /** Hold the next SUBSCRIBE in flight until the returned release is called. */
  gateNextSubscribe(): { release: () => void; entered: Promise<void> };
  /** Hold the next XRANGE in flight until the returned release is called. */
  gateNextXrange(): { release: () => void; entered: Promise<void> };
  /** Run `fn` while the next SUBSCRIBE is in flight. */
  onSubscribeInFlight(fn: () => void | Promise<void>): void;
  xrangeCalls: () => number;
  /** Command names grouped by the exec that issued them (one group per round trip). */
  execGroups: () => string[][];
}

function parseId(id: string): [number, number] {
  const [ms, seq] = id.split('-');
  return [Number(ms ?? 0), Number(seq ?? 0)];
}

function idGte(a: string, b: string): boolean {
  const [am, as] = parseId(a);
  const [bm, bs] = parseId(b);
  return am !== bm ? am > bm : as >= bs;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function createFakeRedisBus(): FakeRedisBus {
  const streams = new Map<string, StreamEntry[]>();
  const channelListeners = new Map<string, Set<MessageListener>>();
  const subscribers: FakeSubscriber[] = [];
  const execGroups: string[][] = [];

  let seq = 0;
  let deliverPublishes = true;
  let xrangeCalls = 0;
  let subscribeGate: { promise: Promise<void>; resolve: () => void } | null = null;
  let subscribeEntered: (() => void) | null = null;
  let subscribeInFlight: (() => void | Promise<void>) | null = null;
  let xrangeGate: { promise: Promise<void>; resolve: () => void } | null = null;
  let xrangeEntered: (() => void) | null = null;

  const doXadd = (key: string, args: string[]): string => {
    // args: MAXLEN ~ <n> * <field> <value> ...
    const starAt = args.indexOf('*');
    const fields = args.slice(starAt + 1);
    seq += 1;
    const id = `${String(seq)}-0`;
    const entries = streams.get(key) ?? [];
    entries.push({ id, fields });
    streams.set(key, entries);
    return id;
  };

  const doPublish = (channel: string, raw: string): number => {
    if (!deliverPublishes) return 0;
    const listeners = channelListeners.get(channel);
    if (!listeners) return 0;
    for (const listener of [...listeners]) listener(channel, raw);
    return listeners.size;
  };

  const client = {
    async xadd(key: string, ...args: string[]): Promise<string> {
      execGroups.push(['xadd']);
      return doXadd(key, args);
    },
    async expire(): Promise<number> {
      execGroups.push(['expire']);
      return 1;
    },
    async publish(channel: string, raw: string): Promise<number> {
      execGroups.push(['publish']);
      return doPublish(channel, raw);
    },
    async xrange(
      key: string,
      fromId: string,
      _to: string,
      _countKeyword: string,
      count: number,
    ): Promise<[string, string[]][]> {
      xrangeCalls += 1;
      // Snapshot before the gate: a gated read models a slow *reply*, so it
      // must not see writes that landed after the command was issued.
      const page = (streams.get(key) ?? [])
        .filter((e) => idGte(e.id, fromId))
        .slice(0, count)
        .map((e) => [e.id, e.fields] as [string, string[]]);
      if (xrangeGate) {
        const gate = xrangeGate;
        xrangeGate = null;
        xrangeEntered?.();
        xrangeEntered = null;
        await gate.promise;
      }
      return page;
    },
    multi() {
      const queued: { name: string; run: () => unknown }[] = [];
      const chain = {
        xadd(key: string, ...args: string[]) {
          queued.push({ name: 'xadd', run: () => doXadd(key, args) });
          return chain;
        },
        expire() {
          queued.push({ name: 'expire', run: () => 1 });
          return chain;
        },
        publish(channel: string, raw: string) {
          queued.push({ name: 'publish', run: () => doPublish(channel, raw) });
          return chain;
        },
        async exec(): Promise<[Error | null, unknown][]> {
          execGroups.push(queued.map((q) => q.name));
          return queued.map((q) => [null, q.run()] as [Error | null, unknown]);
        },
      };
      return chain;
    },
  } as unknown as Redis;

  const mintSubscriber = (): Redis => {
    const messageListeners = new Set<MessageListener>();
    const readyListeners = new Set<ReadyListener>();
    const subscribed = new Set<string>();
    let initialReadyFired = false;

    const record: FakeSubscriber = {
      subscribed,
      quitCalls: 0,
      emitReady() {
        for (const listener of [...readyListeners]) listener();
      },
      fireMessage(channel, raw) {
        for (const listener of [...messageListeners]) listener(channel, raw);
      },
    };
    subscribers.push(record);

    const conn = {
      on(event: string, cb: (...args: never[]) => void) {
        if (event === 'message') {
          const listener = cb as unknown as MessageListener;
          messageListeners.add(listener);
          for (const channel of subscribed) {
            (channelListeners.get(channel) ?? new Set()).add(listener);
          }
        }
        if (event === 'ready') readyListeners.add(cb as unknown as ReadyListener);
        return conn;
      },
      off(event: string, cb: (...args: never[]) => void) {
        if (event === 'message') {
          const listener = cb as unknown as MessageListener;
          messageListeners.delete(listener);
          for (const set of channelListeners.values()) set.delete(listener);
        }
        if (event === 'ready') readyListeners.delete(cb as unknown as ReadyListener);
        return conn;
      },
      async subscribe(...channels: string[]): Promise<number> {
        // ioredis dials eagerly and emits `ready` before the first SUBSCRIBE
        // resolves — the topics under test must treat that first `ready` as
        // the connect their boot read follows, not as a reconnect.
        if (!initialReadyFired) {
          initialReadyFired = true;
          for (const listener of [...readyListeners]) listener();
        }
        if (subscribeInFlight) {
          const fn = subscribeInFlight;
          subscribeInFlight = null;
          await fn();
        }
        if (subscribeGate) {
          const gate = subscribeGate;
          subscribeGate = null;
          subscribeEntered?.();
          subscribeEntered = null;
          await gate.promise;
        }
        for (const channel of channels) {
          subscribed.add(channel);
          let set = channelListeners.get(channel);
          if (!set) {
            set = new Set();
            channelListeners.set(channel, set);
          }
          for (const listener of messageListeners) set.add(listener);
        }
        return subscribed.size;
      },
      async unsubscribe(...channels: string[]): Promise<number> {
        for (const channel of channels) {
          subscribed.delete(channel);
          const set = channelListeners.get(channel);
          if (set) for (const listener of messageListeners) set.delete(listener);
        }
        return subscribed.size;
      },
      async quit(): Promise<'OK'> {
        record.quitCalls += 1;
        for (const channel of [...subscribed]) {
          const set = channelListeners.get(channel);
          if (set) for (const listener of messageListeners) set.delete(listener);
        }
        subscribed.clear();
        return 'OK';
      },
    };
    return conn as unknown as Redis;
  };

  return {
    client,
    subscribers,
    mintSubscriber,
    setPublishDelivery(deliver) {
      deliverPublishes = deliver;
    },
    gateNextSubscribe() {
      const gate = deferred();
      const entered = deferred();
      subscribeGate = gate;
      subscribeEntered = entered.resolve;
      return { release: gate.resolve, entered: entered.promise };
    },
    gateNextXrange() {
      const gate = deferred();
      const entered = deferred();
      xrangeGate = gate;
      xrangeEntered = entered.resolve;
      return { release: gate.resolve, entered: entered.promise };
    },
    onSubscribeInFlight(fn) {
      subscribeInFlight = fn;
    },
    xrangeCalls: () => xrangeCalls,
    execGroups: () => execGroups.map((g) => [...g]),
  };
}
