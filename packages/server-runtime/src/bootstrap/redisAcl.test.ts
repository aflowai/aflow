/**
 * Contract: the host grant admits the executor's traffic and nothing else.
 *
 * Pinned as text rather than as behaviour. A real-Redis run is what proved the
 * grant — the control stream, another lane's jobs, the session state hash,
 * `KEYS` and `FLUSHALL` are all refused under it — but that proof belongs to a
 * running server, and what this file protects is the decision: a command or key
 * family appearing here should be something someone chose.
 */
import { describe, expect, it } from 'vitest';

import { renderRedisAcl } from './redisAcl.js';

const acl = renderRedisAcl({
  defaultPassword: 'd'.repeat(32),
  hostPassword: 'h'.repeat(32),
});
const hostLine = acl.split('\n').find((l) => l.startsWith('user hostexec')) ?? '';

describe('redis acl', () => {
  it('gives the appliance services a password where they previously had none', () => {
    // `resetpass` is part of the rule: SETUSER adds a password rather than
    // replacing one, so without it a rotation left the previous credential
    // valid and `/host/revoke` revoked nothing.
    expect(acl).toContain(`user default resetpass on >${'d'.repeat(32)} ~* &* +@all`);
  });

  it('grants the host executor only the key families it touches', () => {
    expect(hostLine).toContain('~aflow:jobs:host');
    expect(hostLine).toContain('~aflow:shard:*:results');
    expect(hostLine).toContain('~aflow:step:*:state');
    expect(hostLine).toContain('~aflow:executor-heartbeat:*');
  });

  it('reaches no other lane, the control stream, or session state', () => {
    // Absence is the assertion: a pattern that would admit these is the bug.
    expect(hostLine).not.toContain('~*');
    expect(hostLine).not.toContain('aflow:control');
    expect(hostLine).not.toContain('aflow:session:');
  });

  it('subtracts the commands whose damage does not depend on a key', () => {
    // `+@all` is granted and then cut back, because the key patterns are what
    // bounds this identity. What has to go is the handful of commands that
    // ignore keys entirely.
    for (const command of [
      '-keys',
      '-scan',
      '-flushall',
      '-flushdb',
      '-config',
      '-acl',
      '-client',
      '-monitor',
      '-replicaof',
    ]) {
      expect(hostLine).toContain(command);
    }
  });

  it('separates the two identities', () => {
    expect(hostLine).toContain('h'.repeat(32));
    expect(hostLine).not.toContain('d'.repeat(32));
  });
});
