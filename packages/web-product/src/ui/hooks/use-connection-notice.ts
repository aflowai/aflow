'use client';

/**
 * What to tell the operator about the live channel, where they are typing.
 *
 * Connected is the resting state and says nothing. A drop is only worth a word
 * once it has outlasted a normal connect — the stream reports disconnected
 * until its first open, so a notice wired straight to it blinks on every mount.
 * And a reconnect is worth a word too, briefly: a tab that sat in backoff after
 * a server restart has a gap to fill, and "nothing happened, then everything
 * did" is the part that reads as a bug.
 */

import { useEffect, useState } from 'react';

/**
 * Longer than a normal connect and shorter than the first backoff, so a mount
 * says nothing and a real drop is named before the operator has to wonder.
 */
export const RECONNECT_NOTICE_DELAY_MS = 3_000;

/** Long enough to read, short enough that a live channel says nothing again. */
export const RECONNECTED_NOTICE_MS = 4_000;

export type ConnectionNoticePhase = 'live' | 'reconnecting' | 'caught-up';

/** A phase that had been reporting a drop is the only one with a gap to fill. */
export function phaseOnConnected(previous: ConnectionNoticePhase): ConnectionNoticePhase {
  return previous === 'reconnecting' ? 'caught-up' : 'live';
}

export function connectionNoticeLabel(phase: ConnectionNoticePhase): string | undefined {
  if (phase === 'reconnecting') return 'Reconnecting…';
  if (phase === 'caught-up') return 'Reconnected — catching up';
  return undefined;
}

/**
 * The phase of the live channel, as a surface beside the composer should say it.
 *
 * Takes the connected flag the brokers already expose rather than subscribing
 * again: one subscription per session is the broker's whole point, and a second
 * one here would report the same thing a beat later.
 */
export function useConnectionNotice(isConnected: boolean): ConnectionNoticePhase {
  const [phase, setPhase] = useState<ConnectionNoticePhase>('live');

  useEffect(() => {
    if (isConnected) {
      setPhase(phaseOnConnected);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPhase('reconnecting');
    }, RECONNECT_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isConnected]);

  useEffect(() => {
    if (phase !== 'caught-up') return undefined;
    const timer = setTimeout(() => {
      setPhase('live');
    }, RECONNECTED_NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [phase]);

  return phase;
}
