/**
 * What a stack says when the MCP server's port is already held.
 *
 * The MCP server is the one service a stack shares rather than owns: one left
 * running by `yarn dev:mcp`, or by a stack `yarn kill` cleared around, serves
 * this stack's API as well as any. So a held port drops the stack's own MCP
 * server with a line naming the holder, where a held API or web port refuses
 * the stack. `yarn mcp:setup` asks the same question to say which checkout's
 * credential file the server on the port reads.
 */
import { execSync } from 'node:child_process';

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
 * The pids listening on a TCP port here, best effort: empty without lsof, and
 * missing whatever another user owns when this is not root.
 */
export function listenersOn(port) {
  try {
    const out = execSync(`lsof -t -sTCP:LISTEN -iTCP:${port} 2>/dev/null || true`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [
      ...new Set(
        out
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

/** `ps ax -o pid=,command=`, or nothing; the listener pids alone still say something. */
export function readProcessTable() {
  try {
    return execSync('ps ax -o pid=,command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * Who holds the port: `mcp-server` (with the checkout it runs from when its
 * command names one), `other`, `unseen-mcp-server` or `unseen`. `listenerPids`
 * is what lsof saw listening, which is nothing for a process another user owns.
 * An MCP server in the process table then makes one the likely holder, but it
 * may be listening on another port, so none is named.
 */
export function mcpPortHolder(listenerPids, psOutput) {
  const table = parseProcessTable(psOutput);
  const listeners = listenerPids.map((pid) => ({
    pid: Number(pid),
    command: table.get(Number(pid)),
  }));
  const isMcpServer = (command) => command !== undefined && MCP_SERVER.test(command);
  const servers = listeners.filter(({ command }) => isMcpServer(command));

  if (servers.length > 0) {
    const worktree = servers.map(({ command }) => worktreeOfCommand(command)).find(Boolean);
    return {
      kind: 'mcp-server',
      pids: servers.map(({ pid }) => pid),
      ...(worktree === undefined ? {} : { worktree }),
    };
  }
  if (listeners.length > 0) return { kind: 'other', listeners };
  if ([...table.values()].some(isMcpServer)) return { kind: 'unseen-mcp-server' };
  return { kind: 'unseen' };
}

/** The line for a held port. */
export function mcpPortHeldMessage(port, listenerPids, psOutput) {
  const holder = mcpPortHolder(listenerPids, psOutput);

  if (holder.kind === 'mcp-server') {
    const from = holder.worktree === undefined ? '' : ` from ${holder.worktree}`;
    const pids = holder.pids.join(', ');
    return (
      `mcp not started: port ${String(port)} is held by an Aflow MCP server${from} (pid ${pids}). ` +
      'It serves this stack as aflow-local; stop it to have this stack run its own.'
    );
  }
  if (holder.kind === 'other') {
    const named = holder.listeners
      .map(({ pid, command }) =>
        command === undefined ? `pid ${String(pid)}` : `pid ${String(pid)}: ${command}`,
      )
      .join('; ');
    return (
      `mcp not started: port ${String(port)} is held by ${named}, which is not the Aflow MCP ` +
      'server. aflow-local is unavailable until that port is free.'
    );
  }
  if (holder.kind === 'unseen-mcp-server') {
    return (
      `mcp not started: port ${String(port)} is held, probably by an Aflow MCP server this user ` +
      'cannot see listening. If so it serves this stack as aflow-local; stop it to have this ' +
      'stack run its own.'
    );
  }
  return (
    `mcp not started: port ${String(port)} is held by a process this user cannot see. ` +
    'aflow-local is unavailable until that port is free.'
  );
}
