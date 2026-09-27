/**
 * Contract: every ledger write that re-arms a task for dispatch arms its
 * deadline in the same transaction.
 *
 * Several ledger writes produce it, across more than one operator surface, and
 * one that cleared the worker session and wrote its own literals would be
 * invisible again — durably `running` behind no worker, read as the most
 * confident "executing" verdict the classifier has, with nothing at runtime
 * reporting the gap. So this asserts the property over every such write rather
 * than naming them, which is why it caught one the author had not been told
 * about.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  awaitingDispatchPatch,
  isDispatchOverdue,
  DISPATCH_CLAIM_GRACE_MS,
} from '../ledger/dispatchArming.js';

const LEDGER_DIR = join(dirname(fileURLToPath(import.meta.url)), '../ledger');

describe('dispatch arming', () => {
  it('carries the deadline with the state it describes', () => {
    const now = 1_700_000_000_000;
    expect(awaitingDispatchPatch(now)).toEqual({
      status: 'running',
      workerSessionId: null,
      startedAt: null,
      dispatchDeadlineAt: new Date(now + DISPATCH_CLAIM_GRACE_MS),
    });
  });

  it('needs the missing worker as well as the elapsed deadline', () => {
    const now = new Date(1_700_000_000_000);
    const past = new Date(now.getTime() - 1);
    const future = new Date(now.getTime() + 1);

    expect(
      isDispatchOverdue(
        { status: 'running', workerSessionId: null, dispatchDeadlineAt: past },
        now,
      ),
    ).toBe(true);
    expect(
      isDispatchOverdue(
        { status: 'running', workerSessionId: null, dispatchDeadlineAt: future },
        now,
      ),
    ).toBe(false);
    expect(
      isDispatchOverdue(
        { status: 'running', workerSessionId: 'worker-1', dispatchDeadlineAt: past },
        now,
      ),
    ).toBe(false);
    expect(
      isDispatchOverdue(
        { status: 'running', workerSessionId: null, dispatchDeadlineAt: null },
        now,
      ),
    ).toBe(false);
    expect(
      isDispatchOverdue({ status: 'paused', workerSessionId: null, dispatchDeadlineAt: past }, now),
    ).toBe(false);
  });

  it('is reached through the shared helper by every ledger module that re-arms', () => {
    const offenders = readdirSync(LEDGER_DIR)
      .filter((file) => file.endsWith('.ts') && file !== 'dispatchArming.ts')
      .filter((file) => {
        const src = readFileSync(join(LEDGER_DIR, file), 'utf8');
        // A write that puts the row back to `running` and drops its worker is
        // the state the deadline exists to mark, wherever it is written.
        if (!/status:\s*'running'/.test(src)) return false;
        if (!/workerSessionId:\s*null/.test(src)) return false;
        return !src.includes('awaitingDispatchPatch');
      });

    expect(
      offenders.sort(),
      'Re-arming a task for dispatch goes through awaitingDispatchPatch, so the deadline is ' +
        'written by the same transaction that clears the worker session.',
    ).toEqual([]);
  });
});
