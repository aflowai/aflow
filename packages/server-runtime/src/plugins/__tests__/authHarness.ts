/**
 * The shared harness for the authentication request path.
 *
 * The tests drive the real plugin against a real Fastify instance rather than
 * inspecting the options object, because what matters is what the verifier
 * accepts, not what it was configured with. The JWKS endpoint is served from a
 * key pair minted in-process, and tokens are assembled with `crypto` rather
 * than a JWT library so the suites can produce shapes a library would refuse
 * to emit — an HS256 token bearing a real signing key's `kid`, chiefly.
 *
 * `appContext` is wired with no database on purpose. It makes the two outcomes
 * separable without any infrastructure: a token that fails verification is a
 * 401, and a token that passes it reaches identity resolution and fails there
 * with a 503. Asserting only on 401s would pass just as well against a
 * verifier that rejected everything.
 */
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, vi } from 'vitest';

import type { IdentityPlane } from '../../compose/tokenVerification.js';
import { authPlugin } from '../auth.js';
import { editionPlugin } from '../edition.js';

export const DOMAIN = 'tenant.eu.auth0.com';
export const ISSUER = `https://${DOMAIN}/`;
export const AUDIENCE = 'https://api.example.com';
export const JWKS_PATH = /^https:\/\/[^/]+\/\.well-known\/jwks\.json$/;
export const KID = 'signing-key-1';

/** Verification passed and the request reached identity resolution. */
export const VERIFIED = 503;
/** Verification failed. */
export const REJECTED = 401;

export const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  API_BASE_URL: 'https://api.example.com',
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

/**
 * Variables `buildServer` owns: applying an environment sets exactly these and
 * deletes the rest, so a test's configuration is what it declares rather than
 * what the process happened to inherit.
 *
 * A provider's own variables are not here. The suite that drives one adds them
 * through `installAuthTestLifecycle`, which keeps this harness free of any
 * provider's configuration while preserving the property for both.
 */
const CORE_ENV_KEYS = [
  'NODE_ENV',
  'API_BASE_URL',
  'CREDENTIAL_ENCRYPTION_KEY',
  'CREDENTIAL_KMS_KEY',
  'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS',
  'JWT_SECRET',
  'DEFAULT_TENANT_ID',
] as const;

let managedKeys: readonly string[] = CORE_ENV_KEYS;

// ---------------------------------------------------------------------------
// Token minting
// ---------------------------------------------------------------------------

function base64url(value: string | Buffer): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');
}

export function signingInput(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
}

export function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'auth0|subject',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

export function mintRs256(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
  const input = signingInput({ alg: 'RS256', typ: 'JWT', kid: KID }, payload);
  const signature = createSign('RSA-SHA256').update(input).end().sign(key);
  return `${input}.${base64url(signature)}`;
}

export function mintHs256(
  payload: Record<string, unknown>,
  secret: string | Buffer,
  kid?: string,
): string {
  const header =
    kid === undefined ? { alg: 'HS256', typ: 'JWT' } : { alg: 'HS256', typ: 'JWT', kid };
  const input = signingInput(header, payload);
  return `${input}.${base64url(createHmac('sha256', secret).update(input).digest())}`;
}

/** The PEM an alg-confusion attacker reads straight out of the public JWKS. */
export function publishedKeyAsPem(): string {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

export function jwksDocument(): string {
  return JSON.stringify({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }],
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const openServers: FastifyInstance[] = [];
let savedEnv: Record<string, string | undefined> = {};

function applyEnv(env: Record<string, string>): void {
  for (const key of managedKeys) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function buildServer(
  env: Record<string, string>,
  identityPlane?: IdentityPlane,
): Promise<FastifyInstance> {
  applyEnv(env);

  const app = Fastify({ logger: false });
  app.decorate('appContext', {
    db: null,
    sql: null,
    redis: null,
    payloadStore: null,
    pubsubPublisher: null,
    pubsubSubscriber: null,
    redisUrl: null,
    isMock: true,
  });
  openServers.push(app);

  await app.register(editionPlugin);
  await app.register(authPlugin, { identityPlane });
  app.get(
    '/protected',
    { preHandler: (request, reply) => app.authenticate(request, reply) },
    async (request) => ({ authMethod: request.authUser?.authMethod ?? null }),
  );
  await app.ready();
  return app;
}

export function get(app: FastifyInstance, token?: string) {
  return app.inject({
    method: 'GET',
    url: '/protected',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

/**
 * Saves and restores every variable the harness writes, and closes its servers.
 *
 * `alsoManage` names a provider's own variables, so a suite driving one gets
 * the same declare-exactly-this property for them.
 */
export function installAuthTestLifecycle(alsoManage: readonly string[] = []): void {
  managedKeys = [...CORE_ENV_KEYS, ...alsoManage];
  beforeEach(() => {
    savedEnv = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((app) => app.close()));
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
