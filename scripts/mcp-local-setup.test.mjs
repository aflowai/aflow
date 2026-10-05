/**
 * The parts of `yarn mcp:setup` that decide and write, without a stack.
 *
 * The file is what matters most: the MCP server parses it strictly, and a file
 * it refuses leaves every session uncredentialed with nothing but a log line to
 * say why. So it is read back through the server's own loader, not a restated
 * schema.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../apps/aflow-mcp/src/auth/AuthManager.ts';
import { LOCAL_TOKEN_ENV } from '../apps/aflow-mcp/src/requestGate.ts';
import { mcpPortHolder } from './devMcpPort.mjs';
import {
  AUTH_FILE_ENV,
  KEY_EXPIRES_IN_DAYS,
  apiUrlOf,
  authFileContents,
  authFileOf,
  editionRefusal,
  envNamingAuthFile,
  existingKeyVerdict,
  foreignHolderMessage,
  instanceDir,
  isYes,
  keyInAuthFile,
  MCP_TOKEN_ENV,
  newSessionToken,
  profileAddition,
  profileFor,
  profilePlan,
  profileSetsToken,
  sessionTokenIn,
  settleProfile,
  tokenExportLine,
  withSessionToken,
  mcpPortOf,
  missingSecretMessage,
  setupEnv,
  writeAuthFile,
} from './mcp-local-setup.mjs';

const KEY = 'phx_replace_me';
const TOKEN = newSessionToken();
const TENANT = '00000000-0000-4000-8000-00000000000a';
const OWNER = '00000000-0000-4000-8000-0000000ed1c1';

const ME = {
  user: { userId: OWNER, displayName: 'Local user', email: 'owner@example.com' },
  tenants: [{ tenantId: TENANT, role: 'owner', status: 'active', joinedAt: null }],
  edition: { id: 'community-local' },
};

let scratch;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});
function scratchDir() {
  scratch = mkdtempSync(join(tmpdir(), 'mcp-setup-'));
  return scratch;
}

function loadedBy(file) {
  const session = { id: 's', auth: { method: 'none' }, createdAt: 0, lastActivityAt: 0 };
  new AuthManager({
    apiUrl: 'http://localhost:3000',
    port: 3100,
    host: '127.0.0.1',
    logLevel: 'error',
    unauthenticatedFallback: false,
    allowBrowserOrigins: false,
    allowedHosts: [],
    cfOriginSecret: undefined,
    localAuthJsonPath: file,
  }).initFromHeaders(session, { authorization: `Bearer ${TOKEN}` });
  return session.auth;
}

describe('the file it writes', () => {
  it('is accepted by the MCP server as the owner, in the tenant /users/me names', () => {
    const file = join(scratchDir(), 'mcp.local.json');
    writeAuthFile(file, authFileContents(KEY, ME, TOKEN));
    expect(loadedBy(file)).toMatchObject({
      method: 'api_key',
      apiKey: KEY,
      tenantId: TENANT,
      user: { email: 'owner@example.com', name: 'Local user', userId: OWNER },
    });
  });

  it('carries exactly the schema fields, and no comment', () => {
    expect(Object.keys(JSON.parse(authFileContents(KEY, ME, TOKEN))).sort()).toEqual([
      'apiKey',
      'sessionToken',
      'tenantId',
      'user',
    ]);
  });

  it('is readable by its owner alone', () => {
    const file = join(scratchDir(), 'mcp.local.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    writeAuthFile(file, authFileContents(KEY, ME, TOKEN));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  /** `user.email` is required where `user` is present, and the owner may have none. */
  it('leaves the user out rather than writing an email the owner does not have', () => {
    const file = join(scratchDir(), 'mcp.local.json');
    writeAuthFile(file, authFileContents(KEY, { ...ME, user: { ...ME.user, email: null } }, TOKEN));
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('user');
    expect(loadedBy(file)).toMatchObject({ method: 'api_key', tenantId: TENANT });
  });

  it('takes the active membership over an earlier one', () => {
    const tenants = [{ tenantId: 'left', status: 'removed' }, ...ME.tenants];
    expect(JSON.parse(authFileContents(KEY, { ...ME, tenants }, TOKEN)).tenantId).toBe(TENANT);
  });

  it('refuses an owner with no tenant rather than writing a file without one', () => {
    expect(() => authFileContents(KEY, { ...ME, tenants: [] }, TOKEN)).toThrow(/no tenant/);
  });
});

describe('the session token', () => {
  it('is neither an API key nor a token the server forwards', () => {
    expect(TOKEN).toMatch(/^[0-9a-f]+$/);
    expect(TOKEN).not.toBe(newSessionToken());
  });

  it('is added to a file that has none, keeping every other field', () => {
    const file = JSON.stringify({ apiKey: KEY, tenantId: TENANT });
    expect(JSON.parse(withSessionToken(file, TOKEN))).toEqual({
      apiKey: KEY,
      tenantId: TENANT,
      sessionToken: TOKEN,
    });
  });

  /** The example carries none, so a file copied from it gets one generated. */
  it('is generated into a file copied from the example, which the server then accepts', () => {
    const example = readFileSync(
      new URL('../apps/aflow-mcp/mcp.local.json.example', import.meta.url),
      'utf8',
    );
    expect(sessionTokenIn(example)).toBeUndefined();
    const file = join(scratchDir(), 'mcp.local.json');
    writeAuthFile(file, withSessionToken(example, TOKEN));
    expect(sessionTokenIn(readFileSync(file, 'utf8'))).toBe(TOKEN);
    expect(loadedBy(file)).toMatchObject({ method: 'api_key', apiKey: KEY });
  });

  it('is kept where the file has one, and read back from it', () => {
    const file = authFileContents(KEY, ME, TOKEN);
    expect(withSessionToken(file, newSessionToken())).toBeUndefined();
    expect(sessionTokenIn(file)).toBe(TOKEN);
    expect(sessionTokenIn(undefined)).toBeUndefined();
    expect(sessionTokenIn('not json')).toBeUndefined();
  });

  it('is read from the variable the server names in its refusal', () => {
    expect(MCP_TOKEN_ENV).toBe(LOCAL_TOKEN_ENV);
  });

  /** Run as the operator would paste it, from a path a shell would split. */
  it('reaches that variable through the line setup prints, without being printed', () => {
    const file = join(scratchDir(), "it's here", 'mcp.local.json');
    mkdirSync(join(file, '..'));
    writeAuthFile(file, authFileContents(KEY, ME, TOKEN));
    const line = tokenExportLine(file);
    expect(line).not.toContain(TOKEN);
    const shell = spawnSync('sh', ['-c', `${line}; printf %s "$${MCP_TOKEN_ENV}"`], {
      encoding: 'utf8',
    });
    expect(shell.stdout).toBe(TOKEN);
  });
});

describe('an existing file', () => {
  it('is kept while the API accepts its key', () => {
    expect(existingKeyVerdict(200)).toBe('keep');
  });

  it('is replaced once the API refuses its key', () => {
    expect(existingKeyVerdict(401)).toBe('replace');
    expect(existingKeyVerdict(403)).toBe('replace');
  });

  /** Replacing on a passing failure would mint a key per run. */
  it('is neither kept nor replaced on an answer that says nothing about the key', () => {
    expect(existingKeyVerdict(500)).toBe('undecided');
    expect(existingKeyVerdict(503)).toBe('undecided');
  });

  it('yields its key, or nothing when it holds none', () => {
    expect(keyInAuthFile(JSON.stringify({ apiKey: KEY }))).toBe(KEY);
    expect(keyInAuthFile(JSON.stringify({ accessToken: 'ey.placeholder' }))).toBeUndefined();
    expect(keyInAuthFile('not json')).toBeUndefined();
  });
});

describe('minting', () => {
  it('goes ahead against the local edition', () => {
    expect(editionRefusal('community-local')).toBeUndefined();
  });

  it('stops on the hosted edition and says what to do instead', () => {
    const refusal = editionRefusal('enterprise');
    expect(refusal).toContain('enterprise');
    expect(refusal).toContain('Settings → API Keys');
  });

  it('stops without an instance secret and says what to do instead', () => {
    const message = missingSecretMessage('/home/dev/.aflow/dev-local/instance.env');
    expect(message).toContain('/home/dev/.aflow/dev-local/instance.env');
    expect(message).toContain('Settings → API Keys');
  });

  it('says by hand that the session token is generated, never typed', () => {
    for (const message of [editionRefusal('enterprise'), missingSecretMessage('instance.env')]) {
      expect(message).toContain('`yarn mcp:setup` again: it generates the `sessionToken`');
      expect(message).toContain('never typed');
    }
  });

  it('asks for the longest expiry the route allows', () => {
    const route = readFileSync(
      new URL('../packages/server-runtime/src/routes/api-keys.ts', import.meta.url),
      'utf8',
    );
    const max = /expiresInDays: z\.number\(\)[^\n]*\.max\((\d+)\)/.exec(route);
    expect(max?.[1]).toBe(String(KEY_EXPIRES_IN_DAYS));
  });
});

describe('.env', () => {
  it('gains the line when it does not name the file', () => {
    expect(envNamingAuthFile('PORT=3000\n')).toBe(`PORT=3000\n${AUTH_FILE_ENV}=mcp.local.json\n`);
  });

  it('gains it on a line of its own when the file does not end in one', () => {
    expect(envNamingAuthFile('PORT=3000')).toBe(`PORT=3000\n${AUTH_FILE_ENV}=mcp.local.json\n`);
  });

  /** The example ships the line commented out, which names nothing. */
  it('gains it when the line is only commented', () => {
    expect(envNamingAuthFile(`# ${AUTH_FILE_ENV}=mcp.local.json\n`)).toContain(
      `\n${AUTH_FILE_ENV}=mcp.local.json\n`,
    );
  });

  it('gains it when the line is blank, which the server reads as unset', () => {
    expect(envNamingAuthFile(`${AUTH_FILE_ENV}=\n`)).toBe(
      `${AUTH_FILE_ENV}=\n${AUTH_FILE_ENV}=mcp.local.json\n`,
    );
  });

  it('is left alone when it already names one', () => {
    expect(envNamingAuthFile(`${AUTH_FILE_ENV}=elsewhere.json\n`)).toBeUndefined();
  });
});

describe('the environment it reads', () => {
  it('finds the instance where dev:local keeps it', () => {
    expect(instanceDir({ PHOENIX_INSTANCE_DIR: '/srv/instance' })).toBe('/srv/instance');
    expect(instanceDir({})).toMatch(/\.aflow\/dev-local$/);
  });

  it('reads the instance secret it mints the key with from the instance file', () => {
    const repo = scratchDir();
    const instance = join(repo, 'instance');
    mkdirSync(instance);
    writeFileSync(join(repo, '.env'), 'API_BASE_URL=http://localhost:3000\n');
    writeFileSync(
      join(instance, 'instance.env'),
      `PHOENIX_INSTANCE_SECRET='from-the-instance'\nPHOENIX_LOCAL_TENANT_ID=${TENANT}\n`,
    );
    const { env, instanceFile } = setupEnv({ PHOENIX_INSTANCE_DIR: instance }, repo);
    expect(instanceFile).toBe(join(instance, 'instance.env'));
    expect(env['PHOENIX_INSTANCE_SECRET']).toBe('from-the-instance');
    expect(env['PHOENIX_LOCAL_TENANT_ID']).toBe(TENANT);
    expect(apiUrlOf(env)).toBe('http://localhost:3000');
  });

  it('calls the API the MCP server calls, then the one the stack names', () => {
    expect(apiUrlOf({ AFLOW_API_URL: 'http://127.0.0.1:4000/', API_BASE_URL: 'http://x' })).toBe(
      'http://127.0.0.1:4000',
    );
    expect(apiUrlOf({ API_BASE_URL: 'http://localhost:3000' })).toBe('http://localhost:3000');
    expect(apiUrlOf({ AFLOW_API_URL: '  ' })).toBe('http://localhost:3000');
  });

  it('writes the file .env names, resolved from the checkout', () => {
    expect(authFileOf({}, '/repo')).toBe('/repo/mcp.local.json');
    expect(authFileOf({ [AUTH_FILE_ENV]: 'auth/mcp.json' }, '/repo')).toBe('/repo/auth/mcp.json');
  });

  it('reads the port as the MCP server does', () => {
    expect(mcpPortOf({})).toBe(3100);
    expect(mcpPortOf({ PORT: '3000', MCP_PORT: '3200' })).toBe(3200);
    expect(mcpPortOf({ PORT: '3300' })).toBe(3300);
  });
});

describe('the line on who reads the key', () => {
  const HERE = '/home/dev/src/aflow';
  const THERE = '/home/dev/src/aflow-worktrees/topic';
  /** The node process under its watcher that `yarn mcp:dev` leaves listening. */
  const serverFrom = (checkout) =>
    `/usr/local/bin/node --conditions=ts-source --import tsx ${checkout}/apps/aflow-mcp/src/index.ts`;
  const lineFor = (listeners, ps) =>
    foreignHolderMessage({
      port: 3100,
      holder: mcpPortHolder(listeners, ps),
      repo: HERE,
      shown: 'mcp.local.json',
    });

  it('defers to the usual line when this checkout’s server holds the port', () => {
    expect(lineFor(['512'], `  512 ${serverFrom(HERE)}`)).toBeUndefined();
  });

  it('says another checkout’s server reads that checkout’s file, and names it', () => {
    const line = lineFor(['512'], `  512 ${serverFrom(THERE)}`);
    expect(line).toContain(THERE);
    expect(line).toContain("reads that checkout's credential file, not mcp.local.json");
    expect(line).toContain('512');
  });

  it('says so without a name when the server’s checkout cannot be told', () => {
    const line = lineFor(['512'], '  512 node apps/aflow-mcp/src/index.ts');
    expect(line).toContain("its own checkout's credential file");
    expect(line).not.toContain('undefined');
    expect(lineFor([], `  512 ${serverFrom(THERE)}`)).toContain('cannot be told');
  });

  it('says aflow-local is unavailable when something else holds the port', () => {
    expect(lineFor(['700'], '  700 other --port 3100')).toContain('not the Aflow MCP server');
  });

  it('defers to the usual line when nothing is seen on the port', () => {
    expect(lineFor([], '  700 other')).toBeUndefined();
  });
});

describe('the shell profile', () => {
  const HOME = '/Users/you';

  it('is chosen from the shell, by the platform’s convention for bash', () => {
    expect(profileFor('/bin/zsh', 'darwin', HOME)).toBe('/Users/you/.zshrc');
    expect(profileFor('/usr/bin/zsh', 'linux', '/home/you')).toBe('/home/you/.zshrc');
    expect(profileFor('/bin/bash', 'darwin', HOME)).toBe('/Users/you/.bash_profile');
    expect(profileFor('/bin/bash', 'linux', '/home/you')).toBe('/home/you/.bashrc');
  });

  it('is not guessed for any other shell', () => {
    expect(profileFor('/opt/homebrew/bin/fish', 'darwin', HOME)).toBeUndefined();
    expect(profileFor(undefined, 'darwin', HOME)).toBeUndefined();
  });

  it('already sets the token when a live line assigns the variable', () => {
    expect(
      profileSetsToken(`export PATH=x\n${tokenExportLine('/Users/you/mcp.local.json')}\n`),
    ).toBe(true);
    expect(profileSetsToken(`${MCP_TOKEN_ENV}=from-elsewhere\n`)).toBe(true);
  });

  it('does not, when the line is only commented or names another variable', () => {
    expect(profileSetsToken(`# export ${MCP_TOKEN_ENV}=x\n`)).toBe(false);
    expect(profileSetsToken(`export ${MCP_TOKEN_ENV}_OLD=x\n`)).toBe(false);
    expect(profileSetsToken('')).toBe(false);
  });

  it('gains text that sets the token from the file as a shell starts, without the token in it', () => {
    const dir = scratchDir();
    const file = join(dir, "it's here", 'mcp.local.json');
    mkdirSync(join(file, '..'));
    writeAuthFile(file, authFileContents(KEY, ME, TOKEN));
    const profile = join(dir, '.zshrc');
    writeFileSync(profile, 'export EDITOR=vi');

    const addition = profileAddition(readFileSync(profile, 'utf8'), file);
    writeFileSync(profile, `${readFileSync(profile, 'utf8')}${addition}`);

    expect(addition).not.toContain(TOKEN);
    expect(addition).toContain(tokenExportLine(file));
    expect(readFileSync(profile, 'utf8')).toMatch(/^export EDITOR=vi\n\n# aflow-local/);
    const shell = spawnSync('sh', ['-c', `. '${profile}'; printf %s "$${MCP_TOKEN_ENV}"`], {
      encoding: 'utf8',
    });
    expect(shell.stdout).toBe(TOKEN);
    expect(profileSetsToken(readFileSync(profile, 'utf8'))).toBe(true);
  });

  it('costs a new shell nothing once the file is gone', () => {
    const profile = join(scratchDir(), '.bashrc');
    writeFileSync(profile, profileAddition('', join(scratch, 'removed', 'mcp.local.json')));

    const shell = spawnSync(
      'sh',
      ['-c', `. '${profile}'; printf %s "\${${MCP_TOKEN_ENV}-unset}"`],
      {
        encoding: 'utf8',
      },
    );
    expect(shell.status).toBe(0);
    expect(shell.stderr).toBe('');
    expect(shell.stdout).toBe('unset');
  });
});

describe('writing the profile', () => {
  const profile = '/Users/you/.zshrc';

  it('never happens without a terminal unless --write-profile asks for it', () => {
    expect(
      profilePlan({ interactive: false, writeProfile: false, profile, profileText: '' }),
    ).toEqual({ kind: 'print', profile });
    expect(
      profilePlan({ interactive: false, writeProfile: true, profile, profileText: '' }),
    ).toEqual({ kind: 'write', profile });
  });

  it('is offered in a terminal, and done without asking under --write-profile', () => {
    expect(
      profilePlan({ interactive: true, writeProfile: false, profile, profileText: '' }).kind,
    ).toBe('ask');
    expect(
      profilePlan({ interactive: true, writeProfile: true, profile, profileText: '' }).kind,
    ).toBe('write');
  });

  function settleWithoutTerminal(home, writeProfile) {
    const told = [];
    const authFile = join(home, 'mcp.local.json');
    writeAuthFile(authFile, authFileContents(KEY, ME, TOKEN));
    return settleProfile({
      shell: '/bin/zsh',
      platform: 'linux',
      home,
      authFile,
      interactive: false,
      writeProfile,
      ask: () => {
        throw new Error('asked without a terminal');
      },
      tell: (message) => told.push(message),
    }).then((kind) => ({ kind, told, profile: join(home, '.zshrc') }));
  }

  it('is written under --write-profile from a shell that is not a terminal', async () => {
    const home = scratchDir();
    writeFileSync(join(home, '.zshrc'), 'export EDITOR=vi\n');

    const { kind, told, profile: written } = await settleWithoutTerminal(home, true);

    expect(kind).toBe('write');
    expect(told.join('\n')).toContain('added it to ~/.zshrc');
    const shell = spawnSync('sh', ['-c', `. '${written}'; printf %s "$${MCP_TOKEN_ENV}"`], {
      encoding: 'utf8',
    });
    expect(shell.stdout).toBe(TOKEN);
  });

  it('is left alone without --write-profile from a shell that is not a terminal', async () => {
    const home = scratchDir();
    writeFileSync(join(home, '.zshrc'), 'export EDITOR=vi\n');

    const { kind, told, profile: untouched } = await settleWithoutTerminal(home, false);

    expect(kind).toBe('print');
    expect(readFileSync(untouched, 'utf8')).toBe('export EDITOR=vi\n');
    expect(told.join('\n')).toContain('yarn mcp:setup --write-profile');
    expect(told.join('\n')).not.toContain(TOKEN);
  });

  it('is skipped when the profile already sets the token', () => {
    const profileText = `${tokenExportLine('/Users/you/mcp.local.json')}\n`;
    expect(profilePlan({ interactive: true, writeProfile: true, profile, profileText }).kind).toBe(
      'present',
    );
  });

  it('is not attempted for a shell whose profile cannot be chosen', () => {
    expect(
      profilePlan({
        interactive: true,
        writeProfile: true,
        profile: undefined,
        profileText: undefined,
      }),
    ).toEqual({ kind: 'no-profile' });
  });

  it('takes only an explicit yes', () => {
    expect(isYes('y')).toBe(true);
    expect(isYes(' Yes ')).toBe(true);
    expect(isYes('')).toBe(false);
    expect(isYes('n')).toBe(false);
    expect(isYes('yeah')).toBe(false);
    expect(isYes(undefined)).toBe(false);
  });
});
