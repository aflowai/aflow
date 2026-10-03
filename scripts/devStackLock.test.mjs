import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ancestorPids,
  parseParentMap,
  parseStackProcesses,
  profileConflicts,
  stackConflictMessage,
  worktreeOfCommand,
} from './devStackLock.mjs';

const NODE = '/home/dev/.nvm/versions/node/v22.16.0/bin/node';
const WORKTREE = '/home/dev/src/aflow-worktrees/topic';
const MAIN = '/home/dev/src/aflow';

/**
 * `ps ax -o pid=,command=` output, in the shapes it actually produces: a node
 * binary reached through a version manager, a supervisor started by its wrapper,
 * a child carrying tsx's preflight as an absolute `--require`, and one process
 * belonging to a different checkout. The paths are synthetic; only their shape is
 * load-bearing, because the worktree is derived from the `node_modules` prefix.
 */
const PS_TWO_STACKS = [
  `68670 ${NODE} /home/dev/.nvm/versions/node/v22.16.0/bin/yarn dev:local`,
  `68715 ${WORKTREE}/node_modules/.bin/tsx scripts/dev-local.ts`,
  `68963 ${NODE} scripts/dev.mjs --profile local`,
  `69122 ${NODE} --require ${WORKTREE}/node_modules/tsx/dist/preflight.cjs ${WORKTREE}/apps/aflow-orchestrator/src/index.ts`,
  `62988 ${NODE} ${MAIN}/scripts/dev.mjs --profile mcp`,
  `51625 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/153.0.801/Helpers/chrome_crashpad_handler`,
].join('\n');

describe('worktreeOfCommand', () => {
  it('reads the checkout from a repository-internal path', () => {
    expect(worktreeOfCommand(`${WORKTREE}/node_modules/.bin/tsx scripts/dev-local.ts`)).toBe(
      WORKTREE,
    );
    expect(worktreeOfCommand(`${NODE} ${MAIN}/apps/aflow-orchestrator/src/index.ts`)).toBe(MAIN);
  });

  it('answers undefined rather than guessing when no path names one', () => {
    expect(worktreeOfCommand(`${NODE} scripts/dev.mjs --profile local`)).toBeUndefined();
  });
});

describe('parseStackProcesses', () => {
  it('finds the supervisors and the orchestrator, and identifies the worktree', () => {
    const found = parseStackProcesses(PS_TWO_STACKS);
    expect(found.map((p) => p.pid).sort()).toEqual([68715, 68963, 69122]);
    expect(found.find((p) => p.pid === 69122)).toMatchObject({
      kind: 'orchestrator',
      worktree: WORKTREE,
    });
  });

  it('counts supervisors, because killing only the workers lets them restart', () => {
    const found = parseStackProcesses(PS_TWO_STACKS);
    expect(found.filter((p) => p.kind === 'supervisor').map((p) => p.pid)).toContain(68715);
  });

  it('leaves the mcp profile alone — it composes no orchestrator and outlives restarts', () => {
    const found = parseStackProcesses(PS_TWO_STACKS);
    expect(found.map((p) => p.pid)).not.toContain(62988);
  });

  it('does not mistake an unrelated process for a stack', () => {
    const found = parseStackProcesses(PS_TWO_STACKS);
    expect(found.map((p) => p.pid)).not.toContain(51625);
  });

  it('ignores the pids it is told to, so a start never refuses itself', () => {
    const found = parseStackProcesses(PS_TWO_STACKS, { ignorePids: [68963, 68715, 69122] });
    expect(found).toEqual([]);
  });

  it('reports nothing on a machine with no stack', () => {
    expect(
      parseStackProcesses('  1 /sbin/launchd\n 51625 /Applications/Google Chrome.app'),
    ).toEqual([]);
  });
});

describe('profileConflicts', () => {
  const profiles = {
    local: ['orchestrator', 'server', 'web-local'],
    all: ['orchestrator', 'server', 'web'],
    api: ['server'],
    mcp: ['mcp'],
    engine: ['orchestrator', 'executor-mock'],
  };

  it('is true for any profile composing an orchestrator or a server', () => {
    for (const name of ['local', 'all', 'api', 'engine']) {
      expect(profileConflicts(name, profiles)).toBe(true);
    }
  });

  it('is false for mcp, which is expected to run beside a stack', () => {
    expect(profileConflicts('mcp', profiles)).toBe(false);
  });

  it('is false for a profile the registry does not define', () => {
    expect(profileConflicts('nonexistent', profiles)).toBe(false);
  });
});

describe('stackConflictMessage', () => {
  it('is undefined when nothing is running', () => {
    expect(stackConflictMessage([])).toBeUndefined();
  });

  it('names the other worktree and the pids to stop', () => {
    const message = stackConflictMessage(parseStackProcesses(PS_TWO_STACKS), {
      command: 'yarn dev:local',
    });
    expect(message).toContain(WORKTREE);
    expect(message).toContain('68715');
    expect(message).toContain('yarn kill');
    expect(message).toContain('yarn dev:local');
  });

  it('says why a different port is not the remedy', () => {
    const message = stackConflictMessage(parseStackProcesses(PS_TWO_STACKS));
    expect(message).toContain('consumer group');
  });

  it('says another checkout rather than naming none when no path identifies one', () => {
    const relativeOnly = stackConflictMessage([{ pid: 7, kind: 'supervisor' }]);
    expect(relativeOnly).toContain('another checkout on this machine');
    expect(relativeOnly).not.toContain('undefined');
  });

  it('names every distinct worktree when more than one is running', () => {
    const twoCheckouts = [
      `1 ${WORKTREE}/node_modules/.bin/tsx scripts/dev-local.ts`,
      `2 ${MAIN}/node_modules/.bin/tsx scripts/dev-local.ts`,
    ].join('\n');
    const message = stackConflictMessage(parseStackProcesses(twoCheckouts));
    expect(message).toContain(WORKTREE);
    expect(message).toContain(MAIN);
  });
});

/**
 * The exemption is only true of the profile table that exists, so it is asserted
 * against that table rather than a fixture restating it. `dev.mjs` runs `main()`
 * on import, so the table is read from source.
 */
describe('the real profile table', () => {
  const devRunner = readFileSync(new URL('./dev.mjs', import.meta.url), 'utf8');
  const profiles = Object.fromEntries(
    [...devRunner.matchAll(/^ {2}([a-z-]+): \[([^\]]*)\],$/gms)].map(([, name, body]) => [
      name,
      [...body.matchAll(/'([^']+)'/g)].map(([, service]) => service),
    ]),
  );

  it('was parsed at all, so a table rewrite fails loudly instead of silently passing', () => {
    expect(Object.keys(profiles)).toContain('mcp');
    expect(Object.keys(profiles)).toContain('local');
  });

  it('exempts mcp, which is expected to run beside a stack', () => {
    expect(profileConflicts('mcp', profiles)).toBe(false);
  });

  it('guards local and all, the two profiles that own the shared ports', () => {
    expect(profileConflicts('local', profiles)).toBe(true);
    expect(profileConflicts('all', profiles)).toBe(true);
  });

  /** `.mcp.json` points every session in this checkout at it. */
  it('serves the MCP server from local, which `yarn start` runs', () => {
    expect(profiles['local']).toContain('mcp');
  });
});

/**
 * The ancestry, taken from the real tree a `yarn dev:local` produces.
 *
 * `ps -o pid=,ppid=` for a live invocation: the guard runs in 93307, whose
 * parent is the `tsx` preflight process — the two supervisors matching
 * `scripts/dev-local.ts` are two and three levels further up. Ignoring only the
 * immediate parent made a clean start refuse itself, so the chain is the unit.
 */
describe('ancestry exclusion', () => {
  const PS_PPID = [
    '93185     1',
    '93194 93185',
    '93216 93194',
    '93217 93216',
    '93307 93217',
    '68000     1',
  ].join('\n');

  const PS_COMMAND = [
    '93185 node /home/dev/.nvm/versions/node/v22.16.0/bin/yarn dev:local',
    '93194 npm exec tsx scripts/dev-local.ts',
    '93216 node /home/dev/src/aflow/node_modules/.bin/tsx scripts/dev-local.ts',
    '93217 node --require /home/dev/src/aflow/node_modules/tsx/dist/preflight.cjs',
    '93307 node scripts/dev.mjs --profile local',
  ].join('\n');

  it('walks the whole chain to init', () => {
    expect(ancestorPids(parseParentMap(PS_PPID), 93307)).toEqual([
      93307, 93217, 93216, 93194, 93185, 1,
    ]);
  });

  it('a clean start does not refuse itself', () => {
    const own = ancestorPids(parseParentMap(PS_PPID), 93307);
    expect(parseStackProcesses(PS_COMMAND, { ignorePids: own })).toEqual([]);
  });

  it('ignoring only the immediate parent would have refused it — the bug this replaces', () => {
    const found = parseStackProcesses(PS_COMMAND, { ignorePids: [93307, 93217] });
    expect(found.map((p) => p.pid)).toEqual([93194, 93216]);
  });

  it('still sees another checkout while excluding its own chain', () => {
    const own = ancestorPids(parseParentMap(PS_PPID), 93307);
    const withOther = `${PS_COMMAND}\n68000 /home/dev/src/aflow-worktrees/other/node_modules/.bin/tsx scripts/dev-local.ts`;
    expect(parseStackProcesses(withOther, { ignorePids: own }).map((p) => p.pid)).toEqual([68000]);
  });

  it('terminates on a cyclic map rather than hanging', () => {
    expect(ancestorPids(parseParentMap('5 6\n6 5'), 5).length).toBeLessThan(70);
  });

  it('stops at a pid with no recorded parent', () => {
    expect(ancestorPids(parseParentMap('42 7'), 42)).toEqual([42, 7]);
  });
});
