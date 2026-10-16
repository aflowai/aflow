/**
 * Contract: a publication runs only where the executor's git can bring the
 * commit it makes in its clone into the folder — a fetch with
 * `--no-write-fetch-head`, git 2.29 or later — and the refusal says what is
 * missing.
 */
import { describe, expect, it } from 'vitest';

import {
  publicationGitMissing,
  publicationGitReadiness,
  noPublicationGitMessage,
  parseGitVersion,
} from '../gitReadiness.js';

describe('the git a publication needs', () => {
  it('reads the version however the build spells it', () => {
    expect(parseGitVersion('git version 2.52.0\n')).toEqual({ major: 2, minor: 52, patch: 0 });
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual({
      major: 2,
      minor: 39,
      patch: 5,
    });
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
    });
    expect(parseGitVersion('not git')).toBeUndefined();
  });

  it('names the version found, the version needed and the fetch flag below the floor', () => {
    expect(publicationGitMissing('git version 2.29.0')).toEqual([]);
    expect(publicationGitMissing('git version 3.0.0')).toEqual([]);
    const [missing] = publicationGitMissing('git version 2.28.1');
    expect(missing).toContain('git 2.29 or later');
    expect(missing).toContain('this machine has 2.28.1');
    expect(missing).toContain('`--no-write-fetch-head`');
    expect(publicationGitMissing(undefined)).toHaveLength(1);
    expect(publicationGitMissing('something else')[0]).toContain('`something else`');
  });

  it('refuses in the shape of the sandbox refusal, carrying what is missing', () => {
    const message = noPublicationGitMessage(publicationGitMissing('git version 2.20.1'));
    expect(message).toContain('nothing can be published here');
    expect(message).toContain('Missing: git 2.29 or later — this machine has 2.20.1');
  });

  it('finds this machine ready', async () => {
    expect(await publicationGitReadiness()).toEqual({ ready: true, missing: [] });
  });
});
