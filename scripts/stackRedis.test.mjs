import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { probeOutcome, probeRedis, stackRedis, stackRedisUrl } from './stackRedis.mjs';
import { STACK_PASSWORD_KEY, loadStackEnv, withoutRedisPasswordOption } from './stackEnv.mjs';

const MACHINE = 'f3'.repeat(32);
const OWN = 'a1'.repeat(32);

let scratch;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A checkout holding `dotenv` as its `.env` (none when undefined), and a machine file. */
function checkout(dotenv, machinePassword) {
  scratch = mkdtempSync(join(tmpdir(), 'stack-redis-'));
  if (dotenv !== undefined) writeFileSync(join(scratch, '.env'), dotenv);
  const machineFile = join(scratch, 'host', 'stack.env');
  if (machinePassword !== undefined) {
    writeFileSync(join(scratch, 'stack.env'), `${STACK_PASSWORD_KEY}=${machinePassword}\n`);
    return { repo: scratch, machineFile: join(scratch, 'stack.env') };
  }
  return { repo: scratch, machineFile };
}

const answering = (probe) => () => Promise.resolve(probe);

async function urlSeen(processEnv, dotenv, machinePassword, db = 15) {
  const { repo, machineFile } = checkout(dotenv, machinePassword);
  const seen = [];
  await stackRedis(db, {
    processEnv,
    repo,
    machineFile,
    probe: (url) => {
      seen.push(url);
      return Promise.resolve({ outcome: 'accepted' });
    },
  });
  return seen[0];
}

describe('the stack Redis a suite reaches, resolved as the services resolve it', () => {
  it('lays the machine’s password into the checkout’s REDIS_URL', async () => {
    expect(await urlSeen({}, 'REDIS_URL=redis://localhost:6379\n', MACHINE, 12)).toBe(
      `redis://:${MACHINE}@localhost:6379/12`,
    );
  });

  it('reads the shell over .env, as every entry point of the stack does', async () => {
    const shell = { REDIS_URL: 'redis://127.0.0.1:6379' };
    expect(await urlSeen(shell, 'REDIS_URL="redis://localhost:6379"\n', MACHINE)).toBe(
      `redis://:${MACHINE}@127.0.0.1:6379/15`,
    );
    expect(await urlSeen(shell, '# no Redis named here\n', MACHINE)).toBe(
      `redis://:${MACHINE}@127.0.0.1:6379/15`,
    );
  });

  it('keeps a password REDIS_URL carries of its own, which the services would use', async () => {
    expect(await urlSeen({}, `REDIS_URL=redis://:${OWN}@localhost:6379\n`, MACHINE)).toBe(
      `redis://:${OWN}@localhost:6379/15`,
    );
  });

  it('gives a .env setting REDIS_PASSWORD the services’ credential, as the dev runner empties it', async () => {
    const { repo, machineFile } = checkout(
      `REDIS_URL=redis://localhost:6379\nREDIS_PASSWORD=${OWN}\n`,
      MACHINE,
    );
    const services = loadStackEnv(join(repo, '.env'), withoutRedisPasswordOption({}), machineFile);
    expect(services.REDIS_PASSWORD).toBe('');
    const probed = [];
    await stackRedis(15, {
      processEnv: {},
      repo,
      machineFile,
      probe: (url) => {
        probed.push(url);
        return Promise.resolve({ outcome: 'accepted' });
      },
    });
    expect(probed).toEqual([stackRedisUrl(15, services)]);
    expect(probed).toEqual([`redis://:${MACHINE}@localhost:6379/15`]);
  });

  it('gives a shell setting REDIS_PASSWORD the services’ credential too', async () => {
    expect(
      await urlSeen({ REDIS_PASSWORD: OWN }, 'REDIS_URL=redis://localhost:6379\n', MACHINE),
    ).toBe(`redis://:${MACHINE}@localhost:6379/15`);
  });

  it('is the shell’s URL, or a bare local Redis, with no .env and no machine password, as in CI', async () => {
    expect(await urlSeen({ REDIS_URL: 'redis://127.0.0.1:6379' }, undefined, undefined)).toBe(
      'redis://127.0.0.1:6379/15',
    );
    expect(await urlSeen({}, undefined, undefined, 14)).toBe('redis://localhost:6379/14');
  });
});

describe('a suite’s three outcomes', () => {
  function options(probe) {
    const { repo, machineFile } = checkout('REDIS_URL=redis://127.0.0.1:6379\n', MACHINE);
    return { processEnv: {}, repo, machineFile, probe: answering(probe) };
  }

  it('runs when the Redis accepts the credential, or asks for none', async () => {
    expect(await stackRedis(11, options({ outcome: 'accepted' }))).toEqual({
      available: true,
      url: `redis://:${MACHINE}@127.0.0.1:6379/11`,
    });
    expect((await stackRedis(11, options({ outcome: 'no-password-required' }))).available).toBe(
      true,
    );
  });

  it('skips when nothing answers', async () => {
    const absent = options({ outcome: 'unreachable', reason: 'ECONNREFUSED' });
    expect((await stackRedis(11, absent)).available).toBe(false);
  });

  it('fails by name when the Redis refuses the credential, never echoing it', async () => {
    const refused = options({
      outcome: 'refused',
      reason: 'WRONGPASS invalid username-password pair',
    });
    const failure = stackRedis(11, refused);
    await expect(failure).rejects.toThrow(/redis:\/\/127\.0\.0\.1:6379\/11 answers and refuses/);
    await expect(failure).rejects.toThrow(/WRONGPASS/);
    await expect(failure).rejects.toThrow(/yarn redis:password/);
    await expect(failure).rejects.not.toThrow(MACHINE);
  });

  it.each([
    [
      'a managed Redis in .env',
      {},
      'REDIS_URL=rediss://default:secret@managed.example.com:6380\n',
      'managed.example.com:6380',
    ],
    [
      'another host in the shell',
      { REDIS_URL: 'redis://10.0.0.5:6379' },
      'REDIS_URL=redis://localhost:6379\n',
      '10.0.0.5:6379',
    ],
    [
      'the appliance’s Redis on its loopback port',
      { REDIS_URL: 'redis://127.0.0.1:6380' },
      'REDIS_URL=redis://localhost:6379\n',
      '127.0.0.1:6380',
    ],
  ])(
    'never connects to %s, and says the suites run only against this machine’s Redis',
    async (_, processEnv, dotenv, host) => {
      const { repo, machineFile } = checkout(dotenv, MACHINE);
      const probed = [];
      const warned = [];
      const redis = await stackRedis(11, {
        processEnv,
        repo,
        machineFile,
        probe: (url) => {
          probed.push(url);
          return Promise.resolve({ outcome: 'accepted' });
        },
        warn: (message) => warned.push(message),
      });
      expect(probed).toEqual([]);
      expect(redis.available).toBe(false);
      expect(warned).toEqual([redis.skipped]);
      expect(redis.skipped).toContain(`the Redis at ${host}`);
      expect(redis.skipped).toContain("run only against this machine's own Redis");
      expect(redis.skipped).not.toContain('secret');
      expect(redis.skipped).not.toContain(MACHINE);
    },
  );

  it('names the missing machine password when the URL carries none', async () => {
    const { repo, machineFile } = checkout(undefined, undefined);
    const refused = { outcome: 'refused', reason: 'NOAUTH Authentication required.' };
    await expect(
      stackRedis(11, { processEnv: {}, repo, machineFile, probe: answering(refused) }),
    ).rejects.toThrow(/does not exist: `yarn redis:password` writes/);
  });
});

describe('what the probe reads off the wire', () => {
  it('is accepted on +OK then +PONG, and waits for both', () => {
    expect(probeOutcome('+OK\r\n', 2, true)).toBeUndefined();
    expect(probeOutcome('+OK\r\n+PONG\r\n', 2, true)).toEqual({ outcome: 'accepted' });
  });

  it('needs no password where PING answers alone, or AUTH meets a Redis asking for none', () => {
    expect(probeOutcome('+PONG\r\n', 1, false)).toEqual({ outcome: 'no-password-required' });
    const notAskedFor =
      '-ERR AUTH <password> called without any password configured for the default user\r\n';
    expect(probeOutcome(`${notAskedFor}+PONG\r\n`, 2, true)).toEqual({
      outcome: 'no-password-required',
    });
  });

  it('is refused another password, and no password', () => {
    expect(
      probeOutcome('-WRONGPASS invalid username-password pair\r\n-NOAUTH x\r\n', 2, true),
    ).toEqual({
      outcome: 'refused',
      reason: 'WRONGPASS invalid username-password pair',
    });
    expect(probeOutcome('-NOAUTH Authentication required.\r\n', 1, false)).toEqual({
      outcome: 'refused',
      reason: 'NOAUTH Authentication required.',
    });
  });

  it('finds nothing where nothing listens', async () => {
    expect(await probeRedis('redis://127.0.0.1:1/15')).toMatchObject({ outcome: 'unreachable' });
  });
});

/** Answers each command by name, the way a Redis with `requirepass` would. */
function standInRedis(requirePass) {
  return createServer((socket) => {
    let authenticated = requirePass === null;
    let pending = '';
    socket.on('data', (chunk) => {
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
  let server = null;

  async function listening(requirePass) {
    const listener = standInRedis(requirePass);
    server = listener;
    await new Promise((resolve, reject) => {
      listener.once('error', reject).listen(0, '127.0.0.1', resolve);
    });
    return listener.address().port;
  }

  afterEach(async () => {
    await new Promise((resolve) => {
      if (server) {
        server.close(resolve);
      } else {
        resolve(undefined);
      }
    });
    server = null;
  });

  it('is accepted the password the Redis requires', async () => {
    const port = await listening(MACHINE);
    expect(await probeRedis(`redis://:${MACHINE}@127.0.0.1:${String(port)}/15`)).toEqual({
      outcome: 'accepted',
    });
  });

  it('authenticates with a password given beside the URL', async () => {
    const port = await listening(MACHINE);
    expect(await probeRedis(`redis://127.0.0.1:${String(port)}/15`, MACHINE)).toEqual({
      outcome: 'accepted',
    });
  });

  it('needs no password from a Redis started without one', async () => {
    const port = await listening(null);
    expect(await probeRedis(`redis://:${MACHINE}@127.0.0.1:${String(port)}/15`)).toEqual({
      outcome: 'no-password-required',
    });
  });

  it('is refused another password, and no password', async () => {
    const port = await listening(MACHINE);
    expect(await probeRedis(`redis://:other@127.0.0.1:${String(port)}/15`)).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/^WRONGPASS/),
    });
    expect(await probeRedis(`redis://127.0.0.1:${String(port)}/15`)).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/^NOAUTH/),
    });
  });
});
