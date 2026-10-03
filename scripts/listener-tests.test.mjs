/**
 * Contract: on macOS the check leaves out the tests that declare the
 * `listener` tag, names each one it skipped and counts them, with one line
 * saying CI runs them; elsewhere it leaves none out.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LISTENER_TAG,
  listenerSkipLines,
  listenersRefused,
  skippedListenerTests,
  WITHOUT_LISTENER_TESTS,
} from './listener-tests.mjs';

const REPOSITORY = '/repo';

/** A Vitest JSON report as the check's run leaves it, reduced to what is read. */
const REPORT = {
  testResults: [
    {
      name: `${REPOSITORY}/packages/ai-client/src/providers/openaiResponsesStream.test.ts`,
      assertionResults: [
        {
          ancestorTitles: ['OpenAI streaming rides the Responses API'],
          title: 'streams tools and a reasoning effort to /v1/responses',
          status: 'skipped',
          tags: [LISTENER_TAG],
        },
        {
          ancestorTitles: ['OpenAI streaming rides the Responses API'],
          title: 'labels a failure while reading the xAI stream as xAI',
          status: 'skipped',
          tags: [LISTENER_TAG],
        },
      ],
    },
    {
      name: `${REPOSITORY}/apps/aflow-executor-host/src/__tests__/commitCheck.test.ts`,
      assertionResults: [
        { ancestorTitles: ['a check'], title: 'passes', status: 'passed', tags: [] },
        { ancestorTitles: ['a check'], title: 'is not ready', status: 'skipped', tags: [] },
        {
          ancestorTitles: ['host.commit.check — through the real sandbox'],
          title: 'runs a passing check confined',
          status: 'skipped',
          tags: [LISTENER_TAG],
        },
        { ancestorTitles: [], title: 'has no tags field', status: 'skipped' },
      ],
    },
  ],
};

describe('the listener tests a check skipped', () => {
  it('are named by file, suite and test, and only the skipped ones carrying the tag', () => {
    expect(skippedListenerTests(REPORT, REPOSITORY)).toEqual([
      'packages/ai-client/src/providers/openaiResponsesStream.test.ts › OpenAI streaming rides the Responses API › streams tools and a reasoning effort to /v1/responses',
      'packages/ai-client/src/providers/openaiResponsesStream.test.ts › OpenAI streaming rides the Responses API › labels a failure while reading the xAI stream as xAI',
      'apps/aflow-executor-host/src/__tests__/commitCheck.test.ts › host.commit.check — through the real sandbox › runs a passing check confined',
    ]);
  });

  it('are printed one line each, then counted on one line saying CI runs them', () => {
    const lines = listenerSkipLines(['a.test.ts › one', 'b.test.ts › two']);
    expect(lines).toEqual([
      'skip a.test.ts › one',
      'skip b.test.ts › two',
      'skip 2 tests that listen on a port of their own: the sandbox a check runs in on macOS ' +
        'refuses them a listener, and CI runs them',
    ]);
    expect(listenerSkipLines([])).toEqual([]);
  });

  it('are left out on macOS alone, by the tag the Vitest config defines', () => {
    expect(listenersRefused('darwin')).toBe(true);
    expect(listenersRefused('linux')).toBe(false);
    expect(WITHOUT_LISTENER_TESTS).toEqual([`--tags-filter=!${LISTENER_TAG}`]);
    const config = readFileSync(path.join(import.meta.dirname, '..', 'vitest.config.ts'), 'utf8');
    expect(config).toContain(`name: '${LISTENER_TAG}'`);
  });

  it('include the ten ai-client tests that serve themselves, by the tag on their file', () => {
    const file = readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        'packages/ai-client/src/providers/openaiResponsesStream.test.ts',
      ),
      'utf8',
    );
    expect(file).toMatch(new RegExp(`\\*\\s*@module-tag\\s+${LISTENER_TAG}\\b`));
    expect(file.match(/^ {2}it\(/gm)).toHaveLength(10);
  });
});
