/**
 * Which space a new direct message speaks to (Plan 327 D4).
 *
 * A message outside a thread may name a space with its first word: `#slug`,
 * `@slug`, or the space's name and a colon. A slug matches exactly, and a name
 * matches whatever its case. The rest of the message is what the Helmsman
 * reads. A `#` or `@` word that names no space the operator reaches, or a name
 * of a space they see and do not belong to, is not sent anywhere. Any other
 * opening is the message itself, so `Note: …` stays text.
 *
 * A message that names no space goes to the channel's current space, and to
 * the home space when there is none. `spaces` alone lists the spaces.
 */
import type { ListedSpace } from './aflowApi.js';
import { escapeMrkdwn } from './cards.js';

export type SpaceAddress =
  { kind: 'none' } | { kind: 'space'; space: ListedSpace; rest: string } | { kind: 'unknown' };

export const SPACES_COMMAND = 'spaces';

export const SPACES_HEADING = 'The spaces you can reach:';

export const UNKNOWN_SPACE =
  'This names no space you can reach, so it was not sent. The spaces you can reach:';

export const ADDRESS_HINT =
  'Start a direct message with `#slug`, `@slug` or the space’s name and a colon to send it there. A message that names none goes to the current space.';

const SLUG_WORD = /^[#@](\S+)/;

/** True when the message is `spaces` alone. */
export function isSpacesCommand(text: string): boolean {
  return text.trim().toLowerCase() === SPACES_COMMAND;
}

/** The space the message's first word names, and the text after it. */
export function parseSpaceAddress(text: string, spaces: readonly ListedSpace[]): SpaceAddress {
  const typed = text.trimStart();
  const word = SLUG_WORD.exec(typed);
  if (word?.[1] !== undefined) {
    // A word such as `#night-desk:` ends with the punctuation that follows it.
    const slug = word[1].replace(/[:,]$/, '');
    const space = spaces.find((entry) => entry.reachable && entry.slug === slug);
    if (space === undefined) return { kind: 'unknown' };
    return { kind: 'space', space, rest: typed.slice(word[0].length).trim() };
  }
  const lower = typed.toLowerCase();
  const named = [...spaces]
    .sort((a, b) => Number(b.reachable) - Number(a.reachable))
    .find((entry) => {
      const name = entry.name.trim().toLowerCase();
      return name !== '' && lower.startsWith(name) && /^\s*:/.test(typed.slice(name.length));
    });
  if (named === undefined) return { kind: 'none' };
  if (!named.reachable) return { kind: 'unknown' };
  const rest = typed.slice(named.name.trim().length).replace(/^\s*:/, '').trim();
  return { kind: 'space', space: named, rest };
}

/**
 * The space a message that names none goes to: the channel's current space
 * while the operator still reaches it, else the home space.
 */
export function currentSpaceOf(
  current: string | undefined,
  spaces: readonly ListedSpace[],
  homeSpaceId: string,
): string {
  const reached = spaces.some((space) => space.reachable && space.id === current);
  return reached && current !== undefined ? current : homeSpaceId;
}

/** One line per space the operator reaches, with its slug, the current one marked. */
export function spaceLines(spaces: readonly ListedSpace[], currentId: string): string {
  return spaces
    .filter((space) => space.reachable)
    .map(
      (space) =>
        `• ${escapeMrkdwn(space.name)} \`#${space.slug}\`${space.id === currentId ? ' (current)' : ''}`,
    )
    .join('\n');
}

/** The reply to `spaces`. */
export function spacesListText(spaces: readonly ListedSpace[], currentId: string): string {
  return `${SPACES_HEADING}\n${spaceLines(spaces, currentId)}\n${ADDRESS_HINT}`;
}

/** The one fixed reply to a message that names a space the operator does not reach. */
export function unknownSpaceText(spaces: readonly ListedSpace[], currentId: string): string {
  return `${UNKNOWN_SPACE}\n${spaceLines(spaces, currentId)}\n${ADDRESS_HINT}`;
}

/** The reply to a message that names a space and holds nothing else. */
export function spaceSetText(space: ListedSpace): string {
  return `New direct messages now go to ${escapeMrkdwn(space.name)}. Name another space to send them elsewhere.`;
}
