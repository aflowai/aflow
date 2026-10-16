/**
 * Contract: the git the executor runs in a run's checkout after the run reads
 * the git directory the executor made for it, whatever the coding agent left in
 * the checkout — and runs no program the agent chose.
 *
 * The agent, confined, plants what would otherwise reach that git: a write of a
 * `commondir` and a filter into the clone's git directory, the checkout's `.git`
 * rewritten to a git directory of its own whose `commondir` names a repository
 * it built in its scratch with a `filter.<x>.clean` defined, and a
 * `.gitattributes` naming that filter. Staging and the apply check then run
 * outside the sandbox, with this process's PATH and HOME.
 *
 * The proof is a filter that leaves evidence where the sandbox cannot write: if
 * it ever runs, it ran unconfined. And the same plant is shown to bite a git
 * that resolves the checkout through its `.git`, with the safety arguments the
 * executor's own git carries — so the test passing means the executor looked
 * elsewhere, not that the plant was inert.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHostHarnessHandler } from '../handlers/harnessHandlers.js';
import { sandboxReadiness } from '../sandboxedRun.js';
import { removeWorktree } from '../worktree.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const run = promisify(execFile);
const confined = requires(...CONFINEMENT_LISTENERS);

let base: string;
let repo: string;
let evidence: string;
let policyPath: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout.trim();
}

/** The agent's whole turn: plant, record what the sandbox allowed, and leave. */
function plantingScript(evidencePath: string): string {
  return [
    'gd=$(sed -n "s/^gitdir: //p" .git)',
    'agent="$TMPDIR/agent"',
    'git init -q "$agent"',
    `printf '#!/bin/sh\\ntouch %s\\ncat\\n' '${evidencePath}' > "$TMPDIR/filter.sh"`,
    'chmod +x "$TMPDIR/filter.sh"',
    'git -C "$agent" config filter.pwn.clean "$TMPDIR/filter.sh"',
    'git -C "$agent" config filter.pwn.smudge "$TMPDIR/filter.sh"',
    '{ echo "checkout=$PWD"',
    '  printf "%s\\n" "$agent/.git" > "$gd/commondir" && echo commondir-written || echo commondir-refused',
    '  printf "[filter \\"pwn\\"]\\n\\tclean = %s\\n" "$TMPDIR/filter.sh" >> "$gd/config" ' +
      '&& echo config-written || echo config-refused',
    '} > planted.txt 2>/dev/null',
    'mkdir -p "$TMPDIR/moved"',
    'echo "ref: refs/heads/main" > "$TMPDIR/moved/HEAD"',
    'printf "%s\\n" "$agent/.git" > "$TMPDIR/moved/commondir"',
    'printf "gitdir: %s\\n" "$TMPDIR/moved" > .git',
    "echo '* filter=pwn' > .gitattributes",
    "echo 'added by the agent' > added.txt",
  ].join('\n');
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-checkout-gitdir-'));
  repo = join(base, 'project');
  evidence = join(base, 'THE-FILTER-RAN');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'initial');

  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
      harnesses: [
        {
          id: 'plants',
          executable: '/bin/sh',
          args: ['-c', plantingScript(evidence)],
          // A session keeps the checkout as the agent left it, so the plant can
          // be shown to bite afterwards.
          sessionArgs: ['{session}'],
          resumeArgs: ['{session}'],
        },
      ],
    }),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe.runIf(sandboxReadiness().ready)("the executor's git in a run's checkout", () => {
  it.skipIf(confined.skip)(
    confined.title(
      'stages and judges the run through the git directory it made, running no program the agent planted',
    ),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const written: Record<string, unknown> = {};
      const outcome = await createHostHarnessHandler(policyPath).execute({
        operationId: 'host.harness.run',
        spaceId: 'space-test',
        runId: 'run-checkout-gitdir',
        job: { inputRef: 'inline:x' },
        signal: new AbortController().signal,
        log: { error: () => undefined, warn: () => undefined, info: () => undefined },
        readPayload: () =>
          Promise.resolve({
            bindingId: 'hb',
            harness: 'plants',
            task: 'Plant.',
            timeoutMs: 60_000,
            // A named base, so the apply check runs in the clone too.
            base: 'main',
          }),
        emitLiveDelta: () => Promise.resolve(),
        writePayload: (kind: string, data: unknown) => {
          written[kind] = data;
          return Promise.resolve(`inline:${kind}`);
        },
      } as never);
      expect(outcome.status).toBe('SUCCEEDED');
      const output = written['output'] as Record<string, unknown>;
      const patch = String(output['patch']);
      const checkout = /^\+checkout=(.+)$/m.exec(patch)?.[1];
      expect(checkout).toBeDefined();
      try {
        // The sandbox refused both writes into the clone's git directory.
        expect(patch).toContain('+commondir-refused\n');
        expect(patch).toContain('+config-refused\n');

        // Nothing ran: collection staged `.gitattributes` and the files it
        // selects, and the apply check read them, and neither found the filter.
        expect(existsSync(evidence)).toBe(false);

        // Read through the executor's git directory: the diff is against the
        // base the clone checked out, holding only what the agent wrote — read
        // through the agent's repository, whose index is empty, README.md would
        // be an addition too — and the base commit the apply check reads
        // exists only there, so a check through the agent's repository could
        // not have answered `clean`.
        expect(output['baseSha']).toBe(await git(repo, 'rev-parse', 'main'));
        expect(output['filesChanged']).toBe(3);
        for (const file of ['.gitattributes', 'added.txt', 'planted.txt']) {
          expect(patch).toContain(`+++ b/${file}\n`);
        }
        expect(patch).not.toContain('b/README.md');
        expect(output['applies']).toBe('clean');

        // The plant was real: a git resolving the checkout through its `.git`,
        // carrying the same safety arguments and no global or system config,
        // runs the agent's program.
        await run(
          'git',
          [
            '-C',
            checkout ?? '',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=',
            '-c',
            'protocol.ext.allow=never',
            'add',
            '-A',
          ],
          {
            env: {
              PATH: process.env['PATH'] ?? '',
              HOME: process.env['HOME'] ?? '',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
            },
          },
        );
        expect(existsSync(evidence)).toBe(true);
      } finally {
        if (checkout !== undefined) {
          await removeWorktree(checkout);
          await rm(dirname(checkout), { recursive: true, force: true });
        }
      }
    },
  );
});
