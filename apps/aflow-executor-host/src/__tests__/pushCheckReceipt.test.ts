/**
 * Contract: a push from a folder that declares checks goes out only with the
 * receipt of those checks passing, on this executor, on exactly the commit it
 * sends, against the base it measures, as the folder declares them when it
 * pushes — whatever ordered the tasks that led to it. A folder that declares
 * none needs no receipt, and a push from it that carries one is refused.
 *
 * Every push here goes through the handler to a real bare `origin`, so a
 * refusal is shown to have pushed nothing rather than assumed to.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { PUSH_REQUIRED_OPTIONS } from '../bindings.js';
import { type CheckOutcome, issueCheckReceipt } from '../checkReceipt.js';
import { createHostProcessHandler } from '../handlers/processHandlers.js';
import { RECEIPT_TTL_MS } from '../receiptSigning.js';
import { issueScanReceipt } from '../scanReceipt.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

const execFileAsync = promisify(execFile);

const CHECKS = ['npm', 'test'];

interface Captured {
  output?: Record<string, unknown>;
}

function contextFor(input: unknown, captured: Captured): never {
  return {
    operationId: 'host.process.exec',
    tenantId: 'tenant-test',
    spaceId: 'space-test',
    runId: 'run-test',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never;
}

describe('a push carries the receipt of the folder’s checks passing', () => {
  let dir: string;
  let repo: string;
  let policyPath: string;
  /** Where `origin/main` is. */
  let base: string;
  /** The commit pushed, one on top of `base`. */
  let tip: string;

  async function git(...args: string[]): Promise<string> {
    return (await execFileAsync('git', ['-C', repo, ...args])).stdout.trim();
  }

  async function writePolicy(checks: readonly string[]): Promise<void> {
    const binding = (id: string, declared?: readonly string[]) => ({
      id,
      root: repo,
      mode: 'readwrite',
      allowsExecution: true,
      branchPolicy: { branchPrefix: 'aflow/', ...(declared ? { checks: declared } : {}) },
      singleFile: false,
      spaceId: 'space-test',
    });
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [binding('hb_checked', checks), binding('hb_unchecked')],
      }),
    );
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-check-receipt-'));
    repo = join(dir, 'repo');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q', '--initial-branch=main', repo]);
    await git('config', 'user.email', 't@e.com');
    await git('config', 'user.name', 'T');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'initial');
    base = await git('rev-parse', 'HEAD');
    await execFileAsync('git', ['init', '-q', '--bare', join(dir, 'remote.git')]);
    await git('remote', 'add', 'origin', join(dir, 'remote.git'));
    await git('push', '-q', 'origin', 'main');
    tip = await git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'the commit');
    policyPath = join(dir, 'host-policy.json');
    await writePolicy(CHECKS);
  });

  function checkReceipt(
    fields: {
      outcome?: CheckOutcome;
      sha?: string;
      base?: string;
      argv?: readonly string[];
      bindingId?: string;
      now?: number;
    } = {},
  ): string {
    return issueCheckReceipt(
      {
        bindingId: fields.bindingId ?? 'hb_checked',
        sha: fields.sha ?? tip,
        base: fields.base ?? base,
        argv: fields.argv ?? CHECKS,
        outcome: fields.outcome ?? 'passed',
      },
      fields.now,
    );
  }

  /** A push of `tip` to `aflow/<branch>`, with a clean scan receipt for exactly what it sends. */
  async function push(
    branch: string,
    check: { receipt: string | null } | undefined,
    bindingId = 'hb_checked',
  ): Promise<{ status: string; captured: Captured }> {
    const captured: Captured = {};
    const scan = issueScanReceipt({ bindingId, base, sha: tip, outcome: 'clean' });
    const result = await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor(
        {
          bindingId,
          command: [
            'git',
            'push',
            ...PUSH_REQUIRED_OPTIONS,
            'origin',
            `${tip}:refs/heads/aflow/${branch}`,
          ],
          pushBase: 'main',
          scan: { receipt: scan },
          ...(check !== undefined ? { check } : {}),
        },
        captured,
      ),
    );
    return { status: result.status, captured };
  }

  async function onOrigin(branch: string): Promise<boolean> {
    const listed = await execFileAsync('git', [
      '-C',
      join(dir, 'remote.git'),
      'branch',
      '--list',
      `aflow/${branch}`,
    ]);
    return listed.stdout.trim() !== '';
  }

  async function expectRefused(
    branch: string,
    outcome: Promise<{ status: string; captured: Captured }>,
    said: string,
  ): Promise<void> {
    const { status, captured } = await outcome;
    expect(status, branch).toBe('FAILED');
    expect(captured.output?.['code'], branch).toBe('PERMISSION_DENIED');
    expect(String(captured.output?.['message']), branch).toContain(said);
    expect(String(captured.output?.['message']), branch).toContain('Nothing was pushed.');
    expect(await onOrigin(branch), branch).toBe(false);
  }

  it('refuses a push from a folder that declares checks with no check receipt', async () => {
    await expectRefused(
      'no-receipt',
      push('no-receipt', undefined),
      '`hb_checked` declares checks, `npm test`, and this push carries no check receipt',
    );
    await expectRefused(
      'null-receipt',
      push('null-receipt', { receipt: null }),
      'carries no check receipt',
    );
  }, 60_000);

  it('refuses a receipt for another commit', async () => {
    const other = 'f'.repeat(40);
    await expectRefused(
      'other-sha',
      push('other-sha', { receipt: checkReceipt({ sha: other }) }),
      `This push sends \`${tip}\`, and its check receipt is for the checks run on \`${other}\``,
    );
  }, 60_000);

  it('refuses a receipt for checks that failed', async () => {
    await expectRefused(
      'failed',
      push('failed', { receipt: checkReceipt({ outcome: 'failed' }) }),
      'The checks of `hb_checked`, `npm test`, failed on',
    );
  }, 60_000);

  it('refuses a receipt for checks the folder no longer declares', async () => {
    const receipt = checkReceipt();
    await writePolicy(['npm', 'run', 'verify']);
    try {
      await expectRefused(
        'argv-changed',
        push('argv-changed', { receipt }),
        '`hb_checked` declares `npm run verify` as its checks, and its check receipt is for other checks',
      );
    } finally {
      await writePolicy(CHECKS);
    }
  }, 60_000);

  it('refuses a receipt for another base, folder, a stale one, and one not issued here', async () => {
    const valid = checkReceipt();
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [
        'other-base',
        checkReceipt({ base: 'e'.repeat(40) }),
        `This push is measured against \`${base}\``,
      ],
      [
        'other-folder',
        checkReceipt({ bindingId: 'hb_unchecked' }),
        'the receipt for a check of `hb_unchecked`, and pushes from `hb_checked`',
      ],
      ['stale', checkReceipt({ now: Date.now() - RECEIPT_TTL_MS - 1 }), 'more than a day ago'],
      [
        'forged',
        `${valid.slice(0, valid.indexOf('.'))}.${'A'.repeat(43)}`,
        'a check receipt this executor did not issue since it last started',
      ],
      [
        'a-scan-receipt',
        issueScanReceipt({ bindingId: 'hb_checked', base, sha: tip, outcome: 'clean' }),
        'a check receipt this executor did not issue since it last started',
      ],
    ];
    for (const [branch, receipt, said] of cases) {
      await expectRefused(branch, push(branch, { receipt }), said);
    }
  }, 60_000);

  it('pushes with the passed receipt for exactly this commit, base and checks', async () => {
    const { status } = await push('checked', { receipt: checkReceipt() });
    expect(status).toBe('SUCCEEDED');
    expect(await onOrigin('checked')).toBe(true);
  }, 60_000);

  it('pushes from a folder that declares no checks with no receipt', async () => {
    expect((await push('unchecked', undefined, 'hb_unchecked')).status).toBe('SUCCEEDED');
    expect(await onOrigin('unchecked')).toBe(true);
    expect((await push('unchecked-null', { receipt: null }, 'hb_unchecked')).status).toBe(
      'SUCCEEDED',
    );
  }, 60_000);

  it('refuses a receipt sent anyway from a folder that declares no checks, saying it needs none', async () => {
    await expectRefused(
      'unchecked-receipt',
      push(
        'unchecked-receipt',
        { receipt: checkReceipt({ bindingId: 'hb_unchecked' }) },
        'hb_unchecked',
      ),
      '`hb_unchecked` declares no checks, so a push from it needs no check receipt',
    );
  }, 60_000);
});
