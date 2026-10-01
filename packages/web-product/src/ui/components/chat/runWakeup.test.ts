/**
 * The wakeup card says what happened from the event alone, and the one line
 * that says why once the envelope has loaded.
 */
import { describe, expect, it } from 'vitest';
import {
  describeRunWakeup,
  readInlineRunWakeupEnvelope,
  readRunWakeupEnvelope,
} from './runWakeup.js';

const RUN = '11111111-2222-3333-4444-555555555555';

describe('describeRunWakeup', () => {
  it('says what happened before the envelope has loaded', () => {
    expect(describeRunWakeup('paused', undefined)).toEqual({
      orb: 'paused',
      pill: { label: 'paused', tone: 'warning' },
      headline: 'Paused with a decision to make',
      line: undefined,
    });
  });

  it('carries the pause reason for a run waiting on a decision', () => {
    const envelope = readRunWakeupEnvelope({
      runId: RUN,
      outcome: 'paused',
      waiterId: 'w1',
      pause: { reason: 'Approve the push of 3 commits to aflow/fix-parser.\nDetails follow.' },
    });
    expect(describeRunWakeup('paused', envelope).line).toBe(
      'Approve the push of 3 commits to aflow/fix-parser.',
    );
  });

  it("carries the run's closing summary when it completed or failed", () => {
    const envelope = readRunWakeupEnvelope({
      runId: RUN,
      outcome: 'completed',
      waiterId: 'w1',
      result: { summary: 'The review approved the change.' },
    });
    expect(describeRunWakeup('completed', envelope)).toMatchObject({
      orb: 'completed',
      headline: 'Completed',
      line: 'The review approved the change.',
    });
    expect(describeRunWakeup('failed', envelope)).toMatchObject({
      orb: 'failed',
      pill: { label: 'failed', tone: 'destructive' },
      headline: 'Failed',
    });
  });

  it('says who stopped a cancelled run when it gave no reason', () => {
    const envelope = readRunWakeupEnvelope({
      runId: RUN,
      outcome: 'cancelled',
      waiterId: 'w1',
      cancellation: {
        cancelledBy: 'operator',
        retryPolicy: 'do_not_restart_without_explicit_user_instruction',
      },
    });
    expect(describeRunWakeup('cancelled', envelope)).toMatchObject({
      headline: 'Cancelled',
      line: 'Stopped by an operator.',
    });
  });

  it('reads an envelope that does not parse as none', () => {
    expect(readRunWakeupEnvelope({ nothing: 'here' })).toBeUndefined();
    expect(describeRunWakeup('completed', undefined).line).toBeUndefined();
  });

  it('shows a handed-off run as neither running nor ended here', () => {
    const view = describeRunWakeup('handed_off', undefined);
    expect(view).toEqual({
      orb: 'handed_off',
      pill: { label: 'handed off', tone: 'info' },
      headline: 'Handed to another session',
      line: undefined,
    });
    expect(view.orb).not.toBe('running');
    expect(view.pill.label).not.toBe(describeRunWakeup('completed', undefined).pill.label);
  });
});

describe('readInlineRunWakeupEnvelope', () => {
  const envelope = {
    runId: RUN,
    outcome: 'completed',
    waiterId: 'w1',
    result: { summary: 'The review approved the change.' },
  };

  it('decodes the envelope an inline reference carries', () => {
    const ref = `inline:${Buffer.from(JSON.stringify(envelope)).toString('base64')}`;
    expect(readInlineRunWakeupEnvelope(ref)).toMatchObject(envelope);
  });

  it('reads a reference that is not base64 as no envelope, rather than throwing', () => {
    const ref = 'inline:not base64 at all!';
    expect(() => readInlineRunWakeupEnvelope(ref)).not.toThrow();
    expect(readInlineRunWakeupEnvelope(ref)).toBeUndefined();
    expect(describeRunWakeup('completed', readInlineRunWakeupEnvelope(ref))).toMatchObject({
      headline: 'Completed',
      line: undefined,
    });
  });
});
