/**
 * Cloud KMS-backed DEK wrapping.
 *
 * The local provider holds the master key in process memory, which means an
 * environment dump, a heap snapshot, or a leaked secret hands over every
 * credential ever encrypted — including the ones in backups — permanently and
 * silently. Here the key material never leaves KMS: this process can only ask
 * KMS to wrap and unwrap, and that ability is granted by IAM, recorded in
 * Cloud Audit Logs, and revocable in seconds without re-encrypting anything.
 *
 * It does not stop code running inside this process from decrypting what it is
 * entitled to decrypt — nothing short of moving decryption out of the process
 * does that. What it removes is the *stolen key* failure mode.
 */
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { KmsProvider } from './kms.js';

export interface GcpKmsConfig {
  projectId: string;
  location: string;
  keyRing: string;
  cryptoKey: string;
}

/**
 * Reads the crypto-key path from the environment.
 *
 * Accepts the full resource name so the value can be pasted straight from the
 * console. A `cryptoKeyVersions/<n>` suffix is rejected rather than tolerated:
 * symmetric encryption addresses the key and lets KMS choose the primary
 * version, so a pinned version would silently not mean what it appears to.
 */
export function getGcpKmsConfig(env: NodeJS.ProcessEnv = process.env): GcpKmsConfig | null {
  const resource = env['CREDENTIAL_KMS_KEY']?.trim();
  if (!resource) return null;

  const match =
    /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)$/.exec(
      resource,
    );
  if (!match) {
    throw new Error(
      'CREDENTIAL_KMS_KEY must be a crypto-key resource name: ' +
        'projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>',
    );
  }

  // The regex has four capture groups and matched, so all four are present.
  return {
    projectId: match[1]!,
    location: match[2]!,
    keyRing: match[3]!,
    cryptoKey: match[4]!,
  };
}

export class GcpKmsProvider implements KmsProvider {
  private readonly client: KeyManagementServiceClient;
  private readonly keyName: string;

  constructor(config: GcpKmsConfig, client?: KeyManagementServiceClient) {
    this.client = client ?? new KeyManagementServiceClient();
    this.keyName = this.client.cryptoKeyPath(
      config.projectId,
      config.location,
      config.keyRing,
      config.cryptoKey,
    );
  }

  /**
   * The crypto key, not a specific version. KMS picks the primary version when
   * wrapping and reads the version out of the ciphertext when unwrapping, so
   * rotating the KEK inside KMS needs no change here — the envelope's recorded
   * id stays valid across those rotations, and only a move to a *different*
   * key requires a rewrap.
   */
  currentKeyId(): string {
    return this.keyName;
  }

  async wrapKey(dek: Buffer): Promise<Buffer> {
    const [result] = await this.client.encrypt({ name: this.keyName, plaintext: dek });
    if (!result.ciphertext) {
      throw new Error('Cloud KMS returned no ciphertext when wrapping a data-encryption key');
    }
    return Buffer.from(result.ciphertext as Uint8Array);
  }

  async unwrapKey(wrappedDek: Buffer, keyId?: string): Promise<Buffer> {
    // A mismatch means the value was wrapped by a different crypto key, which
    // this provider cannot reach. Say so rather than surfacing an opaque
    // permission or decode error from the API.
    if (keyId !== undefined && keyId !== this.keyName) {
      throw new Error(
        `Credential was wrapped by "${keyId}", but this process is configured for "${this.keyName}". ` +
          'Point CREDENTIAL_KMS_KEY at the original key to rewrap it.',
      );
    }

    const [result] = await this.client.decrypt({ name: this.keyName, ciphertext: wrappedDek });
    if (!result.plaintext) {
      throw new Error('Cloud KMS returned no plaintext when unwrapping a data-encryption key');
    }
    return Buffer.from(result.plaintext as Uint8Array);
  }
}
