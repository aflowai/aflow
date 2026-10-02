import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSignalHandlers,
  createShutdownController,
  DRAIN_SIGNAL,
  type InFlightWork,
  type ShutdownLogger,
} from '../shutdown.js';

const HARNESS_TIMEOUT_MS = 30 * 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Steps that end when the test says so, the way a harness run ends when its agent does. */
function fakeWork(steps: InFlightWork[]) {
  const running = [...steps];
  let wake: (() => void) | undefined;
  return {
    stopClaiming: vi.fn(),
    inFlight: () => [...running],
    idle: () =>
      running.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            wake = resolve;
          }),
    finish(name: string) {
      running.splice(
        running.findIndex((step) => step.name === name),
        1,
      );
      if (running.length === 0) wake?.();
    },
    slide(name: string, deadlineAt: number) {
      const step = running.find((s) => s.name === name);
      if (step !== undefined) step.deadlineAt = deadlineAt;
    },
  };
}

function recordingLogger() {
  const lines: { message: string; data?: Record<string, unknown> }[] = [];
  const logger: ShutdownLogger = {
    debug: () => undefined,
    info: (message, data) => {
      lines.push({ message, ...(data !== undefined ? { data } : {}) });
    },
    warn: () => undefined,
  };
  return { logger, lines };
}

const SIGNALS = ['SIGTERM', 'SIGINT', DRAIN_SIGNAL] as const;

describe('stopping the host executor', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  const listenersBefore = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  function wire(work: ReturnType<typeof fakeWork>) {
    const { logger, lines } = recordingLogger();
    const endInFlight = vi.fn();
    const onShutdown = vi.fn(() => Promise.resolve());
    const controller = createShutdownController({
      name: 'Host Executor',
      logger,
      drain: { work, endInFlight },
      onShutdown,
    });
    attachSignalHandlers({
      onShutdown: () => controller.shutdownOnce(),
      onDrain: () => controller.drainOnce(),
    });
    return { lines, endInFlight, onShutdown };
  }

  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s with a step in flight ends it and exits at once',
    async (signal) => {
      const work = fakeWork([
        { name: 'host.harness.run step-1', deadlineAt: Date.now() + HARNESS_TIMEOUT_MS },
      ]);
      const { endInFlight, onShutdown, lines } = wire(work);

      process.emit(signal);
      expect(endInFlight).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);

      expect(onShutdown).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
      expect(lines.some((l) => l.message.includes('draining'))).toBe(false);
      expect(lines.find((l) => l.message.includes('stopping now'))?.data).toEqual({
        ended: ['host.harness.run step-1'],
      });
    },
  );

  it('stays up past the drain signal while a step runs, and exits when it finishes', async () => {
    const now = Date.now();
    const work = fakeWork([
      { name: 'host.harness.run step-1', deadlineAt: now + HARNESS_TIMEOUT_MS },
    ]);
    const { endInFlight, onShutdown } = wire(work);

    process.emit(DRAIN_SIGNAL);
    await vi.advanceTimersByTimeAsync(HARNESS_TIMEOUT_MS / 2);

    expect(work.stopClaiming).toHaveBeenCalledOnce();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    work.finish('host.harness.run step-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(endInFlight).not.toHaveBeenCalled();
    expect(onShutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each(['SIGTERM', DRAIN_SIGNAL] as const)(
    '%s during a drain ends what is in flight and exits at once',
    async (signal) => {
      const work = fakeWork([
        { name: 'host.harness.run step-1', deadlineAt: Date.now() + HARNESS_TIMEOUT_MS },
      ]);
      const { endInFlight, onShutdown, lines } = wire(work);

      process.emit(DRAIN_SIGNAL);
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).not.toHaveBeenCalled();

      process.emit(signal);
      await vi.advanceTimersByTimeAsync(0);

      expect(endInFlight).toHaveBeenCalledOnce();
      expect(onShutdown).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
      expect(lines.find((l) => l.message === 'Host Executor: drain ended')?.data).toEqual({
        outcome: 'stopped',
        ended: ['host.harness.run step-1'],
      });
    },
  );

  it('shuts a service without a drain down once, however many signals arrive', async () => {
    const onShutdown = vi.fn(() => Promise.resolve());
    const controller = createShutdownController({
      name: 'AI Executor',
      logger: recordingLogger().logger,
      onShutdown,
    });
    attachSignalHandlers({ onShutdown: () => controller.shutdownOnce() });

    process.emit('SIGTERM');
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);

    expect(onShutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('waits until the latest in-flight timeout, and no longer', async () => {
    const now = Date.now();
    const work = fakeWork([
      { name: 'host.harness.run step-1', deadlineAt: now + HARNESS_TIMEOUT_MS },
      { name: 'host.commit.check step-2', deadlineAt: now + CHECK_TIMEOUT_MS },
    ]);
    const { endInFlight, lines } = wire(work);

    process.emit(DRAIN_SIGNAL);
    await vi.advanceTimersByTimeAsync(HARNESS_TIMEOUT_MS - 1);
    expect(endInFlight).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(endInFlight).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(lines.find((l) => l.message === 'Host Executor: drain ended')?.data).toEqual({
      outcome: 'deadline',
      ended: ['host.harness.run step-1', 'host.commit.check step-2'],
    });
  });

  it('follows a deadline the step itself moves', async () => {
    const now = Date.now();
    const work = fakeWork([
      { name: 'host.harness.run step-1', deadlineAt: now + CHECK_TIMEOUT_MS },
    ]);
    const { endInFlight } = wire(work);

    process.emit(DRAIN_SIGNAL);
    work.slide('host.harness.run step-1', now + HARNESS_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(endInFlight).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HARNESS_TIMEOUT_MS - CHECK_TIMEOUT_MS);
    expect(endInFlight).toHaveBeenCalledOnce();
  });

  it('logs one line as the drain begins, naming the steps and the deadline, and one as it ends', async () => {
    const now = Date.now();
    const work = fakeWork([
      { name: 'host.harness.run step-1', deadlineAt: now + HARNESS_TIMEOUT_MS },
      { name: 'host.commit.check step-2', deadlineAt: now + CHECK_TIMEOUT_MS },
    ]);
    const { lines } = wire(work);

    process.emit(DRAIN_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);
    work.finish('host.commit.check step-2');
    work.finish('host.harness.run step-1');
    await vi.advanceTimersByTimeAsync(0);

    const drainLines = lines.filter((l) => l.message.includes('drain'));
    expect(drainLines).toEqual([
      {
        message:
          'Host Executor: draining — claiming no new work, exiting once the steps in flight end',
        data: {
          inFlight: ['host.harness.run step-1', 'host.commit.check step-2'],
          deadline: new Date(now + HARNESS_TIMEOUT_MS).toISOString(),
        },
      },
      { message: 'Host Executor: drain ended', data: { outcome: 'finished' } },
    ]);
  });

  it('exits straight away when nothing is in flight', async () => {
    const work = fakeWork([]);
    const { lines } = wire(work);

    process.emit(DRAIN_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledWith(0);
    expect(lines[0]?.data).toEqual({ inFlight: [], deadline: 'none' });
  });
});
