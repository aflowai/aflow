/**
 * Contract: the commits a publication is about to push are read for secrets
 * line by line, every commit of the range, and a finding names its file, line
 * and rule — never what matched.
 *
 * Every planted value is assembled at run time, so this file holds none of
 * them and cannot trip the scan it tests.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it } from 'vitest';

import { HostCommitScanInputSchema, HostCommitScanOutputSchema } from '@aflow/schemas';

import { SCAN_MAX_FILE_BYTES, SCAN_MAX_FINDINGS } from '../commitScan.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import {
  ENV_SECRET_MIN_LENGTH,
  GENERIC_SECRET_MIN_ENTROPY_BITS,
  GENERIC_SECRET_MIN_LENGTH,
  matchingRule,
  SECRET_RULES,
  shannonEntropy,
} from '../secretRules.js';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random-looking string, the same on every run. */
function randomish(length: number, alphabet = ALNUM, seed = 7): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

/** One planted line per rule, and the value in it a finding must never carry. */
const PLANTED: Record<string, { line: string; value: string }> = (() => {
  const awsId = 'AKIA' + 'QWERTYUIOPASDFGH';
  const awsSecret = randomish(40, `${ALNUM}/+`, 11);
  const github = 'ghp_' + randomish(36, ALNUM, 13);
  const slack = 'xoxb-' + '2741936502-' + randomish(24, ALNUM, 17);
  const google = 'AIza' + randomish(35, `${ALNUM}_-`, 19);
  const stripe = 'sk_' + 'live_' + randomish(24, ALNUM, 23);
  const jwt = [
    'eyJ' + randomish(20, ALNUM, 29),
    'eyJ' + randomish(30, ALNUM, 31),
    randomish(43),
  ].join('.');
  const generic = randomish(24, ALNUM, 37);
  const env = 'hunter' + '2' + randomish(6, ALNUM, 41);
  const keyBody = randomish(64, `${ALNUM}/+`, 43);
  return {
    'private-key': {
      line: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ') + keyBody,
      value: keyBody,
    },
    'aws-secret-access-key': { line: 'aws_secret_access_key = ' + awsSecret, value: awsSecret },
    'aws-access-key-id': { line: 'aws_access_key_id = ' + awsId, value: awsId },
    'github-token': { line: 'const value = "' + github + '";', value: github },
    'slack-token': { line: 'webhook: ' + slack, value: slack },
    'google-api-key': { line: 'maps: ' + google, value: google },
    'stripe-live-key': { line: 'billing: ' + stripe, value: stripe },
    jwt: { line: 'const session = "' + jwt + '";', value: jwt },
    'secret-assignment': { line: 'const signingSecret = "' + generic + '";', value: generic },
    'env-secret': { line: 'DATABASE_PASSWORD=' + env, value: env },
  };
})();

describe('the rules', () => {
  it('has a planted example for every rule, and each is named by its own rule', () => {
    expect(Object.keys(PLANTED).sort()).toEqual(SECRET_RULES.map((rule) => rule.name).sort());
    for (const [name, { line }] of Object.entries(PLANTED)) {
      expect(matchingRule(line), name).toBe(name);
    }
  });

  it('gives every rule a one-line reason', () => {
    for (const rule of SECRET_RULES) {
      expect(rule.reason.length, rule.name).toBeGreaterThan(0);
      expect(rule.reason, rule.name).not.toContain('\n');
    }
  });

  it('reads every GitHub and Slack token kind', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      expect(matchingRule('x ' + prefix + randomish(36)), prefix).toBe('github-token');
    }
    expect(matchingRule('x ' + 'github_pat_' + randomish(40))).toBe('github-token');
    for (const kind of ['a', 'b', 'p', 'r', 's']) {
      expect(matchingRule('x ' + 'xox' + kind + '-' + randomish(20)), kind).toBe('slack-token');
    }
    expect(matchingRule('x ' + 'rk_' + 'live_' + randomish(24))).toBe('stripe-live-key');
  });

  it('reads an AWS secret beside its key id with no name on it', () => {
    const line = 'AKIA' + 'QWERTYUIOPASDFGH' + ',' + randomish(40, `${ALNUM}/+`, 3);
    expect(matchingRule(line)).toBe('aws-secret-access-key');
  });

  it('weighs a value under a secret-looking name by its length and its entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    const low = 'correcthorsebattery';
    expect(shannonEntropy(low)).toBeLessThanOrEqual(GENERIC_SECRET_MIN_ENTROPY_BITS);
    expect(matchingRule('const apiToken = "' + low + '";')).toBeUndefined();
    const short = randomish(GENERIC_SECRET_MIN_LENGTH - 1);
    expect(matchingRule('const apiToken = "' + short + '";')).toBeUndefined();
    // The name decides: the same value under another name is not a secret.
    expect(matchingRule('const greeting = "' + randomish(24) + '";')).toBeUndefined();
    expect(matchingRule('const token = process.env.TOKEN;')).toBeUndefined();
  });

  it('passes a `.env` line that names where the value comes from rather than holding it', () => {
    for (const value of ['${API_TOKEN}', '<your-token>', 'your_api_key_here', 'changeme']) {
      expect(matchingRule('API_TOKEN=' + value), value).toBeUndefined();
    }
    expect(matchingRule('API_TOKEN=' + 'ab1'.repeat(2))).toBeUndefined();
    expect('ab1'.repeat(2).length).toBeLessThan(ENV_SECRET_MIN_LENGTH);
    expect(matchingRule('PORT=' + '8080' + randomish(8))).toBeUndefined();
  });
});

// ── The operation, over a real repository ─────────────────────────────────

let base: string;
let root: string;
let policyPath: string;

interface Captured {
  output?: unknown;
  logged: string[];
}

function contextFor(input: unknown, captured: Captured, spaceId = 'space-a'): never {
  const log = (...args: unknown[]) => {
    captured.logged.push(JSON.stringify(args));
  };
  return {
    operationId: 'host.commit.scan',
    spaceId,
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: log, warn: log, info: log, debug: log },
    readPayload: () => Promise.resolve(input),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never;
}

async function scan(range: string, spaceId?: string) {
  const captured: Captured = { logged: [] };
  const result = await createHostHandler(policyPath).execute(
    contextFor({ bindingId: 'hb_app', range }, captured, spaceId),
  );
  return { result, captured };
}

async function commitFiles(files: Record<string, string | Buffer>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'change');
  return (await git(root, 'rev-parse', 'HEAD')).trim();
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'commit-scan-'));
  root = join(base, 'repo');
  await run('git', ['init', '-q', '-b', 'main', root]);
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'README.md'), '# app\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'init');
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [{ id: 'hb_app', root, mode: 'read', allowsExecution: false, spaceId: 'space-a' }],
    }),
  );
});

describe('host.commit.scan', () => {
  it('finds every planted example, by file, line and rule', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const lines = Object.values(PLANTED).map((p) => p.line);
    const head = await commitFiles({ 'config.txt': `first line\n${lines.join('\n')}\n` });

    const { result, captured } = await scan(`${start}..${head}`);
    expect(result.status).toBe('SUCCEEDED');
    const output = HostCommitScanOutputSchema.parse(captured.output);
    expect(output.clean).toBe(false);
    expect(output.clearedRange).toBeUndefined();
    expect(output.findings).toEqual(
      Object.keys(PLANTED).map((pattern, index) => ({
        file: 'config.txt',
        line: index + 2,
        pattern,
      })),
    );
    expect(output.summary).toContain('config.txt line 2 (private-key)');
    expect(output.summary).toContain('in 10 places');
  });

  it('never returns, logs or stores what matched', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const head = await commitFiles({
      'config.txt': Object.values(PLANTED)
        .map((p) => p.line)
        .join('\n'),
    });
    const { captured } = await scan(`${start}..${head}`);
    const written = JSON.stringify(captured.output) + captured.logged.join('\n');
    expect((captured.output as { findings: unknown[] }).findings).toHaveLength(10);
    for (const [name, { value }] of Object.entries(PLANTED)) {
      expect(written, name).not.toContain(value);
      expect(written, name).not.toContain(value.slice(-12));
    }
  });

  it('clears a clean range, naming it by its two full shas', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const head = await commitFiles({ 'app.ts': 'export const answer = 42;\n' });
    const { result, captured } = await scan(`${start.slice(0, 12)}..${head.slice(0, 12)}`);
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output).toEqual({
      clean: true,
      findings: [],
      summary: `No secret found in the lines the 1 commit of \`${start}..${head}\` add.`,
      clearedRange: `${start}..${head}`,
    });
  });

  it('reads every commit, so a secret removed later in the range is still found', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    await commitFiles({ 'app.ts': `x\n${PLANTED['github-token']?.line ?? ''}\n` });
    const head = await commitFiles({ 'app.ts': 'x\n' });
    const { captured } = await scan(`${start}..${head}`);
    const output = HostCommitScanOutputSchema.parse(captured.output);
    expect(output.findings).toEqual([{ file: 'app.ts', line: 2, pattern: 'github-token' }]);
    expect(output.summary).toContain('the 2 commits of');
  });

  it('reads only what the range adds, not what it removes or what came before it', async () => {
    await commitFiles({ 'old.txt': `${PLANTED['slack-token']?.line ?? ''}\n` });
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const head = await commitFiles({ 'old.txt': 'gone\n' });
    const { captured } = await scan(`${start}..${head}`);
    expect(HostCommitScanOutputSchema.parse(captured.output).clean).toBe(true);
  });

  it('skips binary files and files over the size, and names them', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const secret = PLANTED['stripe-live-key']?.line ?? '';
    const head = await commitFiles({
      'image.bin': Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${secret}\n`)]),
      'bundle.js': `${secret}\n${'x'.repeat(SCAN_MAX_FILE_BYTES)}\n`,
    });
    const { captured } = await scan(`${start}..${head}`);
    const output = HostCommitScanOutputSchema.parse(captured.output);
    expect(output.clean).toBe(true);
    expect(output.summary).toContain('Not read, as binary or adding more than 1024 KB');
    expect(output.summary).toContain('bundle.js, image.bin');
  });

  it('caps the findings it returns and counts the rest', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const line = PLANTED['aws-access-key-id']?.line ?? '';
    const head = await commitFiles({
      'keys.txt': Array.from({ length: SCAN_MAX_FINDINGS + 5 }, () => line).join('\n'),
    });
    const { captured } = await scan(`${start}..${head}`);
    const output = HostCommitScanOutputSchema.parse(captured.output);
    expect(output.findings).toHaveLength(SCAN_MAX_FINDINGS);
    expect(output.summary).toContain(`in ${String(SCAN_MAX_FINDINGS + 5)} places`);
    expect(output.summary).toContain(', and 5 more.');
  });

  it('leaves the working tree, the index and every ref as they were', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const head = await commitFiles({ 'app.ts': `${PLANTED.jwt?.line ?? ''}\n` });
    await writeFile(join(root, 'wip.txt'), 'uncommitted\n');
    await writeFile(join(root, 'app.ts'), 'edited\n');
    const before = [
      await git(root, 'status', '--porcelain'),
      await git(root, 'for-each-ref'),
      await git(root, 'rev-parse', 'HEAD'),
    ];
    const { result } = await scan(`${start}..${head}`);
    expect(result.status).toBe('SUCCEEDED');
    expect([
      await git(root, 'status', '--porcelain'),
      await git(root, 'for-each-ref'),
      await git(root, 'rev-parse', 'HEAD'),
    ]).toEqual(before);
  });

  it('refuses a range end the repository does not have', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const { result, captured } = await scan(`${start}..${'d'.repeat(40)}`);
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output)).toContain('names no commit');
  });

  it('refuses another workspace naming the folder', async () => {
    const start = (await git(root, 'rev-parse', 'HEAD')).trim();
    const { result } = await scan(`${start}..${start}`, 'space-b');
    expect(result.status).toBe('FAILED');
  });

  it('takes two shas and nothing else as its range', () => {
    const sha = 'a'.repeat(40);
    expect(
      HostCommitScanInputSchema.safeParse({ bindingId: 'b', range: `${sha}..${sha}` }).success,
    ).toBe(true);
    for (const range of ['main..HEAD', sha, `${sha}...${sha}`, `main..${sha}`]) {
      expect(HostCommitScanInputSchema.safeParse({ bindingId: 'b', range }).success, range).toBe(
        false,
      );
    }
  });
});
