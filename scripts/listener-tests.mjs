/**
 * Tests that listen on a port of their own, as the check counts them.
 *
 * Such a test says so with the Vitest tag `listener` — on the test, on its
 * suite, or on the whole file as `// @module-tag listener` — which the root
 * Vitest config defines, so a test spelling it otherwise fails instead of going
 * uncounted. Under the check's sandbox on macOS nothing can listen on loopback,
 * so the check leaves these tests out there and names each one; CI runs them
 * as it runs every other test.
 */
import path from 'node:path';
import process from 'node:process';

export const LISTENER_TAG = 'listener';

/** Whether a check on this platform runs where no test can listen on loopback. */
export function listenersRefused(platform = process.platform) {
  return platform === 'darwin';
}

/** The Vitest arguments that leave the listener tests out of a run. */
export const WITHOUT_LISTENER_TESTS = [`--tags-filter=!${LISTENER_TAG}`];

/**
 * The listener tests a Vitest JSON report shows as skipped, each as
 * `<file> › <suite> › <test>`, the file relative to the repository.
 */
export function skippedListenerTests(report, repository) {
  return report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => test.status === 'skipped' && (test.tags ?? []).includes(LISTENER_TAG))
      .map((test) =>
        [path.relative(repository, file.name), ...test.ancestorTitles, test.title].join(' › '),
      ),
  );
}

/** What the check prints for them: a line naming each, then one saying where they run. */
export function listenerSkipLines(names) {
  if (names.length === 0) return [];
  return [
    ...names.map((name) => `skip ${name}`),
    `skip ${String(names.length)} tests that listen on a port of their own: the sandbox a check ` +
      'runs in on macOS refuses them a listener, and CI runs them',
  ];
}
