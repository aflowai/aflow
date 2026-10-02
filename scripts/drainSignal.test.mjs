import { describe, expect, it } from 'vitest';
import { DRAIN_SIGNAL as EXECUTOR_DRAIN_SIGNAL } from '../packages/lib/src/shutdown.ts';
import { DRAIN_SIGNAL, signalToSend } from './drainSignal.mjs';

describe('the signal the watcher sends', () => {
  it('drains on a restart, with the signal the executor drains on', () => {
    expect(DRAIN_SIGNAL).toBe(EXECUTOR_DRAIN_SIGNAL);
    expect(signalToSend({ kind: 'restart' })).toBe(EXECUTOR_DRAIN_SIGNAL);
  });

  it('drains on a signal no supervisor that kills sends', () => {
    expect(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP']).not.toContain(DRAIN_SIGNAL);
  });

  it.each(['SIGTERM', 'SIGINT'])('passes on its own %s, which stops the service now', (signal) => {
    expect(signalToSend({ kind: 'stop', signal })).toBe(signal);
  });
});
