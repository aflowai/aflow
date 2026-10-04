/**
 * The development stack's Redis, as `yarn start`'s readiness and the
 * integration suites find it.
 *
 * Test support lives here rather than in `@aflow/redis` because it reads the
 * URL through the stack's own loader (`scripts/stackEnv.mjs`): the shell over
 * `.env`, this machine's password laid in, `REDIS_PASSWORD` over both as
 * `getRedisConfig` lays it — so a suite probes the Redis the services use, with
 * their credential. With no `.env` and no machine password it is the shell's
 * `REDIS_URL`, or a bare local Redis, which is what CI runs.
 *
 * Nothing answering is a machine without Redis, and a URL naming another host
 * or port is not this machine's Redis: both skip. A Redis of this machine's that
 * answers and refuses the credential is a broken stack, and a suite skipping
 * there would hide its own coverage.
 */
import { connect as connectTcp } from 'node:net';
import { dirname, join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REDIS_PORT,
  LOCAL_REDIS_URL,
  REDIS_PASSWORD_KEY,
  REDIS_URL_KEY,
  isMachineRedisUrl,
  loadStackEnv,
  stackEnvPath,
} from './stackEnv.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_TIMEOUT_MS = 1000;
export const ADOPT_PASSWORD_COMMAND = 'yarn redis:password';

/** What ioredis itself accepts from an AUTH sent to a Redis that asks for none. */
const PASSWORD_NOT_ASKED_FOR = /no password is set|without any password configured/;

export function redisUrlWithoutCredentials(url) {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function resp(args) {
  return `*${String(args.length)}\r\n${args
    .map((arg) => `$${String(Buffer.byteLength(arg))}\r\n${arg}\r\n`)
    .join('')}`;
}

/**
 * What the replies read so far amount to, or undefined until all `expected`
 * have arrived. Each command the probe sends answers in one line.
 */
export function probeOutcome(received, expected, authenticated) {
  const replies = received.split('\r\n').slice(0, -1);
  if (replies.length < expected) return undefined;
  const refusal = replies.find(
    (reply) => reply.startsWith('-') && !PASSWORD_NOT_ASKED_FOR.test(reply),
  );
  if (refusal !== undefined) return { outcome: 'refused', reason: refusal.slice(1) };
  const last = replies[expected - 1] ?? '';
  if (last !== '+PONG') return { outcome: 'refused', reason: `PING answered ${last}` };
  return authenticated && replies[0] === '+OK'
    ? { outcome: 'accepted' }
    : { outcome: 'no-password-required' };
}

/**
 * AUTH with `password` (the URL's when not given), then PING, over one
 * connection: `accepted`, `no-password-required`, `refused` with the reply, or
 * `unreachable` when nothing answers.
 */
export function probeRedis(url, password) {
  const target = new URL(url);
  const secret =
    password !== undefined && password !== ''
      ? password
      : target.password === ''
        ? undefined
        : decodeURIComponent(target.password);
  const commands = [];
  if (secret !== undefined) {
    commands.push(
      target.username === ''
        ? ['AUTH', secret]
        : ['AUTH', decodeURIComponent(target.username), secret],
    );
  }
  commands.push(['PING']);

  return new Promise((settle) => {
    let settled = false;
    const host = target.hostname || '127.0.0.1';
    const port = Number(target.port || DEFAULT_REDIS_PORT);
    const send = () => {
      socket.write(commands.map(resp).join(''));
    };
    const socket =
      target.protocol === 'rediss:'
        ? connectTls({ host, port, servername: host }, send)
        : connectTcp({ host, port }, send);
    const finish = (probe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      settle(probe);
    };

    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      const outcome = probeOutcome(received, commands.length, secret !== undefined);
      if (outcome !== undefined) finish(outcome);
    });
    socket.on('error', (err) => {
      finish({ outcome: 'unreachable', reason: err.code ?? err.message });
    });
    socket.on('close', () => {
      finish({ outcome: 'unreachable', reason: 'closed without replying' });
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      finish({ outcome: 'unreachable', reason: `no reply in ${String(PROBE_TIMEOUT_MS)} ms` });
    });
  });
}

/** The URL a stack process connects with, on database `db`, from its resolved environment. */
export function stackRedisUrl(db, env) {
  const url = new URL(env[REDIS_URL_KEY] || LOCAL_REDIS_URL);
  const password = env[REDIS_PASSWORD_KEY];
  if (password !== undefined && password !== '') url.password = encodeURIComponent(password);
  url.pathname = `/${String(db)}`;
  return url.toString();
}

/**
 * The stack's Redis on database `db`: available when it answers, unavailable
 * when nothing does, and an error naming the refusal when it refuses the
 * credential the services would use.
 *
 * Only this machine's own Redis is ever connected to. Some suites empty their
 * database and rewrite ACL users, so a URL naming any other Redis — on another
 * loopback port, as the appliance's is, or a managed one — is unavailable
 * without a connection, and says so.
 */
export async function stackRedis(db, options = {}) {
  const processEnv = options.processEnv ?? process.env;
  const machineFile = options.machineFile ?? stackEnvPath(processEnv);
  const env = loadStackEnv(join(options.repo ?? REPO, '.env'), processEnv, machineFile);
  const url = stackRedisUrl(db, env);
  if (!isMachineRedisUrl(url)) {
    const skipped =
      `${REDIS_URL_KEY} names the Redis at ${new URL(url).host}, not this machine's. The Redis ` +
      "integration suites run only against this machine's own Redis, because some empty their " +
      'database and rewrite ACL users; skipping without connecting.';
    (options.warn ?? console.warn)(skipped);
    return { available: false, url, skipped };
  }
  const probe = await (options.probe ?? probeRedis)(url);
  if (probe.outcome === 'refused') {
    const remedy =
      new URL(url).password === ''
        ? `REDIS_URL carries no password and ${machineFile} does not exist: ` +
          `\`${ADOPT_PASSWORD_COMMAND}\` writes this machine's password and restarts Redis with it.`
        : `The services use this machine's password in ${machineFile}, unless REDIS_URL in ` +
          `.env carries one of its own or REDIS_PASSWORD is set; \`${ADOPT_PASSWORD_COMMAND}\` ` +
          "adopts the machine's password and restarts Redis with it.";
    throw new Error(
      `The Redis at ${redisUrlWithoutCredentials(url)} answers and refuses the credential the ` +
        `stack's services use (${probe.reason}). A credential the stack wrote that a test ` +
        `cannot use is a defect, so this suite fails rather than skipping. ${remedy}`,
    );
  }
  return { available: probe.outcome !== 'unreachable', url };
}
