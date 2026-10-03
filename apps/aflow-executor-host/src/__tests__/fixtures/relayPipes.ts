/**
 * Both ends of a harness browser's pipe pair, for tests: the relay's end, as
 * the relay script opens it, and the executor's, as `openHarnessBrowser` does.
 * Named pipes in a temporary directory; no socket is listened on.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, openSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const RELAY_SCRIPT = fileURLToPath(
  new URL('../../browser/harnessRelay.mjs', import.meta.url),
);

export interface PipeEnd {
  send(message: Record<string, unknown>): void;
  /** The first message read, now or later, that `match` accepts. */
  next(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function lines(input: NodeJS.ReadableStream): {
  next(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
} {
  const seen: Array<Record<string, unknown>> = [];
  const waiting: Array<{
    match: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  createInterface({ input }).on('line', (line) => {
    if (line.trim() === '') return;
    const message = JSON.parse(line) as Record<string, unknown>;
    const index = waiting.findIndex((each) => each.match(message));
    if (index === -1) {
      seen.push(message);
      return;
    }
    const [taken] = waiting.splice(index, 1);
    taken?.resolve(message);
  });
  return {
    next: (match) => {
      const index = seen.findIndex(match);
      if (index !== -1) {
        const [message] = seen.splice(index, 1);
        if (message !== undefined) return Promise.resolve(message);
      }
      return new Promise((resolve) => {
        waiting.push({ match, resolve });
      });
    },
  };
}

/** The relay's end: requests written, answers read. */
export function relayEnd(requestPath: string, responsePath: string): PipeEnd {
  const out = new Socket({
    fd: openSync(requestPath, constants.O_WRONLY | constants.O_NONBLOCK),
    readable: false,
    writable: true,
  });
  const into = new Socket({
    fd: openSync(responsePath, constants.O_RDONLY | constants.O_NONBLOCK),
    readable: true,
    writable: false,
  });
  const read = lines(into);
  return {
    send: (message) => out.write(`${JSON.stringify(message)}\n`),
    next: read.next,
    close: () => {
      out.destroy();
      into.destroy();
    },
  };
}

/** The executor's end: requests read, answers written. */
export function executorEnd(requestPath: string, responsePath: string): PipeEnd {
  const into = new Socket({
    fd: openSync(requestPath, constants.O_RDWR | constants.O_NONBLOCK),
    readable: true,
    writable: false,
  });
  const out = new Socket({
    fd: openSync(responsePath, constants.O_RDWR | constants.O_NONBLOCK),
    readable: false,
    writable: true,
  });
  const read = lines(into);
  return {
    send: (message) => out.write(`${JSON.stringify(message)}\n`),
    next: read.next,
    close: () => {
      out.destroy();
      into.destroy();
    },
  };
}

/** The relay script started as a harness starts it, spoken to over its standard streams. */
export interface RunningRelay {
  readonly child: ChildProcessWithoutNullStreams;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  stop(): Promise<void>;
}

export function startRelay(args: readonly string[]): RunningRelay {
  const child = spawn(process.execPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const read = lines(child.stdout);
  let nextId = 0;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    child,
    request: async (method, params) => {
      nextId += 1;
      const id = nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return await read.next((message) => message['id'] === id);
    },
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    stop: async () => {
      child.stdin.end();
      await exited;
    },
  };
}
