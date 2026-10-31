/**
 * `yarn channel:slack setup` (Plan 327 D5): gives the Slack channel app what it
 * runs on and prints the code that links one Slack user to it.
 *
 * It writes `~/.aflow/channel-slack.env`, mode 0600, holding:
 *
 * - the Slack bot token and the app-level token for Socket Mode;
 * - a user API key for the instance owner, minted with the instance secret as
 *   `yarn mcp:setup` mints its own, expiring after a year and listed under
 *   Settings → API Keys;
 * - the channel lane's Redis credential, which it also writes into the
 *   platform's `instance.env`, because that credential is what composes the
 *   lane (D1). The stack composes it on its next start.
 *
 * Idempotent: a key the API still accepts is kept, and so is the channel
 * credential. Every run prints a fresh one-time code. Never prints a token, the
 * key, the credential or the secret.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  KEY_EXPIRES_IN_DAYS,
  apiUrlOf,
  editionRefusal,
  existingKeyVerdict,
  missingSecretMessage,
  setupEnv,
  writeAuthFile,
} from '../../../scripts/mcp-local-setup.mjs';
import { parseEnvFile, readEnvFile } from '../../../scripts/stackEnv.mjs';

export const CHANNEL_SLACK_ENV_FILENAME = 'channel-slack.env';
export const CHANNEL_REDIS_PASSWORD_ENV = 'PHOENIX_CHANNEL_REDIS_PASSWORD';
export const KEY_NAME = 'aflow Slack channel';
/** Long enough to walk to the phone, short enough that a code seen in passing goes stale. */
export const LINK_CODE_TTL_MS = 30 * 60 * 1000;
/** Crockford base32: no I, L, O or U, so a code read off a screen is typed right. */
const LINK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function channelSlackDirOf(env) {
  const named = env['AFLOW_CHANNEL_SLACK_DIR']?.trim();
  return named !== undefined && named !== '' ? named : join(homedir(), '.aflow');
}

/** Eight characters shown as two groups of four. */
export function newLinkCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The hash the app compares a direct message against, by the app's own normalisation. */
export function linkCodeSha256(code) {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

/** The stack's Redis address with its credentials removed: the app presents its own. */
export function channelRedisUrlOf(env) {
  const configured = env['REDIS_URL']?.trim();
  const url = new URL(
    configured === undefined || configured === '' ? 'redis://127.0.0.1:6379' : configured,
  );
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/$/, '');
}

export function isBotToken(value) {
  return typeof value === 'string' && value.startsWith('xoxb-');
}

export function isAppToken(value) {
  return typeof value === 'string' && value.startsWith('xapp-');
}

/**
 * `instance.env` with the channel credential appended, or undefined when it
 * already holds one. Appended rather than rewritten, so nothing else in the
 * file the platform's secrets live in is touched.
 */
export function instanceWithChannelCredential(instanceText, password) {
  const existing = parseEnvFile(instanceText)[CHANNEL_REDIS_PASSWORD_ENV]?.trim();
  if (existing !== undefined && existing !== '') return undefined;
  const separator = instanceText === '' || instanceText.endsWith('\n') ? '' : '\n';
  return `${separator}${CHANNEL_REDIS_PASSWORD_ENV}='${password}'\n`;
}

/** Shell-quoted lines, as `instance.env` is written. */
export function serializeChannelSlackEnv(values) {
  return `${Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}='${String(value).replace(/'/g, "'\\''")}'`)
    .join('\n')}\n`;
}

/** The key owner's user and tenant from `GET /v1/users/me`. */
export function ownerOf(me) {
  const tenants = Array.isArray(me?.tenants) ? me.tenants : [];
  const tenant = tenants.find((t) => t.status === 'active') ?? tenants[0];
  const userId = me?.user?.userId;
  if (tenant === undefined || typeof userId !== 'string') {
    throw new Stop('The key authenticates, but its owner has no user id or no tenant.');
  }
  return { userId, tenantId: tenant.tenantId };
}

export class Stop extends Error {}
const stop = (message) => {
  throw new Stop(message);
};

const say = (message) => {
  console.log(`\x1b[36m[channel:slack setup]\x1b[0m ${message}`);
};

async function call(api, path, { bearer, body }) {
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function ask(question) {
  if (process.stdin.isTTY !== true) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

async function slackToken(env, existing, key, accepts, question, shape) {
  const value = env[key]?.trim() || existing[key] || (await ask(question));
  if (!accepts(value)) {
    stop(
      `No ${shape} for ${key}. Set ${key} in the environment, or run this in a terminal to be asked. ` +
        "The Help page's article on reaching Aflow from Slack says where Slack shows it.",
    );
  }
  return value;
}

/** A key for the instance owner: the one the file holds while the API accepts it, else a new one. */
async function ownerKey(api, env, existing, instanceFile) {
  const held = existing['AFLOW_API_KEY'];
  if (held !== undefined && held !== '') {
    const me = await call(api, '/v1/users/me', { bearer: held });
    const verdict = existingKeyVerdict(me.status);
    if (verdict === 'keep') {
      return {
        key: held,
        expiresAt: existing['AFLOW_API_KEY_EXPIRES_AT'],
        me: me.body,
        minted: false,
      };
    }
    if (verdict === 'undecided') {
      stop(
        `The API answered ${String(me.status)} when asked about the channel's key; check its log and run this again.`,
      );
    }
    say('the API no longer accepts the channel key; replacing it');
  }

  const secret = env['PHOENIX_INSTANCE_SECRET']?.trim();
  if (secret === undefined || secret === '') stop(missingSecretMessage(instanceFile));
  const owner = await call(api, '/v1/users/me', { bearer: secret });
  if (owner.status !== 200) {
    stop(
      `The API at ${api} answered ${String(owner.status)} to the instance secret, so it is not the instance ${instanceFile} provisions.`,
    );
  }
  const refusal = editionRefusal(owner.body?.edition?.id);
  if (refusal !== undefined) stop(refusal);

  const created = await call(api, '/v1/api-keys', {
    bearer: secret,
    body: { name: KEY_NAME, expiresInDays: KEY_EXPIRES_IN_DAYS },
  });
  if (created.status !== 201 || typeof created.body?.key !== 'string') {
    stop(`The API answered ${String(created.status)} to creating the key.`);
  }
  const me = await call(api, '/v1/users/me', { bearer: created.body.key });
  if (me.status !== 200) {
    stop(
      `The API created "${KEY_NAME}" and then answered ${String(me.status)} to it. Revoke it under Settings → API Keys and run this again.`,
    );
  }
  return { key: created.body.key, expiresAt: created.body.expiresAt, me: me.body, minted: true };
}

/** The channel credential `instance.env` holds, written there first when it holds none. */
function channelCredential(instanceFile) {
  if (!existsSync(instanceFile)) {
    stop(`No ${instanceFile}. Start the stack once with \`yarn start\`, then run this again.`);
  }
  const text = readFileSync(instanceFile, 'utf8');
  const fresh = randomBytes(32).toString('hex');
  const addition = instanceWithChannelCredential(text, fresh);
  if (addition === undefined) {
    return { password: parseEnvFile(text)[CHANNEL_REDIS_PASSWORD_ENV].trim(), created: false };
  }
  appendFileSync(instanceFile, addition);
  return { password: fresh, created: true };
}

export async function main() {
  const { env, instanceFile } = setupEnv(process.env);
  const api = apiUrlOf(env);
  const health = await fetch(`${api}/health`, { signal: AbortSignal.timeout(5_000) }).catch(
    () => undefined,
  );
  if (health?.ok !== true) {
    stop(
      `The API at ${api} does not answer. Start the stack with \`yarn start\`, then run this again.`,
    );
  }

  const dir = channelSlackDirOf(process.env);
  const file = join(dir, CHANNEL_SLACK_ENV_FILENAME);
  const existing = readEnvFile(file);

  const botToken = await slackToken(
    env,
    existing,
    'SLACK_BOT_TOKEN',
    isBotToken,
    'Slack bot token (xoxb-…): ',
    'bot token (xoxb-…)',
  );
  const appToken = await slackToken(
    env,
    existing,
    'SLACK_APP_TOKEN',
    isAppToken,
    'Slack app-level token (xapp-…): ',
    'app-level token (xapp-…)',
  );

  const { key, expiresAt, me, minted } = await ownerKey(api, env, existing, instanceFile);
  const owner = ownerOf(me);
  const credential = channelCredential(instanceFile);

  const code = newLinkCode();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAuthFile(
    file,
    serializeChannelSlackEnv({
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
      AFLOW_API_URL: api,
      AFLOW_API_KEY: key,
      AFLOW_API_KEY_EXPIRES_AT: expiresAt ?? undefined,
      AFLOW_TENANT_ID: owner.tenantId,
      AFLOW_USER_ID: owner.userId,
      CHANNEL_REDIS_URL: channelRedisUrlOf(env),
      CHANNEL_REDIS_PASSWORD: credential.password,
      CHANNEL_SLACK_LINK_CODE_SHA256: linkCodeSha256(code),
      CHANNEL_SLACK_LINK_CODE_EXPIRES_AT: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(),
      PHOENIX_PAYLOAD_DIR: env['PHOENIX_PAYLOAD_DIR']?.trim() || undefined,
    }),
  );

  const expires = typeof expiresAt === 'string' ? expiresAt.slice(0, 10) : 'never';
  say(`wrote ${file} (mode 0600).`);
  say(
    `${minted ? 'minted' : 'kept'} the key "${KEY_NAME}" for the instance owner, expiring ${expires}, listed under Settings → API Keys.`,
  );
  if (credential.created) {
    say(
      `wrote the channel lane's credential into ${instanceFile}. Restart the stack (\`yarn start\`) so it composes the channel lane.`,
    );
  }
  say('start the app with `yarn channel:slack start`, and keep it running.');
  say(`then send this code to the bot in a direct message on Slack, within 30 minutes: ${code}`);
  say('the Slack user who sends it is the only one the app serves from then on.');
}
