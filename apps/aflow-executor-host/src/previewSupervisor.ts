/**
 * The preview a harness run asks for with `preview: true` (Plan 320 D19): the
 * connected folder's declared command, started by this executor — never by
 * the coding agent — in the run's own checkout, waited for on its ready path,
 * opened to that run's ephemeral browser alone, and stopped when the run ends.
 *
 * It runs unconfined but supervised (Plan 320 F49): a detached process group
 * of its own in the one registry every spawn enters, owned by its run and
 * scoped to its binding, so withdrawal, shutdown, a drain and the next boot's
 * orphan sweep all reach it as they reach a harness. Unconfined because the
 * folder's sandbox cannot listen on loopback on macOS, and the command is the
 * person's own declaration, which no operation can set; the checks the harness
 * runs already execute the repository's code. What it is not given is this
 * executor's environment: its own is built from named variables, so neither the
 * harness's credential nor anything the executor holds reaches it.
 */
import { createServer } from 'node:net';

import { stackOwnPorts, type StackPortOwner } from '@aflow/lib';
import { portTaken } from '@aflow/lib/port-probe';
import {
  FOLDER_PREVIEW_PORT_PLACEHOLDER,
  FOLDER_PREVIEW_READY_TIMEOUT_MS,
  HOST_CHECK_OUTPUT_HEAD_BYTES,
  type HostResolvedFolderPreview,
} from '@aflow/schemas';

import { buildBaseEnv, createWorkloadDirs } from './baseEnv.js';
import { checkTail, createHeadTailBuffer } from './commitCheck.js';
import { createSecretsScrubber } from './credentialFetch.js';
import { previewStackPortRefusal } from './folderPreview.js';
import { type RunningService, type ServiceExit, startUnconfinedService } from './sandboxedRun.js';

/** What a preview keeps of its output: its start and its end, as a check's is kept. */
const PREVIEW_LOG_TAIL_BYTES = 192 * 1024;
/** How often the ready path is asked while the preview starts. */
const READY_POLL_MS = 500;
/** How long one ask of the ready path may take before it counts as no answer. */
const READY_REQUEST_MS = 5_000;
/**
 * How long a stop waits for the group to be gone: past the SIGKILL the registry
 * sends, the only thing still open is a pipe held by a process that left the
 * group, and the run is not held on it.
 */
const STOP_WAIT_MS = 10_000;
/** Free ports tried before giving up, each refused if a run or this stack holds it. */
const FREE_PORT_ATTEMPTS = 20;

export type PreviewErrorKind = 'held' | 'in_use' | 'stack_port' | 'no_port' | 'not_ready';

/** A preview refused or failed, in words the run's error carries as they are. */
export class PreviewError extends Error {
  constructor(
    message: string,
    readonly kind: PreviewErrorKind,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

interface PortHolder {
  readonly runId: string;
  readonly bindingId: string;
}

/**
 * The ports runs' previews hold now. A fixed port serves one run at a time; a
 * free port is never handed to two. Checked and set with no await between, so
 * two runs claiming one port cannot both see it free.
 */
const held = new Map<number, PortHolder>();

/** Who holds `port` for a preview, if a run does. */
export function previewPortHolder(port: number): PortHolder | undefined {
  return held.get(port);
}

/** A port held for one run's preview until `release`. */
export interface PreviewPortClaim {
  readonly port: number;
  /** Idempotent: a second release frees nothing someone else claimed since. */
  release(): void;
}

export interface PreviewPortDeps {
  readonly stackOwn?: ReadonlyMap<number, StackPortOwner>;
  readonly taken?: (port: number) => Promise<boolean>;
  readonly freePort?: () => Promise<number>;
}

function claimed(port: number, holder: PortHolder): PreviewPortClaim {
  held.set(port, holder);
  let released = false;
  return {
    port,
    release: () => {
      if (released) return;
      released = true;
      if (held.get(port) === holder) held.delete(port);
    },
  };
}

/** A port the system says is free on IPv4 loopback now. */
export async function pickFreeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Claim the port a run's preview serves on, before any checkout is made.
 *
 * A fixed port another run's preview holds is refused, naming that run, and
 * one anything else listens on is refused too: a server already there would
 * answer the wait and show this run's browser another checkout. Neither is
 * waited out here — a holder runs for minutes, and the caller starts the run
 * again once it is free. Without a fixed port, a free one is taken that no
 * run holds and this stack does not serve on.
 */
export async function claimPreviewPort(
  preview: Pick<HostResolvedFolderPreview, 'port'>,
  holder: PortHolder,
  deps: PreviewPortDeps = {},
): Promise<PreviewPortClaim> {
  const stackOwn = deps.stackOwn ?? stackOwnPorts(process.env);
  const taken = deps.taken ?? portTaken;
  if (preview.port !== undefined) {
    const port = preview.port;
    const stack = previewStackPortRefusal(port, stackOwn);
    if (stack !== undefined) throw new PreviewError(stack, 'stack_port');
    const other = held.get(port);
    if (other !== undefined) {
      throw new PreviewError(
        `preview port ${String(port)} is held by run ${other.runId}. Start this run again once ` +
          'that run has ended.',
        'held',
      );
    }
    const claim = claimed(port, holder);
    if (await taken(port)) {
      claim.release();
      throw new PreviewError(
        `preview port ${String(port)} is in use. Stop whatever listens on it, or leave the ` +
          "folder's preview without a fixed port so each run takes a free one.",
        'in_use',
      );
    }
    return claim;
  }
  const freePort = deps.freePort ?? pickFreeLoopbackPort;
  for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    if (port <= 0 || held.has(port) || stackOwn.has(port)) continue;
    return claimed(port, holder);
  }
  throw new PreviewError(
    `No free loopback port was found for the preview in ${String(FREE_PORT_ATTEMPTS)} tries.`,
    'no_port',
  );
}

/** The command as it runs: `{port}` replaced wherever it stands. */
export function previewCommand(command: string, port: number): string {
  return command.split(FOLDER_PREVIEW_PORT_PLACEHOLDER).join(String(port));
}

/**
 * Where the preview is asked whether it is up. Built on loopback and checked
 * to have stayed there: the schema already refuses a ready path that names
 * another host, and this is the second lock on the same door.
 */
export function previewReadyUrl(port: number, readyPath: string): URL {
  const origin = `http://127.0.0.1:${String(port)}`;
  const url = new URL(readyPath, origin);
  if (url.origin !== origin) {
    throw new PreviewError(
      `The preview's ready path \`${readyPath}\` resolves to ${url.origin}, not the preview at ` +
        `${origin}.`,
      'not_ready',
    );
  }
  return url;
}

/** A preview this run started, ready. */
export interface StartedPreview {
  readonly port: number;
  /** The address the harness is handed: the preview's root, on loopback. */
  readonly previewUrl: string;
  /** What it printed, scrubbed, kept head and tail. */
  log(): string;
  /** Stop its group, and wait for it to be gone. Idempotent. */
  stop(): Promise<void>;
}

export interface StartPreviewInput {
  readonly preview: HostResolvedFolderPreview;
  readonly port: number;
  /** The run's checkout, at the folder's place in it. */
  readonly cwd: string;
  /** A directory of the run's own for the preview's home and temporary files. */
  readonly scratchDir: string;
  readonly bindingId: string;
  readonly ownerRunId: string;
  /** What must never appear in its log, should the preview print it. */
  readonly secrets: readonly string[];
  readonly signal: AbortSignal;
  /** Called while it starts, so the step's idle window sees the wait as work. */
  readonly onProgress?: () => void;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly start?: typeof startUnconfinedService;
  readonly fetch?: typeof fetch;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Whether the ready path answered as up. A response of any status but a
 * server error counts — `/` on a dev server can be a redirect or a 404 page
 * and is still serving — while a 5xx is a server that is not ready yet, as a
 * health route reports one. A redirect is not followed: its target is not
 * the preview's to name.
 */
async function answered(url: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(READY_REQUEST_MS)]),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Start the folder's preview in the run's checkout and wait for it to answer.
 * One that never answers, or exits first, is stopped and fails the run naming
 * the command and the last lines it printed.
 */
export async function startPreview(input: StartPreviewInput): Promise<StartedPreview> {
  const command = previewCommand(input.preview.command, input.port);
  const readyUrl = previewReadyUrl(input.port, input.preview.readyPath);
  await createWorkloadDirs(input.scratchDir);
  const kept = createHeadTailBuffer(HOST_CHECK_OUTPUT_HEAD_BYTES, PREVIEW_LOG_TAIL_BYTES);
  const scrubber = createSecretsScrubber(input.secrets);
  let exit: ServiceExit | undefined;
  let flushed = false;
  const log = (): string => {
    if (!flushed && exit !== undefined) {
      flushed = true;
      kept.push(scrubber.flush());
    }
    return kept.text();
  };

  const start = input.start ?? startUnconfinedService;
  const running: RunningService = start({
    // A shell, because the declaration is one command line as a person would
    // type it; nothing else in the lane parses command lines.
    argv: ['/bin/sh', '-c', command],
    cwd: input.cwd,
    idPrefix: 'pv',
    scope: { kind: 'binding', id: input.bindingId },
    ownerRunId: input.ownerRunId,
    env: {
      ...buildBaseEnv(input.scratchDir),
      PORT: String(input.port),
      // A dev server told nothing opens the operator's own browser on start.
      BROWSER: 'none',
    },
    onOutput: (text) => {
      kept.push(scrubber.push(text));
      input.onProgress?.();
    },
  });
  void running.exited.then((value) => {
    exit = value;
  });

  let stopping: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    stopping ??= (async () => {
      running.stop();
      await Promise.race([
        running.exited,
        new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
      ]);
    })();
    await stopping;
  };

  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.readyTimeoutMs ?? FOLDER_PREVIEW_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (input.signal.aborted) {
        throw new PreviewError('The run was stopped while its preview was starting.', 'not_ready');
      }
      if (exit !== undefined) {
        throw new PreviewError(
          `The preview \`${command}\` exited ` +
            (exit.code === null ? `on ${exit.signal ?? 'a signal'}` : `with ${String(exit.code)}`) +
            ` before it answered at ${readyUrl.href}. The last lines it printed:\n` +
            checkTail(log()),
          'not_ready',
        );
      }
      if (await answered(readyUrl, fetchImpl, input.signal)) break;
      input.onProgress?.();
      if (Date.now() >= deadline) {
        throw new PreviewError(
          `The preview \`${command}\` did not answer at ${readyUrl.href} within ` +
            `${String(Math.round(timeoutMs / 1000))} s. The last lines it printed:\n` +
            checkTail(log()),
          'not_ready',
        );
      }
      await delay(input.pollMs ?? READY_POLL_MS, input.signal);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    port: input.port,
    previewUrl: `http://127.0.0.1:${String(input.port)}/`,
    log,
    stop,
  };
}
