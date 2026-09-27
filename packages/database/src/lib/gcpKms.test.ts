/**
 * Moving the master key into Cloud KMS is a migration, not a switch: values
 * already stored were wrapped by the local key and KMS cannot read those bytes
 * at all. These tests drive that crossover — new writes go to KMS, everything
 * already stored keeps decrypting, and the rewrap predicate can tell the two
 * apart — against a fake KMS client, so no cloud call is made.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { GcpKmsProvider, getGcpKmsConfig } from './gcpKms.js';
import { LocalKmsProvider, MigratingKmsProvider, setKmsProvider, resetKmsProvider } from './kms.js';
import {
  encryptCredentialEnvelope,
  decryptCredentialAsync,
  credentialNeedsRewrap,
} from './credentials.js';

const KEY_PATH = 'projects/aflowai/locations/europe-west3/keyRings/phoenix/cryptoKeys/credentials';
const LOCAL_KEY = randomBytes(32);
const SECRET = 'sk-live-not-a-real-credential';

/**
 * Stands in for Cloud KMS. Uses a distinct algorithm and a wire format the
 * local provider cannot parse, so a test that routes to the wrong provider
 * fails rather than quietly succeeding.
 */
function fakeKmsClient() {
  const kek = randomBytes(32);
  return {
    calls: { encrypt: 0, decrypt: 0 },
    cryptoKeyPath: (p: string, l: string, r: string, k: string) =>
      `projects/${p}/locations/${l}/keyRings/${r}/cryptoKeys/${k}`,
    encrypt(req: { name: string; plaintext: Buffer }) {
      this.calls.encrypt++;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', kek, iv);
      const body = Buffer.concat([c.update(req.plaintext), c.final()]);
      return Promise.resolve([
        { ciphertext: Buffer.concat([Buffer.from('KMS1'), iv, c.getAuthTag(), body]) },
      ]);
    },
    decrypt(req: { name: string; ciphertext: Buffer }) {
      this.calls.decrypt++;
      const raw = req.ciphertext;
      if (raw.subarray(0, 4).toString() !== 'KMS1') {
        return Promise.reject(new Error('not a KMS ciphertext'));
      }
      const d = createDecipheriv('aes-256-gcm', kek, raw.subarray(4, 16));
      d.setAuthTag(raw.subarray(16, 32));
      return Promise.resolve([
        { plaintext: Buffer.concat([d.update(raw.subarray(32)), d.final()]) },
      ]);
    },
  };
}

type FakeClient = ReturnType<typeof fakeKmsClient>;

function gcpProvider(client: FakeClient): GcpKmsProvider {
  return new GcpKmsProvider(
    {
      projectId: 'aflowai',
      location: 'europe-west3',
      keyRing: 'phoenix',
      cryptoKey: 'credentials',
    },
    client as unknown as ConstructorParameters<typeof GcpKmsProvider>[1],
  );
}

describe('getGcpKmsConfig', () => {
  it('is absent until a key is configured', () => {
    expect(getGcpKmsConfig({})).toBeNull();
    expect(getGcpKmsConfig({ CREDENTIAL_KMS_KEY: '  ' })).toBeNull();
  });

  it('parses a crypto-key resource name', () => {
    expect(getGcpKmsConfig({ CREDENTIAL_KMS_KEY: KEY_PATH })).toEqual({
      projectId: 'aflowai',
      location: 'europe-west3',
      keyRing: 'phoenix',
      cryptoKey: 'credentials',
    });
  });

  it('rejects a shape that would silently address the wrong key', () => {
    for (const bad of [
      'phoenix/credentials',
      'projects/p/locations/l/keyRings/r',
      `${KEY_PATH}/cryptoKeyVersions/3`,
      'projects//locations/l/keyRings/r/cryptoKeys/k',
    ]) {
      expect(() => getGcpKmsConfig({ CREDENTIAL_KMS_KEY: bad })).toThrow(/resource name/);
    }
  });
});

describe('GcpKmsProvider', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = fakeKmsClient();
  });

  it('round-trips a data-encryption key without exposing key material', async () => {
    const provider = gcpProvider(client);
    const dek = randomBytes(32);

    const wrapped = await provider.wrapKey(dek);
    expect(wrapped.equals(dek)).toBe(false);
    expect((await provider.unwrapKey(wrapped, provider.currentKeyId())).equals(dek)).toBe(true);
  });

  it('names the crypto key, not a version, so KMS-side rotation needs no rewrap', () => {
    expect(gcpProvider(client).currentKeyId()).toBe(KEY_PATH);
  });

  it('explains a mismatch instead of surfacing an opaque API error', async () => {
    const provider = gcpProvider(client);
    await expect(provider.unwrapKey(Buffer.from('x'), 'local:abc123')).rejects.toThrow(
      /wrapped by "local:abc123"/,
    );
    expect(client.calls.decrypt).toBe(0);
  });
});

describe('migrating from the local key to Cloud KMS', () => {
  let client: FakeClient;
  let writtenLocally: string;
  let legacyEnvelope: string;

  beforeEach(async () => {
    client = fakeKmsClient();

    // Everything stored before the migration.
    resetKmsProvider();
    setKmsProvider(new LocalKmsProvider(LOCAL_KEY));
    writtenLocally = await encryptCredentialEnvelope(SECRET);

    const packed = JSON.parse(
      Buffer.from(writtenLocally.slice(5), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    delete packed['kid'];
    legacyEnvelope = 'env1:' + Buffer.from(JSON.stringify(packed)).toString('base64');

    // The crossover state: KMS wraps, the local key still unwraps.
    resetKmsProvider();
    setKmsProvider(new MigratingKmsProvider(gcpProvider(client), new LocalKmsProvider(LOCAL_KEY)));
  });

  afterEach(() => resetKmsProvider());

  it('writes new credentials through KMS', async () => {
    const fresh = await encryptCredentialEnvelope(SECRET);

    expect(client.calls.encrypt).toBe(1);
    const packed = JSON.parse(Buffer.from(fresh.slice(5), 'base64').toString('utf8')) as {
      kid: string;
    };
    expect(packed.kid).toBe(KEY_PATH);
    await expect(decryptCredentialAsync(fresh)).resolves.toBe(SECRET);
  });

  it('still reads values the local key wrapped', async () => {
    await expect(decryptCredentialAsync(writtenLocally)).resolves.toBe(SECRET);
  });

  it('routes pre-key-id values to the local key rather than to KMS', async () => {
    await expect(decryptCredentialAsync(legacyEnvelope)).resolves.toBe(SECRET);
    // KMS was never asked to read bytes it did not produce.
    expect(client.calls.decrypt).toBe(0);
  });

  it('flags everything not yet wrapped by KMS, and only that', async () => {
    expect(credentialNeedsRewrap(writtenLocally)).toBe(true);
    expect(credentialNeedsRewrap(legacyEnvelope)).toBe(true);

    const rewrapped = await encryptCredentialEnvelope(await decryptCredentialAsync(writtenLocally));
    expect(credentialNeedsRewrap(rewrapped)).toBe(false);
  });

  it('leaves KMS as the only reader once the local key is withdrawn', async () => {
    const rewrapped = await encryptCredentialEnvelope(SECRET);

    resetKmsProvider();
    setKmsProvider(gcpProvider(client));

    await expect(decryptCredentialAsync(rewrapped)).resolves.toBe(SECRET);
    await expect(decryptCredentialAsync(writtenLocally)).rejects.toThrow(/wrapped by "local:/);
  });
});
