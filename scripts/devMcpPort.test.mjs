import { describe, expect, it } from 'vitest';

import { mcpPortHeldMessage, parseProcessTable } from './devMcpPort.mjs';

const WORKTREE = '/home/dev/src/aflow-worktrees/topic';

/**
 * `ps ax -o pid=,command=` in the shapes a `yarn dev:mcp` leaves: the runner,
 * and the node process under `tsx watch` that actually listens.
 */
const PS = [
  `  501 node scripts/dev.mjs --profile mcp`,
  `  512 node --require ${WORKTREE}/node_modules/tsx/dist/preflight.cjs --import file://${WORKTREE}/node_modules/tsx/dist/loader.mjs apps/aflow-mcp/src/index.ts`,
  '  700 /Applications/Other.app/Contents/MacOS/other --port 3100',
].join('\n');

describe('a held MCP port', () => {
  it('names the MCP server holding it, and where it runs from', () => {
    const message = mcpPortHeldMessage(3100, ['512'], PS);
    expect(message).toContain('held by an Aflow MCP server');
    expect(message).toContain(WORKTREE);
    expect(message).toContain('512');
    expect(message).toContain('serves this stack');
  });

  it('names a holder that is not the MCP server, and what that costs', () => {
    const message = mcpPortHeldMessage(3100, ['700'], PS);
    expect(message).toContain('pid 700: /Applications/Other.app');
    expect(message).toContain('not the Aflow MCP server');
    expect(message).toContain('aflow-local is unavailable');
  });

  /** lsof sees nothing another user owns; the process table still shows the server. */
  it('falls back to the MCP servers running when no listener is visible', () => {
    expect(mcpPortHeldMessage(3100, [], PS)).toContain('held by an Aflow MCP server');
  });

  it('says it cannot see the holder rather than naming none', () => {
    const message = mcpPortHeldMessage(3100, [], '  700 other');
    expect(message).toContain('cannot see');
    expect(message).not.toContain('undefined');
  });
});

describe('parseProcessTable', () => {
  it('keys commands by pid and skips lines without one', () => {
    expect(parseProcessTable('  1 init\nnoise\n22 node x.js')).toEqual(
      new Map([
        [1, 'init'],
        [22, 'node x.js'],
      ]),
    );
  });
});
