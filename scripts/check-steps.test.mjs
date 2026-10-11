/**
 * Contract: the check's live output names the step it is on while it is on
 * it — `building @acme/a` reaches whoever reads the check's pipe before that
 * build ends, and `ok   build @acme/a` once it has.
 *
 * The check runs as a child here, its output a pipe as the executor reads it,
 * and the build it is on waits until the test has seen the line naming it.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const STEPS = fileURLToPath(new URL('./check-steps.mjs', import.meta.url));
/** How often the waiting step looks for its release. */
const POLL_MS = 10;
/** Long enough for two Node processes to start on a loaded machine. */
const STEP_TEST_TIMEOUT_MS = 60_000;

let dir;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'check-steps-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A check of one step, `build @acme/a`, that runs until `release` exists. */
function checkWaitingOn(release) {
  const step = [
    "const { existsSync } = require('node:fs');",
    `setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, ${String(POLL_MS)});`,
  ].join('\n');
  const check = [
    `import { runStep } from ${JSON.stringify(STEPS)};`,
    'await runStep({',
    "  label: 'build @acme/a',",
    "  activity: 'building @acme/a',",
    '  command: process.execPath,',
    `  args: ['-e', ${JSON.stringify(step)}],`,
    '});',
  ].join('\n');
  return spawn(process.execPath, ['--input-type=module', '-e', check], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

describe('the check’s live output', () => {
  it(
    'names the step it is on before the step ends, and the step’s end once it has',
    async () => {
      const release = path.join(dir, 'release');
      const child = checkWaitingOn(release);
      let printed = '';
      let printedWhileRunning;
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.stdout.on('data', (chunk) => {
        printed += chunk.toString('utf8');
        if (printedWhileRunning === undefined && printed.includes('building @acme/a\n')) {
          printedWhileRunning = printed;
          void writeFile(release, '');
        }
      });
      expect(await exited).toBe(0);
      expect(printedWhileRunning).toBe('building @acme/a\n');
      expect(printed).toMatch(/^building @acme\/a\nok {3}build @acme\/a \(\d+\.\d s\)\n$/);
    },
    STEP_TEST_TIMEOUT_MS,
  );
});
