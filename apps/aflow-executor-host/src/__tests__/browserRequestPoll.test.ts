/**
 * The executor serves the command line's browser requests that no watch event
 * announced: those already waiting when it starts, and every one while the
 * directory watch is down.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_REQUEST_POLL_MS, followBrowserRequests } from '../browser/requestPoll.js';
import { EXECUTOR_CLAIM_TIMEOUT_MS, serveBrowserRequests } from '../browser/windowRequests.js';

const ANSWER_DEADLINE_MS = 5_000;

const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function countingServer() {
  const server = {
    checks: 0,
    check: () => {
      server.checks += 1;
      return Promise.resolve();
    },
  };
  return server;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-browser-poll-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('browser requests no watch announced', () => {
  it('are served once at startup, even with the watch up', async () => {
    const server = countingServer();
    const poll = followBrowserRequests(server, () => true, quiet);
    expect(server.checks).toBe(1);
    await poll.runOnce();
    expect(server.checks).toBe(1);
  });

  it('are polled for while the watch is down, and not once it is back', async () => {
    const server = countingServer();
    let watching = false;
    const poll = followBrowserRequests(server, () => watching, quiet);
    await poll.runOnce();
    await poll.runOnce();
    expect(server.checks).toBe(3);
    watching = true;
    await poll.runOnce();
    expect(server.checks).toBe(3);
  });

  it('are polled for inside the command line’s claim timeout', () => {
    expect(BROWSER_REQUEST_POLL_MS).toBeLessThan(EXECUTOR_CLAIM_TIMEOUT_MS);
  });

  it('include one written before the executor started, which is claimed and answered', async () => {
    await writeFile(
      join(dir, 'browser-request-early.json'),
      JSON.stringify({ id: 'early', kind: 'list', requestedAt: Date.now() }),
    );
    const server = serveBrowserRequests(
      dir,
      () => Promise.resolve({ kind: 'list' as const, profiles: [] }),
      () => undefined,
    );
    followBrowserRequests(server, () => true, quiet);
    // Served without being awaited — a sign-in sitting lasts as long as the
    // operator takes — and answered through a synced write, so it is waited
    // for against a deadline rather than a fixed pause a loaded machine misses.
    await vi.waitFor(
      async () => {
        expect(await readdir(dir)).toEqual(['browser-result-early.json']);
      },
      { timeout: ANSWER_DEADLINE_MS, interval: 20 },
    );
  });
});
