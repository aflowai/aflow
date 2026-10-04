import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  probeOutcome,
  probeStackRedis,
  stackRedis,
  stackRedisUrl,
  stackRedisUrlAs,
  type StackRedisProbe,
} from '../testing/stackRedis.js';

const PASSWORD = 'f3'.repeat(32);

function envFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'stack-redis-')), '.env');
  writeFileSync(path, text);
  return path;
}

const NO_ENV_FILE = join(tmpdir(), 'stack-redis-absent', '.env');

describe('the stack Redis a suite reaches', () => {
  it('is the shell’s REDIS_URL first, as the services read it', () => {
    const file = envFile(`REDIS_URL=redis://:from-file@localhost:6379\n`);
    expect(stackRedisUrl(15, { REDIS_URL: `redis://:${PASSWORD}@127.0.0.1:6380` }, file)).toBe(
      `redis://:${PASSWORD}@127.0.0.1:6380/15`,
    );
  });

  it('is the checkout’s .env otherwise, parsed by the services’ loader', () => {
    const file = envFile(`# the stack\nREDIS_URL="redis://:${PASSWORD}@localhost:6379"\n`);
    expect(stackRedisUrl(12, {}, file)).toBe(`redis://:${PASSWORD}@localhost:6379/12`);
  });

  it('is a bare local Redis when neither names one, as in CI', () => {
    expect(stackRedisUrl(14, {}, NO_ENV_FILE)).toBe('redis://127.0.0.1:6379/14');
  });

  it('keeps the address and database when it authenticates as another identity', () => {
    expect(stackRedisUrlAs(`redis://:${PASSWORD}@localhost:6379/13`, 'hostexec-test', 'h')).toBe(
      'redis://hostexec-test:h@localhost:6379/13',
    );
  });
});

describe('the probe’s three outcomes', () => {
  const env = { REDIS_URL: `redis://:${PASSWORD}@127.0.0.1:6379` };
  const answering = (probe: StackRedisProbe) => (): Promise<StackRedisProbe> =>
    Promise.resolve(probe);

  it('runs the suite when the Redis answers, on the stack’s credential', async () => {
    expect(
      await stackRedis(11, { env, envFile: NO_ENV_FILE, probe: answering({ outcome: 'answers' }) }),
    ).toEqual({ available: true, url: `redis://:${PASSWORD}@127.0.0.1:6379/11` });
  });

  it('skips the suite when nothing answers', async () => {
    const absent = answering({ outcome: 'absent', reason: 'ECONNREFUSED' });
    expect((await stackRedis(11, { env, envFile: NO_ENV_FILE, probe: absent })).available).toBe(
      false,
    );
  });

  it('fails the suite by name when the Redis refuses the credential, never echoing it', async () => {
    const refuses = answering({
      outcome: 'refuses',
      reason: 'WRONGPASS invalid username-password pair or user is disabled.',
    });
    const failure = stackRedis(11, { env, envFile: NO_ENV_FILE, probe: refuses });
    await expect(failure).rejects.toThrow(/redis:\/\/127\.0\.0\.1:6379\/11 answers and refuses/);
    await expect(failure).rejects.toThrow(/WRONGPASS/);
    await expect(failure).rejects.not.toThrow(PASSWORD);
  });

  it('names the command that adds a password when REDIS_URL carries none', async () => {
    const refuses = answering({ outcome: 'refuses', reason: 'NOAUTH Authentication required.' });
    await expect(stackRedis(11, { env: {}, envFile: NO_ENV_FILE, probe: refuses })).rejects.toThrow(
      /carries no password: `yarn redis:password`/,
    );
  });
});

describe('what the probe reads off the wire', () => {
  it('answers on +OK then +PONG, and waits for both', () => {
    expect(probeOutcome('+OK\r\n', 2)).toBeUndefined();
    expect(probeOutcome('+OK\r\n+PONG\r\n', 2)).toEqual({ outcome: 'answers' });
    expect(probeOutcome('+PONG\r\n', 1)).toEqual({ outcome: 'answers' });
  });

  it('answers when a credential reaches a Redis that asks for none, as ioredis does', () => {
    const notAskedFor =
      '-ERR AUTH <password> called without any password configured for the default user\r\n';
    expect(probeOutcome(`${notAskedFor}+PONG\r\n`, 2)).toEqual({ outcome: 'answers' });
  });

  it('is refused another password, and no password', () => {
    expect(probeOutcome('-WRONGPASS invalid username-password pair\r\n-NOAUTH x\r\n', 2)).toEqual({
      outcome: 'refuses',
      reason: 'WRONGPASS invalid username-password pair',
    });
    expect(probeOutcome('-NOAUTH Authentication required.\r\n', 1)).toEqual({
      outcome: 'refuses',
      reason: 'NOAUTH Authentication required.',
    });
  });

  it('finds nothing where nothing listens', async () => {
    expect(await probeStackRedis('redis://127.0.0.1:1/15')).toMatchObject({ outcome: 'absent' });
  });
});

/** Answers each command by name, the way a Redis with `requirepass` would. */
function standInRedis(requirePass: string | null): Server {
  return createServer((socket) => {
    let authenticated = requirePass === null;
    let pending = '';
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\r\n');
      let at = 0;
      while (at < lines.length && lines[at]?.startsWith('*')) {
        const count = Number(lines[at]?.slice(1));
        if (lines.length < at + 1 + count * 2 + 1) break;
        const args = Array.from({ length: count }, (_, i) => lines[at + 2 + i * 2] ?? '');
        at += 1 + count * 2;
        if (args[0] === 'AUTH') {
          if (requirePass === null) {
            socket.write('-ERR AUTH <password> called without any password configured\r\n');
          } else if (args.at(-1) === requirePass) {
            authenticated = true;
            socket.write('+OK\r\n');
          } else {
            socket.write('-WRONGPASS invalid username-password pair\r\n');
          }
        } else {
          socket.write(authenticated ? '+PONG\r\n' : '-NOAUTH Authentication required.\r\n');
        }
      }
      pending = lines.slice(at).join('\r\n');
    });
  });
}

describe('the probe, against a stand-in Redis', { tags: ['listener'] }, () => {
  let server: Server | null = null;

  async function listening(requirePass: string | null): Promise<number> {
    const listener = standInRedis(requirePass);
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject).listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = null;
  });

  it('answers with the credential the Redis requires', async () => {
    const port = await listening(PASSWORD);
    expect(await probeStackRedis(`redis://:${PASSWORD}@127.0.0.1:${String(port)}/15`)).toEqual({
      outcome: 'answers',
    });
  });

  it('answers when a credential reaches a Redis that asks for none, as ioredis does', async () => {
    const port = await listening(null);
    expect(await probeStackRedis(`redis://:${PASSWORD}@127.0.0.1:${String(port)}/15`)).toEqual({
      outcome: 'answers',
    });
  });

  it('is refused another password, and no password', async () => {
    const port = await listening(PASSWORD);
    expect(await probeStackRedis(`redis://:other@127.0.0.1:${String(port)}/15`)).toMatchObject({
      outcome: 'refuses',
      reason: expect.stringMatching(/^WRONGPASS/) as unknown,
    });
    expect(await probeStackRedis(`redis://127.0.0.1:${String(port)}/15`)).toMatchObject({
      outcome: 'refuses',
      reason: expect.stringMatching(/^NOAUTH/) as unknown,
    });
  });
});
