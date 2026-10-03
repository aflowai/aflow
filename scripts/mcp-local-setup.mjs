#!/usr/bin/env node
/**
 * Gives the local MCP server (`aflow-local`) a credential of its own.
 *
 * The server mints none: a session authenticates with what its client sends or,
 * on a development stack, with the key in the file `AFLOW_MCP_LOCAL_AUTH_JSON`
 * names. This mints that key with the instance secret and writes the file. An
 * ordinary API key rather than the secret, so the two stay separately revocable
 * — the key is listed, and revoked, under Settings → API Keys.
 *
 * Idempotent: a file whose key the API still accepts is left alone. Never prints
 * a key or the secret.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { listenersOn, mcpPortHolder, readProcessTable } from './devMcpPort.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export const AUTH_FILE_ENV = 'AFLOW_MCP_LOCAL_AUTH_JSON';
export const DEFAULT_AUTH_FILE = 'mcp.local.json';
export const KEY_NAME = 'aflow-local MCP server';
/** The longest `POST /v1/api-keys` allows; a test pins the two together. */
export const KEY_EXPIRES_IN_DAYS = 365;
const LOCAL_EDITION = 'community-local';

const BY_HAND =
  'Create a key under Settings → API Keys and write it into mcp.local.json as `apiKey`, ' +
  'with its `tenantId` (shape: apps/aflow-mcp/mcp.local.json.example), or give it to the ' +
  'MCP client as an `Authorization: Bearer phx_…` header.';

/** `KEY=value` lines, as both `.env` and the shell-quoted `instance.env` write them. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    const raw = match[2].trim();
    values[match[1]] = /^'.*'$/s.test(raw)
      ? raw.slice(1, -1).replace(/'\\''/g, "'")
      : /^".*"$/s.test(raw)
        ? raw.slice(1, -1)
        : raw.replace(/\s+#.*$/, '');
  }
  return values;
}

/** Where the dev stack keeps its instance identity — `scripts/dev-local.ts`'s rule. */
export function instanceDir(processEnv) {
  const explicit = processEnv['PHOENIX_INSTANCE_DIR']?.trim();
  return explicit !== undefined && explicit !== ''
    ? explicit
    : join(homedir(), '.aflow', 'dev-local');
}

/**
 * The environment the stack's processes see: `.env` over the shell's and the
 * instance file over both, the order the dev runner merges them in.
 */
export function stackEnv(processEnv, dotenv, instance) {
  return { ...processEnv, ...dotenv, ...instance };
}

function setting(env, key) {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The API the MCP server talks to (`AFLOW_API_URL`), else the one the stack names. */
export function apiUrlOf(env) {
  const url =
    setting(env, 'AFLOW_API_URL') ?? setting(env, 'API_BASE_URL') ?? 'http://localhost:3000';
  return url.replace(/\/+$/, '');
}

/** The file the MCP server reads, resolved from the checkout as `yarn` runs it. */
export function authFileOf(env, repo = REPO) {
  return resolve(repo, setting(env, AUTH_FILE_ENV) ?? DEFAULT_AUTH_FILE);
}

/** The port the MCP server listens on, by `apps/aflow-mcp/src/config.ts`'s rule. */
export function mcpPortOf(env) {
  return Number(setting(env, 'MCP_PORT') ?? setting(env, 'PORT') ?? '3100');
}

/**
 * What to say when the port is not held by this checkout's MCP server, or
 * undefined when it is (or nothing is seen on it). The server resolves its
 * credential file from its own working directory, so one another checkout
 * started never reads the file written here.
 */
export function foreignHolderMessage({ port, holder, repo, shown }) {
  const onPort = `port ${String(port)}`;
  if (holder.kind === 'mcp-server' && holder.worktree !== undefined) {
    if (holder.worktree === repo) return undefined;
    return (
      `${onPort} is held by the Aflow MCP server from ${holder.worktree} (pid ${holder.pids.join(', ')}), ` +
      `which reads that checkout's credential file, not ${shown}. Run \`yarn mcp:setup\` there, ` +
      'or stop that server and run `yarn dev:mcp` here.'
    );
  }
  if (holder.kind === 'mcp-server' || holder.kind === 'unseen-mcp-server') {
    return (
      `${onPort} is held by an Aflow MCP server whose checkout cannot be told; unless it is this ` +
      `one, it reads its own checkout's credential file, not ${shown}.`
    );
  }
  if (holder.kind === 'other') {
    const pids = holder.listeners.map(({ pid }) => String(pid)).join(', ');
    return (
      `${onPort} is held by pid ${pids}, which is not the Aflow MCP server; aflow-local is ` +
      'unavailable until that port is free.'
    );
  }
  return undefined;
}

/** `.env` with the line naming the file added, or undefined when it already names one. */
export function envNamingAuthFile(envText) {
  const named = new RegExp(`^\\s*(?:export\\s+)?${AUTH_FILE_ENV}=\\s*[^\\s#]`, 'm');
  if (named.test(envText)) return undefined;
  const separator = envText === '' || envText.endsWith('\n') ? '' : '\n';
  return `${envText}${separator}${AUTH_FILE_ENV}=${DEFAULT_AUTH_FILE}\n`;
}

export function keyInAuthFile(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.apiKey === 'string' && parsed.apiKey !== '' ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `GET /v1/users/me`'s status says about the file's key. Only a refusal
 * means the key is spent; anything else says nothing about it, and replacing
 * a good key on a passing 5xx would mint one per run.
 */
export function existingKeyVerdict(status) {
  if (status === 200) return 'keep';
  if (status === 401 || status === 403) return 'replace';
  return 'undecided';
}

/** Why no key can be minted against this API, or undefined when one can. */
export function editionRefusal(editionId) {
  if (editionId === LOCAL_EDITION) return undefined;
  return (
    `This API is the ${editionId ?? 'unknown'} edition, which has no instance secret to ` +
    `mint a key with. ${BY_HAND}`
  );
}

export function missingSecretMessage(instanceFile) {
  return (
    `No PHOENIX_INSTANCE_SECRET in .env or ${instanceFile}. The local edition's ` +
    '`yarn start` provisions it there; on the hosted edition there is none. ' +
    BY_HAND
  );
}

/**
 * The file the MCP server reads, with exactly the fields its schema accepts —
 * it is parsed strictly, and a refused file leaves every session uncredentialed.
 */
export function authFileContents(apiKey, me) {
  const tenants = Array.isArray(me?.tenants) ? me.tenants : [];
  const tenant = tenants.find((t) => t.status === 'active') ?? tenants[0];
  if (tenant === undefined) throw new Error('The key authenticates, but its owner has no tenant.');
  const file = { apiKey, tenantId: tenant.tenantId };
  const user = me.user;
  if (typeof user?.email === 'string' && user.email !== '') {
    file.user = { email: user.email, name: user.displayName, userId: user.userId };
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function writeAuthFile(path, contents) {
  const staging = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(staging, contents, { mode: 0o600 });
  chmodSync(staging, 0o600);
  renameSync(staging, path);
}

const say = (message) => {
  console.log(`\x1b[36m[mcp:setup]\x1b[0m ${message}`);
};

class Stop extends Error {}
const stop = (message) => {
  throw new Stop(message);
};

/** A GET, or a POST when there is a body. */
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

async function answers(api) {
  try {
    const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Adds the line when `.env` lacks it; true when it did. */
function ensureEnvNamesAuthFile() {
  const envPath = join(REPO, '.env');
  if (!existsSync(envPath)) {
    say(`no .env here; set ${AUTH_FILE_ENV}=${DEFAULT_AUTH_FILE} in the MCP server's environment`);
    return false;
  }
  const updated = envNamingAuthFile(readFileSync(envPath, 'utf8'));
  if (updated === undefined) return false;
  writeFileSync(envPath, updated);
  say(`.env now names it: ${AUTH_FILE_ENV}=${DEFAULT_AUTH_FILE}`);
  return true;
}

async function main() {
  const envPath = join(REPO, '.env');
  const dotenv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const instanceFile = join(instanceDir(process.env), 'instance.env');
  const instance = existsSync(instanceFile) ? parseEnvFile(readFileSync(instanceFile, 'utf8')) : {};
  const env = stackEnv(process.env, dotenv, instance);
  const api = apiUrlOf(env);
  const authFile = authFileOf(env);
  const shown = relative(REPO, authFile) || authFile;

  if (!(await answers(api))) {
    stop(
      `The API at ${api} does not answer. Start the stack with \`yarn start\`, then run this again.`,
    );
  }

  const existing = existsSync(authFile) ? keyInAuthFile(readFileSync(authFile, 'utf8')) : undefined;
  if (existing !== undefined) {
    const { status } = await call(api, '/v1/users/me', { bearer: existing });
    const verdict = existingKeyVerdict(status);
    if (verdict === 'keep') {
      say(`${shown} holds a key the API accepts; nothing to do.`);
      const envNamesItNow = ensureEnvNamesAuthFile();
      const foreign = foreignHolderOfPort(env, shown);
      if (foreign !== undefined) say(foreign);
      else if (envNamesItNow) say('restart the MCP server so it reads that line.');
      return;
    }
    if (verdict === 'undecided') {
      stop(
        `The API answered ${String(status)} when asked about the key in ${shown}; check its log and run this again.`,
      );
    }
    say(`the API no longer accepts the key in ${shown}; replacing it`);
  }

  const secret = setting(env, 'PHOENIX_INSTANCE_SECRET');
  if (secret === undefined) stop(missingSecretMessage(instanceFile));

  const owner = await call(api, '/v1/users/me', { bearer: secret });
  if (owner.status === 401) {
    stop(
      `The API at ${api} refused the instance secret, so the stack answering there is not ` +
        `the instance ${instanceFile} provisions. ${BY_HAND}`,
    );
  }
  if (owner.status !== 200) stop(`The API answered ${String(owner.status)} to GET /v1/users/me.`);
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
      `The API created "${KEY_NAME}" and then answered ${String(me.status)} to it. Revoke it ` +
        'under Settings → API Keys and run this again.',
    );
  }
  writeAuthFile(authFile, authFileContents(created.body.key, me.body));
  const expires = created.body.expiresAt?.slice(0, 10) ?? 'never';
  say(
    `wrote ${shown}: the key "${KEY_NAME}", expiring ${expires}, listed under Settings → API Keys.`,
  );

  const envNamesItNow = ensureEnvNamesAuthFile();
  const foreign = foreignHolderOfPort(env, shown);
  if (foreign !== undefined) {
    say(foreign);
  } else if (envNamesItNow) {
    say('restart the MCP server so it reads that line; auth_status then reports api_key.');
  } else {
    say('the next MCP session picks it up; auth_status reports api_key.');
  }
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function foreignHolderOfPort(env, shown) {
  const port = mcpPortOf(env);
  const holder = mcpPortHolder(listenersOn(port), readProcessTable());
  const placed =
    holder.kind === 'mcp-server' && holder.worktree !== undefined
      ? { ...holder, worktree: canonical(holder.worktree) }
      : holder;
  return foreignHolderMessage({ port, holder: placed, repo: canonical(REPO), shown });
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch((/** @type {unknown} */ error) => {
    const message =
      error instanceof Stop
        ? error.message
        : `failed: ${error instanceof Error ? error.message : 'an unexpected error'}`;
    console.error(`\x1b[31m[mcp:setup]\x1b[0m ${message}`);
    process.exit(1);
  });
}
