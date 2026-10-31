/**
 * Contract: every refusal the push gate gives names a remedy its reader has.
 * The agent that reads a refused push is refused promotion of `host.commit.scan`
 * and `host.commit.check` — the publication holds them — so a refusal that
 * asks for a receipt again sends its reader to the publication, which scans and
 * checks what it sends, and names neither operation.
 *
 * Every refusal code of both receipts is reached here, and the census it is
 * measured against is a Record over both unions (`fixtures/pushRefusals.ts`),
 * so a refusal added later is held to the same wording or fails the type-check.
 */
import { describe, expect, it } from 'vitest';

import type { HostSandboxPosture } from '@aflow/schemas';

import { type CheckOutcome, issueCheckReceipt } from '../checkReceipt.js';
import { RECEIPT_TTL_MS } from '../receiptSigning.js';
import {
  issueScanReceipt,
  type PushHistory,
  type PushUnderScan,
  requireScannedPush,
  type ScanOutcome,
} from '../scanReceipt.js';

import { EVERY_REFUSAL, type Refusal } from './fixtures/pushRefusals.js';

const BASE = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const MOVED = 'c'.repeat(40);
const CHECKS = ['npm', 'test'];
const BRANCH = 'aflow/the-change';
const REFSPEC = `${TIP}:refs/heads/${BRANCH}`;

function scanReceipt(fields: { bindingId?: string; outcome?: ScanOutcome } = {}): string {
  return issueScanReceipt({
    bindingId: fields.bindingId ?? 'hb',
    base: BASE,
    sha: TIP,
    outcome: fields.outcome ?? 'clean',
  });
}

function checkReceipt(
  fields: {
    bindingId?: string;
    sha?: string;
    base?: string;
    argv?: readonly string[];
    outcome?: CheckOutcome;
    sandbox?: HostSandboxPosture;
    now?: number;
  } = {},
): string {
  return issueCheckReceipt(
    {
      bindingId: fields.bindingId ?? 'hb',
      sha: fields.sha ?? TIP,
      base: fields.base ?? BASE,
      argv: fields.argv ?? CHECKS,
      outcome: fields.outcome ?? 'passed',
      sandbox: fields.sandbox ?? 'open',
    },
    fields.now,
  );
}

const stillAtBase: PushHistory = {
  measureBase: () => Promise.resolve(BASE),
  holds: () => Promise.resolve(false),
  conflicts: () => Promise.resolve([]),
  merge: () => Promise.reject(new Error('a push its receipt covers merges nothing')),
  parents: () => Promise.reject(new Error('a push its receipt covers merges nothing')),
  scanSecrets: () => Promise.reject(new Error('a push its receipt covers scans nothing')),
};

/** `origin/main` moved on to `MOVED`, which holds `BASE`. */
function movedOn(history: Partial<PushHistory>): PushHistory {
  return {
    measureBase: () => Promise.resolve(MOVED),
    holds: () => Promise.resolve(true),
    conflicts: () => Promise.resolve([]),
    merge: () => Promise.reject(new Error('not merged in this case')),
    parents: () => Promise.reject(new Error('not merged in this case')),
    scanSecrets: () => Promise.reject(new Error('not scanned in this case')),
    ...history,
  };
}

function push(overrides: Partial<PushUnderScan> = {}): PushUnderScan {
  return {
    bindingId: 'hb',
    pushApproval: 'unless-unreviewed',
    refspecs: [REFSPEC],
    sources: [TIP],
    pushBase: 'main',
    receipt: scanReceipt(),
    checks: { argv: CHECKS, receipt: checkReceipt(), posture: 'open' },
    history: stillAtBase,
    approvalFor: () => Promise.resolve(null),
    ...overrides,
  };
}

function withCheck(check: Partial<PushUnderScan['checks']>): PushUnderScan {
  return push({ checks: { argv: CHECKS, receipt: checkReceipt(), posture: 'open', ...check } });
}

const REFUSED: ReadonlyArray<readonly [Refusal, PushUnderScan]> = [
  ['no_base', push({ pushBase: undefined })],
  ['no_receipt', push({ receipt: undefined })],
  ['not_issued_here', push({ receipt: 'not-a.receipt' })],
  ['other_folder', push({ receipt: scanReceipt({ bindingId: 'hb_other' }) })],
  ['other_range', push({ sources: ['main'], refspecs: [`main:refs/heads/${BRANCH}`] })],
  ['other_range', push({ history: movedOn({ holds: () => Promise.resolve(false) }) })],
  ['base_conflicts', push({ history: movedOn({ conflicts: () => Promise.resolve(['a.ts']) }) })],
  [
    'secret_found',
    push({
      history: movedOn({
        scanSecrets: () =>
          Promise.resolve({
            clean: false,
            findings: [],
            unscanned: [],
            allowed: [],
            summary: 'One rule matched.',
          } as never),
      }),
    }),
  ],
  ['unapproved', push({ receipt: scanReceipt({ outcome: 'allowed' }) })],
  ['checks_undeclared', withCheck({ argv: undefined })],
  ['no_check_receipt', withCheck({ receipt: undefined })],
  ['check_not_issued_here', withCheck({ receipt: scanReceipt() })],
  ['check_other_folder', withCheck({ receipt: checkReceipt({ bindingId: 'hb_other' }) })],
  ['check_stale', withCheck({ receipt: checkReceipt({ now: Date.now() - RECEIPT_TTL_MS - 1 }) })],
  ['check_other_commit', withCheck({ receipt: checkReceipt({ sha: 'f'.repeat(40) }) })],
  [
    'check_other_commit',
    push({
      history: movedOn({
        // `TIP` does not hold `MOVED`, so the push merges it: a merge whose
        // second parent is not the measured base takes no receipt for `TIP`.
        holds: (commit) => Promise.resolve(commit === MOVED),
        merge: () => Promise.resolve('d'.repeat(40)),
        parents: () => Promise.resolve([TIP, BASE]),
        scanSecrets: () =>
          Promise.resolve({ clean: true, unflaggedRange: `${MOVED}..${'d'.repeat(40)}` } as never),
      }),
    }),
  ],
  ['check_other_base', withCheck({ receipt: checkReceipt({ base: 'e'.repeat(40) }) })],
  ['check_other_checks', withCheck({ receipt: checkReceipt({ argv: ['npm', 'run', 'x'] }) })],
  ['check_other_posture', withCheck({ posture: 'confined' })],
  ['check_failed', withCheck({ receipt: checkReceipt({ outcome: 'failed' }) })],
];

/** The refusals whose remedy is a receipt the push does not have, and so the publication. */
const PUBLISH_AGAIN: readonly Refusal[] = [
  'no_receipt',
  'not_issued_here',
  'other_folder',
  'other_range',
  'no_check_receipt',
  'check_not_issued_here',
  'check_other_folder',
  'check_stale',
  'check_other_commit',
  'check_other_base',
  'check_other_checks',
  'check_other_posture',
];

async function refusalOf(
  pushed: PushUnderScan,
): Promise<{ refusal: Refusal; message: string } | undefined> {
  try {
    await requireScannedPush(pushed);
    return undefined;
  } catch (error) {
    const { refusal, message } = error as { refusal: Refusal; message: string };
    return { refusal, message };
  }
}

describe('what the push gate tells the agent it refuses', () => {
  it('reaches every refusal it has, so none escapes what follows', async () => {
    const reached = new Set<Refusal>();
    for (const [expected, pushed] of REFUSED) {
      const refused = await refusalOf(pushed);
      expect(refused?.refusal, expected).toBe(expected);
      if (refused !== undefined) reached.add(refused.refusal);
    }
    expect([...reached].sort()).toEqual([...EVERY_REFUSAL].sort());
  });

  it('names neither `host.commit.scan` nor `host.commit.check` in any refusal', async () => {
    for (const [expected, pushed] of REFUSED) {
      const message = (await refusalOf(pushed))?.message ?? '';
      expect(message, expected).not.toContain('host.commit.scan');
      expect(message, expected).not.toContain('host.commit.check');
    }
  });

  it('says "Nothing was pushed." as a whole sentence in every refusal', async () => {
    for (const [expected, pushed] of REFUSED) {
      const message = (await refusalOf(pushed))?.message ?? '';
      expect(message, expected).toMatch(/(^|[.:] )Nothing was pushed\.( |$)/);
    }
  });

  it('sends a push its receipts do not cover to publish the branch again as it stands', async () => {
    for (const [expected, pushed] of REFUSED) {
      if (!PUBLISH_AGAIN.includes(expected)) continue;
      const message = (await refusalOf(pushed))?.message ?? '';
      expect(message, expected).toContain(`Publish \`${BRANCH}\` again as it stands`);
    }
  });

  it('sends a commit whose checks failed to commission the fix and publish again', async () => {
    const refused = await refusalOf(withCheck({ receipt: checkReceipt({ outcome: 'failed' }) }));
    expect(refused?.refusal).toBe('check_failed');
    expect(refused?.message).toContain('a commit is pushed only once they pass on it.');
    expect(refused?.message).toContain(`Commission the fix onto \`${BRANCH}\` and publish again`);
    expect(refused?.message).not.toContain('again once they pass');
    expect(refused?.message).not.toContain('as it stands');
  });

  it('predicts nothing about whether a commit whose checks failed will pass', async () => {
    const refused = await refusalOf(withCheck({ receipt: checkReceipt({ outcome: 'failed' }) }));
    expect(refused?.message).not.toMatch(/\bwill\b/);
    expect(refused?.message).not.toContain('start passing');
  });

  it('clears the push every one of these departs from', async () => {
    expect(await refusalOf(push())).toBeUndefined();
  });
});
