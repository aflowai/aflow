/**
 * Contract: the check gives every test the time sized for a loaded machine
 * unless the test declares its own, a test that builds a body of a megabyte or
 * more declares its own, and a run is named as lost to time only where nothing
 * but tests running out of it failed.
 *
 * The runs are real Vitest runs over a fixture project whose own config gives
 * its tests five seconds, as this repository's projects do, with the options
 * and the reporter the check passes.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CHECK_TEST_RESULTS_ENV,
  CHECK_TEST_TIMEOUT_MS,
  checkTestOptions,
  OUTSIDE_EVERY_TEST_FILE,
  summarizeTestRun,
  testsTimedOutAlone,
} from './check-tests.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

/** What the fixture project gives a test, as a project of this repository does. */
const PROJECT_TEST_TIMEOUT_MS = 5_000;
/** What a fixture test declares for itself. */
const OWN_TIMEOUT_MS = 120_000;
/** A time a fixture test runs past, and the far shorter one it declares. */
const SLEEP_MS = 200;
const TINY_TIMEOUT_MS = 20;
/** Long enough for a nested Vitest run on a loaded machine. */
const FIXTURE_RUN_TIMEOUT_MS = 120_000;

const FIXTURE_CONFIG = `export default {
  test: {
    projects: [
      {
        test: {
          name: 'fixture',
          include: ['*.test.mjs'],
          globals: true,
          testTimeout: ${String(PROJECT_TEST_TIMEOUT_MS)},
        },
      },
    ],
  },
};
`;

const FIXTURE_TESTS = {
  'given.test.mjs': [
    "it('takes the check’s time', () => {});",
    `it('declares its own', () => {}, ${String(OWN_TIMEOUT_MS)});`,
    '',
  ].join('\n'),
  'timedOut.test.mjs': [
    "it('runs out of its time', async () => {",
    `  await new Promise((resolve) => setTimeout(resolve, ${String(SLEEP_MS)}));`,
    `}, ${String(TINY_TIMEOUT_MS)});`,
    "it('passes', () => {});",
    '',
  ].join('\n'),
  'failed.test.mjs': [
    "it('runs out of its time', async () => {",
    `  await new Promise((resolve) => setTimeout(resolve, ${String(SLEEP_MS)}));`,
    `}, ${String(TINY_TIMEOUT_MS)});`,
    "it('fails on its own', () => { throw new Error('a real failure'); });",
    '',
  ].join('\n'),
};

let fixture;

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'check-tests-'));
  await writeFile(path.join(fixture, 'vitest.config.mjs'), FIXTURE_CONFIG);
  for (const [file, text] of Object.entries(FIXTURE_TESTS)) {
    await writeFile(path.join(fixture, file), text);
  }
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

/** Run the fixture's `file` as the check runs its tests, and read what its reporter wrote. */
async function runAsTheCheck(file) {
  const results = path.join(fixture, `${file}.results.json`);
  // The nested run is a run of its own, not a worker of the one running this test.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')),
  );
  const run = spawnSync(
    process.execPath,
    [
      vitestEntry,
      'run',
      '--root',
      fixture,
      '--config',
      path.join(fixture, 'vitest.config.mjs'),
      ...checkTestOptions(),
      file,
    ],
    { cwd: fixture, env: { ...env, [CHECK_TEST_RESULTS_ENV]: results }, encoding: 'utf8' },
  );
  return {
    status: run.status,
    summary: JSON.parse(await readFile(results, 'utf8')),
  };
}

describe('the time the check gives each test', () => {
  it(
    'is the check’s for a test that declares none, over its project’s, and its own for one that does',
    async () => {
      const { status, summary } = await runAsTheCheck('given.test.mjs');
      expect(status).toBe(0);
      expect(PROJECT_TEST_TIMEOUT_MS).toBeLessThan(CHECK_TEST_TIMEOUT_MS);
      expect(summary.tests).toEqual([
        expect.objectContaining({
          name: 'given.test.mjs › takes the check’s time',
          timeoutMs: CHECK_TEST_TIMEOUT_MS,
          state: 'passed',
        }),
        expect.objectContaining({
          name: 'given.test.mjs › declares its own',
          timeoutMs: OWN_TIMEOUT_MS,
          state: 'passed',
        }),
      ]);
    },
    FIXTURE_RUN_TIMEOUT_MS,
  );
});

describe('a run lost to time alone', () => {
  it(
    'names the tests that ran out of time where nothing else failed',
    async () => {
      const { status, summary } = await runAsTheCheck('timedOut.test.mjs');
      expect(status).not.toBe(0);
      expect(testsTimedOutAlone(summary)).toEqual(['timedOut.test.mjs › runs out of its time']);
    },
    FIXTURE_RUN_TIMEOUT_MS,
  );

  it(
    'is not one where a test also failed on its own',
    async () => {
      const { status, summary } = await runAsTheCheck('failed.test.mjs');
      expect(status).not.toBe(0);
      expect(testsTimedOutAlone(summary)).toEqual([]);
    },
    FIXTURE_RUN_TIMEOUT_MS,
  );

  it('is not one where a file failed to load, or a run that failed nothing', () => {
    const timedOut = {
      name: 'a.test.ts › waits',
      timeoutMs: CHECK_TEST_TIMEOUT_MS,
      state: 'failed',
      errors: [`Test timed out in ${String(CHECK_TEST_TIMEOUT_MS)}ms.`],
    };
    expect(
      testsTimedOutAlone({
        tests: [timedOut],
        errors: [{ file: 'b.test.ts', message: 'Failed to resolve entry for package "@acme/a"' }],
      }),
    ).toEqual([]);
    expect(
      testsTimedOutAlone({
        tests: [timedOut],
        errors: [{ file: 'b.test.ts', message: 'Hook timed out in 30000ms.' }],
      }),
    ).toEqual(['a.test.ts › waits', 'b.test.ts']);
    expect(testsTimedOutAlone({ tests: [{ ...timedOut, state: 'passed' }], errors: [] })).toEqual(
      [],
    );
    expect(testsTimedOutAlone({ tests: [{ ...timedOut, errors: [] }], errors: [] })).toEqual([]);
  });

  it('is one where no failing test is named and the run itself ran out of time, whatever it printed', () => {
    const passed = {
      name: 'a.test.ts › passes',
      timeoutMs: CHECK_TEST_TIMEOUT_MS,
      state: 'passed',
      errors: [],
    };
    // What a machine under load does to a run: workers that do not start, and
    // calls to them that go unanswered, with not one test failing.
    const lostToLoad = {
      tests: [passed],
      errors: [
        { file: 'b.test.ts', message: '[vitest-pool]: Timeout starting forks runner.' },
        { file: 'c.test.ts', message: '[vitest-pool]: Timeout starting forks runner.' },
        { message: '[vitest-worker]: Timeout calling "onTaskUpdate" with "[]"' },
        { message: '[birpc] timeout on calling "onCollected"' },
      ],
    };
    expect(testsTimedOutAlone(lostToLoad)).toEqual([
      'b.test.ts',
      'c.test.ts',
      OUTSIDE_EVERY_TEST_FILE,
    ]);
    // A test that failed on its own, or an error that is no time-out, is a failure.
    expect(
      testsTimedOutAlone({
        ...lostToLoad,
        errors: [...lostToLoad.errors, { message: 'Worker exited unexpectedly' }],
      }),
    ).toEqual([]);
    expect(
      testsTimedOutAlone({
        ...lostToLoad,
        tests: [{ ...passed, state: 'failed', errors: ['expected 1 to be 2'] }],
      }),
    ).toEqual([]);
  });

  it('is summarised from what Vitest reports, files relative to the repository', () => {
    const summary = summarizeTestRun(
      [
        {
          moduleId: path.join(repoRoot, 'apps', 'x', 'src', 'a.test.ts'),
          errors: () => [],
          children: {
            allTests: () => [
              {
                fullName: 'suite > waits',
                options: { timeout: CHECK_TEST_TIMEOUT_MS },
                result: () => ({
                  state: 'failed',
                  errors: [{ message: 'Test timed out in 30000ms.' }],
                }),
              },
            ],
          },
        },
      ],
      [],
      repoRoot,
    );
    expect(summary).toEqual({
      tests: [
        {
          name: 'apps/x/src/a.test.ts › suite > waits',
          timeoutMs: CHECK_TEST_TIMEOUT_MS,
          state: 'failed',
          errors: ['Test timed out in 30000ms.'],
        },
      ],
      errors: [],
    });
  });
});

// ── A test that builds a body of a megabyte or more declares its own time ──

/** What spells a megabyte in this repository's tests. */
const MEGABYTE = '1024 * 1024';
const TEST_SOURCE = /\.test\.tsx?$/;
const WORKSPACE_GROUPS = ['apps', 'packages'];
const TEST_CALLS = new Set(['it', 'test']);
/** Calls and constructors that make a body of the size their argument says. */
const BODY_CALLS = new Set(['repeat', 'alloc']);
const BODY_CONSTRUCTORS = new Set(['Uint8Array', 'ArrayBuffer']);

function workspaceTestSources() {
  const files = [];
  for (const group of WORKSPACE_GROUPS) {
    for (const workspace of readdirSync(path.join(repoRoot, group))) {
      const sourceDir = path.join(repoRoot, group, workspace, 'src');
      let entries;
      try {
        entries = readdirSync(sourceDir, { recursive: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = `${group}/${workspace}/src/${String(entry).split(path.sep).join('/')}`;
        if (TEST_SOURCE.test(file)) files.push(file);
      }
    }
  }
  return files;
}

/** Whether `node` builds a body whose size is named in megabytes. */
function buildsMegabyteBody(node, source) {
  const sized = (args) => (args ?? []).some((arg) => arg.getText(source).includes(MEGABYTE));
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    BODY_CALLS.has(node.expression.name.text) &&
    sized(node.arguments)
  ) {
    return true;
  }
  if (
    ts.isNewExpression(node) &&
    BODY_CONSTRUCTORS.has(node.expression.getText(source)) &&
    sized(node.arguments)
  ) {
    return true;
  }
  return ts.forEachChild(node, (child) => buildsMegabyteBody(child, source)) ?? false;
}

/** Every test in `file` that builds such a body, and whether it declares its own time. */
function megabyteBodyTests(file) {
  const text = readFileSync(path.join(repoRoot, file), 'utf8');
  if (!text.includes(MEGABYTE)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      const [name, body, time] = node.arguments;
      if (
        ts.isIdentifier(callee) &&
        TEST_CALLS.has(callee.text) &&
        body !== undefined &&
        (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
        buildsMegabyteBody(body, source)
      ) {
        found.push({
          test: `${file} › ${name?.getText(source) ?? ''}`,
          declaresItsTime: time !== undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('a test that builds a body of a megabyte or more', () => {
  const found = workspaceTestSources().flatMap(megabyteBodyTests);

  it('is found, the 11 MB response body among them', () => {
    expect(found.map((entry) => entry.test.split(' › ')[0])).toContain(
      'apps/aflow-executor-api/src/handlers/api/saveResponse.test.ts',
    );
  });

  it('declares its own time, which the check does not override', () => {
    expect(found.filter((entry) => !entry.declaresItsTime).map((entry) => entry.test)).toEqual([]);
  });
});
