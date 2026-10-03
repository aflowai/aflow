/**
 * What a stack says when the MCP server's port is already held.
 *
 * The MCP server is the one service a stack shares rather than owns: one left
 * running by `yarn dev:mcp`, or by a stack `yarn kill` cleared around, serves
 * this stack's API as well as any. So a held port drops the stack's own MCP
 * server with a line naming the holder, where a held API or web port refuses
 * the stack.
 */
import { worktreeOfCommand } from './devStackLock.mjs';

const MCP_SERVER = /apps\/aflow-mcp\/(?:src|dist)\/index|scripts\/dev\.mjs --profile mcp\b/;

/** `ps ax -o pid=,command=` as pid → command. */
export function parseProcessTable(psOutput) {
  const table = new Map();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null) table.set(Number(match[1]), match[2]);
  }
  return table;
}

/**
 * The line for a held port. `listenerPids` is what lsof saw listening, which is
 * nothing for a process another user owns; the MCP servers in the process table
 * then stand in for it.
 */
export function mcpPortHeldMessage(port, listenerPids, psOutput) {
  const table = parseProcessTable(psOutput);
  const listeners = listenerPids.map((pid) => ({
    pid: Number(pid),
    command: table.get(Number(pid)),
  }));
  const servers = (
    listeners.length > 0 ? listeners : [...table].map(([pid, command]) => ({ pid, command }))
  ).filter(({ command }) => command !== undefined && MCP_SERVER.test(command));

  if (servers.length > 0) {
    const worktree = servers.map(({ command }) => worktreeOfCommand(command)).find(Boolean);
    const from = worktree === undefined ? '' : ` from ${worktree}`;
    const pids = servers.map(({ pid }) => pid).join(', ');
    return (
      `mcp not started: port ${String(port)} is held by an Aflow MCP server${from} (pid ${pids}). ` +
      'It serves this stack as aflow-local; stop it to have this stack run its own.'
    );
  }
  if (listeners.length > 0) {
    const holder = listeners
      .map(({ pid, command }) =>
        command === undefined ? `pid ${String(pid)}` : `pid ${String(pid)}: ${command}`,
      )
      .join('; ');
    return (
      `mcp not started: port ${String(port)} is held by ${holder}, which is not the Aflow MCP ` +
      'server. aflow-local is unavailable until that port is free.'
    );
  }
  return (
    `mcp not started: port ${String(port)} is held by a process this user cannot see. ` +
    'aflow-local is unavailable until that port is free.'
  );
}
