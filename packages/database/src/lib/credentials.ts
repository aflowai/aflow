/**
 * Credential encryption/decryption with envelope encryption support.
 *
 * Storage format versions:
 *   - Legacy (v1): base64(iv[12] || authTag[16] || ciphertext)
 *     Master key encrypts data directly. Still supported for decryption.
 *   - Envelope (v2): "env1:" + base64(JSON.stringify({ wdk, iv, at, ct }))
 *     Per-credential DEK wrapped by KMS. Used for all new encryptions.
 *
 * The "env1:" prefix distinguishes envelope-encrypted values from legacy ones.
 * Decryption auto-detects the format and handles both transparently.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import {
  getKmsProvider,
  envelopeEncrypt,
  envelopeDecrypt,
  type EnvelopeEncryptResult,
} from './kms.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENVELOPE_PREFIX = 'env1:';
/** Adds the id of the wrapping key, so a stored value can be re-wrapped later. */
const ENVELOPE_V2_PREFIX = 'env2:';

let cachedLegacyKey: Buffer | null = null;

function getLegacyEncryptionKey(): Buffer {
  if (cachedLegacyKey) return cachedLegacyKey;

  const envKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (envKey) {
    const keyBuffer = Buffer.from(envKey, 'base64');
    if (keyBuffer.length !== 32) {
      throw new Error(
        `CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (base64-encoded). Got ${String(keyBuffer.length)} bytes.`,
      );
    }
    cachedLegacyKey = keyBuffer;
    return cachedLegacyKey;
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is required in production. ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  cachedLegacyKey = createHash('sha256')
    .update('phoenix-dev-credential-key-not-for-production')
    .digest();
  return cachedLegacyKey;
}

/**
 * Encrypt a credential value using envelope encryption.
 *
 * Writes the `env2:` form, which records which key wrapped the DEK. Without
 * that, a master key can never be replaced: nothing can tell which stored
 * values still need re-wrapping, so a rotation cannot be resumed, verified,
 * or finished.
 */
export async function encryptCredentialEnvelope(plaintext: string): Promise<string> {
  const kms = getKmsProvider();
  const envelope = await envelopeEncrypt(kms, plaintext);
  const packed = JSON.stringify({
    kid: envelope.keyId,
    wdk: envelope.wrappedDek,
    iv: envelope.iv,
    at: envelope.authTag,
    ct: envelope.ciphertext,
  });
  return ENVELOPE_V2_PREFIX + Buffer.from(packed).toString('base64');
}

/**
 * Encrypt a credential value (synchronous, legacy v1 format).
 * Kept for backward compatibility. New code should prefer encryptCredentialEnvelope().
 */
export function encryptCredential(plaintext: string): string {
  const key = getLegacyEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypt a credential value. Auto-detects format:
 *   - "env1:..." → envelope decryption (v2, async KMS unwrap)
 *   - otherwise  → legacy direct decryption (v1)
 */
export async function decryptCredentialAsync(encryptedValue: string): Promise<string> {
  const prefix = encryptedValue.startsWith(ENVELOPE_V2_PREFIX)
    ? ENVELOPE_V2_PREFIX
    : encryptedValue.startsWith(ENVELOPE_PREFIX)
      ? ENVELOPE_PREFIX
      : null;

  if (prefix) {
    const packed = Buffer.from(encryptedValue.slice(prefix.length), 'base64').toString('utf8');
    const { kid, wdk, iv, at, ct } = JSON.parse(packed) as {
      kid?: string;
      wdk: string;
      iv: string;
      at: string;
      ct: string;
    };
    // `env1:` carries no key id; it was wrapped by whatever key was current
    // at the time, which is what the provider falls back to.
    const envelope: EnvelopeEncryptResult = {
      wrappedDek: wdk,
      iv,
      authTag: at,
      ciphertext: ct,
      ...(kid !== undefined ? { keyId: kid } : {}),
    };
    const kms = getKmsProvider();
    return envelopeDecrypt(kms, envelope);
  }

  return decryptCredential(encryptedValue);
}

/**
 * Whether a stored value should be re-encrypted — because it predates
 * envelope encryption, predates key ids, or was wrapped by a key that is no
 * longer current. This is the predicate a rewrap job iterates on, and it is
 * what makes a rotation resumable: it stays true until the value is migrated,
 * whatever happened in between.
 */
export function credentialNeedsRewrap(encryptedValue: string): boolean {
  if (!encryptedValue.startsWith(ENVELOPE_V2_PREFIX)) return true;

  try {
    const packed = Buffer.from(encryptedValue.slice(ENVELOPE_V2_PREFIX.length), 'base64').toString(
      'utf8',
    );
    const { kid } = JSON.parse(packed) as { kid?: string };
    return kid !== getKmsProvider().currentKeyId();
  } catch {
    // Unreadable is not "already migrated" — surface it by asking for a rewrap.
    return true;
  }
}

/**
 * Decrypt a credential value (synchronous, legacy v1 only).
 * Kept for backward compatibility.
 */
export function decryptCredential(encryptedBase64: string): string {
  const key = getLegacyEncryptionKey();
  const combined = Buffer.from(encryptedBase64, 'base64');

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted credential: too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Reset the cached encryption key (for testing).
 */
export function resetEncryptionKeyCache(): void {
  cachedLegacyKey = null;
}
