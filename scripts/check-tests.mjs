/**
 * The check's test run, on a machine it shares.
 *
 * A check runs beside the stack it serves and often beside another stream's
 * commission, so a test given five or ten seconds on a quiet machine runs out
 * of them under load having failed at nothing. The run gives every test and
 * hook one time sized for that load, and a test that needs longer on any
 * machine declares its own, which this does not override. Its reporter writes
 * what the run ended with, so a run that failed only because tests ran out of
 * time can say so, and a publication can run the checks once more rather than
 * refuse a commit for the machine's load.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long one test or hook may run in the check: three times the longest a project gives one. */
export const CHECK_TEST_TIMEOUT_MS = 30_000;

/** Names the file the check's reporter writes what the run ended with to. */
export const CHECK_TEST_RESULTS_ENV = 'AFLOW_CHECK_TEST_RESULTS';

const REPORTER = fileURLToPath(new URL('./check-test-reporter.mjs', import.meta.url));

/** What Vitest says of a test or a hook stopped at its time, whatever the time was. */
const TIMEOUT_MESSAGE = /^(?:Test|Hook) timed out in \d+ms\./;

/** The Vitest options the check's test run takes beside its files. */
export function checkTestOptions() {
  return [
    `--testTimeout=${String(CHECK_TEST_TIMEOUT_MS)}`,
    `--hookTimeout=${String(CHECK_TEST_TIMEOUT_MS)}`,
    '--reporter=minimal',
    `--reporter=${REPORTER}`,
  ];
}

/**
 * What a run ended with, from the modules Vitest reports at its end: every
 * test by name, `<file> › <suite> › <test>`, with the time it was given, how it
 * ended and the message of each error; and every error that belongs to no test
 * — a module that failed to load, a hook around a whole file, an unhandled
 * rejection.
 */
export function summarizeTestRun(testModules, unhandledErrors, repository) {
  const tests = [];
  const errors = [];
  const messageOf = (error) => String(error?.message ?? error);
  for (const testModule of testModules) {
    const file = path.relative(repository, testModule.moduleId).split(path.sep).join('/');
    for (const error of testModule.errors()) errors.push({ file, message: messageOf(error) });
    for (const testCase of testModule.children.allTests()) {
      const result = testCase.result();
      tests.push({
        name: [file, testCase.fullName].join(' › '),
        timeoutMs: testCase.options.timeout,
        state: result.state,
        errors: (result.errors ?? []).map(messageOf),
      });
    }
  }
  for (const error of unhandledErrors) errors.push({ message: messageOf(error) });
  return { tests, errors };
}

/**
 * The tests a failed run lost to their time, where that is all it lost: every
 * failing test failed only by running out of time, and every error outside a
 * test was a hook doing the same, named by its file. Empty where anything else
 * failed, or nothing did.
 */
export function testsTimedOutAlone(summary) {
  const failed = summary.tests.filter((test) => test.state === 'failed');
  const timedOut = (message) => TIMEOUT_MESSAGE.test(message);
  if (failed.length === 0 && summary.errors.length === 0) return [];
  if (failed.some((test) => test.errors.length === 0 || !test.errors.every(timedOut))) return [];
  if (!summary.errors.every((error) => timedOut(error.message))) return [];
  return [
    ...failed.map((test) => test.name),
    ...summary.errors.map((error) => error.file ?? 'outside every test file'),
  ];
}

/** What the check prints for them: a line naming each, then one saying what that means. */
export function timedOutLines(names) {
  return [
    ...names.map((name) => `time ${name}`),
    `time ${String(names.length)} ran out of their time and nothing else failed: a machine ` +
      'under load does this to a passing commit, so a publication runs the checks once more',
  ];
}
