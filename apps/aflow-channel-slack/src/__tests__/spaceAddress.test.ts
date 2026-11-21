/**
 * A new direct message names its space with its first word: `#slug`, `@slug`,
 * or the space's name and a colon. A slug matches exactly and a name matches
 * whatever its case.
 */
import { describe, expect, it } from 'vitest';

import type { ListedSpace } from '../aflowApi.js';
import { listedSpacesOf } from '../aflowApi.js';
import {
  currentSpaceOf,
  isSpacesCommand,
  parseSpaceAddress,
  spacesListText,
} from '../spaceAddress.js';

const TRADING: ListedSpace = {
  id: 's-1',
  name: 'Trading Joe',
  slug: 'trading-joe',
  reachable: true,
};
const NIGHT: ListedSpace = { id: 's-2', name: 'Night Desk', slug: 'night-desk', reachable: true };
const BACK: ListedSpace = { id: 's-3', name: 'Back Office', slug: 'back-office', reachable: false };
const SPACES = [TRADING, NIGHT, BACK];

describe('a space named by slug', () => {
  it('is addressed with `#slug`, and the rest is the message', () => {
    expect(parseSpaceAddress('#night-desk what runs now?', SPACES)).toEqual({
      kind: 'space',
      space: NIGHT,
      rest: 'what runs now?',
    });
  });

  it('is addressed with `@slug`', () => {
    expect(parseSpaceAddress('@trading-joe status?', SPACES)).toEqual({
      kind: 'space',
      space: TRADING,
      rest: 'status?',
    });
  });

  it('takes the colon or comma that follows the slug as punctuation', () => {
    expect(parseSpaceAddress('#night-desk: status?', SPACES)).toMatchObject({ rest: 'status?' });
    expect(parseSpaceAddress('@night-desk, status?', SPACES)).toMatchObject({ rest: 'status?' });
  });

  it('matches exactly, so another case names no space', () => {
    expect(parseSpaceAddress('#Night-Desk status?', SPACES)).toEqual({ kind: 'unknown' });
  });

  it('names no space the operator reaches when the slug is unknown or not theirs', () => {
    expect(parseSpaceAddress('#nowhere status?', SPACES)).toEqual({ kind: 'unknown' });
    expect(parseSpaceAddress('#back-office status?', SPACES)).toEqual({ kind: 'unknown' });
  });

  it('holds nothing else when the message is the slug alone', () => {
    expect(parseSpaceAddress('#night-desk', SPACES)).toEqual({
      kind: 'space',
      space: NIGHT,
      rest: '',
    });
  });
});

describe('a space named by its name and a colon', () => {
  it('matches whatever the case', () => {
    expect(parseSpaceAddress('night DESK: what runs now?', SPACES)).toEqual({
      kind: 'space',
      space: NIGHT,
      rest: 'what runs now?',
    });
    expect(parseSpaceAddress('Trading Joe : status?', SPACES)).toMatchObject({ space: TRADING });
  });

  it('names no space the operator reaches when the space is one they are no member of', () => {
    expect(parseSpaceAddress('Back Office: status?', SPACES)).toEqual({ kind: 'unknown' });
  });

  it('is the message itself when the name is no space’s, or no colon follows it', () => {
    expect(parseSpaceAddress('Note: buy milk', SPACES)).toEqual({ kind: 'none' });
    expect(parseSpaceAddress('Night Desk is quiet today', SPACES)).toEqual({ kind: 'none' });
    expect(parseSpaceAddress('status?', SPACES)).toEqual({ kind: 'none' });
  });
});

describe('the current space', () => {
  it('is the channel’s while the operator reaches it, and the home space otherwise', () => {
    expect(currentSpaceOf(NIGHT.id, SPACES, TRADING.id)).toBe(NIGHT.id);
    expect(currentSpaceOf(undefined, SPACES, TRADING.id)).toBe(TRADING.id);
    expect(currentSpaceOf(BACK.id, SPACES, TRADING.id)).toBe(TRADING.id);
    expect(currentSpaceOf('gone', SPACES, TRADING.id)).toBe(TRADING.id);
  });
});

describe('the `spaces` list', () => {
  it('is asked for by `spaces` alone, whatever the case', () => {
    expect(isSpacesCommand(' Spaces ')).toBe(true);
    expect(isSpacesCommand('spaces?')).toBe(false);
    expect(isSpacesCommand('list the spaces')).toBe(false);
  });

  it('shows each space the operator reaches with its slug, and marks the current one', () => {
    const text = spacesListText(SPACES, NIGHT.id);
    expect(text).toContain('• Trading Joe `#trading-joe`\n• Night Desk `#night-desk` (current)');
    expect(text).not.toContain('Back Office');
  });
});

describe('the spaces Aflow lists', () => {
  it('are reachable where the account holds a role, and skipped without a name or slug', () => {
    expect(
      listedSpacesOf({
        spaces: [
          { id: 's-1', name: 'Trading Joe', slug: 'trading-joe', myRole: 'viewer' },
          { id: 's-3', name: 'Back Office', slug: 'back-office', myRole: null },
          { id: 's-4', slug: 'no-name', myRole: 'admin' },
        ],
      }),
    ).toEqual([
      { id: 's-1', name: 'Trading Joe', slug: 'trading-joe', reachable: true },
      { id: 's-3', name: 'Back Office', slug: 'back-office', reachable: false },
    ]);
  });
});
