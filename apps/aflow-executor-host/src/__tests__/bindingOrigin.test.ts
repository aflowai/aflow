/**
 * Contract: a connected folder's inspection names the GitHub repository its
 * `origin` fetches from, as the operator's own git resolves the URL, and, for a
 * caller that asks, the branch `origin`'s HEAD names — recorded in the folder,
 * else asked of `origin` — so a skill calls GitHub for the repository the folder pushes to,
 * and targets its default branch, without being told either; a folder whose
 * `origin` is elsewhere, or which has none, names none, and a default branch
 * nothing can say is left out rather than guessed.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HostBindingInspectOutputSchema } from '@aflow/schemas';

import { createHostHandler } from '../handlers/hostHandler.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

const run = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<void> {
  await run('git', [`--git-dir=${join(repo, '.git')}`, `--work-tree=${repo}`, ...args]);
}

async function repository(base: string, name: string, origin?: string): Promise<string> {
  const root = join(base, name);
  await mkdir(root);
  await run('git', ['init', '-q', root]);
  if (origin !== undefined) await git(root, 'remote', 'add', 'origin', origin);
  return root;
}

function binding(id: string, root: string) {
  return {
    id,
    root,
    mode: 'readwrite',
    allowsExecution: true,
    branchPolicy: { branchPrefix: 'aflow/' },
    spaceId: 'space-a',
  };
}

const GITHUB_ORIGIN = 'git@github.com:aflowai/aflow.git';

/**
 * An ssh that never reaches github.com: without `upstream` it refuses every
 * connection, with one it answers as though `upstream` were the repository
 * asked for. `-G` is git asking which ssh this is; failing it makes it a
 * plain one.
 */
async function fakeSsh(base: string, name: string, upstream?: string): Promise<string> {
  const path = join(base, name);
  const body =
    upstream === undefined
      ? 'echo "ssh: connect to host github.com: Connection refused" >&2\nexit 255\n'
      : `exec git upload-pack '${upstream}'\n`;
  await writeFile(
    path,
    `#!/bin/sh\ncase "$1" in -G) exit 1;; esac\necho "$@" >> '${path}.calls'\n${body}`,
  );
  await chmod(path, 0o755);
  return path;
}

/**
 * The executor reaches a remote with the operator's global git config, where
 * an `insteadOf` rewriting GitHub's ssh URLs to https would take the fake ssh
 * out of the path and reach the real github.com. The global config is an
 * empty file for the suite and `XDG_CONFIG_HOME` is dropped. The system
 * config cannot be replaced from here — the executor withholds
 * `GIT_CONFIG_SYSTEM` — so every proxy variable names a closed local port:
 * a rewrite there to https fails on this machine rather than leaving it.
 */
const CLOSED_PROXY = 'http://127.0.0.1:9';
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const ISOLATED_ENV = [
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'XDG_CONFIG_HOME',
  'NO_PROXY',
  'no_proxy',
  ...PROXY_ENV,
];

describe('host.binding.inspect — the folder’s GitHub origin', () => {
  let policyPath: string;
  let unreachable: string;
  let serving: string;
  const prior = new Map(ISOLATED_ENV.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'binding-origin-'));
    policyPath = join(base, 'host-policy.json');
    const emptyConfig = join(base, 'gitconfig');
    await writeFile(emptyConfig, '');
    process.env['GIT_CONFIG_GLOBAL'] = emptyConfig;
    delete process.env['XDG_CONFIG_HOME'];
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
    for (const name of PROXY_ENV) process.env[name] = CLOSED_PROXY;

    // The repository on `origin`, whose HEAD names `trunk`.
    const upstream = join(base, 'upstream.git');
    await run('git', ['init', '-q', '--bare', upstream]);
    await run('git', [`--git-dir=${upstream}`, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    const seed = await repository(base, 'seed', upstream);
    await git(seed, 'config', 'user.email', 'seed@example.com');
    await git(seed, 'config', 'user.name', 'Seed');
    await writeFile(join(seed, 'a.txt'), 'a\n');
    await git(seed, 'add', 'a.txt');
    await git(seed, 'commit', '-qm', 'seed');
    await git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk');

    unreachable = await fakeSsh(base, 'ssh-unreachable');
    serving = await fakeSsh(base, 'ssh-serving', upstream);
    process.env['GIT_SSH_COMMAND'] = unreachable;

    // A clone records `origin`'s HEAD; this folder records `develop`.
    const recorded = await repository(base, 'recorded', GITHUB_ORIGIN);
    await git(recorded, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');

    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          binding('hb_github', await repository(base, 'github', GITHUB_ORIGIN)),
          binding('hb_recorded', recorded),
          binding('hb_gitlab', await repository(base, 'gitlab', 'https://gitlab.com/a/b.git')),
          binding('hb_none', await repository(base, 'none')),
        ],
      }),
    );
  });

  afterAll(() => {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function inspect(bindingId: string, defaultBranch?: boolean): Promise<unknown> {
    let output: unknown;
    const result = await createHostHandler(policyPath, noPushApprovals).execute({
      operationId: 'host.binding.inspect',
      spaceId: 'space-a',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve(defaultBranch === undefined ? { bindingId } : { bindingId, defaultBranch }),
      writePayload: (_kind: string, data: unknown) => {
        output = data;
        return Promise.resolve('inline:out');
      },
    } as never);
    expect(result.status).toBe('SUCCEEDED');
    return HostBindingInspectOutputSchema.parse(output);
  }

  it('names the owner and repository of a GitHub origin', async () => {
    expect(await inspect('hb_github')).toMatchObject({
      origin: { owner: 'aflowai', repo: 'aflow' },
    });
  });

  it("names the default branch the folder recorded for `origin`'s HEAD, without asking `origin`", async () => {
    // `origin` is unreachable here, so the branch can only come from the folder.
    expect(await inspect('hb_recorded', true)).toMatchObject({
      origin: { owner: 'aflowai', repo: 'aflow', defaultBranch: 'develop' },
    });
  });

  it('asks `origin` which branch its HEAD names where the folder recorded none', async () => {
    process.env['GIT_SSH_COMMAND'] = serving;
    try {
      expect(await inspect('hb_github', true)).toMatchObject({
        origin: { owner: 'aflowai', repo: 'aflow', defaultBranch: 'trunk' },
      });
    } finally {
      process.env['GIT_SSH_COMMAND'] = unreachable;
    }
  });

  it('leaves the default branch out where `origin` cannot be asked, and never guesses one', async () => {
    const inspected = (await inspect('hb_github', true)) as { origin?: Record<string, unknown> };
    expect(inspected.origin).toEqual({ owner: 'aflowai', repo: 'aflow' });
  });

  it('reads no default branch, and asks `origin` nothing, for a caller that does not ask for it', async () => {
    await rm(`${serving}.calls`, { force: true });
    process.env['GIT_SSH_COMMAND'] = serving;
    try {
      for (const bindingId of ['hb_github', 'hb_recorded']) {
        for (const asked of [undefined, false]) {
          const inspected = (await inspect(bindingId, asked)) as {
            origin?: Record<string, unknown>;
          };
          expect(inspected.origin).toEqual({ owner: 'aflowai', repo: 'aflow' });
        }
      }
      expect(existsSync(`${serving}.calls`)).toBe(false);
    } finally {
      process.env['GIT_SSH_COMMAND'] = unreachable;
    }
  });

  it.each(['hb_gitlab', 'hb_none'])('names none for %s', async (bindingId) => {
    expect(await inspect(bindingId)).not.toHaveProperty('origin');
  });
});
