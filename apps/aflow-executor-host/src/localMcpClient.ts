/**
 * Speaking MCP to a server on this machine, inside the boundary.
 *
 * The protocol client spawns the server itself, so it is pointed at the sandbox
 * launcher rather than at the server: the launcher is what runs, and the server
 * is its argument. The client then talks to a confined process over the pipes
 * it would have used anyway, and nothing in the transport had to learn about
 * sandboxing.
 *
 * A connection lives for one operation. A local MCP server is cheap to start
 * and the alternative — a pool of long-lived servers holding an old binding's
 * boundary — is the thing that made revocation hard to reason about everywhere
 * else in this lane.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { HostBinding } from './bindings.js';
import { LocalMcpServerError, type LocalMcpServer } from './localMcpServers.js';
import { signalGroup, spawnConfined } from './sandboxedRun.js';

/** A server that has not answered by now is not going to. */
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
/** Enough of a failing server's complaint to name the cause. */
const STDERR_KEEP_BYTES = 4_000;

/**
 * A server installed under the operator's home cannot read its own code, since
 * home is denied as a region. That surfaces as a missing module or a missing
 * file, which reads like a broken install rather than a boundary — so the
 * boundary says so itself.
 */
const READ_HINT =
  'If it is installed under your home directory it cannot read its own files: home is denied, ' +
  'and a server reaches only what its binding and `authPaths` allow. Add the directory it is ' +
  "installed in to that server's `authPaths`.";

function looksLikeARefusedRead(complaint: string): boolean {
  return /MODULE_NOT_FOUND|Cannot find module|ENOENT|EACCES|EPERM|no such file/i.test(complaint);
}

export interface LocalMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * Run one exchange with a server. The connection, the sandbox policy and the
 * scratch it lives in are all created and torn down around the callback, so
 * nothing survives the operation that asked for it.
 */
/**
 * A transport over a process this lane owns.
 *
 * The protocol library ships one that spawns the server itself, and using it
 * put the server outside every registry this lane keeps: not in the process
 * table, so withdrawal and shutdown could not reach it; never journalled, so
 * the next boot could not find it; and the library kills only the launcher it
 * started, which does not forward the signal to the workload underneath — the
 * server survived, reparented to init, with the folder still open.
 *
 * So the process is spawned the way every other workload here is, and this
 * carries the protocol over its pipes. The framing is the library's own.
 */
class OwnedStdioTransport implements Transport {
  private readonly buffer = new ReadBuffer();
  private closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly child: ChildProcess,
    private readonly onEnd: () => void,
  ) {}

  start(): Promise<void> {
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (message === null) return;
        this.onmessage?.(message);
      }
    });
    this.child.once('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
    this.child.once('error', (error: Error) => {
      this.onerror?.(error);
    });
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error('The MCP server is no longer accepting input.'));
    }
    stdin.write(serializeMessage(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.onEnd();
    return Promise.resolve();
  }
}

/**
 * Run one exchange with a server. The process, the policy and the scratch it
 * lives in are created and torn down around the callback, so nothing survives
 * the operation that asked for it.
 */
async function withServer<T>(
  server: LocalMcpServer,
  binding: HostBinding,
  ownerRunId: string,
  signal: AbortSignal,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), 'aflow-mcp-'));
  let started: Awaited<ReturnType<typeof spawnConfined>> | undefined;
  try {
    started = await spawnConfined({
      binding,
      argv: [server.executable, ...server.args],
      cwd: binding.root,
      env: {},
      scratchDir: scratch,
      widening: {
        authPaths: server.authPaths,
        allowedDomains: server.allowedDomains,
      },
      inheritEnv: server.inheritEnv,
      idPrefix: 'hm',
      ownerRunId,
    });
    const child = started.child;

    // Kept so a server that dies on startup can say why. Without this the only
    // symptom is a closed connection, which describes every possible cause —
    // a missing dependency, a path the boundary refused, a bad argument — and
    // distinguishes none of them.
    let complaint = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (complaint.length < STDERR_KEEP_BYTES) complaint += chunk.toString('utf8');
    });

    const onAbort = (): void => {
      signalGroup(child, 'SIGKILL');
    };
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) onAbort();

    try {
      const transport = new OwnedStdioTransport(child, () => {
        signalGroup(child, 'SIGKILL');
      });
      const client = new Client({ name: 'aflow-host', version: '1.0.0' }, { capabilities: {} });
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, server.id, 'connect');
      } catch {
        const said = complaint.trim().split('\n').slice(-6).join('; ').slice(0, STDERR_KEEP_BYTES);
        throw new LocalMcpServerError(
          `MCP server '${server.id}' did not start.${said === '' ? '' : ` It said: ${said}`}${
            looksLikeARefusedRead(said) ? ` ${READ_HINT}` : ''
          }`,
          'protocol',
        );
      }
      return await use(client);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  } finally {
    // The group, not the launcher: the launcher does not pass a kill down to
    // the workload it started, and that workload is the server.
    if (started !== undefined) signalGroup(started.child, 'SIGKILL');
    await rm(scratch, { recursive: true, force: true });
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  serverId: string,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new LocalMcpServerError(
              `MCP server '${serverId}' did not ${what} within ${String(Math.round(ms / 1000))}s.`,
              'protocol',
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listLocalTools(
  server: LocalMcpServer,
  binding: HostBinding,
  ownerRunId: string,
  signal: AbortSignal,
): Promise<LocalMcpTool[]> {
  return await withServer(server, binding, ownerRunId, signal, async (client) => {
    const listed = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, server.id, 'list tools');
    return listed.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      // The protocol requires a schema, so it is carried straight through — a
      // tool the agent may call needs the server's own argument shape, not one
      // derived here.
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  });
}

export interface LocalMcpCallResult {
  /** The content blocks the server returned, as it returned them. */
  readonly content: unknown;
  /** The server's own judgement that the call failed, which is not a transport failure. */
  readonly isError: boolean;
}

export async function callLocalTool(
  server: LocalMcpServer,
  binding: HostBinding,
  ownerRunId: string,
  signal: AbortSignal,
  toolName: string,
  args: Record<string, unknown>,
): Promise<LocalMcpCallResult> {
  return await withServer(server, binding, ownerRunId, signal, async (client) => {
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      server.id,
      `answer \`${toolName}\``,
    );
    return {
      content: result.content ?? [],
      // A server saying the call failed is information for the agent, not a
      // failure of the step — the same distinction the API lane draws.
      isError: result.isError === true,
    };
  });
}
