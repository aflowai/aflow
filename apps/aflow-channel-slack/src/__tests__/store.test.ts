/**
 * The send records: claimed before a send leaves, and pruned on every write.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelStore, SENT_RETENTION_MS } from '../store.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-slack-store-'));
  path = join(dir, 'store.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sendAt(store: ChannelStore, runId: string, at: Date): void {
  const claim = store.claimSend(
    { executionId: 'exec-1', runId, text: 'Hello.', sentAt: at.toISOString() },
    at,
  );
  if (!claim.claimed) throw new Error('expected a claim');
  store.settleSend(claim.record, 'slack:D-1:1.0001');
}

describe('the channel store', () => {
  it('prunes sends past the retention on write, not only when it opens', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const store = ChannelStore.open(path, start);
    sendAt(store, 'run-old', start);

    const later = new Date(start.getTime() + SENT_RETENTION_MS + 1);
    sendAt(store, 'run-new', later);

    expect(store.sentFor('run-old', 'exec-1')).toBeUndefined();
    expect(store.sentFor('run-new', 'exec-1')).toBeDefined();
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { sent: Array<{ runId: string }> };
    expect(onDisk.sent.map((record) => record.runId)).toEqual(['run-new']);
  });

  it('holds a claim with no messageRef on disk until it settles, and drops a released one', () => {
    const store = ChannelStore.open(path);
    const claim = store.claimSend({
      executionId: 'exec-1',
      runId: 'run-1',
      text: 'Hello.',
      sentAt: new Date().toISOString(),
    });
    if (!claim.claimed) throw new Error('expected a claim');

    expect(store.inFlight(claim.record)).toBe(true);
    expect(ChannelStore.open(path).sentFor('run-1', 'exec-1')?.messageRef).toBeNull();

    const again = store.claimSend({
      executionId: 'exec-2',
      runId: 'run-1',
      text: 'Hello.',
      sentAt: new Date().toISOString(),
    });
    expect(again.claimed).toBe(false);

    store.releaseSend(claim.record);
    expect(store.sentFor('run-1', 'exec-1')).toBeUndefined();
    expect(ChannelStore.open(path).sentFor('run-1', 'exec-1')).toBeUndefined();
  });
});
