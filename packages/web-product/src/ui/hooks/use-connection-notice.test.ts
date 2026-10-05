/**
 * What the composer says about the live channel.
 *
 * Three states and two of them are words: connected says nothing, a drop that
 * outlasted a normal connect says it is retrying, and a reconnect says there is
 * a gap being filled — which is the one a tab in backoff after a server restart
 * never said, so the conversation read as quiet rather than as disconnected.
 */
import { describe, expect, it } from 'vitest';
import {
  connectionNoticeAction,
  connectionNoticeLabel,
  phaseOnConnected,
  statusLine,
  type ConnectionNoticePhase,
} from './use-connection-notice.js';

describe('a channel with nothing subscribed to it', () => {
  // The brokers report disconnected for a subscription they were never asked to
  // make, so a composer rendered before its conversation has a session was fed a
  // drop that never happened — and after the delay every fresh chat said
  // "Reconnecting…" on a live socket, for as long as it stayed empty.
  it('reports live, and times nothing', () => {
    expect(connectionNoticeAction(false, false)).toBe('report-live');
    expect(connectionNoticeAction(false, true)).toBe('report-live');
  });

  it('says nothing, so the composer is unchanged', () => {
    expect(connectionNoticeLabel('live')).toBeUndefined();
  });
});

describe('a channel that has a session', () => {
  it('times a drop, and reads a connect for the gap it may have left', () => {
    expect(connectionNoticeAction(true, false)).toBe('time-the-drop');
    expect(connectionNoticeAction(true, true)).toBe('report-on-connected');
  });
});

describe('the phase a connect lands on', () => {
  it('reports catching up only where a drop had been reported', () => {
    expect(phaseOnConnected('reconnecting')).toBe('caught-up');
  });

  it('says nothing about a first connect, which no reader was waiting on', () => {
    expect(phaseOnConnected('live')).toBe('live');
  });

  it('does not restate catching up on a second connect inside the same notice', () => {
    expect(phaseOnConnected('caught-up')).toBe('live');
  });
});

describe('what each phase says', () => {
  it('is silent while the channel is up', () => {
    expect(connectionNoticeLabel('live')).toBeUndefined();
  });

  it('names the retry, and then the gap', () => {
    expect(connectionNoticeLabel('reconnecting')).toBe('Reconnecting…');
    expect(connectionNoticeLabel('caught-up')).toBe('Reconnected — catching up');
  });

  it('speaks about the system rather than to the reader', () => {
    const phases: ConnectionNoticePhase[] = ['live', 'reconnecting', 'caught-up'];
    for (const phase of phases) {
      const label = connectionNoticeLabel(phase) ?? '';
      expect(/\byou\b|\byour\b/i.test(label)).toBe(false);
    }
  });
});

describe('the status line, with no orchestrator consuming', () => {
  const absent =
    'No orchestrator is running: messages, step results and cancellations wait until one starts.';

  it('says so over a live channel, where it would otherwise say nothing', () => {
    expect(statusLine('live', undefined)).toBeUndefined();
    expect(statusLine('live', absent)).toEqual({ label: absent, tone: 'warning' });
  });

  it('says so over a reconnect, which only reports a gap already being filled', () => {
    expect(statusLine('caught-up', absent)).toEqual({ label: absent, tone: 'warning' });
    expect(statusLine('caught-up', undefined)).toEqual({
      label: 'Reconnected — catching up',
      tone: 'quiet',
    });
  });

  // While the channel is down, the API that reads the orchestrator's lease is
  // not being reached either, so its last answer is not news.
  it('gives way to a dropped channel', () => {
    expect(statusLine('reconnecting', absent)).toEqual({ label: 'Reconnecting…', tone: 'warning' });
  });
});
