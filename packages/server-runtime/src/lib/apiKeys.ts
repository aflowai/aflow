import { createHash, randomBytes } from 'crypto';

export const API_KEY_PREFIX = 'phx_';

/**
 * SHA-256 hash a plaintext API key to match against `api_keys.key_hash`.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export interface MintedApiKey {
  /** Full key — shown to the caller exactly once, never stored. */
  plaintext: string;
  /** SHA-256 hex digest stored in `api_keys.key_hash`. */
  keyHash: string;
  /** First 12 chars of the plaintext, stored for display/lookup. */
  keyPrefix: string;
}

export function mintApiKey(): MintedApiKey {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, 12),
  };
}
