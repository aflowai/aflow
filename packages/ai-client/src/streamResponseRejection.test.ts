import { describe, it, expect, afterEach } from 'vitest';

/**
 * A streaming call hands back `{ stream, response }`, and a provider error
 * rejects BOTH. A consumer iterating the stream throws before it reaches
 * `await response`, so nothing is ever attached to that promise — and an
 * unhandled rejection takes the whole executor process down with it, killing
 * every other step in flight over one bad request.
 *
 * The shape is reproduced directly rather than driven through a real provider:
 * what needs guarding is the promise-wiring, and a test that needed an API key
 * would not run.
 */
describe('a rejected stream response promise', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  async function drain(pair: { stream: AsyncGenerator<string>; response: Promise<string> }) {
    process.on('unhandledRejection', onUnhandled);
    await expect(async () => {
      for await (const _ of pair.stream) {
        /* provider fails mid-stream */
      }
    }).rejects.toThrow('provider said no');
    // Two macrotask turns: Node reports an unhandled rejection after the
    // microtask queue drains, not synchronously.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function makePair(guard: boolean) {
    let reject!: (e: Error) => void;
    const response = new Promise<string>((_res, rej) => {
      reject = rej;
    });
    if (guard) response.catch(() => {});
    const stream = (async function* () {
      await Promise.resolve();
      const err = new Error('provider said no');
      reject(err);
      throw err;
    })();
    return { stream, response };
  }

  it('goes unhandled without the guard — the failure mode being fixed', async () => {
    await drain(makePair(false));
    expect(unhandled).toHaveLength(1);
  });

  it('is handled once a sink is attached at construction', async () => {
    await drain(makePair(true));
    expect(unhandled).toHaveLength(0);
  });

  it('still surfaces to a caller that does await it — the sink is not a swallow', async () => {
    const pair = makePair(true);
    await expect(async () => {
      for await (const _ of pair.stream) {
        /* fails */
      }
    }).rejects.toThrow('provider said no');
    await expect(pair.response).rejects.toThrow('provider said no');
  });
});

describe('client.generateTextStream wiring', () => {
  it('attaches a sink to the response promise it hands out', async () => {
    // The adapter's promise was already guarded; the one the CALLER holds was
    // not, which is the level the crash happened at.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./client.ts', import.meta.url), 'utf8'),
    );
    const construction = src.slice(
      src.indexOf('const responsePromise = new Promise'),
      src.indexOf('const streamGenerator'),
    );
    expect(construction).toContain('responsePromise.catch(');
  });
});
