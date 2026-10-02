/**
 * `aflow browser` — the agent's browser, from the machine that holds it. What
 * each command does is in `browser/browserCommands.ts`.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { loadHostPolicy } from './bindings.js';
import { BROWSER_USAGE, parseBrowserArgs, runBrowserCommand } from './browser/browserCommands.js';
import { discoverChrome } from './browser/chromeDiscovery.js';
import { createChromeLauncher } from './browser/chromeProcess.js';
import { BrowserDriver } from './browser/driver.js';
import { realClock } from './browser/settle.js';

// The same resolution `connect` and `harness` use, so all three read one file.
const HOST_DIR = process.env['PHOENIX_HOST_DIR']?.trim() ?? resolve(homedir(), '.aflow');
const POLICY_PATH = resolve(HOST_DIR, 'host-policy.json');

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
