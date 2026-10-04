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
 * The server gives that key only to a session presenting the file's session
 * token, which this generates beside it; a client started from `.mcp.json`
 * sends it from `AFLOW_MCP_LOCAL_TOKEN`, read from the shell it starts in. Run
 * in a terminal, it offers to add the line that sets it to the shell's profile;
 * `--write-profile` adds it without asking, from a terminal or not.
 *
 * Idempotent: a file whose key the API still accepts is left alone, gaining a
 * session token only when it has none. Never prints a key, the token or the secret.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { listenersOn, mcpPortHolder, readProcessTable } from './devMcpPort.mjs';
import { readEnvFile, stackEnv } from './stackEnv.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export const AUTH_FILE_ENV = 'AFLOW_MCP_LOCAL_AUTH_JSON';
/** Where a client started from `.mcp.json` reads the session token it presents. */
export const MCP_TOKEN_ENV = 'AFLOW_MCP_LOCAL_TOKEN';
export const DEFAULT_AUTH_FILE = 'mcp.local.json';
export const KEY_NAME = 'aflow-local MCP server';
/** The longest `POST /v1/api-keys` allows; a test pins the two together. */
export const KEY_EXPIRES_IN_DAYS = 365;
const LOCAL_EDITION = 'community-local';
const SESSION_TOKEN_BYTES = 32;

const BY_HAND =
  'Create a key under Settings → API Keys and write it into mcp.local.json as `apiKey`, ' +
  'with its `tenantId` (shape: apps/aflow-mcp/mcp.local.json.example), then run ' +
  '`yarn mcp:setup` again: it generates the `sessionToken` sessions present, which is ' +
  'never typed. Or give the key to the MCP client as an `Authorization: Bearer phx_…` header.';

/** Where the dev stack keeps its instance identity — `scripts/dev-local.ts`'s rule. */
export function instanceDir(processEnv) {
  const explicit = processEnv['PHOENIX_INSTANCE_DIR']?.trim();
  return explicit !== undefined && explicit !== ''
    ? explicit
    : join(homedir(), '.aflow', 'dev-local');
}

/** The stack's environment with the instance file's, where the instance secret the key is minted with lives. */
export function setupEnv(processEnv, repo = REPO) {
  const instanceFile = join(instanceDir(processEnv), 'instance.env');
  const env = stackEnv(processEnv, readEnvFile(join(repo, '.env')), {
    instance: readEnvFile(instanceFile),
  });
  return { env, instanceFile };
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

/** Hex, so it can never be read as an API key (`phx_`) or a token (`ey`). */
export function newSessionToken() {
  return randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

/**
 * The session token in the file, kept when its key is replaced so clients need
 * no change.
 */
export function sessionTokenIn(text) {
  if (text === undefined) return undefined;
  try {
    const token = JSON.parse(text)?.sessionToken;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The file's contents with a session token added, or undefined when it has one. */
export function withSessionToken(text, sessionToken) {
  if (sessionTokenIn(text) !== undefined) return undefined;
  return `${JSON.stringify({ ...JSON.parse(text), sessionToken }, null, 2)}\n`;
}

/**
 * The line that puts the file's session token where a client started from
 * `.mcp.json` reads it, without the token itself appearing anywhere.
 */
export function tokenExportLine(authFile) {
  const quoted = `'${authFile.replace(/'/g, "'\\''")}'`;
  return `export ${MCP_TOKEN_ENV}="$(node -p 'require(process.argv[1]).sessionToken' ${quoted})"`;
}

/**
 * The shell profile a new shell of the operator's reads, from `$SHELL`: zsh
 * reads `~/.zshrc`; bash reads `~/.bash_profile` where a terminal opens a login
 * shell, as macOS's does, and `~/.bashrc` where it opens an interactive one, as
 * Linux's do. Undefined for any other shell, whose profile is not guessed at.
 */
export function profileFor(shell, platform, home) {
  const name = shell === undefined ? '' : shell.split('/').pop();
  if (name === 'zsh') return join(home, '.zshrc');
  if (name === 'bash') return join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc');
  return undefined;
}

/** Whether the profile already sets the token variable on a line that is not a comment. */
export function profileSetsToken(profileText) {
  return new RegExp(`^[^#\\n]*\\b${MCP_TOKEN_ENV}=`, 'm').test(profileText);
}

/**
 * What is appended to the profile: the printed line, run only while the file
 * exists, so a removed file costs a new shell nothing.
 */
export function profileAddition(profileText, authFile) {
  const quoted = `'${authFile.replace(/'/g, "'\\''")}'`;
  const separator = profileText === '' || profileText.endsWith('\n') ? '' : '\n';
  return (
    `${separator}\n# aflow-local MCP server: the session token .mcp.json sends\n` +
    `if [ -f ${quoted} ]; then ${tokenExportLine(authFile)}; fi\n`
  );
}

/**
 * What to do about the profile. Nothing is written without a yes: one typed at
 * a terminal, or `--write-profile`, which gives it in advance and so holds
 * where nobody can type one — a coding agent's shell is not a terminal.
 */
export function profilePlan({ interactive, writeProfile, profile, profileText }) {
  if (profile === undefined) return { kind: 'no-profile' };
  if (profileText !== undefined && profileSetsToken(profileText))
    return { kind: 'present', profile };
  if (writeProfile) return { kind: 'write', profile };
  return { kind: interactive ? 'ask' : 'print', profile };
}

/** Only an explicit yes. */
export function isYes(answer) {
  return /^\s*y(es)?\s*$/i.test(answer ?? '');
}

/**
 * The file the MCP server reads, with exactly the fields its schema accepts —
 * it is parsed strictly, and a refused file leaves every session uncredentialed.
 */
export function authFileContents(apiKey, me, sessionToken) {
  const tenants = Array.isArray(me?.tenants) ? me.tenants : [];
  const tenant = tenants.find((t) => t.status === 'active') ?? tenants[0];
  if (tenant === undefined) throw new Error('The key authenticates, but its owner has no tenant.');
  const file = { apiKey, tenantId: tenant.tenantId, sessionToken };
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
  const { env, instanceFile } = setupEnv(process.env);
  const api = apiUrlOf(env);
  const authFile = authFileOf(env);
  const shown = relative(REPO, authFile) || authFile;

  if (!(await answers(api))) {
    stop(
      `The API at ${api} does not answer. Start the stack with \`yarn start\`, then run this again.`,
    );
  }

  const existingText = existsSync(authFile) ? readFileSync(authFile, 'utf8') : undefined;
  const existing = existingText === undefined ? undefined : keyInAuthFile(existingText);
  if (existing !== undefined) {
    const { status } = await call(api, '/v1/users/me', { bearer: existing });
    const verdict = existingKeyVerdict(status);
    if (verdict === 'keep') {
      const tokened = withSessionToken(existingText, newSessionToken());
      if (tokened === undefined) {
        say(`${shown} holds a key the API accepts and a session token; nothing to do.`);
      } else {
        writeAuthFile(authFile, tokened);
        say(`${shown} holds a key the API accepts; added the session token sessions present.`);
      }
      const envNamesItNow = ensureEnvNamesAuthFile();
      const foreign = foreignHolderOfPort(env, shown);
      if (foreign !== undefined) say(foreign);
      else if (envNamesItNow) say('restart the MCP server so it reads that line.');
      await finish(authFile);
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
  writeAuthFile(
    authFile,
    authFileContents(created.body.key, me.body, sessionTokenIn(existingText) ?? newSessionToken()),
  );
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
  await finish(authFile);
}

async function askYes(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return isYes(await prompt.question(question));
  } finally {
    prompt.close();
  }
}

/** Adds the token line to the shell's profile, offers to, or prints it, as `profilePlan` decides. */
export async function settleProfile({
  shell,
  platform,
  home,
  authFile,
  interactive,
  writeProfile,
  ask,
  tell,
}) {
  const profile = profileFor(shell, platform, home);
  const profileText =
    profile === undefined ? undefined : existsSync(profile) ? readFileSync(profile, 'utf8') : '';
  const plan = profilePlan({ interactive, writeProfile, profile, profileText });
  const line = `  ${tokenExportLine(authFile)}`;
  const shown = profile?.startsWith(`${home}/`) ? `~${profile.slice(home.length)}` : profile;
  const append = () => {
    appendFileSync(profile, profileAddition(profileText ?? '', authFile));
    tell(`added it to ${shown}; it reads the token from ${authFile} each time a shell starts.`);
  };

  if (plan.kind === 'present') {
    tell(`${shown} already sets ${MCP_TOKEN_ENV}; left unchanged.`);
  } else if (plan.kind === 'no-profile') {
    tell(
      `cannot tell which profile your shell (${shell ?? '$SHELL unset'}) reads; ` +
        'add this line to it:',
    );
    tell(line);
  } else if (plan.kind === 'print') {
    tell(`add this line to ${shown}, which a new shell reads:`);
    tell(line);
    tell(
      'or run `yarn mcp:setup --write-profile`, which adds it, or `yarn mcp:setup` in a ' +
        'terminal, which offers to.',
    );
  } else if (plan.kind === 'write') {
    append();
  } else {
    tell(`this line sets it:`);
    tell(line);
    if (await ask(`\x1b[36m[mcp:setup]\x1b[0m append it to ${shown}? [y/N] `)) append();
    else tell(`${shown} left unchanged; add the line to it yourself.`);
  }
  return plan.kind;
}

/** Puts the token where a new shell finds it, then says what is left to do. */
async function finish(authFile) {
  say(
    `a session is given the key only when it presents the file's session token; ` +
      `.mcp.json sends it from ${MCP_TOKEN_ENV}, which the MCP client reads from the shell it starts in.`,
  );
  await settleProfile({
    shell: process.env['SHELL'],
    platform: process.platform,
    home: homedir(),
    authFile,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    writeProfile: process.argv.includes('--write-profile'),
    ask: askYes,
    tell: say,
  });

  say(
    'still to do: start your MCP client from a NEW shell — a session already running, or a ' +
      'shell opened before the line was set, has no token and no aflow-local server — and ' +
      'approve the project’s MCP server, aflow-local, when the client offers it.',
  );
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
