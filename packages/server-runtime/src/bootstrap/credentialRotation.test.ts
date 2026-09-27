/**
 * Contract: revoking a host credential actually revokes it, and survives a
 * restart. Both halves failed independently, and each looked like success.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rotateInstanceValue } from './instanceConfig.js';
import { renderRedisAcl } from './redisAcl.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-rot-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the rendered ACL replaces a password rather than adding one', () => {
  it('resets before setting, on both identities', () => {
    // `ACL SETUSER` ADDS a password. Without `resetpass` the previous one stays
    // valid, so a rotation reported success and revoked nothing — confirmed
    // against a live Redis, where the old password still answered afterwards.
    const acl = renderRedisAcl({ defaultPassword: 'dpw', hostPassword: 'hpw' });
    const hostLine = acl.split('\n').find((l) => l.startsWith('user hostexec')) ?? '';
    const defaultLine = acl.split('\n').find((l) => l.startsWith('user default')) ?? '';

    expect(hostLine).toContain('resetpass');
    expect(defaultLine).toContain('resetpass');
    // And the reset must precede the password, or it erases the one just set.
    expect(hostLine.indexOf('resetpass')).toBeLessThan(hostLine.indexOf('>hpw'));
    expect(defaultLine.indexOf('resetpass')).toBeLessThan(defaultLine.indexOf('>dpw'));
  });
});

describe('a rotation survives a restart', () => {
  it('replaces the stored value and leaves the others alone', async () => {
    await writeFile(
      join(dir, 'instance.env'),
      [
        "PHOENIX_INSTANCE_SECRET='keep-me'",
        "PHOENIX_HOST_REDIS_PASSWORD='old-host-pw'",
        "REDIS_PASSWORD='keep-me-too'",
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    await rotateInstanceValue(dir, 'PHOENIX_HOST_REDIS_PASSWORD', 'new-host-pw');

    const after = await readFile(join(dir, 'instance.env'), 'utf8');
    expect(after).toContain('new-host-pw');
    expect(after).not.toContain('old-host-pw');
    // The credential-wrapping key and the instance secret are unrecoverable if
    // lost, so a narrow rotation must not disturb them.
    expect(after).toContain('keep-me');
    expect(after).toContain('keep-me-too');
  });

  it('refuses when there is no instance file, rather than inventing one', async () => {
    // Writing a fresh file here would mean a restart reading a config whose
    // other values were never generated.
    await expect(rotateInstanceValue(dir, 'PHOENIX_HOST_REDIS_PASSWORD', 'x')).rejects.toThrow(
      /nothing to rotate/,
    );
  });

  it('leaves the file readable only by its owner', async () => {
    await writeFile(join(dir, 'instance.env'), "PHOENIX_HOST_REDIS_PASSWORD='a'\n", {
      mode: 0o600,
    });
    await rotateInstanceValue(dir, 'PHOENIX_HOST_REDIS_PASSWORD', 'b');
    const { mode } = await stat(join(dir, 'instance.env'));
    expect(mode & 0o077).toBe(0);
  });
});
