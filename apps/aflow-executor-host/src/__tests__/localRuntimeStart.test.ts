import { describe, expect, it } from 'vitest';

import { startLocalRuntime, type RuntimeStartDeps } from '../localRuntimeStart.js';

interface Machine {
  files?: string[];
  agents?: string[];
  running?: boolean;
  /** Commands that fail, by their first argument. */
  failing?: string[];
}

/** A machine with the given files, whose runtime answers once something has started it. */
function machine(setup: Machine & Partial<RuntimeStartDeps> = {}) {
  const files = new Set(setup.files ?? []);
  let running = setup.running ?? false;
  const ran: string[] = [];
  const served: Array<{ binary: string; env: Record<string, string> }> = [];
  const starts = (command: string, args: readonly string[]) =>
    command === 'open' ||
    (command === 'launchctl' && args[0] === 'kickstart') ||
    command === 'systemctl' ||
    command.endsWith('/brew');
  const deps: RuntimeStartDeps = {
    platform: 'darwin',
    home: '/Users/op',
    uid: 501,
    searchPath: ['/opt/homebrew/bin', '/usr/local/bin'],
    exists: async (path) => files.has(path),
    executable: async (path) => files.has(path),
    list: async (dir) => (dir === '/Users/op/Library/LaunchAgents' ? (setup.agents ?? []) : []),
    exec: async (command, args) => {
      ran.push([command, ...args].join(' '));
      if (setup.failing?.includes(args[0] ?? command)) throw new Error(`${command} failed`);
      if (starts(command, args)) running = true;
    },
    serve: (binary, env) => {
      served.push({ binary, env });
      running = true;
    },
    answers: async () => running,
    sleep: async () => undefined,
    waitMs: 2_000,
    ...setup,
  };
  return { deps, ran, served };
}

describe('starting Ollama on this machine', () => {
  it('starts a Homebrew install through Homebrew, which reinstalls the agent it removed on stop', async () => {
    const { deps, ran, served } = machine({
      files: [
        '/opt/homebrew/opt/ollama/bin/ollama',
        '/opt/homebrew/bin/brew',
        '/opt/homebrew/bin/ollama',
        '/Applications/Ollama.app',
      ],
    });

    const answer = await startLocalRuntime(11434, deps);

    expect(answer).toEqual({
      kind: 'started',
      message: 'Started the ollama Homebrew service.',
    });
    expect(ran).toEqual(['/opt/homebrew/bin/brew services start ollama']);
    expect(served).toHaveLength(0);
  });

  it('starts an installed launch agent as that service, so its settings hold', async () => {
    const { deps, ran, served } = machine({
      agents: ['sh.brew.ollama.plist', 'com.other.plist'],
      files: ['/Applications/Ollama.app', '/opt/homebrew/bin/ollama'],
    });

    const answer = await startLocalRuntime(11434, deps);

    expect(answer).toEqual({ kind: 'started', message: 'Started the sh.brew.ollama service.' });
    expect(ran).toEqual([
      'launchctl bootstrap gui/501 /Users/op/Library/LaunchAgents/sh.brew.ollama.plist',
      'launchctl kickstart gui/501/sh.brew.ollama',
    ]);
    expect(served).toHaveLength(0);
  });

  it('starts a launch agent that is already loaded, whose bootstrap fails', async () => {
    const { deps } = machine({ agents: ['sh.brew.ollama.plist'], failing: ['bootstrap'] });

    expect(await startLocalRuntime(11434, deps)).toMatchObject({ kind: 'started' });
  });

  it('opens the macOS app where no service is installed', async () => {
    const { deps, ran } = machine({ files: ['/Applications/Ollama.app'] });

    expect(await startLocalRuntime(11434, deps)).toEqual({
      kind: 'started',
      message: 'Opened the Ollama app.',
    });
    expect(ran).toEqual(['open -g -a /Applications/Ollama.app']);
  });

  it('starts a Linux user unit through systemd', async () => {
    const { deps, ran } = machine({
      platform: 'linux',
      files: ['/Users/op/.config/systemd/user/ollama.service', '/usr/local/bin/ollama'],
    });

    expect(await startLocalRuntime(11434, deps)).toMatchObject({ kind: 'started' });
    expect(ran).toEqual(['systemctl --user start ollama']);
  });

  it('leaves a system service to the administrator, and says how', async () => {
    const { deps, served } = machine({
      platform: 'linux',
      files: ['/etc/systemd/system/ollama.service', '/usr/local/bin/ollama'],
    });

    const answer = await startLocalRuntime(11434, deps);

    expect(answer).toMatchObject({ kind: 'refused' });
    expect(answer.message).toContain('sudo systemctl start ollama');
    expect(served).toHaveLength(0);
  });

  it('runs `ollama serve` without the executor’s own credentials where nothing else is installed', async () => {
    process.env['REDIS_URL'] = 'redis://:secret@127.0.0.1:6379';
    const { deps, served } = machine({ platform: 'linux', files: ['/usr/local/bin/ollama'] });

    const answer = await startLocalRuntime(11500, deps);

    expect(answer.kind).toBe('started');
    expect(served[0]?.binary).toBe('/usr/local/bin/ollama');
    expect(served[0]?.env['REDIS_URL']).toBeUndefined();
    expect(served[0]?.env['OLLAMA_HOST']).toBe('127.0.0.1:11500');
    delete process.env['REDIS_URL'];
  });

  it('points at the download where Ollama is not installed', async () => {
    const answer = await startLocalRuntime(11434, machine().deps);

    expect(answer).toMatchObject({ kind: 'refused' });
    expect(answer.message).toContain('https://ollama.com/download');
  });

  it('starts nothing when the runtime already answers', async () => {
    const { deps, ran, served } = machine({ running: true, agents: ['sh.brew.ollama.plist'] });

    expect(await startLocalRuntime(11434, deps)).toMatchObject({ kind: 'started' });
    expect(ran).toHaveLength(0);
    expect(served).toHaveLength(0);
  });

  it('says where to look when what it started never answers', async () => {
    const { deps } = machine({ files: ['/Applications/Ollama.app'], answers: async () => false });

    const answer = await startLocalRuntime(11434, deps);

    expect(answer).toMatchObject({ kind: 'refused' });
    expect(answer.message).toContain('~/.ollama/logs');
  });
});
