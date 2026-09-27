import { describe, expect, it } from 'vitest';
import { governedPathRefusal } from '../governedPaths.js';

/**
 * A draft carries a revision, a replay key and a compare-and-swap. A generic
 * memory write has none of those, so editing a draft underneath them loses a
 * concurrent patch silently — and the id route reaches a document no
 * path-shaped guard upstream ever sees.
 */
describe('a task draft is not writable as ordinary memory', () => {
  it('refuses a draft path', () => {
    const refusal = governedPathRefusal('/run/draft/run-1/design/1.json');
    expect(refusal).toContain('draft_patch');
  });

  it('refuses whatever attempt or task it names', () => {
    expect(governedPathRefusal('/run/draft/other-run/other-task/7.json')).not.toBeNull();
  });

  it('leaves ordinary paths alone', () => {
    expect(governedPathRefusal('/data/notes.md')).toBeNull();
    expect(governedPathRefusal('/run/outputs/api_0/data')).toBeNull();
  });
});
