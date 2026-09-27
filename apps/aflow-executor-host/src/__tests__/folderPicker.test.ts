/**
 * The dialog's three outcomes, which are three different things to do next and
 * were one exit code away from being confused with each other.
 */
import { describe, expect, it } from 'vitest';

import { chooseFolder } from '../folderPicker.js';

describe('choosing a folder from the operating system', () => {
  it('returns the path, without the separator the dialog appends', async () => {
    // `POSIX path of` ends a directory with a slash, and every comparison
    // downstream — containment, `.git` segments, the policy file — is written
    // against the unslashed form.
    const choice = await chooseFolder('pick', {
      platform: 'darwin',
      runner: () => Promise.resolve('/Users/someone/code/thing/\n'),
    });
    expect(choice).toEqual({ kind: 'chosen', path: '/Users/someone/code/thing' });
  });

  it('treats a dismissed dialog as a deliberate no', async () => {
    // Cancelling exits non-zero like any failure. Read as "the picker broke",
    // it would fall through and ask the operator to type the thing they had
    // just declined to give.
    const choice = await chooseFolder('pick', {
      platform: 'darwin',
      runner: () =>
        Promise.reject(
          new Error('Command failed: osascript\nexecution error: User canceled. (-128)'),
        ),
    });
    expect(choice).toEqual({ kind: 'cancelled' });
  });

  it('reports no dialog when there is no session to show one in', async () => {
    // Over ssh or under a launch agent there is no window server. That is a
    // reason to ask in text, not to fail the command.
    const choice = await chooseFolder('pick', {
      platform: 'darwin',
      runner: () => Promise.reject(new Error('osascript is not allowed assistive access')),
    });
    expect(choice).toEqual({ kind: 'unavailable' });
  });

  it('reports no dialog on a platform that has none', async () => {
    let called = false;
    const choice = await chooseFolder('pick', {
      platform: 'linux',
      runner: () => {
        called = true;
        return Promise.resolve('/tmp');
      },
    });
    expect(choice).toEqual({ kind: 'unavailable' });
    // And does not shell out looking for one.
    expect(called).toBe(false);
  });

  it('reports no dialog rather than an empty choice', async () => {
    const choice = await chooseFolder('pick', {
      platform: 'darwin',
      runner: () => Promise.resolve('  \n'),
    });
    expect(choice).toEqual({ kind: 'unavailable' });
  });

  it('quotes the prompt, so an apostrophe cannot end the script', async () => {
    let script = '';
    await chooseFolder("the operator's folder", {
      platform: 'darwin',
      runner: (s) => {
        script = s;
        return Promise.resolve('/tmp/x');
      },
    });
    expect(script).toContain('"the operator\'s folder"');
  });
});
