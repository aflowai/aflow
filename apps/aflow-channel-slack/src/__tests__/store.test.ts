/**
 * The send records: claimed before a send leaves, and pruned on every write.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('opens a thread written before runs opened threads as one the operator opened', () => {
    const at = new Date().toISOString();
    writeFileSync(
      path,
      JSON.stringify({
        migrations: ['0001-link-and-sent', '0002-cards', '0003-conversations', '0004-thread-notes'],
        link: null,
        usedLinkCodes: [],
        sent: [],
        cards: [],
        inbound: [],
        threads: [
          {
            channel: 'D-1',
            threadTs: '1.0001',
            sessionId: 'session-1',
            spaceId: 'space-1',
            status: 'waiting',
            pausedStepExecutionId: 'step-1',
            relayedStepExecutionId: 'step-1',
            resumedStepExecutionId: null,
            notesAfter: null,
            startedAt: at,
            updatedAt: at,
          },
        ],
      }),
    );

    expect(ChannelStore.open(path).threadAt('D-1', '1.0001')).toMatchObject({
      sessionId: 'session-1',
      spaceId: 'space-1',
      runId: null,
      postedText: null,
      status: 'waiting',
    });
  });

  it('opens a store written before current spaces with none, and keeps the one set', () => {
    writeFileSync(
      path,
      JSON.stringify({
        migrations: [
          '0001-link-and-sent',
          '0002-cards',
          '0003-conversations',
          '0004-thread-notes',
          '0005-posted-threads',
        ],
        link: null,
        usedLinkCodes: [],
        sent: [],
        cards: [],
        inbound: [],
        threads: [],
      }),
    );
    const store = ChannelStore.open(path);
    expect(store.currentSpace('D-1')).toBeUndefined();

    store.setCurrentSpace('D-1', 'space-1', new Date());
    store.setCurrentSpace('D-1', 'space-2', new Date());

    expect(ChannelStore.open(path).currentSpace('D-1')).toBe('space-2');
    expect(ChannelStore.open(path).currentSpace('D-2')).toBeUndefined();
  });
});
