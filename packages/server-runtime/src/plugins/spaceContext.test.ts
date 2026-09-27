/**
 * Which space a request is about.
 *
 * Authorization reads the `:spaceId` route parameter; the handler used to read
 * the header. A request checked against one space therefore operated on
 * another, and in development a caller that sent no header at all operated on
 * whichever space it happened to own first. The precedence below is what keeps
 * the check and the action about the same thing.
 */
import { describe, expect, it } from 'vitest';
import { spaceIdFromRequest } from './space.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

describe('spaceIdFromRequest', () => {
  it('takes the route parameter over everything else', () => {
    // The case that was wrong: authorization passes on A, and the handler used
    // to go on to read and write B.
    expect(
      spaceIdFromRequest({
        params: { spaceId: A },
        headers: { 'x-space-id': B },
        query: { spaceId: C },
      }),
    ).toBe(A);
  });

  it('falls back to the header when the path declares no space', () => {
    expect(spaceIdFromRequest({ params: {}, headers: { 'x-space-id': B } })).toBe(B);
  });

  it('falls back to the query parameter when there is no header', () => {
    expect(spaceIdFromRequest({ params: {}, headers: {}, query: { spaceId: C } })).toBe(C);
  });

  it('names no space when the request names none', () => {
    // Not "the first space this user owns" — that decision belongs to the one
    // caller that may guess, and only outside production.
    expect(spaceIdFromRequest({ params: {}, headers: {}, query: {} })).toBeUndefined();
    expect(spaceIdFromRequest({ headers: {} })).toBeUndefined();
  });

  it('ignores empty and non-string values rather than resolving to them', () => {
    expect(spaceIdFromRequest({ params: { spaceId: '' }, headers: { 'x-space-id': B } })).toBe(B);
    expect(spaceIdFromRequest({ params: { spaceId: 42 }, headers: { 'x-space-id': B } })).toBe(B);
  });
});
