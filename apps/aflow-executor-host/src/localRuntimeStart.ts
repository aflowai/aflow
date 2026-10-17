/**
 * Starting the model runtime on this machine when the operator asks from the
 * workspace (Plan 323 D15).
 *
 * The request names nothing to run: this starts Ollama the way the machine has
 * it installed, and only that. A service the operator installed — a launch
 * agent, a user unit — is started as that service, because its definition
 * carries the runtime's settings (a cache type, flash attention) that a bare
 * `ollama serve` would drop, and the machine's measured footprint with them.
 * Then the macOS app; then `ollama serve` as the operator, detached so it
 * outlives this executor's restarts. A system service is the administrator's
 * to start, and the answer says how.
 */
import { spawn, execFile } from 'node:child_process';
import { constants, openSync } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import type { HostRuntimeAnswer } from '@aflow/redis';

import { probeEnv } from './probeEnv.js';

const run = promisify(execFile);

export const OLLAMA_DEFAULT_PORT = 11_434;
/** An app's first launch after an update unpacks before it listens. */
export const RUNTIME_START_WAIT_MS = 30_000;
const ANSWER_POLL_MS = 500;
const DOWNLOAD = 'https://ollama.com/download';
const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
const SYSTEM_UNITS = ['/etc/systemd/system/ollama.service', '/lib/systemd/system/ollama.service'];

export interface RuntimeStartDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  searchPath: readonly string[];
  exists(path: string): Promise<boolean>;
  executable(path: string): Promise<boolean>;
  /** The names in a directory, or none where it does not exist. */
  list(dir: string): Promise<string[]>;
  exec(command: string, args: readonly string[]): Promise<void>;
  serve(binary: string, env: Record<string, string>): void;
  answers(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  waitMs: number;
}

/** Where a package manager or the installer puts the binary, when the executor's PATH is a service's. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function defaultDeps(): RuntimeStartDeps {
  return {
    platform: process.platform,
    home: homedir(),
    uid: userInfo().uid,
    searchPath: [
      ...(process.env['PATH'] ?? '').split(delimiter).filter(Boolean),
      ...COMMON_BIN_DIRS,
    ],
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    executable: (path) =>
      access(path, constants.X_OK).then(
        () => true,
        () => false,
      ),
    list: (dir) => readdir(dir).catch(() => []),
    exec: async (command, args) => {
      await run(command, [...args], { timeout: 30_000, env: probeEnv() });
    },
    serve: (binary, env) => {
      // Ollama's own log, where an operator who goes looking will look.
      const logs = join(env['HOME'] ?? homedir(), '.ollama', 'logs');
      void mkdir(logs, { recursive: true })
        .catch(() => undefined)
        .then(() => {
          const out = openSync(join(logs, 'server.log'), 'a');
          spawn(binary, ['serve'], { detached: true, stdio: ['ignore', out, out], env }).unref();
        });
    },
    answers: async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitMs: RUNTIME_START_WAIT_MS,
  };
}

/** The runtime's own settings from this executor's environment, which a service manager may have set. */
function serveEnv(port: number): Record<string, string> {
  const env = probeEnv();
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('OLLAMA_') && value !== undefined) env[name] = value;
  }
  if (port !== OLLAMA_DEFAULT_PORT) env['OLLAMA_HOST'] = `127.0.0.1:${port}`;
  return env;
}

async function findBinary(deps: RuntimeStartDeps): Promise<string | undefined> {
  for (const dir of deps.searchPath) {
    const candidate = join(dir, 'ollama');
    if (await deps.executable(candidate)) return candidate;
  }
  return undefined;
}

async function waitForAnswer(deps: RuntimeStartDeps, port: number): Promise<boolean> {
  for (let waited = 0; waited < deps.waitMs; waited += ANSWER_POLL_MS) {
    if (await deps.answers(port)) return true;
    await deps.sleep(ANSWER_POLL_MS);
  }
  return deps.answers(port);
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Started {
  readonly how: string;
  readonly log: string;
}

/** Starts the runtime the way this machine has it installed, or says why it cannot. */
async function start(port: number, deps: RuntimeStartDeps): Promise<Started | { refused: string }> {
  if (deps.platform === 'darwin') {
    // Homebrew removes its launch agent when the service is stopped and keeps
    // the definition in the formula, so only its own command starts it again.
    for (const prefix of HOMEBREW_PREFIXES) {
      const brew = join(prefix, 'bin', 'brew');
      if (
        !(await deps.executable(join(prefix, 'opt', 'ollama', 'bin', 'ollama'))) ||
        !(await deps.executable(brew))
      ) {
        continue;
      }
      try {
        await deps.exec(brew, ['services', 'start', 'ollama']);
      } catch (error) {
        return { refused: `Homebrew did not start the ollama service: ${errorText(error)}.` };
      }
      return { how: 'Started the ollama Homebrew service', log: `${prefix}/var/log/ollama.log` };
    }
    const agentsDir = join(deps.home, 'Library', 'LaunchAgents');
    const agent = (await deps.list(agentsDir)).find(
      (name) => /ollama/i.test(name) && name.endsWith('.plist'),
    );
    if (agent !== undefined) {
      const label = basename(agent, '.plist');
      const domain = `gui/${deps.uid}`;
      // Loaded unless it was stopped through its manager, which unloads it;
      // loading one already loaded fails, and the start below is what counts.
      await deps
        .exec('launchctl', ['bootstrap', domain, join(agentsDir, agent)])
        .catch(() => undefined);
      try {
        await deps.exec('launchctl', ['kickstart', `${domain}/${label}`]);
      } catch (error) {
        return { refused: `The ${label} service did not start: ${errorText(error)}.` };
      }
      return { how: `Started the ${label} service`, log: 'the service’s log' };
    }
    for (const app of ['/Applications/Ollama.app', join(deps.home, 'Applications', 'Ollama.app')]) {
      if (!(await deps.exists(app))) continue;
      try {
        await deps.exec('open', ['-g', '-a', app]);
      } catch (error) {
        return { refused: `The Ollama app did not open: ${errorText(error)}.` };
      }
      return { how: 'Opened the Ollama app', log: '~/.ollama/logs' };
    }
  }
  if (deps.platform === 'linux') {
    if (await deps.exists(join(deps.home, '.config', 'systemd', 'user', 'ollama.service'))) {
      try {
        await deps.exec('systemctl', ['--user', 'start', 'ollama']);
      } catch (error) {
        return { refused: `The ollama user service did not start: ${errorText(error)}.` };
      }
      return { how: 'Started the ollama user service', log: '`journalctl --user -u ollama`' };
    }
    for (const unit of SYSTEM_UNITS) {
      if (await deps.exists(unit)) {
        return {
          refused:
            'Ollama is installed here as a system service, which only an administrator starts: run `sudo systemctl start ollama`.',
        };
      }
    }
  }
  const binary = await findBinary(deps);
  if (binary === undefined) {
    return { refused: `Ollama is not installed on this computer. Get it from ${DOWNLOAD}.` };
  }
  deps.serve(binary, serveEnv(port));
  return { how: `Started \`ollama serve\` (${binary})`, log: '~/.ollama/logs/server.log' };
}

export async function startLocalRuntime(
  port: number,
  deps: RuntimeStartDeps = defaultDeps(),
): Promise<HostRuntimeAnswer> {
  if (await deps.answers(port)) return { kind: 'started', message: 'Ollama is already running.' };
  const started = await start(port, deps);
  if ('refused' in started) return { kind: 'refused', message: started.refused };
  if (await waitForAnswer(deps, port)) return { kind: 'started', message: `${started.how}.` };
  return {
    kind: 'refused',
    message: `${started.how}, and it has not answered on port ${port} after ${deps.waitMs / 1000} seconds. Its log is ${started.log}.`,
  };
}
