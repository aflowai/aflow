/**
 * The development stack's Redis, as an integration suite finds it.
 *
 * Test support, not runtime API: every suite that probes a live Redis reads it
 * here, so they all reach the Redis the stack protects with the credential the
 * stack wrote. The URL is resolved as `dotenv -e .env` resolves it for the
 * services — the shell's `REDIS_URL` first, then the checkout's `.env` — and
 * falls back to a bare local Redis, which is what CI runs.
 *
 * Of the three outcomes only one is a skip. Nothing answering is a machine
 * without Redis. A Redis that answers and refuses the credential is a broken
 * stack, and a suite skipping there would hide its own coverage, so it fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import { connect as connectTcp, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { parse as parseDotenv } from 'dotenv';

// The same depth from `src/testing` and from `dist/testing`.
const CHECKOUT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env');
const BARE_LOCAL_REDIS = 'redis://127.0.0.1:6379';
const PROBE_TIMEOUT_MS = 1000;

export type StackRedisProbe =
  | { outcome: 'answers' }
  | { outcome: 'absent'; reason: string }
  | { outcome: 'refuses'; reason: string };

export interface StackRedis {
  /** False only when nothing answers; a refusal throws instead. */
  available: boolean;
  /** The stack's Redis URL, credential included, on the suite's database. */
  url: string;
}

export interface StackRedisOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  probe?: (url: string) => Promise<StackRedisProbe>;
}

export function stackRedisUrl(
  db: number,
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = CHECKOUT_ENV_FILE,
): string {
  const fromFile = existsSync(envFile)
    ? parseDotenv(readFileSync(envFile))['REDIS_URL']
    : undefined;
  const url = new URL(env['REDIS_URL'] || fromFile || BARE_LOCAL_REDIS);
  url.pathname = `/${String(db)}`;
  return url.toString();
}

/** The same Redis and database, authenticating as another identity. */
export function stackRedisUrlAs(url: string, username: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(username);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

function withoutCredential(url: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function resp(args: string[]): string {
  return `*${String(args.length)}\r\n${args
    .map((arg) => `$${String(Buffer.byteLength(arg))}\r\n${arg}\r\n`)
    .join('')}`;
}

// What ioredis itself accepts from an AUTH sent to a Redis that asks for none.
const PASSWORD_NOT_ASKED_FOR = /no password is set|without any password configured/;

/**
 * The outcome the replies read so far amount to, or undefined until all
 * `expected` have arrived. Each command the probe sends answers in one line.
 */
export function probeOutcome(received: string, expected: number): StackRedisProbe | undefined {
  const replies = received.split('\r\n').slice(0, -1);
  if (replies.length < expected) return undefined;
  const refusal = replies.find(
    (reply) => reply.startsWith('-') && !PASSWORD_NOT_ASKED_FOR.test(reply),
  );
  if (refusal !== undefined) return { outcome: 'refuses', reason: refusal.slice(1) };
  const last = replies[expected - 1] ?? '';
  return last === '+PONG'
    ? { outcome: 'answers' }
    : { outcome: 'refuses', reason: `PING answered ${last}` };
}

/** AUTH with the URL's credential, then PING, over one connection. */
export function probeStackRedis(url: string): Promise<StackRedisProbe> {
  const target = new URL(url);
  const commands: string[][] = [];
  if (target.password !== '') {
    const password = decodeURIComponent(target.password);
    commands.push(
      target.username === ''
        ? ['AUTH', password]
        : ['AUTH', decodeURIComponent(target.username), password],
    );
  }
  commands.push(['PING']);

  return new Promise((settle) => {
    let settled = false;
    const host = target.hostname || '127.0.0.1';
    const port = Number(target.port || 6379);
    const send = (): void => {
      socket.write(commands.map(resp).join(''));
    };
    const socket: Socket =
      target.protocol === 'rediss:'
        ? connectTls({ host, port, servername: host }, send)
        : connectTcp({ host, port }, send);
    const finish = (probe: StackRedisProbe): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      settle(probe);
    };

    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      const outcome = probeOutcome(received, commands.length);
      if (outcome !== undefined) finish(outcome);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish({ outcome: 'absent', reason: err.code ?? err.message });
    });
    socket.on('close', () => {
      finish({ outcome: 'absent', reason: 'closed without replying' });
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      finish({ outcome: 'absent', reason: `no reply in ${String(PROBE_TIMEOUT_MS)} ms` });
    });
  });
}

/**
 * The stack's Redis on database `db`: available when it answers, unavailable
 * when nothing does, and an error naming the refusal when it refuses the
 * credential `REDIS_URL` carries.
 */
export async function stackRedis(db: number, options: StackRedisOptions = {}): Promise<StackRedis> {
  const url = stackRedisUrl(db, options.env, options.envFile);
  const probe = await (options.probe ?? probeStackRedis)(url);
  if (probe.outcome === 'refuses') {
    const remedy =
      new URL(url).password === ''
        ? 'REDIS_URL carries no password: `yarn redis:password` writes one into .env.'
        : 'REDIS_URL — the shell’s, else the one in .env — has to carry the password that Redis was started with.';
    throw new Error(
      `The Redis at ${withoutCredential(url)} answers and refuses the credential REDIS_URL ` +
        `carries (${probe.reason}). A credential the stack wrote that a test cannot use is a ` +
        `defect, so this suite fails rather than skipping. ${remedy}`,
    );
  }
  return { available: probe.outcome === 'answers', url };
}
