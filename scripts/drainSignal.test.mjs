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

  it('passes on its own SIGTERM, which stops the service now', () => {
    expect(signalToSend({ kind: 'stop', signal: 'SIGTERM', fromTerminal: false })).toBe('SIGTERM');
    expect(signalToSend({ kind: 'stop', signal: 'SIGTERM', fromTerminal: true })).toBe('SIGTERM');
  });

  it('passes on a SIGINT no terminal has already delivered', () => {
    expect(signalToSend({ kind: 'stop', signal: 'SIGINT', fromTerminal: false })).toBe('SIGINT');
    expect(signalToSend({ kind: 'stop', signal: 'SIGINT', fromTerminal: true })).toBeNull();
  });
});
