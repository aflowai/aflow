/**
 * Whether a real Chrome starts here, probed as `capabilities.ts` probes the
 * rest: by making the real call — starting one this machine has installed and
 * stopping it — never by reading the environment. Kept apart from those
 * probes because it starts a browser, which only a suite that drives one
 * should pay for.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserProfileSchema } from '@aflow/schemas';

import { discoverChrome } from '../../browser/chromeDiscovery.js';
import { createChromeLauncher } from '../../browser/chromeProcess.js';
import { BrowserDriverError } from '../../browser/errors.js';
import type { Capability } from './capabilities.js';

/** How long the probe gives Chrome to start before it counts as unable to. */
const CHROME_PROBE_DEADLINE_MS = 15_000;

export async function probeChromeStart(): Promise<Capability> {
  const name = 'a headless Chrome';
  const found = discoverChrome().found;
  if (found === undefined) return { name, available: false, refusal: 'none installed' };
  const dir = await mkdtemp(join(tmpdir(), 'aflow-chrome-probe-'));
  try {
    const launched = await createChromeLauncher({
      readyTimeoutMs: CHROME_PROBE_DEADLINE_MS,
    }).launch({
      executable: found.path,
      hostDir: dir,
      userDataDir: dir,
      profile: BrowserProfileSchema.parse({ id: 'probe' }),
      // Nothing is loaded; the address only has to be well formed.
      proxyServer: 'http://127.0.0.1:9',
    });
    launched.stop();
    await launched.exited;
    return { name, available: true };
  } catch (error) {
    // The kind, not the message, which names the temporary directory and
    // would give the skipped test a different name on every run.
    const refusal =
      error instanceof BrowserDriverError
        ? error.kind
        : error instanceof Error
          ? error.name
          : String(error);
    return { name, available: false, refusal };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
