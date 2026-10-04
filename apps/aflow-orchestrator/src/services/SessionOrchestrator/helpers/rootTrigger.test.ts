/**
 * Starting a session keeps the root trigger its parent queued it with: the
 * start message's own trigger names only a session nothing queued.
 */
import { describe, expect, it } from 'vitest';

import { rootTriggerAtStart } from './rootTrigger.js';

describe('rootTriggerAtStart', () => {
  it('keeps the root trigger a parent queued the session with', () => {
    expect(rootTriggerAtStart({ rootTrigger: 'schedule' }, undefined)).toBe('schedule');
    expect(rootTriggerAtStart({ rootTrigger: 'chat' }, undefined)).toBe('chat');
    expect(rootTriggerAtStart({ rootTrigger: 'schedule' }, 'chat')).toBe('schedule');
  });

  it('takes the start message’s trigger for a root', () => {
    expect(rootTriggerAtStart(null, 'voice')).toBe('voice');
    expect(rootTriggerAtStart({}, 'webhook')).toBe('webhook');
  });

  it('leaves it absent when neither names one', () => {
    expect(rootTriggerAtStart({}, undefined)).toBeUndefined();
  });
});
