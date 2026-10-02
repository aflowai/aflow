import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdownController, DRAIN_SIGNAL } from '@aflow/lib';

import { startUnderSignals } from '../startUnderSignals.js';

const SIGNALS = ['SIGTERM', 'SIGINT', DRAIN_SIGNAL] as const;

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined };

function wire() {
  let shutDown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    shutDown = resolve;
  });
  const work = {
    stopClaiming: vi.fn(),
    inFlight: () => [],
    idle: () => Promise.resolve(),
  };
  const endInFlight = vi.fn();
  const controller = createShutdownController({
    name: 'Host Executor',
    logger: quiet,
    drain: { work, endInFlight },
    onShutdown: () => {
      shutDown();
      return Promise.resolve();
    },
  });
  return { controller, work, endInFlight, shutdown };
}

describe('the host executor starting', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  const listenersBefore = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();

  beforeEach(() => {
    for (const signal of SIGNALS) listenersBefore.set(signal, process.listeners(signal));
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore.get(signal)?.includes(listener)) process.off(signal, listener);
      }
    }
    exit.mockRestore();
  });

  // Delivered for real rather than emitted: with no handler attached, the
  // default action ends this test's own process.
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'stops now on %s delivered right after the runtime starts',
    async (signal) => {
      const { controller, work, endInFlight, shutdown } = wire();
      const start = vi.fn(() => Promise.resolve());

      await startUnderSignals(controller, [start]);
      process.kill(process.pid, signal);
      await shutdown;

      expect(start).toHaveBeenCalledOnce();
      expect(endInFlight).toHaveBeenCalledOnce();
      expect(work.stopClaiming).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(0);
      });
    },
  );

  it('drains on the drain signal delivered right after the runtime starts', async () => {
    const { controller, work, endInFlight, shutdown } = wire();

    await startUnderSignals(controller, [() => Promise.resolve()]);
    process.kill(process.pid, DRAIN_SIGNAL);
    await shutdown;

    expect(work.stopClaiming).toHaveBeenCalledOnce();
    expect(endInFlight).not.toHaveBeenCalled();
  });

  it('starts nothing more once a signal lands during a start', async () => {
    const { controller, shutdown } = wire();
    const second = vi.fn(() => Promise.resolve());

    const started = await startUnderSignals(controller, [
      async () => {
        process.kill(process.pid, DRAIN_SIGNAL);
        await shutdown;
      },
      second,
    ]);

    expect(started).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });
});
