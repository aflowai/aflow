/**
 * Applying the real host grant to a throwaway identity, and reading back what
 * the server refused.
 *
 * ACL users are server-wide rather than per database, so a suite that applied
 * the grant to `hostexec` would take the credential a paired machine on the
 * same server is authenticating with. Each caller gets a name of its own and
 * reads denials filtered to that name: the log is server-wide too, and a
 * sibling suite's refusals are not this one's evidence.
 */
import { Redis } from 'ioredis';

import { renderRedisAcl } from '../redisAcl.js';

export const HOST_TEST_PASSWORD = 'h'.repeat(48);

/** A name no live identity answers to, and no two test processes share. */
export function hostTestUser(suite: string): string {
  return `hostexec-test-${suite}-${String(process.pid)}`;
}

export async function redisReachable(db: number): Promise<boolean> {
  const probe = new Redis({
    host: '127.0.0.1',
    port: 6379,
    db,
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

/**
 * The rendered ACL line, applied to a running server rather than a config file.
 * `user <name> …` in a file is `ACL SETUSER <name> …` on a live server; the
 * rules are the grant, the name is the caller's.
 */
export async function applyHostGrant(
  admin: Redis,
  username: string,
  rewriteRules: (rules: string[]) => string[] = (rules) => rules,
): Promise<void> {
  const acl = renderRedisAcl({
    defaultPassword: 'd'.repeat(48),
    hostPassword: HOST_TEST_PASSWORD,
  });
  const line = acl.split('\n').find((l) => l.startsWith('user hostexec')) ?? '';
  await admin.call('ACL', 'SETUSER', username, ...rewriteRules(line.split(' ').slice(2)));
}

export function hostGrantUrl(username: string, db: number): string {
  return `redis://${username}:${HOST_TEST_PASSWORD}@127.0.0.1:6379/${String(db)}`;
}

/**
 * What the server refused this identity, as `reason: object` pairs. Naming what
 * was refused is the whole point — a bare count sends the next reader back to
 * `ACL LOG` by hand, which is where these tests came from.
 */
export async function hostGrantDenials(admin: Redis, username: string): Promise<string[]> {
  const log = (await admin.call('ACL', 'LOG')) as unknown[];
  return log
    .map((entry) => {
      // Flat field/value pairs, and not all of the values are strings.
      const flat = entry as unknown[];
      const at = (k: string): string => {
        const value = flat[flat.indexOf(k) + 1];
        return typeof value === 'string' ? value : '';
      };
      return { user: at('username'), text: `${at('reason')}: ${at('object')}` };
    })
    .filter((d) => d.user === username)
    .map((d) => d.text);
}
