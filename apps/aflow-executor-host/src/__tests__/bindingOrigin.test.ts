/**
 * Contract: a connected folder's inspection names the GitHub repository its
 * `origin` fetches from, as the operator's own git resolves the URL, so a
 * skill calls GitHub for the repository the folder pushes to without being
 * told it; a folder whose `origin` is elsewhere, or which has none, names
 * none.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

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

describe('host.binding.inspect — the folder’s GitHub origin', () => {
  let policyPath: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'binding-origin-'));
    policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          binding(
            'hb_github',
            await repository(base, 'github', 'git@github.com:aflowai/aflow.git'),
          ),
          binding('hb_gitlab', await repository(base, 'gitlab', 'https://gitlab.com/a/b.git')),
          binding('hb_none', await repository(base, 'none')),
        ],
      }),
    );
  });

  async function inspect(bindingId: string): Promise<unknown> {
    let output: unknown;
    const result = await createHostHandler(policyPath, noPushApprovals).execute({
      operationId: 'host.binding.inspect',
      spaceId: 'space-a',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId }),
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

  it.each(['hb_gitlab', 'hb_none'])('names none for %s', async (bindingId) => {
    expect(await inspect(bindingId)).not.toHaveProperty('origin');
  });
});
