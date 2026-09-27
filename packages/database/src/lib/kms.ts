/**
 * Key Management Service (KMS) abstraction for envelope encryption.
 *
 * Envelope encryption pattern:
 *   1. Generate a random Data Encryption Key (DEK) per credential
 *   2. Encrypt the credential value with the DEK (AES-256-GCM)
 *   3. Wrap (encrypt) the DEK with a KMS-managed Customer Master Key (CMK)
 *   4. Store: wrappedDek + iv + authTag + ciphertext
 *
 * Decryption reverses the process: unwrap DEK via KMS, then decrypt value.
 *
 * Providers:
 *   - LocalKmsProvider: uses a local AES-256-GCM master key (CREDENTIAL_ENCRYPTION_KEY).
 *     Suitable for dev and small deployments. NOT recommended for high-security production
 *     (key lives in process memory / env var).
 *   - Cloud providers (AWS KMS, GCP KMS, etc.): implement KmsProvider and call the cloud
 *     API for wrap/unwrap. The DEK never leaves the process; only the wrapped form is stored.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { GcpKmsProvider, getGcpKmsConfig } from './gcpKms.js';

// ============================================================================
// KMS Provider Interface
// ============================================================================

export interface KmsProvider {
  /**
   * Identifies the key this provider currently wraps with. Recorded in every
   * envelope so a later reader knows which key to unwrap with — without it,
   * a key can never be replaced, because nothing can tell which ciphertext
   * has already been migrated.
   */
  currentKeyId(): string;

  /** Encrypt (wrap) a DEK. Returns the wrapped key bytes. */
  wrapKey(dek: Buffer): Promise<Buffer>;

  /**
   * Decrypt (unwrap) a wrapped DEK. `keyId` names the key that wrapped it;
   * a provider holding several selects on it. Omitted for envelopes written
   * before key ids were recorded, which the current key wrapped.
   */
  unwrapKey(wrappedDek: Buffer, keyId?: string): Promise<Buffer>;
}

// ============================================================================
// Local KMS Provider (AES-256-GCM master key from env)
// ============================================================================

const LOCAL_WRAP_ALGORITHM = 'aes-256-gcm';
const LOCAL_WRAP_IV_LEN = 12;
const LOCAL_WRAP_TAG_LEN = 16;

/**
 * A stable, non-secret name for a key. Derived from the key itself so two
 * processes given the same key agree without any coordination, and truncated
 * because an envelope only needs to distinguish the handful of keys that can
 * plausibly be in play.
 */
export function localKeyId(masterKey: Buffer): string {
  return `local:${createHash('sha256').update(masterKey).digest('hex').slice(0, 16)}`;
}

export class LocalKmsProvider implements KmsProvider {
  private readonly masterKey: Buffer;
  /**
   * Keys retired but still able to unwrap. Rotation is only possible while
   * both the new and old key are live: the new one wraps, both unwrap, and
   * the old is dropped once nothing references it.
   */
  private readonly previousKeys: Map<string, Buffer>;

  constructor(masterKey: Buffer, previousKeys: readonly Buffer[] = []) {
    if (masterKey.length !== 32) {
      throw new Error(
        `LocalKmsProvider: master key must be 32 bytes, got ${String(masterKey.length)}`,
      );
    }
    this.masterKey = masterKey;
    for (const key of previousKeys) {
      if (key.length !== 32) {
        throw new Error(
          `LocalKmsProvider: retired key must be 32 bytes, got ${String(key.length)}`,
        );
      }
    }
    this.previousKeys = new Map(previousKeys.map((k) => [localKeyId(k), k] as const));
  }

  currentKeyId(): string {
    return localKeyId(this.masterKey);
  }

  async wrapKey(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(LOCAL_WRAP_IV_LEN);
    const cipher = createCipheriv(LOCAL_WRAP_ALGORITHM, this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  async unwrapKey(wrappedDek: Buffer, keyId?: string): Promise<Buffer> {
    if (wrappedDek.length < LOCAL_WRAP_IV_LEN + LOCAL_WRAP_TAG_LEN) {
      throw new Error('Invalid wrapped DEK: too short');
    }

    const key =
      keyId === undefined || keyId === this.currentKeyId()
        ? this.masterKey
        : this.previousKeys.get(keyId);
    if (!key) {
      throw new Error(
        `No key available to unwrap this credential (wrapped by "${keyId ?? 'unknown'}"). ` +
          'Supply it via CREDENTIAL_ENCRYPTION_KEY_PREVIOUS to complete a rotation.',
      );
    }

    const iv = wrappedDek.subarray(0, LOCAL_WRAP_IV_LEN);
    const authTag = wrappedDek.subarray(LOCAL_WRAP_IV_LEN, LOCAL_WRAP_IV_LEN + LOCAL_WRAP_TAG_LEN);
    const ciphertext = wrappedDek.subarray(LOCAL_WRAP_IV_LEN + LOCAL_WRAP_TAG_LEN);
    const decipher = createDecipheriv(LOCAL_WRAP_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

/**
 * Wraps with one provider while still unwrapping with another.
 *
 * Moving to Cloud KMS is not a switch: values already stored were wrapped by
 * the local master key, and KMS cannot read those bytes at all. Both have to
 * be live until a rewrap has worked through them — which the envelope's
 * recorded key id is what makes possible.
 */
export class MigratingKmsProvider implements KmsProvider {
  constructor(
    private readonly primary: KmsProvider,
    private readonly legacy: KmsProvider,
  ) {}

  currentKeyId(): string {
    return this.primary.currentKeyId();
  }

  wrapKey(dek: Buffer): Promise<Buffer> {
    return this.primary.wrapKey(dek);
  }

  unwrapKey(wrappedDek: Buffer, keyId?: string): Promise<Buffer> {
    // An absent id means the value predates key ids, and everything written
    // then was wrapped locally — so it routes to the legacy provider, not the
    // primary, which would fail on bytes it never produced.
    if (keyId !== undefined && keyId === this.primary.currentKeyId()) {
      return this.primary.unwrapKey(wrappedDek, keyId);
    }
    return this.legacy.unwrapKey(wrappedDek, keyId);
  }
}

// ============================================================================
// Envelope Encryption (uses KmsProvider for DEK wrapping)
// ============================================================================

const DATA_ALGORITHM = 'aes-256-gcm';
const DATA_IV_LEN = 12;
const DEK_LEN = 32;

export interface EnvelopeEncryptResult {
  wrappedDek: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  /** Key that wrapped the DEK. Absent on envelopes predating key ids. */
  keyId?: string;
}

/**
 * Encrypt a value using envelope encryption.
 *
 * 1. Generate a fresh random DEK (32 bytes)
 * 2. Encrypt plaintext with DEK (AES-256-GCM)
 * 3. Wrap DEK with KMS provider
 * 4. Return all components as base64 strings
 */
export async function envelopeEncrypt(
  kms: KmsProvider,
  plaintext: string,
): Promise<EnvelopeEncryptResult> {
  const dek = randomBytes(DEK_LEN);

  const iv = randomBytes(DATA_IV_LEN);
  const cipher = createCipheriv(DATA_ALGORITHM, dek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const wrappedDek = await kms.wrapKey(dek);

  return {
    wrappedDek: wrappedDek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    keyId: kms.currentKeyId(),
  };
}

/**
 * Decrypt a value that was encrypted with envelope encryption.
 *
 * 1. Unwrap DEK via KMS provider
 * 2. Decrypt ciphertext with DEK
 */
export async function envelopeDecrypt(
  kms: KmsProvider,
  envelope: EnvelopeEncryptResult,
): Promise<string> {
  const wrappedDek = Buffer.from(envelope.wrappedDek, 'base64');
  const dek = await kms.unwrapKey(wrappedDek, envelope.keyId);

  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = createDecipheriv(DATA_ALGORITHM, dek, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ============================================================================
// Global KMS Provider + Migration Helpers
// ============================================================================

let _kmsProvider: KmsProvider | null = null;

/**
 * Get or create the KMS provider.
 * Uses LocalKmsProvider by default; override via setKmsProvider() for cloud KMS.
 */
export function getKmsProvider(): KmsProvider {
  if (_kmsProvider) return _kmsProvider;

  // Selected by configuration rather than by build: a deployment moves to
  // Cloud KMS by setting CREDENTIAL_KMS_KEY, and the envelope's recorded key
  // id is what lets values written under the local key still be read while a
  // rewrap works through them.
  const gcpConfig = getGcpKmsConfig();
  if (!gcpConfig) {
    _kmsProvider = new LocalKmsProvider(getMasterKey(), getPreviousMasterKeys());
    return _kmsProvider;
  }

  const gcp = new GcpKmsProvider(gcpConfig);
  // Keep the local key readable while stored values still reference it. Once
  // nothing reports needing a rewrap, dropping CREDENTIAL_ENCRYPTION_KEY
  // leaves KMS as the only way to reach any credential.
  const localKey = tryGetMasterKey();
  _kmsProvider = localKey
    ? new MigratingKmsProvider(gcp, new LocalKmsProvider(localKey, getPreviousMasterKeys()))
    : gcp;
  return _kmsProvider;
}

/**
 * Keys that may still appear in stored envelopes but no longer wrap anything.
 * Comma-separated so a rotation can overlap more than one generation if a
 * rewrap is interrupted.
 */
/** The local master key when one is configured, without demanding it. */
function tryGetMasterKey(): Buffer | null {
  const envKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (!envKey) return null;
  return getMasterKey();
}

function getPreviousMasterKeys(): Buffer[] {
  const raw = process.env['CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'];
  if (!raw) return [];

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.map((entry, index) => {
    const key = Buffer.from(entry, 'base64');
    // Dropping a malformed retired key would leave exactly the credentials
    // that key still holds failing to decrypt, mid-rotation, with nothing
    // pointing at the cause. Every process that wraps or unwraps builds this
    // provider, so the check belongs here rather than in one service's boot.
    if (key.length !== 32) {
      throw new Error(
        `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS entry ${String(index + 1)} of ${String(entries.length)} ` +
          `decodes to ${String(key.length)} bytes, expected 32. Credentials wrapped by it would fail to decrypt.`,
      );
    }
    return key;
  });
}

/**
 * Set a custom KMS provider (e.g., cloud KMS).
 * Must be called before any encrypt/decrypt operations.
 */
export function setKmsProvider(provider: KmsProvider): void {
  _kmsProvider = provider;
}

/** Reset KMS provider (for testing). */
export function resetKmsProvider(): void {
  _kmsProvider = null;
}

function getMasterKey(): Buffer {
  const envKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (envKey) {
    const keyBuffer = Buffer.from(envKey, 'base64');
    if (keyBuffer.length !== 32) {
      throw new Error(
        `CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (base64-encoded). Got ${String(keyBuffer.length)} bytes.`,
      );
    }
    return keyBuffer;
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is required in production. ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  return createHash('sha256').update('phoenix-dev-credential-key-not-for-production').digest();
}
