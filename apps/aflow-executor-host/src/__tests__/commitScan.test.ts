/**
 * Contract: the commits a publication is about to push are read for secrets
 * line by line, every commit of the range, and a finding names its file, line
 * and rule — never what matched. A file the scan could not read whole is
 * named with why, and a range holding one is never clean.
 *
 * Every planted value is assembled at run time, so this file holds none of
 * them and cannot trip the scan it tests.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it } from 'vitest';

import { HostCommitScanInputSchema, HostCommitScanOutputSchema } from '@aflow/schemas';

import { SCAN_MAX_FILE_BYTES, SCAN_MAX_LINE_BYTES, SCAN_MAX_LISTED } from '../commitScan.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';
import {
  endsInAllowComment,
  isEnvFile,
  SCAN_ALLOW_MARKER,
  scanLine,
  SECRET_RULES,
  SECRET_VALUE_MAX_LENGTH,
  SECRET_VALUE_MIN_ENTROPY_BITS,
  SECRET_VALUE_MIN_LENGTH,
  shannonEntropy,
} from '../secretRules.js';
import { LineCutter } from '../worktree.js';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 * 1024 });
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

/** The file every planted line is committed to: `*.env`, so the `.env` rule reads it too. */
const PLANTED_FILE = 'deploy.env';

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
  const env = randomish(24, ALNUM, 41);
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

function ruleOf(file: string, line: string): string | undefined {
  return scanLine(file, line)?.rule;
}

describe('the rules', () => {
  it('has a planted example for every rule, and each is named by its own rule', () => {
    expect(Object.keys(PLANTED).sort()).toEqual(SECRET_RULES.map((rule) => rule.name).sort());
    for (const [name, { line }] of Object.entries(PLANTED)) {
      expect(ruleOf(PLANTED_FILE, line), name).toBe(name);
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
      expect(ruleOf('a.ts', 'x ' + prefix + randomish(36)), prefix).toBe('github-token');
    }
    expect(ruleOf('a.ts', 'x ' + 'github_pat_' + randomish(40))).toBe('github-token');
    for (const kind of ['a', 'b', 'p', 'r', 's']) {
      expect(ruleOf('a.ts', 'x ' + 'xox' + kind + '-' + randomish(20)), kind).toBe('slack-token');
    }
    expect(ruleOf('a.ts', 'x ' + 'rk_' + 'live_' + randomish(24))).toBe('stripe-live-key');
  });

  it('reads an AWS secret beside its key id with no name on it', () => {
    const line = 'AKIA' + 'QWERTYUIOPASDFGH' + ',' + randomish(40, `${ALNUM}/+`, 3);
    expect(ruleOf('a.ts', line)).toBe('aws-secret-access-key');
  });

  it('weighs a value under a secret-looking name by its length and its entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    const key = randomish(24, ALNUM, 5);
    expect(ruleOf('a.ts', 'const apiToken = "' + key + '";')).toBe('secret-assignment');
    expect(ruleOf('a.ts', "apiToken: '" + key + "',")).toBe('secret-assignment');
    expect(ruleOf('a.ts', 'apiToken := `' + key + '`')).toBe('secret-assignment');
    const low = 'correcthorsebattery';
    expect(shannonEntropy(low)).toBeLessThanOrEqual(SECRET_VALUE_MIN_ENTROPY_BITS);
    expect(ruleOf('a.ts', 'const apiToken = "' + low + '";')).toBeUndefined();
    const short = randomish(SECRET_VALUE_MIN_LENGTH - 1);
    expect(ruleOf('a.ts', 'const apiToken = "' + short + '";')).toBeUndefined();
    // The name decides: the same value under another name is not a secret.
    expect(ruleOf('a.ts', 'const greeting = "' + key + '";')).toBeUndefined();
    // A bare value is a value; an expression that reads one from elsewhere is not.
    expect(ruleOf('a.ts', 'const apiToken = ' + key + ';')).toBe('secret-assignment');
    expect(ruleOf('a.ts', 'const token = process.env.TOKEN;')).toBeUndefined();
    expect(
      ruleOf('a.ts', 'const basePricePerToken = pricing.promptPer1M / 1_000_000;'),
    ).toBeUndefined();
    expect(ruleOf('a.ts', 'apiToken: tokenFromHeader(request),')).toBeUndefined();
    // A dotted token is not a member access, however it is spelled.
    const dotted = 'sk.' + 'eyJ' + randomish(40, ALNUM, 53) + '.' + randomish(22, ALNUM, 59);
    expect(ruleOf('a.yaml', 'mapbox_token: ' + dotted)).toBe('secret-assignment');
  });

  it('reads a bare value as YAML, `.properties`, shell, compose and `.npmrc` write it', () => {
    const key = randomish(32, ALNUM, 61);
    const shapes: Array<[string, string]> = [
      ['config/app.yaml', `  api_key: ${key}`],
      ['src/main/resources/application.properties', `db.password=${key}`],
      ['scripts/deploy.sh', `export API_TOKEN=${key}`],
      ['docker-compose.yml', `      - POSTGRES_PASSWORD=${key}`],
      ['.npmrc', `//registry.npmjs.org/:_authToken=${key}`],
    ];
    for (const [file, line] of shapes) {
      expect(ruleOf(file, line), file).toBe('secret-assignment');
      expect(ruleOf(file, `${line} # rotated`), `${file} with a comment`).toBe('secret-assignment');
    }
    for (const [file, line] of [
      ['config/app.yaml', '  api_key: ${API_KEY}'],
      ['config/app.yaml', '  api_key: changeme-' + randomish(12)],
      ['application.properties', 'db.password=/run/secrets/' + randomish(16)],
      ['scripts/deploy.sh', 'export API_TOKEN=$(cat /run/secrets/token)'],
      ['docker-compose.yml', '      - POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password'],
      ['.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'],
      // Past the longest value weighed, a bare run is data, not a key, and is not cut to fit.
      ['data.yaml', `token: ${randomish(SECRET_VALUE_MAX_LENGTH + 1)}`],
    ] as const) {
      expect(ruleOf(file, line), line).toBeUndefined();
    }
  });

  it('passes a value that is plainly something other than a secret, whatever its name', () => {
    const sha = randomish(40, '0123456789abcdef', 3);
    const digest = randomish(64, '0123456789abcdef', 5);
    const values = [
      sha,
      digest,
      '86400000123456789',
      'https://auth.' + 'provider.test/oauth/token',
      '/etc/aflow/' + randomish(16),
      './fixtures/' + randomish(16),
      '${RUN}:' + randomish(16),
      'test-password-123',
      'key-for-example-' + randomish(12),
      'changeme-' + randomish(12),
      'xxxx' + randomish(16),
      'dummy-' + randomish(16),
      'workflow_run_tasks_pending',
      'dispatch:run-1:task-a:1',
      'stripeDefaultClientSecret',
      'sk-live-not-a-real-credential',
      '0123456789abcdefghij',
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64'),
    ];
    for (const value of values) {
      expect(value.length, value).toBeGreaterThanOrEqual(SECRET_VALUE_MIN_LENGTH);
      for (const name of ['headSha256Token', 'tokenEndpoint', 'apiSecret', 'password']) {
        expect(ruleOf('a.ts', `const ${name} = '${value}';`), `${name} ${value}`).toBeUndefined();
      }
    }
  });

  it('names a `.env` line by the `.env` rule only in a `.env` file, and by the assignment anywhere else', () => {
    for (const file of ['.env', 'apps/web/.env', '.env.local', '.env.production', 'deploy.env']) {
      expect(isEnvFile(file), file).toBe(true);
      expect(ruleOf(file, PLANTED['env-secret']?.line ?? ''), file).toBe('env-secret');
    }
    for (const file of ['app.ts', 'environment.ts', 'docs/env.md', 'Dockerfile', 'env']) {
      expect(isEnvFile(file), file).toBe(false);
      expect(ruleOf(file, PLANTED['env-secret']?.line ?? ''), file).toBe('secret-assignment');
    }
  });

  it('passes a `.env` value that is not a secret under the same rules as any other value', () => {
    for (const line of [
      'TOKEN_TTL_SECONDS=86400000',
      'TOKEN_FILE=/etc/aflow/' + randomish(16),
      'SECRET_MANAGER_URL=http://' + 'vault.internal:8200/v1',
      'API_TOKEN=${API_TOKEN}',
      'API_TOKEN=$OTHER_' + randomish(16),
      'API_TOKEN=<your-token-' + randomish(12) + '>',
      'API_TOKEN=your_api_key_here',
      'DATABASE_PASSWORD=hunter2',
      'API_TOKEN=changeme',
      'PORT=8080' + randomish(16),
    ]) {
      expect(ruleOf('.env', line), line).toBeUndefined();
    }
    const key = randomish(24, ALNUM, 9);
    for (const line of [
      'export API_TOKEN=' + key,
      'API_TOKEN="' + key + '"',
      "API_TOKEN='" + key + "' # rotated",
      'API_TOKEN=' + key + ' # rotated',
    ]) {
      expect(ruleOf('.env', line), line).toBe('env-secret');
    }
  });

  it('marks a line allowed only when the marker ends it, in a trailing comment', () => {
    const line = PLANTED['secret-assignment']?.line ?? '';
    expect(scanLine('a.ts', line)).toEqual({ rule: 'secret-assignment', allowed: false });
    for (const comment of [
      `// ${SCAN_ALLOW_MARKER}`,
      `//${SCAN_ALLOW_MARKER}`,
      `# ${SCAN_ALLOW_MARKER}`,
      `-- ${SCAN_ALLOW_MARKER}`,
      `/* ${SCAN_ALLOW_MARKER} */`,
      `<!-- ${SCAN_ALLOW_MARKER} -->`,
      `// ${SCAN_ALLOW_MARKER}   \r`,
    ]) {
      expect(scanLine('a.ts', `${line} ${comment}`), comment).toEqual({
        rule: 'secret-assignment',
        allowed: true,
      });
    }
    // Strings the line closes, and an apostrophe inside a word, leave the comment a comment.
    for (const before of [`const label = "it's"; const u = 'a\\'b';`, "# isn't real"]) {
      expect(scanLine('a.ts', `${line} ${before} // ${SCAN_ALLOW_MARKER}`), before).toEqual({
        rule: 'secret-assignment',
        allowed: true,
      });
    }
    // A line that matches nothing has nothing to allow.
    expect(scanLine('a.ts', `const note = "x"; // ${SCAN_ALLOW_MARKER}`)).toBeUndefined();
  });

  it('does not count the marker anywhere but the end of a trailing comment', () => {
    const line = PLANTED['secret-assignment']?.line ?? '';
    const notAComment = [
      // Inside a string literal, the marker is part of the value.
      `${line} const note = "${SCAN_ALLOW_MARKER}";`,
      `${line} const note = '// ${SCAN_ALLOW_MARKER}'`,
      `${line} const note = \`# ${SCAN_ALLOW_MARKER}\``,
      // Inside a URL: a query, a fragment, a path.
      `${line} fetch("https://example.com/?note=${SCAN_ALLOW_MARKER}")`,
      `${line} const u = 'https://example.com/a#${SCAN_ALLOW_MARKER}'`,
      `${line} // see https://example.com/?q=1#${SCAN_ALLOW_MARKER}`,
      `${line} https://example.com//${SCAN_ALLOW_MARKER}`,
      // A leader not set off by a space is part of something else.
      `${line} x--${SCAN_ALLOW_MARKER}`,
      // Something after the marker: it is no longer the last thing on the line.
      `${line} // ${SCAN_ALLOW_MARKER} because the fixture needs it`,
      `${line} // ${SCAN_ALLOW_MARKER}ed`,
      `${line} /* ${SCAN_ALLOW_MARKER} */ const more = 1;`,
      `${line} /* ${SCAN_ALLOW_MARKER}`,
      `${line} <!-- ${SCAN_ALLOW_MARKER}`,
      // Inside a string the line leaves open, running on to the next line.
      `${line} const more = "x" + \` // ${SCAN_ALLOW_MARKER}`,
      `${line} const more = 'unterminated // ${SCAN_ALLOW_MARKER}`,
      `${line} const more = "escaped \\" // ${SCAN_ALLOW_MARKER}`,
    ];
    for (const candidate of notAComment) {
      expect(scanLine('a.ts', candidate), candidate).toEqual({
        rule: 'secret-assignment',
        allowed: false,
      });
    }
    expect(endsInAllowComment(`fetch("https://example.com/?note=${SCAN_ALLOW_MARKER}")`)).toBe(
      false,
    );
    expect(endsInAllowComment(`value // ${SCAN_ALLOW_MARKER}`)).toBe(true);
  });

  it('reads a line of a megabyte in linear time, whatever it is made of', () => {
    const size = 1024 * 1024;
    const fill = (unit: string): string =>
      unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const lines = [
      fill('a'),
      fill('token'),
      fill("token='"),
      'apiToken = "' + fill('a'),
      fill('aws_secret_'),
      fill('awssecret'),
      fill('eyJ'),
      fill('-eyJ'),
      fill('eyJaaaaaaaaa.'),
      fill('github_pat_'),
      fill('-xoxb-'),
      '-----BEGIN ' + fill('A '),
      fill('AKIA' + 'QWERTYUIOPASDFGH/'),
      fill('A_TOKEN_'),
      fill(`token = "${'Ab_'.repeat(170)}" `),
      fill('token='),
      fill('token:'),
      fill(`token: ${'Ab'.repeat(300)} `),
      fill('# '),
      fill("'"),
      fill('" // '),
    ];
    for (const line of lines) {
      const started = performance.now();
      for (const file of ['bundle.js', '.env']) scanLine(file, line);
      // A quadratic rule takes minutes here; a linear one, milliseconds.
      expect(performance.now() - started, line.slice(0, 24)).toBeLessThan(2000);
    }
  });

  it('finds nothing in this repository', async () => {
    const repository = fileURLToPath(new URL('../../../../', import.meta.url));
    const files = (await git(repository, 'ls-files', '-z')).split('\0').filter(Boolean);
    const hits: string[] = [];
    for (const file of files) {
      const path = join(repository, file);
      const size = await stat(path).then(
        (s) => (s.isFile() ? s.size : undefined),
        () => undefined,
      );
      if (size === undefined || size > SCAN_MAX_FILE_BYTES) continue;
      const bytes = await readFile(path);
      if (bytes.subarray(0, 8000).includes(0)) continue;
      bytes
        .toString('utf8')
        .split('\n')
        .forEach((line, index) => {
          if (Buffer.byteLength(line, 'utf8') > SCAN_MAX_LINE_BYTES) return;
          const verdict = scanLine(file, line);
          if (verdict !== undefined && !verdict.allowed) {
            hits.push(`${file} line ${String(index + 1)} (${verdict.rule})`);
          }
        });
    }
    expect(files.length).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  }, 120_000);
});

describe('the line reader', () => {
  it('holds no more of a line than its cap, and says how long the line was', () => {
    const cap = 1024;
    const lines: Array<[string, number]> = [];
    const cutter = new LineCutter(cap, (line, bytes) => lines.push([line, bytes]));
    cutter.push(Buffer.from('first\r\n+'));
    for (let i = 0; i < 1024; i += 1) cutter.push(Buffer.alloc(10 * 1024, 'x'));
    cutter.push(Buffer.from('\nlast'));
    cutter.end();
    expect(lines.map(([line, bytes]) => [line.length, bytes])).toEqual([
      [5, 5],
      [cap, 1 + 1024 * 10 * 1024],
      [4, 4],
    ]);
    expect(lines[0]?.[0]).toBe('first');
    expect(lines[1]?.[0].startsWith('+x')).toBe(true);
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

async function scan(range: string, spaceId?: string, texts?: Record<string, string>) {
  const captured: Captured = { logged: [] };
  const result = await createHostHandler(policyPath, noPushApprovals).execute(
    contextFor({ bindingId: 'hb_app', range, ...(texts ? { texts } : {}) }, captured, spaceId),
  );
  return { result, captured };
}

async function scanOutput(range: string, texts?: Record<string, string>) {
  const { result, captured } = await scan(range, undefined, texts);
  expect(result.status).toBe('SUCCEEDED');
  return HostCommitScanOutputSchema.parse(captured.output);
}

async function headSha(): Promise<string> {
  return (await git(root, 'rev-parse', 'HEAD')).trim();
}

async function commitFiles(files: Record<string, string | Buffer>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'change');
  return headSha();
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
    const start = await headSha();
    const lines = Object.values(PLANTED).map((p) => p.line);
    const head = await commitFiles({ [PLANTED_FILE]: `first line\n${lines.join('\n')}\n` });

    const output = await scanOutput(`${start}..${head}`);
    expect(output.clean).toBe(false);
    expect(output.unflaggedRange).toBeUndefined();
    expect(output.clearedRange).toBeUndefined();
    // Nothing that was found can be pushed.
    expect(output.receipt).toBeUndefined();
    expect(output.findings).toEqual(
      Object.keys(PLANTED).map((pattern, index) => ({
        file: PLANTED_FILE,
        line: index + 2,
        pattern,
      })),
    );
    expect(output.summary).toContain(`${PLANTED_FILE} line 2 (private-key)`);
    expect(output.summary).toContain('in 10 places');
  });

  it('never returns, logs or stores what matched', async () => {
    const start = await headSha();
    const head = await commitFiles({
      [PLANTED_FILE]: Object.values(PLANTED)
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
    const start = await headSha();
    const head = await commitFiles({ 'app.ts': 'export const answer = 42;\n' });
    const { result, captured } = await scan(`${start.slice(0, 12)}..${head.slice(0, 12)}`);
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output).toEqual({
      clean: true,
      findings: [],
      unscanned: [],
      allowed: [],
      summary: `No secret found in the lines the 1 commit of \`${start}..${head}\` add and their headers and messages.`,
      unflaggedRange: `${start}..${head}`,
      clearedRange: `${start}..${head}`,
      receipt: expect.any(String),
    });
  });

  it('reads every commit, so a secret removed later in the range is still found', async () => {
    const start = await headSha();
    await commitFiles({ 'app.ts': `x\n${PLANTED['github-token']?.line ?? ''}\n` });
    const head = await commitFiles({ 'app.ts': 'x\n' });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([{ file: 'app.ts', line: 2, pattern: 'github-token' }]);
    expect(output.summary).toContain('the 2 commits of');
  });

  it('reads only what the range adds, not what it removes or what came before it', async () => {
    await commitFiles({ 'old.txt': `${PLANTED['slack-token']?.line ?? ''}\n` });
    const start = await headSha();
    const head = await commitFiles({ 'old.txt': 'gone\n' });
    expect((await scanOutput(`${start}..${head}`)).clean).toBe(true);
  });

  it('reads a path holding a space as git names it, without the TAB git ends it with', async () => {
    const start = await headSha();
    const head = await commitFiles({ 'my config.ts': `${PLANTED.jwt?.line ?? ''}\n` });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([{ file: 'my config.ts', line: 1, pattern: 'jwt' }]);
  });

  it('reads the lines a merge adds resolving a conflict', async () => {
    await commitFiles({ 'app.ts': 'shared\n' });
    const start = await headSha();
    await git(root, 'checkout', '-q', '-b', 'side');
    await commitFiles({ 'app.ts': 'side\n' });
    await git(root, 'checkout', '-q', 'main');
    await commitFiles({ 'app.ts': 'main\n' });
    await run('git', ['-C', root, 'merge', '-q', 'side']).catch(() => undefined);
    await writeFile(join(root, 'app.ts'), `main\nside\n${PLANTED['github-token']?.line ?? ''}\n`);
    await git(root, 'add', 'app.ts');
    await git(root, 'commit', '-q', '--no-edit');
    const merge = await headSha();
    expect(
      (await git(root, 'rev-list', '--parents', '-n', '1', merge)).trim().split(' '),
    ).toHaveLength(3);
    // Neither parent holds the line: only the merge adds it.
    const output = await scanOutput(`${start}..${merge}`);
    expect(output.findings).toEqual([{ file: 'app.ts', line: 3, pattern: 'github-token' }]);
  });

  it('names binary and oversized files as unscanned, keeps what it found in them, and is not clean', async () => {
    const start = await headSha();
    const secret = PLANTED['stripe-live-key']?.line ?? '';
    const head = await commitFiles({
      'image.bin': Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${secret}\n`)]),
      'bundle.js': `${secret}\n${'x'.repeat(SCAN_MAX_FILE_BYTES)}\n`,
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.clean).toBe(false);
    expect(output.clearedRange).toBeUndefined();
    expect(output.unflaggedRange).toBeUndefined();
    expect(output.findings).toEqual([{ file: 'bundle.js', line: 1, pattern: 'stripe-live-key' }]);
    expect(output.unscanned).toEqual([
      { file: 'bundle.js', reason: 'too-large' },
      { file: 'image.bin', reason: 'binary' },
    ]);
    expect(output.summary).toContain(
      'Not read whole: bundle.js (more than 1024 KB added in one commit), image.bin (binary).',
    );
  });

  it('names a binary file whose path holds " and " by its whole path', async () => {
    const start = await headSha();
    const binary = Buffer.from([0, 1, 2, 0]);
    const head = await commitFiles({
      'cats and dogs.bin': binary,
      'a and b and c.png': binary,
    });
    const added = await scanOutput(`${start}..${head}`);
    expect(added.unscanned).toEqual([
      { file: 'a and b and c.png', reason: 'binary' },
      { file: 'cats and dogs.bin', reason: 'binary' },
    ]);
    const changed = await commitFiles({ 'cats and dogs.bin': Buffer.from([0, 9, 9, 0]) });
    expect((await scanOutput(`${head}..${changed}`)).unscanned).toEqual([
      { file: 'cats and dogs.bin', reason: 'binary' },
    ]);
    // A deleted file adds nothing, so there is nothing left unread.
    await git(root, 'rm', '-q', 'a and b and c.png');
    await git(root, 'commit', '-q', '-m', 'remove');
    const removed = await scanOutput(`${changed}..${await headSha()}`);
    expect(removed).toMatchObject({ clean: true, unscanned: [] });
  });

  it('does not clear a range it could not read whole, though nothing was found', async () => {
    const start = await headSha();
    const head = await commitFiles({ 'vendor.js': `${'y'.repeat(SCAN_MAX_FILE_BYTES + 1)}\n` });
    const output = await scanOutput(`${start}..${head}`);
    expect(output).toMatchObject({
      clean: false,
      findings: [],
      unscanned: [{ file: 'vendor.js', reason: 'too-large' }],
      unflaggedRange: `${start}..${head}`,
    });
    expect(output.clearedRange).toBeUndefined();
    expect(output.summary).toContain('but not all of it was read');
  });

  it('stops reading a file at a line holding a NUL byte, keeping what came before', async () => {
    const start = await headSha();
    // git judges a file binary by its first 8000 bytes, so the NUL sits past them.
    const padding = Array.from({ length: 500 }, (_, i) => `line ${String(i)} of padding text`);
    const head = await commitFiles({
      'data.txt': [
        PLANTED['github-token']?.line ?? '',
        ...padding,
        'a\0b',
        PLANTED['slack-token']?.line ?? '',
        '',
      ].join('\n'),
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([{ file: 'data.txt', line: 1, pattern: 'github-token' }]);
    expect(output.unscanned).toEqual([{ file: 'data.txt', reason: 'nul-byte' }]);
    expect(output.clean).toBe(false);
  });

  it('reports a line too long to read rather than matching it, and reads the rest of the file', async () => {
    const start = await headSha();
    const long = `const blob = "${'z'.repeat(SCAN_MAX_LINE_BYTES)}"; ${PLANTED['github-token']?.line ?? ''}`;
    const head = await commitFiles({
      'app.min.js': `${long}\n${PLANTED['slack-token']?.line ?? ''}\n`,
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([{ file: 'app.min.js', line: 2, pattern: 'slack-token' }]);
    expect(output.unscanned).toEqual([{ file: 'app.min.js', reason: 'line-too-long' }]);
    expect(output.summary).toContain('app.min.js (a line longer than 64 KB)');
  });

  it('lists a line marked allowed and does not clear the range, so the push asks', async () => {
    const start = await headSha();
    const head = await commitFiles({
      'fixture.ts': `${PLANTED['secret-assignment']?.line ?? ''} // ${SCAN_ALLOW_MARKER}\n`,
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output).toMatchObject({
      clean: false,
      findings: [],
      unscanned: [],
      allowed: [{ file: 'fixture.ts', line: 1, pattern: 'secret-assignment' }],
      unflaggedRange: `${start}..${head}`,
    });
    expect(output.clearedRange).toBeUndefined();
    expect(output.summary).toContain('apart from lines marked allowed');
    expect(output.summary).toContain(
      'Marked allowed by an `aflow-scan: allow` comment, and so for the operator to read before ' +
        'anything is pushed: fixture.ts line 1 (secret-assignment).',
    );
  });

  it('finds a line whose marker sits inside a string or a URL rather than ending a comment', async () => {
    const start = await headSha();
    const secret = PLANTED['secret-assignment']?.line ?? '';
    const head = await commitFiles({
      'app.ts': [
        `${secret} const note = "${SCAN_ALLOW_MARKER}";`,
        `${secret} fetch("https://example.com/?note=${SCAN_ALLOW_MARKER}")`,
        '',
      ].join('\n'),
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([
      { file: 'app.ts', line: 1, pattern: 'secret-assignment' },
      { file: 'app.ts', line: 2, pattern: 'secret-assignment' },
    ]);
    expect(output.allowed).toEqual([]);
    expect(output.unflaggedRange).toBeUndefined();
  });

  it('finds a bare value in a YAML, `.properties`, shell, compose or `.npmrc` file', async () => {
    const start = await headSha();
    const key = (seed: number): string => randomish(32, ALNUM, seed);
    await mkdir(join(root, 'config'));
    const head = await commitFiles({
      'config/app.yaml': `service:\n  api_key: ${key(71)}\n`,
      'application.properties': `db.url=jdbc:postgresql://db/app\ndb.password=${key(73)}\n`,
      'deploy.sh': `#!/bin/sh\nexport API_TOKEN=${key(79)}\n`,
      'docker-compose.yml': `services:\n  db:\n    environment:\n      - POSTGRES_PASSWORD=${key(83)}\n`,
      '.npmrc': `//registry.npmjs.org/:_authToken=${key(89)}\n`,
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([
      { file: '.npmrc', line: 1, pattern: 'secret-assignment' },
      { file: 'application.properties', line: 2, pattern: 'secret-assignment' },
      { file: 'config/app.yaml', line: 2, pattern: 'secret-assignment' },
      { file: 'deploy.sh', line: 2, pattern: 'secret-assignment' },
      { file: 'docker-compose.yml', line: 4, pattern: 'secret-assignment' },
    ]);
    expect(output.unflaggedRange).toBeUndefined();
  });

  it('names a Git LFS pointer as unscanned, so the push asks rather than clearing it', async () => {
    const start = await headSha();
    const pointer = (seed: number, size: number): string =>
      [
        'version https://git-lfs.github.com/spec/v1',
        `oid sha256:${randomish(64, '0123456789abcdef', seed)}`,
        `size ${String(size)}`,
        '',
      ].join('\n');
    const added = await commitFiles({
      'secrets.env': pointer(97, 2048),
      'notes.md': `# notes\n\nversion https://git-lfs.github.com/spec/v1 is the pointer format.\n`,
    });
    const first = await scanOutput(`${start}..${added}`);
    expect(first).toMatchObject({
      clean: false,
      findings: [],
      allowed: [],
      unscanned: [{ file: 'secrets.env', reason: 'lfs' }],
      unflaggedRange: `${start}..${added}`,
    });
    expect(first.clearedRange).toBeUndefined();
    expect(first.summary).toContain('secrets.env (a Git LFS pointer');

    // A new version of the tracked content changes the pointer's object, not its version line.
    const changed = await commitFiles({ 'secrets.env': pointer(101, 4096) });
    expect((await scanOutput(`${added}..${changed}`)).unscanned).toEqual([
      { file: 'secrets.env', reason: 'lfs' },
    ]);
  });

  it('reads every commit message in the range as its own text', async () => {
    const start = await headSha();
    await commitFiles({ 'app.ts': 'export const a = 1;\n' });
    await writeFile(join(root, 'app.ts'), 'export const a = 2;\n');
    await git(root, 'add', '-A');
    await git(
      root,
      'commit',
      '-q',
      '-m',
      'Rotate the deploy key',
      '-m',
      `The old one was ${PLANTED['github-token']?.value ?? ''}`,
    );
    const flagged = await headSha();
    const head = await commitFiles({ 'app.ts': 'export const a = 3;\n' });

    const { captured } = await scan(`${start}..${head}`);
    const output = HostCommitScanOutputSchema.parse(captured.output);
    expect(output.findings).toEqual([
      { file: `${flagged} (message)`, line: 3, pattern: 'github-token' },
    ]);
    expect(output.unflaggedRange).toBeUndefined();
    expect(output.summary).toContain(`${flagged} (message) line 3 (github-token)`);
    expect(JSON.stringify(captured.output)).not.toContain(PLANTED['github-token']?.value ?? '');
  });

  it('reads a message from the commit object, and names one holding a NUL byte as unscanned', async () => {
    const start = await headSha();
    const tree = (await git(root, 'rev-parse', `${start}^{tree}`)).trim();
    const identity = 'Test <test@example.com> 1700000000 +0000';
    // A formatted message ends at the NUL, so the line before it is all
    // `git log` would show; the object holds the rest.
    const message = [
      'Tidy the config',
      '',
      `The old one was ${PLANTED['github-token']?.value ?? ''}`,
      'nothing here\0and then',
      PLANTED['slack-token']?.line ?? '',
      '',
    ].join('\n');
    const object = join(base, 'crafted-commit');
    await writeFile(
      object,
      `tree ${tree}\nparent ${start}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
    );
    const crafted = (
      await git(root, 'hash-object', '--literally', '-t', 'commit', '-w', object)
    ).trim();

    const output = await scanOutput(`${start}..${crafted}`);
    expect(output.findings).toEqual([
      { file: `${crafted} (message)`, line: 3, pattern: 'github-token' },
    ]);
    expect(output.unscanned).toEqual([{ file: `${crafted} (message)`, reason: 'nul-byte' }]);
    expect(output.clean).toBe(false);

    // Past the NUL alone: nothing found, and still not cleared.
    const hidden = message.replace(`The old one was ${PLANTED['github-token']?.value ?? ''}`, '');
    await writeFile(
      object,
      `tree ${tree}\nparent ${start}\nauthor ${identity}\ncommitter ${identity}\n\n${hidden}`,
    );
    const quiet = (
      await git(root, 'hash-object', '--literally', '-t', 'commit', '-w', object)
    ).trim();
    const unread = await scanOutput(`${start}..${quiet}`);
    expect(unread).toMatchObject({
      clean: false,
      findings: [],
      unscanned: [{ file: `${quiet} (message)`, reason: 'nul-byte' }],
      unflaggedRange: `${start}..${quiet}`,
    });
    expect(unread.clearedRange).toBeUndefined();
  });

  it('reads the headers of every commit, `mergetag` and unnamed ones included, as their own text', async () => {
    const start = await headSha();
    const tree = (await git(root, 'rev-parse', `${start}^{tree}`)).trim();
    const author = `Test ${PLANTED['github-token']?.value ?? ''} <test@example.com> 1700000000 +0000`;
    const committer = 'Test <test@example.com> 1700000000 +0000';
    const object = join(base, 'crafted-headers');
    await writeFile(
      object,
      [
        `tree ${tree}`,
        `parent ${start}`,
        `author ${author}`,
        `committer ${committer}`,
        `mergetag object ${start}`,
        ' type commit',
        ' tag v1',
        ' ',
        ` ${PLANTED['slack-token']?.line ?? ''}`,
        `x-note ${PLANTED['stripe-live-key']?.line ?? ''}`,
        '',
        'An ordinary message',
        '',
      ].join('\n'),
    );
    const crafted = (
      await git(root, 'hash-object', '--literally', '-t', 'commit', '-w', object)
    ).trim();
    // The last commit's message ends without a newline: the object is cut by
    // its size, not by lines, so the one after it is still read on its own.
    await writeFile(
      object,
      `tree ${tree}\nparent ${crafted}\nauthor ${committer}\ncommitter ${committer}\n\n` +
        `Tail ${PLANTED['google-api-key']?.line ?? ''}`,
    );
    const unterminated = (
      await git(root, 'hash-object', '--literally', '-t', 'commit', '-w', object)
    ).trim();

    const output = await scanOutput(`${start}..${unterminated}`);
    expect(output.findings).toEqual([
      { file: `${unterminated} (message)`, line: 1, pattern: 'google-api-key' },
      { file: `${crafted} (headers)`, line: 3, pattern: 'github-token' },
      { file: `${crafted} (headers)`, line: 9, pattern: 'slack-token' },
      { file: `${crafted} (headers)`, line: 10, pattern: 'stripe-live-key' },
    ]);
    expect(output.summary).toContain(`${crafted} (headers) line 3 (github-token)`);
    expect(output.unflaggedRange).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain(PLANTED['github-token']?.value ?? '');
  });

  it('reads the commits a push sends, never what a replace ref stands in for them', async () => {
    const start = await headSha();
    await writeFile(join(root, PLANTED_FILE), `${PLANTED['github-token']?.line ?? ''}\n`);
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', `Deploy ${PLANTED['slack-token']?.line ?? ''}`);
    const leaking = await headSha();
    const harmless = await commitFiles({ [PLANTED_FILE]: 'ok\n' });
    const tree = (await git(root, 'rev-parse', `${harmless}^{tree}`)).trim();
    const standIn = (await git(root, 'commit-tree', tree, '-p', start, '-m', 'Deploy')).trim();
    await git(root, 'replace', leaking, standIn);
    // The planted ref bites: git as the operator runs it shows the stand-in.
    const shown = await git(root, 'log', '-p', '--format=%B', `${start}..${leaking}`);
    expect(shown).toContain('+ok');
    expect(shown).not.toContain(PLANTED['github-token']?.value ?? '');

    const output = await scanOutput(`${start}..${leaking}`);
    expect(output.findings).toEqual([
      { file: PLANTED_FILE, line: 1, pattern: 'github-token' },
      { file: `${leaking} (message)`, line: 1, pattern: 'slack-token' },
    ]);
    expect(output.unflaggedRange).toBeUndefined();
  });

  it("reads the root commit and the stored text whatever the repository's config says", async () => {
    const start = await headSha();
    // An orphan history whose root adds a secret and whose next commit takes
    // it out: merged, only the root's own diff shows the line.
    await git(root, 'checkout', '-q', '--orphan', 'orphan');
    await git(root, 'rm', '-q', '-r', '--cached', '.');
    await writeFile(join(root, 'vault.txt'), `${PLANTED['github-token']?.line ?? ''}\n`);
    await git(root, 'add', 'vault.txt');
    await git(root, 'commit', '-q', '-m', 'orphan root');
    const orphanRoot = await headSha();
    await writeFile(join(root, 'vault.txt'), 'empty\n');
    await git(root, 'commit', '-q', '-am', 'take it out');
    await git(root, 'checkout', '-q', '-f', 'main');
    await git(root, 'merge', '-q', '--allow-unrelated-histories', '-m', 'merge', 'orphan');
    // A textconv would show every `.ts` line as `converted`; a few lines
    // apart, the two hunks would be joined by context lines.
    await writeFile(
      join(root, 'app.ts'),
      `${PLANTED['slack-token']?.line ?? ''}\nb\nc\n${PLANTED['stripe-live-key']?.line ?? ''}\n`,
    );
    await git(root, 'add', 'app.ts');
    await git(root, 'commit', '-q', '-m', 'app');
    const head = await headSha();

    await git(root, 'config', 'log.showRoot', 'false');
    await git(root, 'config', 'diff.hide.textconv', 'sed s/.*/converted/');
    await git(root, 'config', 'diff.external', 'true');
    await git(root, 'config', 'diff.noprefix', 'true');
    await git(root, 'config', 'diff.context', '3');
    await git(root, 'config', 'diff.interHunkContext', '5');
    await writeFile(join(root, '.git', 'info', 'attributes'), '*.ts diff=hide\n');
    // The planted config bites git as the operator runs it.
    const shown = await git(root, 'log', '-p', '--format=', `${start}..${head}`);
    expect(shown).toContain('+converted');
    expect(shown).not.toContain(PLANTED['slack-token']?.line ?? '');
    const rootShown = await git(root, 'log', '-p', '--format=', '-1', orphanRoot);
    expect(rootShown).toBe('');

    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toEqual([
      { file: 'app.ts', line: 1, pattern: 'slack-token' },
      { file: 'app.ts', line: 4, pattern: 'stripe-live-key' },
      { file: 'vault.txt', line: 1, pattern: 'github-token' },
    ]);
    expect(output.unflaggedRange).toBeUndefined();
  });

  it('reads the texts passed beside the range under the same rules, by name', async () => {
    const start = await headSha();
    const head = await commitFiles({ 'app.ts': 'export const answer = 42;\n' });
    const clean = await scanOutput(`${start}..${head}`, {
      'pull request title': 'Answer the question',
      'pull request summary': 'Sets the answer.\r\nNothing else.',
    });
    expect(clean.clean).toBe(true);
    expect(clean.summary).toContain(
      'their headers and messages, and `pull request title`, `pull request summary`',
    );

    const flagged = await scanOutput(`${start}..${head}`, {
      'pull request title': 'Answer the question',
      'pull request summary': `Sets the answer.\n${PLANTED['slack-token']?.line ?? ''}`,
    });
    expect(flagged.findings).toEqual([
      { file: 'pull request summary', line: 2, pattern: 'slack-token' },
    ]);
    expect(flagged.unflaggedRange).toBeUndefined();
    expect(flagged.clearedRange).toBeUndefined();

    const long = await scanOutput(`${start}..${head}`, {
      'pull request summary': 'x'.repeat(SCAN_MAX_LINE_BYTES + 1),
    });
    expect(long.unscanned).toEqual([{ file: 'pull request summary', reason: 'line-too-long' }]);
    expect(long.clean).toBe(false);
  });

  it('caps the findings it returns and counts the rest', async () => {
    const start = await headSha();
    const line = PLANTED['aws-access-key-id']?.line ?? '';
    const head = await commitFiles({
      'keys.txt': Array.from({ length: SCAN_MAX_LISTED + 5 }, () => line).join('\n'),
    });
    const output = await scanOutput(`${start}..${head}`);
    expect(output.findings).toHaveLength(SCAN_MAX_LISTED);
    expect(output.summary).toContain(`in ${String(SCAN_MAX_LISTED + 5)} places`);
    expect(output.summary).toContain(', and 5 more.');
  });

  it('leaves the working tree, the index and every ref as they were', async () => {
    const start = await headSha();
    const head = await commitFiles({ 'app.ts': `${PLANTED.jwt?.line ?? ''}\n` });
    await writeFile(join(root, 'wip.txt'), 'uncommitted\n');
    await writeFile(join(root, 'app.ts'), 'edited\n');
    const before = [
      await git(root, 'status', '--porcelain'),
      await git(root, 'for-each-ref'),
      await headSha(),
    ];
    const { result } = await scan(`${start}..${head}`);
    expect(result.status).toBe('SUCCEEDED');
    expect([
      await git(root, 'status', '--porcelain'),
      await git(root, 'for-each-ref'),
      await headSha(),
    ]).toEqual(before);
  });

  it('refuses a range end the repository does not have', async () => {
    const start = await headSha();
    const { result, captured } = await scan(`${start}..${'d'.repeat(40)}`);
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output)).toContain('names no commit');
  });

  it('refuses another workspace naming the folder', async () => {
    const start = await headSha();
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
