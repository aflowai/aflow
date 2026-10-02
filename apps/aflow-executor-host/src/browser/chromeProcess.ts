/**
 * Starting a profile's Chrome, and finding where it listens.
 *
 * Chrome runs as the operator, outside the lane's sandbox — it cannot start
 * inside it — with its own sandbox on and pointed at the profile's directory
 * and nothing else. It is started through the lane's supervised spawn so that
 * withdrawal, shutdown and the next boot's sweep reach it like any command.
 */
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserProfile } from '@aflow/schemas';

import { startUnconfinedService, type RunningService } from '../sandboxedRun.js';
import { BrowserDriverError } from './errors.js';
import { browserServiceEnv } from './serviceEnv.js';

/** Chrome writes its DevTools port and path here once it is listening. */
export const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

export function profileDirectory(hostDir: string, profileId: string): string {
  return join(hostDir, 'browsers', profileId);
}

/**
 * The whole command line. Built here and nowhere else, from the profile and the
 * executable discovery found — nothing a job sends reaches it.
 */
export function chromeArgv(
  executable: string,
  userDataDir: string,
  profile: Pick<BrowserProfile, 'window' | 'windowSize'>,
  proxyServer: string,
): string[] {
  return [
    executable,
    `--user-data-dir=${userDataDir}`,
    // Chrome picks the port and binds it on loopback; the file above says which.
    '--remote-debugging-port=0',
    // Every request through the profile's egress proxy. Chrome otherwise sends
    // loopback straight past any proxy, which is exactly the traffic the proxy
    // exists to refuse; `<-loopback>` takes that exemption away.
    `--proxy-server=${proxyServer}`,
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${String(profile.windowSize.width)},${String(profile.windowSize.height)}`,
    ...(profile.window === 'visible' ? [] : ['--headless=new']),
    'about:blank',
  ];
}

/** The websocket endpoint in a DevToolsActivePort file, or nothing while it is incomplete. */
export function parseDevToolsActivePort(text: string): string | undefined {
  const [portLine, pathLine] = text.split('\n');
  const port = Number(portLine?.trim());
  const path = pathLine?.trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  if (!path?.startsWith('/devtools/browser/')) return undefined;
  return `ws://127.0.0.1:${String(port)}${path}`;
}

export interface LaunchedChrome {
  readonly endpoint: string;
  readonly exited: Promise<void>;
  stop(): void;
}

export interface ChromeLaunchInput {
  readonly executable: string;
  readonly hostDir: string;
  readonly profile: BrowserProfile;
  /** The egress proxy every request of this browser goes through. */
  readonly proxyServer: string;
}

export interface ChromeLauncher {
  launch(input: ChromeLaunchInput): Promise<LaunchedChrome>;
}

export function createChromeLauncher(
  options: {
    start?: typeof startUnconfinedService;
    readyTimeoutMs?: number;
    pollMs?: number;
  } = {},
): ChromeLauncher {
  const start = options.start ?? startUnconfinedService;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;

  return {
    launch: async ({ executable, hostDir, profile, proxyServer }): Promise<LaunchedChrome> => {
      const browsersDir = join(hostDir, 'browsers');
      const userDataDir = profileDirectory(hostDir, profile.id);
      await mkdir(userDataDir, { recursive: true, mode: 0o700 });
      // `mode` applies only to what mkdir creates; a directory that already
      // existed keeps whatever it had, and these hold the operator's sign-ins.
      await chmod(browsersDir, 0o700);
      await chmod(userDataDir, 0o700);
      const portFile = join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
      // A file left by the last run names a port nothing listens on any more.
      await rm(portFile, { force: true });

      const service: RunningService = start({
        argv: chromeArgv(executable, userDataDir, profile, proxyServer),
        cwd: userDataDir,
        idPrefix: 'browser',
        scope: { kind: 'browser-profile', id: profile.id },
        env: browserServiceEnv(),
      });

      let exit: { code: number | null; stderrTail: string } | undefined;
      void service.exited.then((ended) => {
        exit = ended;
      });

      const deadline = Date.now() + readyTimeoutMs;
      for (;;) {
        const endpoint = parseDevToolsActivePort(await readFile(portFile, 'utf8').catch(() => ''));
        if (endpoint !== undefined) {
          return {
            endpoint,
            exited: service.exited.then(() => undefined),
            stop: () => {
              service.stop();
            },
          };
        }
        if (exit !== undefined) {
          const said = exit.stderrTail.trim().split('\n').slice(-3).join(' ').slice(-400);
          throw new BrowserDriverError(
            'launch_failed',
            `The browser at ${executable} exited before it was ready (exit ${String(exit.code)})` +
              (said !== '' ? `: ${said}` : '.') +
              ` Its profile directory is ${userDataDir}.`,
          );
        }
        if (Date.now() >= deadline) {
          service.stop();
          throw new BrowserDriverError(
            'launch_failed',
            `The browser at ${executable} did not start listening within ` +
              `${String(Math.round(readyTimeoutMs / 1000))} seconds, and was stopped. ` +
              `Its profile directory is ${userDataDir}.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
