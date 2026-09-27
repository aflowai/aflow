/**
 * Which card a result gets, and why the order matters.
 *
 * A host result and a compute result share `exitCode` and `durationMs`, so the
 * shapes overlap and detection is decided by the handle each carries. Getting
 * that wrong is silent: the wrong card renders, missing the fields it wanted,
 * and nobody sees an error.
 */
import { describe, expect, it } from 'vitest';
import { isValidElement } from 'react';

import { isComputeResult } from '../compute/ComputeResultCard.js';
import { MarkdownRenderer } from '../markdown-renderer.js';
import {
  changedFilePaths,
  HostHarnessBody,
  isHostHarnessResult,
  isHostInspectResult,
  isHostProcessResult,
  readHarnessChecks,
  type HostHarnessResult,
} from './HostOutputCard.js';

const hostExec = {
  processId: 'hp_abc_1',
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 298,
  stdout: 'total 8\n',
  stderr: '',
  truncated: false,
};

const harnessRun = {
  runId: 'hr_abc_3',
  sessionRef: 'hs_abc_1',
  continued: false,
  baseSha: '5af899c7ca753a56a4daeb6fa6ff3cbb113234b8',
  patch: 'diff --git a/x b/x\n',
  filesChanged: 1,
  exitCode: 0,
  timedOut: false,
  durationMs: 18639,
  truncated: false,
};

const computeRun = { exitCode: 0, data: 'hello\n', stderr: '', durationMs: 42 };

/** What a detached process reports: a state and a slice, no duration, no exit. */
const hostInspect = {
  processId: 'hp_abc_1',
  state: 'running' as const,
  startedAt: '2026-09-13T10:00:00.000Z',
  descendantCount: 2,
  output: 'webpack compiled\n',
};

describe('telling one machine result from another', () => {
  it('recognises a host command by its process handle', () => {
    expect(isHostProcessResult(hostExec)).toBe(true);
    expect(isHostHarnessResult(hostExec)).toBe(false);
  });

  it('recognises a harness run by its run handle and base commit', () => {
    expect(isHostHarnessResult(harnessRun)).toBe(true);
    expect(isHostProcessResult(harnessRun)).toBe(false);
  });

  it('does not claim a compute result', () => {
    // The overlap that makes order matter: compute carries `exitCode` and
    // `durationMs` too, and would match anything keyed on those alone.
    expect(isHostProcessResult(computeRun)).toBe(false);
    expect(isHostHarnessResult(computeRun)).toBe(false);
    expect(isComputeResult(computeRun)).toBe(true);
  });

  it('is not fooled by something that merely has the field names', () => {
    expect(isHostProcessResult({ processId: 42 })).toBe(false);
    expect(isHostHarnessResult({ runId: 'x' })).toBe(false);
    expect(isHostProcessResult(null)).toBe(false);
    expect(isHostProcessResult('hp_abc_1')).toBe(false);
  });
});

/**
 * The two host shapes must not answer for each other. Sharing one guard is
 * what sent inspect results to the raw-JSON fallback: the exec fields it
 * required are exactly the ones a running process cannot have yet.
 */
describe('an exec result and an inspect result are told apart', () => {
  it('recognises an inspect result by its state', () => {
    expect(isHostInspectResult(hostInspect)).toBe(true);
  });

  it('does not read an inspect result as a finished command', () => {
    expect(isHostProcessResult(hostInspect)).toBe(false);
  });

  it('does not read a finished command as an inspection', () => {
    expect(isHostInspectResult(hostExec)).toBe(false);
  });

  it('refuses a handle carrying a state nobody defined', () => {
    expect(isHostInspectResult({ processId: 'hp_x', state: 'sleeping' })).toBe(false);
  });
});

/**
 * What the completed half of the card reads out of a result it did not define.
 *
 * The typed result is whatever the task's `outputSchema` asked for, so checks
 * arrive under whichever spelling the skill chose. Reading too eagerly is the
 * failure that matters: a strip of confident green ticks invented from a field
 * that meant something else.
 */
describe('reading checks out of a typed result', () => {
  it('reads a verdict however the skill spelled it', () => {
    expect(
      readHarnessChecks({
        checks: [
          { name: 'typecheck', ok: true },
          { profileName: 'unit', conclusion: 'failure', failedCommand: 'yarn test' },
          { label: 'lint', status: 'success' },
        ],
      }),
    ).toEqual([
      { label: 'typecheck', ok: true },
      { label: 'unit', ok: false },
      { label: 'lint', ok: true },
    ]);
  });

  it('says it does not know rather than guessing', () => {
    expect(readHarnessChecks({ checks: [{ name: 'e2e', conclusion: 'skipped' }] })).toEqual([
      { label: 'e2e', ok: null },
    ]);
  });

  it('claims nothing from a result with no checks in it', () => {
    expect(readHarnessChecks({ summary: 'all good' })).toEqual([]);
    expect(readHarnessChecks({ checks: 'two passed' })).toEqual([]);
    expect(readHarnessChecks([{ name: 'typecheck', ok: true }])).toEqual([]);
    expect(readHarnessChecks(undefined)).toEqual([]);
  });

  it('skips an entry nothing can be named from, leaving the result itself to answer', () => {
    expect(readHarnessChecks({ checks: [{ ok: true }, { name: 'build', ok: true }] })).toEqual([
      { label: 'build', ok: true },
    ]);
  });
});

describe('what a diff changed', () => {
  it('names each file once, in the order the diff names them', () => {
    const patch = [
      'diff --git a/src/parser.ts b/src/parser.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/parser.test.ts b/src/parser.test.ts',
      '@@ -1 +1 @@',
      '+covered',
    ].join('\n');

    expect(changedFilePaths(patch)).toEqual(['src/parser.ts', 'src/parser.test.ts']);
  });

  it('takes the destination path of a rename', () => {
    expect(changedFilePaths('diff --git a/old/name.ts b/new/name.ts')).toEqual(['new/name.ts']);
  });

  it('finds nothing in a diff that names nothing', () => {
    expect(changedFilePaths('')).toEqual([]);
    expect(changedFilePaths('+ a line with no header')).toEqual([]);
  });
});

/**
 * The closing answer is the whole point of a finished run, and the agent wrote
 * it as prose: headings, lists, a fenced snippet. Rendered as a code block it
 * arrives as its own source, three lines at a time behind a `more lines`
 * button — which is how the answer to the run came to be the hardest thing on
 * the card to read.
 */
describe('the closing answer', () => {
  const said = '## Fixed the parser\n\n- guards empty input\n- covers it in `parser.test.ts`\n';
  const answered: HostHarnessResult = {
    runId: 'hr_abc_4',
    baseSha: '5af899c7ca753a56a4daeb6fa6ff3cbb113234b8',
    filesChanged: 2,
    exitCode: 0,
    timedOut: false,
    durationMs: 18_639,
    stdout: said,
  };

  it('goes to the markdown renderer, whole', () => {
    expect(markdownContents(HostHarnessBody({ result: answered }))).toEqual([said]);
  });

  it('is absent from the card where the run said nothing', () => {
    expect(markdownContents(HostHarnessBody({ result: { ...answered, stdout: '  ' } }))).toEqual(
      [],
    );
  });
});

/** Every string the rendered block hands to `MarkdownRenderer`, in tree order. */
function markdownContents(node: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isValidElement(value)) return;
    const props = value.props as Record<string, unknown>;
    const content = props['content'];
    if (value.type === MarkdownRenderer && typeof content === 'string') found.push(content);
    visit(props['children']);
  };
  visit(node);
  return found;
}
