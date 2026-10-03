/**
 * What this machine lets a test do that a sandbox may refuse: watch a file and
 * listen on a socket.
 *
 * Each capability is probed once, when this module loads, by making the real
 * call against a temporary path — never inferred from the environment, which
 * says where the tests run but not what that place permits. A test needing one
 * is skipped where it is refused, and its name says which, so a run that could
 * not exercise it records that rather than failing on a refusal or passing
 * without having run.
 */
import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Capability {
  /** What was tried, as a skipped test's name gives it. */
  readonly name: string;
  readonly available: boolean;
  /** How the call was refused, when it was. */
  readonly refusal?: string;
}

/** How long an armed watch may take to report a write before it counts as not working. */
export const WATCH_PROBE_DEADLINE_MS = 5_000;
const WATCH_PROBE_REWRITE_MS = 50;

/**
 * The error's code alone when it has one: the reason becomes part of a skipped
 * test's name, and a message naming a temporary path would give the same test a
 * different name on every run.
 */
function refusalOf(error: unknown): string {
  if (error instanceof Error) return (error as NodeJS.ErrnoException).code ?? error.message;
  return String(error);
}

function available(name: string): Capability {
  return { name, available: true };
}

function refused(name: string, refusal: string): Capability {
  return { name, available: false, refusal };
}

export type WatchFunction = (path: string) => FSWatcher;

/**
 * Whether `fs.watch` works here: available only once a watch on a temporary
 * directory has reported a write into it.
 *
 * A refused watch is not always a throw — in a sandbox that denies it, the call
 * returns a watcher and the refusal (`EMFILE`) arrives as an `error` event a
 * moment later. So the probe waits for the event a working watch produces,
 * rewriting meanwhile, because a watch arms asynchronously and a single write
 * can land before it exists.
 */
export async function probeFileWatching(
  watch: WatchFunction = (path) => fsWatch(path),
  deadlineMs: number = WATCH_PROBE_DEADLINE_MS,
): Promise<Capability> {
  const name = 'fs.watch';
  const dir = await mkdtemp(join(tmpdir(), 'aflow-watch-probe-'));
  let watcher: FSWatcher | undefined;
  let rewrite: NodeJS.Timeout | undefined;
  try {
    const answer = await new Promise<Capability>((resolve) => {
      const deadline = setTimeout(() => {
        resolve(refused(name, `no change reported within ${String(deadlineMs)} ms`));
      }, deadlineMs);
      const settle = (capability: Capability): void => {
        clearTimeout(deadline);
        resolve(capability);
      };
      try {
        watcher = watch(dir);
      } catch (error) {
        settle(refused(name, refusalOf(error)));
        return;
      }
      // `on`, not `once`: a second error with nobody listening would be thrown.
      watcher.on('error', (error) => {
        settle(refused(name, refusalOf(error)));
      });
      watcher.on('change', () => {
        settle(available(name));
      });
      let written = 0;
      const write = (): void => {
        written += 1;
        writeFile(join(dir, 'probe'), String(written)).catch((error: unknown) => {
          settle(refused(name, `the probe could not write: ${refusalOf(error)}`));
        });
      };
      write();
      rewrite = setInterval(write, WATCH_PROBE_REWRITE_MS);
    });
    return answer;
  } finally {
    if (rewrite !== undefined) clearInterval(rewrite);
    watcher?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function listenOnce(name: string, listen: (server: Server) => void): Promise<Capability> {
  return new Promise<Capability>((resolve) => {
    const server = createServer();
    server.once('error', (error) => {
      resolve(refused(name, refusalOf(error)));
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(available(name));
      });
    });
    try {
      listen(server);
    } catch (error) {
      resolve(refused(name, refusalOf(error)));
    }
  });
}

/** Whether a TCP listener can be opened on 127.0.0.1. */
export async function probeLoopbackListener(
  listen: (server: Server) => void = (server) => server.listen(0, '127.0.0.1'),
): Promise<Capability> {
  return await listenOnce('a loopback listener (TCP on 127.0.0.1)', listen);
}

/** Whether a Unix-domain socket can be listened on in the temporary directory. */
export async function probeLocalSocketListener(): Promise<Capability> {
  const dir = await mkdtemp(join(tmpdir(), 'aflow-sock-probe-'));
  try {
    return await listenOnce('a local socket listener (Unix domain)', (server) =>
      server.listen(join(dir, 'probe.sock')),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const FILE_WATCHING = await probeFileWatching();
export const LOOPBACK_LISTENER = await probeLoopbackListener();
export const LOCAL_SOCKET_LISTENER = await probeLocalSocketListener();

/**
 * The confined runner starts its proxies on both, before the command runs: a
 * mux on a local socket and its listeners on loopback.
 */
export const CONFINEMENT_LISTENERS = [LOOPBACK_LISTENER, LOCAL_SOCKET_LISTENER] as const;

export interface Requirement {
  /** True when any capability needed is refused here. */
  readonly skip: boolean;
  /** The test's name, with why it was skipped when it is. */
  title(name: string): string;
}

/** What a test needs, for `it.skipIf(needed.skip)(needed.title('…'), …)`. */
export function requires(...capabilities: readonly Capability[]): Requirement {
  const missing = capabilities.filter((capability) => !capability.available);
  const why = missing
    .map((capability) => `${capability.name} refused here (${capability.refusal ?? 'unknown'})`)
    .join('; ');
  return {
    skip: missing.length > 0,
    title: (name) => (missing.length > 0 ? `${name} — skipped: ${why}` : name),
  };
}
