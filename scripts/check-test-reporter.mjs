/**
 * The check's Vitest reporter: at the end of the run, what it ended with, to
 * the file `AFLOW_CHECK_TEST_RESULTS` names (`check-tests.mjs`). Vitest's own
 * JSON report keeps a timed-out test's stack and not its message, which is
 * the one place the timeout is said.
 */
import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { CHECK_TEST_RESULTS_ENV, summarizeTestRun } from './check-tests.mjs';

export default class CheckTestReporter {
  // Modules are named under the root as Vitest was given it, which the working
  // directory, a real path, is not wherever a symbolic link leads to the root.
  root = process.cwd();

  onInit(vitest) {
    this.root = vitest.config.root;
  }

  onTestRunEnd(testModules, unhandledErrors) {
    const file = process.env[CHECK_TEST_RESULTS_ENV];
    if (file === undefined || file === '') return;
    writeFileSync(file, JSON.stringify(summarizeTestRun(testModules, unhandledErrors, this.root)));
  }
}
