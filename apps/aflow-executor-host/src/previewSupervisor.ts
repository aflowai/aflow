/**
 * The preview a harness run asks for with `preview: true` (Plan 320 D19): the
 * connected folder's declared command, started by this executor — never by
 * the coding agent — in a snapshot of the run's checkout, waited for on its
 * ready path, opened to that run's ephemeral browser alone, and stopped when
 * the run ends.
 *
 * It runs unconfined but supervised, over a snapshot taken at preview start —
 * never the agent's live checkout (Plan 320 F49). Unconfined because the
 * folder's sandbox cannot listen on loopback on macOS. The snapshot is what
 * makes that acceptable: it is the checkout's commit, copied before the agent
 * runs, so what executes as the operator is the content the run started from
 * and nothing the sandboxed agent writes afterwards. Supervised as a detached
 * process group of its own in the one registry every spawn enters, owned by
 * its run and scoped to its binding, so withdrawal, shutdown, a drain and the
 * next boot's orphan sweep all reach it as they reach a harness. What it is
 * not given is this executor's environment: its own is built from named
 * variables, so neither the harness's credential nor anything the executor
 * holds reaches it.
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
    /** What the preview printed before it failed, scrubbed, when it had started. */
    readonly log?: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

interface PortHolder {
  readonly runId: string;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly spaceId: string;
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

/** A port the system hands out on IPv4 loopback now, before it is probed on every stack. */
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

function inUse(port: number): PreviewError {
  return new PreviewError(
    `preview port ${String(port)} is in use. Stop whatever listens on it, or leave the ` +
      "folder's preview without a fixed port so each run takes a free one.",
    'in_use',
  );
}

/**
 * Claim the port a run's preview serves on, before any checkout is made.
 *
 * A fixed port another run's preview holds is refused, and one anything else
 * listens on is refused too: a server already there would answer the wait and
 * show this run's browser another checkout. The holding run is named only to a
 * caller in its own workspace; any other gets the refusal a port held by
 * anything else gets, word for word, so it learns nothing of another
 * workspace's runs. Neither is waited out here — a holder runs for minutes,
 * and the caller starts the run again once it is free. Without a fixed port, a
 * free one is taken that no run holds, this stack does not serve on, and
 * nothing listens on in either address family, wildcard or loopback.
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
      if (other.tenantId !== holder.tenantId || other.spaceId !== holder.spaceId) {
        throw inUse(port);
      }
      throw new PreviewError(
        `preview port ${String(port)} is held by run ${other.runId}. Start this run again once ` +
          'that run has ended.',
        'held',
      );
    }
    const claim = claimed(port, holder);
    if (await taken(port)) {
      claim.release();
      throw inUse(port);
    }
    return claim;
  }
  const freePort = deps.freePort ?? pickFreeLoopbackPort;
  for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    if (port <= 0 || held.has(port) || stackOwn.has(port)) continue;
    // Free on IPv4 loopback is not free: a wildcard or IPv6 listener on the
    // same port would answer the wait or the browser in the preview's place.
    // Claimed before the probe, so no other run is handed it meanwhile.
    const claim = claimed(port, holder);
    if (await taken(port)) {
      claim.release();
      continue;
    }
    return claim;
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

/** The loopback hosts a preview may answer on, as a URL names them, IPv4 first. */
export const PREVIEW_LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'] as const;
export type PreviewLoopbackHost = (typeof PREVIEW_LOOPBACK_HOSTS)[number];

/**
 * Where the preview is asked whether it is up, on one loopback host. Built on
 * loopback and checked to have stayed there: the schema already refuses a
 * ready path that names another host, and this is the second lock on the
 * same door.
 */
export function previewReadyUrl(
  port: number,
  readyPath: string,
  host: PreviewLoopbackHost = '127.0.0.1',
): URL {
  const origin = `http://${host}:${String(port)}`;
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
  /** The address the harness is handed: the preview's root, on the loopback host that answered. */
  readonly previewUrl: string;
  /** What it printed, scrubbed, kept head and tail. */
  log(): string;
  /** Stop its group, and wait for it to be gone. Idempotent. */
  stop(): Promise<void>;
}

export interface StartPreviewInput {
  readonly preview: HostResolvedFolderPreview;
  readonly port: number;
  /**
   * A snapshot of the run's checkout taken at preview start, at the folder's
   * place in it — never the checkout the agent works in.
   */
  readonly cwd: string;
  /** A directory of the run's own for the preview's home and temporary files. */
  readonly scratchDir: string;
  readonly bindingId: string;
  readonly ownerRunId: string;
  /** What must never appear in its log, should the preview print it. */
  readonly secrets: readonly string[];
  readonly signal: AbortSignal;
  /**
   * Called while it starts, so the step's idle window sees the wait as work.
   * Never once it has answered or failed: a dev server that keeps printing
   * would otherwise hold a stalled harness's idle deadline open to the ceiling.
   */
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

/** The first loopback host, IPv4 first, whose ready path answers now. */
async function answeringHost(
  urls: ReadonlyArray<readonly [PreviewLoopbackHost, URL]>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<PreviewLoopbackHost | undefined> {
  const answers = await Promise.all(
    urls.map(async ([, url]) => await answered(url, fetchImpl, signal)),
  );
  return urls[answers.indexOf(true)]?.[0];
}

/**
 * Start the folder's preview in the run's snapshot and wait for it to answer
 * on IPv4 or IPv6 loopback, since a dev server may listen on either alone.
 * One that never answers, or exits first, is stopped and fails the run naming
 * the command and the last lines it printed.
 */
export async function startPreview(input: StartPreviewInput): Promise<StartedPreview> {
  const command = previewCommand(input.preview.command, input.port);
  const readyUrls = PREVIEW_LOOPBACK_HOSTS.map(
    (host) => [host, previewReadyUrl(input.port, input.preview.readyPath, host)] as const,
  );
  const askedAt = readyUrls.map(([, url]) => url.href).join(' or ');
  await createWorkloadDirs(input.scratchDir);
  const kept = createHeadTailBuffer(HOST_CHECK_OUTPUT_HEAD_BYTES, PREVIEW_LOG_TAIL_BYTES);
  const scrubber = createSecretsScrubber(input.secrets);
  let exit: ServiceExit | undefined;
  let starting = true;
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
      if (starting) input.onProgress?.();
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
  let host: PreviewLoopbackHost | undefined;
  try {
    for (;;) {
      if (input.signal.aborted) {
        throw new PreviewError('The run was stopped while its preview was starting.', 'not_ready');
      }
      if (exit !== undefined) {
        throw new PreviewError(
          `The preview \`${command}\` exited ` +
            (exit.code === null ? `on ${exit.signal ?? 'a signal'}` : `with ${String(exit.code)}`) +
            ` before it answered at ${askedAt}. The last lines it printed:\n` +
            checkTail(log()),
          'not_ready',
        );
      }
      host = await answeringHost(readyUrls, fetchImpl, input.signal);
      if (host !== undefined) break;
      input.onProgress?.();
      if (Date.now() >= deadline) {
        throw new PreviewError(
          `The preview \`${command}\` did not answer at ${askedAt} within ` +
            `${String(Math.round(timeoutMs / 1000))} s. The last lines it printed:\n` +
            checkTail(log()),
          'not_ready',
        );
      }
      await delay(input.pollMs ?? READY_POLL_MS, input.signal);
    }
    starting = false;
  } catch (error) {
    starting = false;
    await stop();
    // The log kept with the run as well as the tail in the message.
    if (error instanceof PreviewError) throw new PreviewError(error.message, error.kind, log());
    throw error;
  }

  return {
    port: input.port,
    previewUrl: `http://${host}:${String(input.port)}/`,
    log,
    stop,
  };
}
