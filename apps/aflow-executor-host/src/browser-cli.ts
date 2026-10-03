/**
 * `aflow browser` — the agent's browser, from the machine that holds it. What
 * each command does is in `browser/browserCommands.ts`.
 */
import { dirname } from 'node:path';

import { loadHostPolicy } from './bindings.js';
import { BROWSER_USAGE, parseBrowserArgs, runBrowserCommand } from './browser/browserCommands.js';
import { discoverChrome } from './browser/chromeDiscovery.js';
import { createChromeLauncher, profileDirectory } from './browser/chromeProcess.js';
import { BrowserDriver } from './browser/driver.js';
import { profileHolder } from './browser/profileLock.js';
import { realClock } from './browser/settle.js';
import { resolveHostPolicyPath } from './hostDir.js';

const POLICY_PATH = resolveHostPolicyPath();
const HOST_DIR = dirname(POLICY_PATH);

async function main(): Promise<void> {
  const command = parseBrowserArgs(process.argv.slice(2));
  if (command === undefined) {
    console.error(BROWSER_USAGE);
    process.exit(1);
  }
  await runBrowserCommand(command, {
    hostDir: HOST_DIR,
    policyPath: POLICY_PATH,
    print: (line) => {
      console.log(line);
    },
    findChrome: discoverChrome,
    clock: realClock,
    profileHolder: async (profileId) => await profileHolder(profileDirectory(HOST_DIR, profileId)),
    ownDriver: async () => {
      // Loaded only when this command drives Chrome itself.
      const { createPlaywrightEngine } = await import('./browser/engine.js');
      return new BrowserDriver({
        engine: createPlaywrightEngine(),
        launcher: createChromeLauncher(),
        hostDir: HOST_DIR,
        loadPolicy: async () => await loadHostPolicy(POLICY_PATH),
      });
    },
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
