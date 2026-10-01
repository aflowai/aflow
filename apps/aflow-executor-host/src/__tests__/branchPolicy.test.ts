/**
 * Contract: a folder pushes only where the operator said it may, and only
 * forward.
 *
 * The push rule is read from an argv rather than enforced by the sandbox,
 * because the effect of a push lands outside the boundary the sandbox can see —
 * and because what passes the rule then runs as the operator's own git, with
 * their remotes and their keys. That makes the parsing itself load-bearing:
 * every way of spelling a force, a deletion, another repository or a program to
 * run is a way past the rule if it is not read here.
 */
import { describe, expect, it } from 'vitest';

import {
  type HostBinding,
  HostBindingError,
  HostBindingSchema,
  isGitPush,
  type PushJobShape,
  requirePushAllowed,
} from '../bindings.js';
import { DEFAULT_BRANCH_PREFIX, resolveBranchPrefix } from '../interview.js';

function bindingWith(branchPrefix?: string): HostBinding {
  return HostBindingSchema.parse({
    id: 'hb',
    root: '/tmp/project',
    mode: 'readwrite',
    allowsExecution: true,
    spaceId: 'space-test',
    ...(branchPrefix !== undefined ? { branchPolicy: { branchPrefix } } : {}),
  });
}

const allowed = bindingWith('aflow/');

function refusalFor(
  binding: HostBinding,
  argv: readonly string[],
  job?: PushJobShape,
): HostBindingError {
  try {
    requirePushAllowed(binding, argv, job);
  } catch (error) {
    if (error instanceof HostBindingError) return error;
    throw error;
  }
  throw new Error(`\`${argv.join(' ')}\` was allowed, and this expected a refusal.`);
}

describe('what a push may be', () => {
  const refused: Array<[string, readonly string[], HostBinding]> = [
    ['a folder with no prefix pushes nothing', ['git', 'push', 'origin', 'aflow/x'], bindingWith()],
    [
      'another repository, by -C',
      ['git', '-C', '/elsewhere', 'push', 'origin', 'aflow/x'],
      allowed,
    ],
    [
      'another repository, by --git-dir',
      ['git', '--git-dir=/elsewhere/.git', 'push', 'origin', 'aflow/x'],
      allowed,
    ],
    [
      'another repository, by --work-tree',
      ['git', '--work-tree', '/elsewhere', 'push', 'origin', 'aflow/x'],
      allowed,
    ],
    // A push runs as the operator's own git, so nothing stands before `push` —
    // each of these chooses a program, a config source or a repository for an
    // unconfined process.
    ['a global -c', ['git', '-c', 'core.x=y', 'push', 'origin', 'aflow/x'], allowed],
    [
      'a global --config-env',
      ['git', '--config-env=core.x=ENVVAR', 'push', 'origin', 'aflow/x'],
      allowed,
    ],
    ['a global --exec-path', ['git', '--exec-path=/tmp/bin', 'push', 'origin', 'aflow/x'], allowed],
    ['a global --namespace', ['git', '--namespace', 'ns', 'push', 'origin', 'aflow/x'], allowed],
    [
      'a global --super-prefix',
      ['git', '--super-prefix', 'sub/', 'push', 'origin', 'aflow/x'],
      allowed,
    ],
    [
      'a global --attr-source',
      ['git', '--attr-source', 'HEAD', 'push', 'origin', 'aflow/x'],
      allowed,
    ],
    ['a global flag', ['git', '--no-pager', 'push', 'origin', 'aflow/x'], allowed],
    [
      '--receive-pack, which names a program on the remote',
      ['git', 'push', '--receive-pack=/tmp/anything', 'origin', 'aflow/x'],
      allowed,
    ],
    [
      '--exec, which is the same option spelled differently',
      ['git', 'push', '--exec', '/tmp/anything', 'origin', 'aflow/x'],
      allowed,
    ],
    [
      '--repo, which names another repository',
      ['git', 'push', '--repo', '/elsewhere', 'origin', 'aflow/x'],
      allowed,
    ],
    ['-f', ['git', 'push', '-f', 'origin', 'aflow/x'], allowed],
    ['--force', ['git', 'push', '--force', 'origin', 'aflow/x'], allowed],
    ['--force-with-lease', ['git', 'push', '--force-with-lease', 'origin', 'aflow/x'], allowed],
    [
      '--force-with-lease with a value',
      ['git', 'push', '--force-with-lease=aflow/x:abc123', 'origin', 'aflow/x'],
      allowed,
    ],
    ['--force-if-includes', ['git', 'push', '--force-if-includes', 'origin', 'aflow/x'], allowed],
    ['a short cluster carrying a force', ['git', 'push', '-fu', 'origin', 'aflow/x'], allowed],
    ['-d', ['git', 'push', '-d', 'origin', 'aflow/x'], allowed],
    ['--delete', ['git', 'push', '--delete', 'origin', 'aflow/x'], allowed],
    ['--mirror', ['git', 'push', '--mirror', 'origin'], allowed],
    ['--all', ['git', 'push', '--all', 'origin'], allowed],
    ['--tags', ['git', 'push', '--tags', 'origin'], allowed],
    ['--prune', ['git', 'push', '--prune', 'origin', 'aflow/x'], allowed],
    ['a forced refspec', ['git', 'push', 'origin', '+aflow/x'], allowed],
    ['a deleting refspec', ['git', 'push', 'origin', ':aflow/x'], allowed],
    ['a branch outside the prefix', ['git', 'push', 'origin', 'main'], allowed],
    ['a destination outside the prefix', ['git', 'push', 'origin', 'HEAD:main'], allowed],
    [
      'a full branch ref outside the prefix',
      ['git', 'push', 'origin', `${'c'.repeat(40)}:refs/heads/main`],
      allowed,
    ],
    [
      'a tag spelled under the prefix',
      ['git', 'push', 'origin', `${'c'.repeat(40)}:refs/tags/aflow/x`],
      allowed,
    ],
    [
      'one refspec inside the prefix and one outside',
      ['git', 'push', 'origin', 'aflow/x', 'main'],
      allowed,
    ],
    ['a push that names nothing', ['git', 'push'], allowed],
    ['a push that names only a remote', ['git', 'push', 'origin'], allowed],
  ];

  it.each(refused)('refuses %s', (_name, argv, binding) => {
    const error = refusalFor(binding, argv);
    expect(error.kind).toBe('push_refused');
    // The refusal names the command that was refused and what to do instead;
    // a refusal nobody can act on costs a turn and teaches nothing.
    expect(error.message).toContain(argv.join(' '));
    expect(error.message.length).toBeGreaterThan(argv.join(' ').length + 20);
  });

  const accepted: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['a named branch under the prefix', ['git', 'push', '-u', 'origin', 'aflow/x']],
    ['HEAD onto a branch under the prefix', ['git', 'push', 'origin', 'HEAD:aflow/x']],
    [
      'a commit onto a full branch ref under the prefix',
      ['git', 'push', '--set-upstream', 'origin', `${'c'.repeat(40)}:refs/heads/aflow/x`],
    ],
    ['git reached by an absolute path', ['/usr/bin/git', 'push', 'origin', 'aflow/x']],
    ['--set-upstream spelled out', ['git', 'push', '--set-upstream', 'origin', 'aflow/x']],
    ['a push option', ['git', 'push', '-o', 'ci.skip', 'origin', 'aflow/x']],
    [
      'a push option carrying its value',
      ['git', 'push', '--push-option=ci.skip', 'origin', 'aflow/x'],
    ],
    ['quietly', ['git', 'push', '-q', 'origin', 'aflow/x']],
    ['verbosely', ['git', 'push', '-v', 'origin', 'aflow/x']],
    ['reporting in porcelain', ['git', 'push', '--porcelain', 'origin', 'aflow/x']],
    ['the operator’s own hooks being skipped', ['git', 'push', '--no-verify', 'origin', 'aflow/x']],
  ];

  it.each(accepted)('allows %s', (_name, argv) => {
    expect(() => {
      requirePushAllowed(allowed, argv);
    }).not.toThrow();
  });

  it('leaves everything that is not a push alone', () => {
    // The rule reads one subcommand. A folder that allows commands still allows
    // them, and a binding with no prefix is not thereby a read-only folder.
    for (const binding of [allowed, bindingWith()]) {
      expect(() => {
        requirePushAllowed(binding, ['git', 'status']);
      }).not.toThrow();
      expect(() => {
        requirePushAllowed(binding, ['git', 'commit', '-m', 'push']);
      }).not.toThrow();
      expect(() => {
        requirePushAllowed(binding, ['npm', 'run', 'push']);
      }).not.toThrow();
      // The tightening is on pushes only: everything else is still confined, so
      // a global option and an environment of its own are exactly what this lane
      // is for.
      expect(() => {
        requirePushAllowed(binding, ['git', '-c', 'core.x=y', 'log', '-1'], {
          env: { CI: '1' },
          detach: true,
        });
      }).not.toThrow();
    }
  });

  it('refuses an environment on a push, whatever it names', () => {
    // A push runs in the executor's own environment, which is the operator's.
    // `GIT_SSH_COMMAND` or `GIT_CONFIG_*` from a job would be a program of the
    // job's choosing, and no deny list of names is the boundary here.
    const error = refusalFor(allowed, ['git', 'push', 'origin', 'aflow/x'], {
      env: { GIT_SSH_COMMAND: '/tmp/ssh', TERM: 'dumb' },
    });
    expect(error.kind).toBe('push_refused');
    expect(error.message).toContain('GIT_SSH_COMMAND');
    expect(error.message).toContain('TERM');
  });

  it('refuses a detached push, because a push is waited for', () => {
    const error = refusalFor(allowed, ['git', 'push', 'origin', 'aflow/x'], { detach: true });
    expect(error.kind).toBe('push_refused');
    expect(error.message).toContain('detach');
  });

  it('recognises the pushes it permits, and nothing else', () => {
    // The rule and the path that runs a push unconfined read the same argv
    // through the same parser; a recogniser of its own would eventually disagree.
    expect(isGitPush(['git', 'push', 'origin', 'aflow/x'])).toBe(true);
    expect(isGitPush(['/usr/bin/git', 'push', '-u', 'origin', 'aflow/x'])).toBe(true);
    expect(isGitPush(['git', 'commit', '-m', 'push'])).toBe(false);
    expect(isGitPush(['npm', 'run', 'push'])).toBe(false);
    expect(isGitPush(['git', '--unheard-of', 'push', 'origin', 'aflow/x'])).toBe(false);
    expect(isGitPush([])).toBe(false);
  });

  it('refuses a push it cannot read rather than guessing at it', () => {
    // An option this rule does not know could take the subcommand as its value,
    // and reading `push` as a value is how a push escapes the rule entirely.
    const error = refusalFor(allowed, ['git', '--unheard-of', 'push', 'origin', 'aflow/x']);
    expect(error.kind).toBe('push_refused');
  });
});

describe('which branches a connected folder publishes to', () => {
  const repository = { allowsExecution: true, repository: true, root: '/tmp/project' } as const;

  it('publishes under the default prefix for a repository that runs commands', () => {
    // Nothing is asked: the default reaches a namespace of its own, and every
    // publication pauses for approval anyway.
    expect(resolveBranchPrefix(repository)).toBe(DEFAULT_BRANCH_PREFIX);
  });

  it('publishes nothing from a folder that is not a repository', () => {
    expect(
      resolveBranchPrefix({ allowsExecution: true, repository: false, root: '/tmp/notes' }),
    ).toBeUndefined();
  });

  it('takes the prefix the operator named instead of the default', () => {
    expect(resolveBranchPrefix({ ...repository, requested: 'proposals/' })).toBe('proposals/');
  });

  it('publishes nothing from a folder that runs no commands', () => {
    expect(
      resolveBranchPrefix({ allowsExecution: false, repository: true, root: '/tmp/project' }),
    ).toBeUndefined();
  });

  it('refuses a named prefix on a folder that is not a repository', () => {
    // There is no history for the rule to govern, so recording it would declare
    // an authority that could never be exercised.
    expect(() =>
      resolveBranchPrefix({
        requested: 'aflow/',
        allowsExecution: true,
        repository: false,
        root: '/tmp/notes',
      }),
    ).toThrow(/`\/tmp\/notes` is not a git repository/);
  });

  it('refuses a named prefix on a folder that runs nothing, rather than widening it', () => {
    // A push is a command.
    expect(() =>
      resolveBranchPrefix({
        requested: 'aflow/',
        allowsExecution: false,
        repository: true,
        root: '/tmp/project',
      }),
    ).toThrow(/--run/);
  });

  it('refuses a prefix that is not a name', () => {
    for (const requested of ['-oops', 'has space', 'up/../out']) {
      expect(() => resolveBranchPrefix({ ...repository, requested })).toThrow();
    }
  });
});
