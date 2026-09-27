/**
 * The wait between two polls of a render.
 *
 * One video is polled for as long as its budget allows, against a signal that
 * lives until the step ends — so what the wait leaves behind on that signal
 * accumulates for the whole render.
 */
import { getEventListeners } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollDelay } from './videoJobRunner.js';

const INTERVAL_MS = 10_000;

describe('pollDelay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves nothing on the signal behind it, poll after poll', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    for (let poll = 0; poll < 60; poll += 1) {
      const waiting = pollDelay(INTERVAL_MS, controller.signal);
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await waiting;
    }

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('drops its listener and its timer when the wait is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const waiting = pollDelay(INTERVAL_MS, controller.signal);
    controller.abort();
    await waiting;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns without arming anything on a signal that has already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await pollDelay(INTERVAL_MS, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
