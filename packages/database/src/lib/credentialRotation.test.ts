/**
 * A master key that cannot be rotated is a master key that cannot be responded
 * to. These tests exercise the whole rotation, not just the format change:
 * write under one key, bring up a second, prove old values still decrypt, and
 * prove the rewrap predicate can tell what is left to migrate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptCredentialEnvelope,
  decryptCredentialAsync,
  credentialNeedsRewrap,
} from './credentials.js';
import { LocalKmsProvider, localKeyId, setKmsProvider, resetKmsProvider } from './kms.js';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

const SECRET = 'sk-live-not-a-real-credential';

/** Point the global provider at `current`, still able to unwrap `previous`. */
function useKeys(current: Buffer, previous: Buffer[] = []) {
  resetKmsProvider();
  setKmsProvider(new LocalKmsProvider(current, previous));
}

describe('credential key rotation', () => {
  beforeEach(() => useKeys(KEY_A));
  afterEach(() => resetKmsProvider());

  it('records the wrapping key in the stored value', async () => {
    const stored = await encryptCredentialEnvelope(SECRET);

    expect(stored.startsWith('env2:')).toBe(true);
    const packed = JSON.parse(Buffer.from(stored.slice(5), 'base64').toString('utf8')) as {
      kid: string;
    };
    expect(packed.kid).toBe(localKeyId(KEY_A));
  });

  it('round-trips under the key that wrote it', async () => {
    const stored = await encryptCredentialEnvelope(SECRET);
    await expect(decryptCredentialAsync(stored)).resolves.toBe(SECRET);
  });

  it('names nothing secret in the key id', async () => {
    const id = localKeyId(KEY_A);
    expect(id).toMatch(/^local:[0-9a-f]{16}$/);
    expect(KEY_A.toString('base64')).not.toContain(id.slice(6));
    expect(KEY_A.toString('hex')).not.toContain(id.slice(6));
  });

  // The rotation itself: B becomes current, A is retained for unwrapping only.
  describe('after rotating to a new key', () => {
    let writtenUnderA: string;

    beforeEach(async () => {
      useKeys(KEY_A);
      writtenUnderA = await encryptCredentialEnvelope(SECRET);
      useKeys(KEY_B, [KEY_A]);
    });

    it('still decrypts values written under the old key', async () => {
      await expect(decryptCredentialAsync(writtenUnderA)).resolves.toBe(SECRET);
    });

    it('writes new values under the new key', async () => {
      const fresh = await encryptCredentialEnvelope(SECRET);
      const packed = JSON.parse(Buffer.from(fresh.slice(5), 'base64').toString('utf8')) as {
        kid: string;
      };
      expect(packed.kid).toBe(localKeyId(KEY_B));
    });

    it('flags the old value for rewrap and clears it once rewrapped', async () => {
      expect(credentialNeedsRewrap(writtenUnderA)).toBe(true);

      const rewrapped = await encryptCredentialEnvelope(
        await decryptCredentialAsync(writtenUnderA),
      );

      expect(credentialNeedsRewrap(rewrapped)).toBe(false);
      await expect(decryptCredentialAsync(rewrapped)).resolves.toBe(SECRET);
    });

    it('refuses, rather than silently failing, once the old key is dropped', async () => {
      useKeys(KEY_B);
      await expect(decryptCredentialAsync(writtenUnderA)).rejects.toThrow(
        /CREDENTIAL_ENCRYPTION_KEY_PREVIOUS/,
      );
    });
  });

  describe('values written before key ids existed', () => {
    /** The `env1:` shape: same fields, no `kid`. */
    async function legacyEnvelope(): Promise<string> {
      const stored = await encryptCredentialEnvelope(SECRET);
      const packed = JSON.parse(Buffer.from(stored.slice(5), 'base64').toString('utf8')) as Record<
        string,
        unknown
      >;
      delete packed['kid'];
      return 'env1:' + Buffer.from(JSON.stringify(packed)).toString('base64');
    }

    it('still decrypt under the current key', async () => {
      await expect(decryptCredentialAsync(await legacyEnvelope())).resolves.toBe(SECRET);
    });

    it('are flagged for rewrap', async () => {
      expect(credentialNeedsRewrap(await legacyEnvelope())).toBe(true);
    });
  });

  // Dropping a bad retired key would strand exactly the credentials it still
  // holds, mid-rotation, with nothing pointing at the cause. Every process
  // that wraps or unwraps builds this provider, so it has to refuse here —
  // not only in the one service that validates its own env at boot.
  it('refuses a malformed retired key instead of dropping it', () => {
    expect(() => new LocalKmsProvider(KEY_A, [randomBytes(16)])).toThrow(/32 bytes/);
    expect(() => new LocalKmsProvider(KEY_A, [KEY_B, randomBytes(31)])).toThrow(/32 bytes/);
  });

  it('accepts a well-formed set of retired keys', () => {
    expect(() => new LocalKmsProvider(KEY_A, [KEY_B, randomBytes(32)])).not.toThrow();
  });

  it('treats an unreadable value as needing rewrap rather than as migrated', () => {
    expect(credentialNeedsRewrap('env2:' + Buffer.from('not json').toString('base64'))).toBe(true);
    expect(credentialNeedsRewrap('env2:@@@not-base64@@@')).toBe(true);
    expect(credentialNeedsRewrap('some-legacy-v1-value')).toBe(true);
  });
});
