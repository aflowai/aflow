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

export interface StatusLine {
  label: string;
  tone: 'warning' | 'quiet';
}

/**
 * The one line beside the composer: the channel's phase, or that no
 * orchestrator is consuming.
 *
 * A dropped channel comes first, because while it is down the API that reads
 * the orchestrator's lease is not being reached either. Otherwise a missing
 * orchestrator outranks a reconnect: a message sent now is accepted and waits,
 * and this line is the only place that says so.
 */
export function statusLine(
  phase: ConnectionNoticePhase,
  orchestratorNotice: string | undefined,
): StatusLine | undefined {
  if (phase !== 'reconnecting' && orchestratorNotice !== undefined) {
    return { label: orchestratorNotice, tone: 'warning' };
  }
  const channel = connectionNoticeLabel(phase);
  if (channel === undefined) return undefined;
  return { label: channel, tone: phase === 'reconnecting' ? 'warning' : 'quiet' };
}

/** What the notice does about the channel as the broker reports it. */
export type ConnectionNoticeAction = 'report-live' | 'report-on-connected' | 'time-the-drop';

/**
 * Whether there is a drop here to report, and whether it is worth timing.
 *
 * `subscribed` is the case the connected flag cannot express: a broker reports
 * disconnected for a subscription it was never asked to make, so a composer
 * rendered before its conversation has a session reads as a channel that has
 * been down since mount — which is how every fresh chat said "Reconnecting…" on
 * a live socket.
 */
export function connectionNoticeAction(
  subscribed: boolean,
  isConnected: boolean,
): ConnectionNoticeAction {
  if (!subscribed) return 'report-live';
  return isConnected ? 'report-on-connected' : 'time-the-drop';
}

/**
 * The phase of the live channel, as a surface beside the composer should say it.
 *
 * Takes the connected flag the brokers already expose rather than subscribing
 * again: one subscription per session is the broker's whole point, and a second
 * one here would report the same thing a beat later. `subscribed` says whether
 * that flag is about anything yet.
 */
export function useConnectionNotice(
  isConnected: boolean,
  subscribed: boolean,
): ConnectionNoticePhase {
  const [phase, setPhase] = useState<ConnectionNoticePhase>('live');

  useEffect(() => {
    const action = connectionNoticeAction(subscribed, isConnected);
    if (action === 'report-live') {
      setPhase('live');
      return undefined;
    }
    if (action === 'report-on-connected') {
      setPhase(phaseOnConnected);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPhase('reconnecting');
    }, RECONNECT_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isConnected, subscribed]);

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
