/**
 * The credential an operator carries to their own terminal.
 *
 * Connecting a folder used to be authorised by `PHOENIX_INSTANCE_SECRET`, which
 * authenticates as the edition owner for every call this API has. The workspace
 * told the operator to read it out of the container and interpolate it into a
 * shell command, so a one-folder operation cost them their master credential,
 * left in scrollback and shell history. The usability complaint and the security
 * one are the same sentence: what is handed out should be able to do the one
 * thing it is for.
 *
 * A connect token can pair a machine and attach folders to the space that minted
 * it. It expires in minutes, survives one redemption, and is worth nothing
 * afterwards. It does not weaken the two halves — it authorises *asking*, and the
 * operator still answers on their own machine, where the folder and the consent
 * both live.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { getRedisConnection } from '@aflow/redis';
import type { TenantId } from '@aflow/schemas';

/** Long enough that guessing is hopeless, short enough to read off a screen. */
const CODE_BYTES = 10;
const TOKEN_TTL_SECONDS = 15 * 60;

export interface ConnectTokenGrant {
  readonly tenantId: TenantId;
  readonly spaceId: string;
  readonly spaceSlug: string;
}

/**
 * Crockford base32 without the letters that read as digits, grouped for
 * transcription. An operator reads this off one screen and types it into
 * another; `0`/`O` and `1`/`I` are where that goes wrong.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte % ALPHABET.length);
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Stored hashed, so a Redis dump is not a list of usable tokens. */
function keyFor(code: string): string {
  const digest = createHash('sha256').update(normalize(code)).digest('hex');
  return `aflow:host-connect-token:${digest}`;
}

/** Case and grouping are presentation; the operator should not have to match them. */
export function normalize(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, '');
}

export async function mintConnectToken(
  grant: ConnectTokenGrant,
): Promise<{ code: string; expiresAt: string }> {
  const code = encode(randomBytes(CODE_BYTES));
  await getRedisConnection().setex(keyFor(code), TOKEN_TTL_SECONDS, JSON.stringify(grant));
  return {
    code,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Consume a token, or refuse. Deleted before the caller acts on it, so two
 * redemptions of the same code cannot both succeed — the delete's own return
 * value is what decides the race, rather than a read followed by a write.
 */
export async function redeemConnectToken(code: string): Promise<ConnectTokenGrant | null> {
  if (normalize(code).length !== CODE_BYTES) return null;
  const redis = getRedisConnection();
  const key = keyFor(code);
  const stored = await redis.get(key);
  if (stored === null) return null;
  const consumed = await redis.del(key);
  if (consumed !== 1) return null;
  try {
    return JSON.parse(stored) as ConnectTokenGrant;
  } catch {
    return null;
  }
}

/** Exported for the guard test that keeps the comparison constant-time. */
export function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(normalize(a));
  const right = Buffer.from(normalize(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
