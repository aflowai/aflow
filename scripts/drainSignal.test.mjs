import { describe, expect, it } from 'vitest';
import { DRAIN_SIGNAL, signalToSend } from './drainSignal.mjs';

describe('the signal the watcher sends', () => {
  it('drains on a restart, with a signal no supervisor that kills sends', () => {
    expect(DRAIN_SIGNAL).toBe('SIGUSR2');
    expect(signalToSend({ kind: 'restart' })).toBe('SIGUSR2');
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
