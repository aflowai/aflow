/**
 * Startup invariant: a production process must never fall back to a
 * development security posture.
 *
 * These values are checked eagerly at boot rather than lazily at first use so
 * a misconfigured deployment fails the rollout instead of serving traffic with
 * a symmetric dev token secret or an unencryptable credential store.
 */
import { getGcpKmsConfig } from '@aflow/database';

import type { IdentityPlane } from '../compose/tokenVerification.js';
import { resolveEditionDescriptor } from '@aflow/schemas';
import { canonicalApiOrigin } from './apiBaseUrl.js';

export interface SecurityConfigViolation {
  key: string;
  message: string;
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === '';
}

/**
 * The origin the runtime will resolve this value to, or `null` when the value
 * is not a bare origin — which is what every caller appends a fixed path to.
 *
 * `canonicalApiOrigin` is the same reduction `resolveApiBaseUrl` performs, so
 * what is judged here is the string the OAuth redirect and the realtime socket
 * are actually built from, never a raw form that merely resembles it. It
 * reduces a path, a query, a fragment and credentials away rather than
 * refusing them, so those are caught before it: an operator who wrote
 * `https://api.example.com/base` meant every route to sit under `/base`, and
 * silently serving them from the root is not the deployment configured.
 */
function resolveConfiguredOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.pathname !== '/') return null;
  return canonicalApiOrigin(value);
}

/** `URL.hostname` keeps the brackets an IPv6 literal is written with. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * An origin that would carry traffic over a network in the clear. Loopback is
 * exempt: it never reaches one, so TLS on it would protect nothing that is not
 * already inside this process's own host.
 */
function isCleartextNetworkOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname);
}

export function findProductionSecurityViolations(
  env: NodeJS.ProcessEnv = process.env,
  identityPlane?: IdentityPlane,
): SecurityConfigViolation[] {
  if (env['NODE_ENV'] !== 'production') return [];

  const violations: SecurityConfigViolation[] = [];

  // Resolved first, and allowed to throw: an edition that cannot be resolved
  // is not a process whose Auth0 configuration is worth reporting on.
  const edition = resolveEditionDescriptor(env);

  // Asked of the distribution rather than answered here: which provider an
  // edition names is core vocabulary, but what that provider needs is the
  // provider's own. A core build supplies no plane and so reports nothing —
  // correctly, because it has no identity configuration to be missing.
  if (edition.authProvider !== 'local-instance') {
    if (identityPlane) {
      violations.push(...identityPlane.configurationViolations(env));
    } else {
      violations.push({
        key: 'identity provider',
        message:
          `This build composes none, and the edition resolved "${edition.authProvider}". ` +
          'Bearer tokens would be verified with a symmetric development secret. ' +
          'Run the distribution root that supplies a provider, or set PHOENIX_EDITION=community-local.',
      });
    }
  }

  // Both the OAuth redirect URI and the realtime socket URL are built from
  // this. Unset, it falls back to loopback — which is exactly right for an
  // appliance bound to loopback, and unreachable for anything published.
  const apiBaseUrl = env['API_BASE_URL'];
  if (edition.exposure.bind === 'any' && isBlank(apiBaseUrl)) {
    violations.push({
      key: 'API_BASE_URL',
      message:
        'Required. It is the canonical origin this API is reachable at, and both OAuth redirects and the realtime WebSocket URL are derived from it.',
    });
  } else if (!isBlank(apiBaseUrl)) {
    const origin = resolveConfiguredOrigin(apiBaseUrl);
    if (origin === null) {
      // The realtime URL is this origin addressed as a WebSocket, so a value
      // with no scheme, or a scheme that is not HTTP, yields a URL the browser
      // cannot open — and nothing between here and that failure names the
      // variable.
      violations.push({
        key: 'API_BASE_URL',
        message: `Must be an absolute http:// or https:// origin. Received "${apiBaseUrl}".`,
      });
    } else if (edition.exposure.requireTls && isCleartextNetworkOrigin(origin)) {
      // A deployment whose exposure policy requires TLS still advertises this
      // origin verbatim to every browser, and rewrites it to `ws` for the
      // realtime socket, so a cleartext value puts the session on the wire
      // however the terminator in front of it is configured.
      violations.push({
        key: 'API_BASE_URL',
        message: `Must be an https:// origin where the edition requires TLS; this value advertises cleartext API and WebSocket URLs. Received "${apiBaseUrl}".`,
      });
    }
  }

  // What must hold is that some key can wrap a credential, not that a
  // particular one is present — a check naming the local key specifically is
  // what would keep it loaded, and therefore stealable, after KMS has taken
  // over and nothing references it.
  const encryptionKey = env['CREDENTIAL_ENCRYPTION_KEY'];
  const kmsKey = env['CREDENTIAL_KMS_KEY'];
  if (isBlank(encryptionKey) && isBlank(kmsKey)) {
    violations.push({
      key: 'CREDENTIAL_ENCRYPTION_KEY or CREDENTIAL_KMS_KEY',
      message:
        'One is required to wrap tenant credential data-encryption keys. ' +
        'Set CREDENTIAL_KMS_KEY for Cloud KMS, or CREDENTIAL_ENCRYPTION_KEY for a local key.',
    });
  }

  // Checked whenever present, including alongside KMS: during a crossover the
  // local key is what still unwraps everything not yet rewrapped, so a
  // malformed one fails later and selectively rather than at boot.
  if (!isBlank(encryptionKey) && Buffer.from(encryptionKey, 'base64').length !== 32) {
    violations.push({
      key: 'CREDENTIAL_ENCRYPTION_KEY',
      message: 'Must decode from base64 to exactly 32 bytes.',
    });
  }

  // The provider parses this lazily, on the first credential operation, so a
  // malformed value boots and then fails at whichever request happens to touch
  // a credential first. Parsed here with the same function, so the refusal
  // lands at startup where the rest of this contract lives.
  if (!isBlank(kmsKey)) {
    try {
      getGcpKmsConfig(env);
    } catch (err) {
      violations.push({
        key: 'CREDENTIAL_KMS_KEY',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A malformed retired key is dropped when the provider is built, which would
  // turn a rotation into silent decryption failures on exactly the credentials
  // that had not been rewrapped yet. Refuse the rollout instead.
  const previousKeys = env['CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'];
  if (previousKeys !== undefined && previousKeys.trim() !== '') {
    const malformed = previousKeys
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => Buffer.from(entry, 'base64').length !== 32);
    if (malformed.length > 0) {
      violations.push({
        key: 'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS',
        message: `${String(malformed.length)} of the comma-separated keys do not decode to 32 bytes; a rotation would fail to unwrap values still held by them.`,
      });
    }
  }

  return violations;
}

export function assertProductionSecurityConfig(
  identityPlane?: IdentityPlane,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const violations = findProductionSecurityViolations(env, identityPlane);
  if (violations.length === 0) return;

  throw new Error(
    'Refusing to start: production security configuration is incomplete.\n' +
      violations.map((v) => `  - ${v.key}: ${v.message}`).join('\n'),
  );
}
