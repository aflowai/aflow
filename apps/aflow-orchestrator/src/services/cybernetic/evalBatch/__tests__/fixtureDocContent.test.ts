/**
 * A fixture payload is materialized only under the path it claims.
 *
 * The mined payload wraps the body as `{ path, content }`, so a wrapped body
 * naming a different path means the ref points at another document than the
 * fixture declares. Materializing it anyway would grade the trial against
 * content the case never captured — a wrong verdict rather than a loud
 * failure — so the mismatch returns null and the caller fails the trial.
 */
import { describe, it, expect } from 'vitest';
import { fixtureDocContent } from '../fixtureSpaces.js';

describe('fixtureDocContent', () => {
  it('takes a bare string body as-is', () => {
    expect(fixtureDocContent('hello', '/notes/a.md')).toBe('hello');
  });

  it('takes a wrapped body whose path matches', () => {
    expect(fixtureDocContent({ path: '/notes/a.md', content: 'hello' }, '/notes/a.md')).toBe(
      'hello',
    );
  });

  it('takes a wrapped body carrying no path', () => {
    expect(fixtureDocContent({ content: 'hello' }, '/notes/a.md')).toBe('hello');
  });

  it('refuses a wrapped body naming a different path', () => {
    expect(fixtureDocContent({ path: '/notes/OTHER.md', content: 'hello' }, '/notes/a.md')).toBe(
      null,
    );
  });

  it('refuses a payload with no string body', () => {
    expect(fixtureDocContent({ path: '/notes/a.md' }, '/notes/a.md')).toBe(null);
    expect(fixtureDocContent(null, '/notes/a.md')).toBe(null);
    expect(fixtureDocContent(42, '/notes/a.md')).toBe(null);
  });
});
