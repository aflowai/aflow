/**
 * Every message the app posts for a space opens with the space's name in
 * brackets, read through the API and kept for a while.
 */
import { describe, expect, it } from 'vitest';

import type { AflowApi } from '../aflowApi.js';
import { SPACE_NAME_TTL_MS, SpaceNames, prefixedBlocks, spacePrefix } from '../spaceNames.js';

function namesFrom(answers: Array<string | Error>) {
  const reads: string[] = [];
  const api: Pick<AflowApi, 'spaceName'> = {
    spaceName: (spaceId) => {
      reads.push(spaceId);
      const answer = answers.shift();
      if (answer === undefined || answer instanceof Error) {
        return Promise.resolve({
          ok: false,
          status: 0,
          error: 'UNREACHABLE',
          message: 'Aflow did not answer.',
          retryable: true,
          outcomeUnknown: false,
        });
      }
      return Promise.resolve({ ok: true, name: answer });
    },
  };
  return { api, reads };
}

describe('the space prefix', () => {
  it('names the space in brackets, escaped as mrkdwn', () => {
    expect(spacePrefix('Trading Joe')).toBe('[Trading Joe] ');
    expect(spacePrefix('R&D <ops>')).toBe('[R&amp;D &lt;ops&gt;] ');
  });

  it('reads a name once, and again once it is old', async () => {
    let now = 0;
    const { api, reads } = namesFrom(['Trading Joe', 'Trading Joe Ltd']);
    const names = new SpaceNames(api, () => now);

    expect(await names.prefix('space-1')).toBe('[Trading Joe] ');
    expect(await names.prefix('space-1')).toBe('[Trading Joe] ');
    now = SPACE_NAME_TTL_MS;
    expect(await names.prefix('space-1')).toBe('[Trading Joe Ltd] ');
    expect(reads).toEqual(['space-1', 'space-1']);
  });

  it('keeps the last name read when a read fails, and shows the id when none came back', async () => {
    let now = 0;
    const { api } = namesFrom(['Trading Joe', new Error('down'), new Error('down')]);
    const names = new SpaceNames(api, () => now);

    await names.prefix('space-1');
    now = SPACE_NAME_TTL_MS;
    expect(await names.prefix('space-1')).toBe('[Trading Joe] ');
    expect(await names.prefix('space-2')).toBe('[space-2] ');
  });

  it('opens the first block that shows mrkdwn, and leaves the rest', () => {
    const blocks = [
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: 'Run it now?' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Second.' } },
    ];
    expect(prefixedBlocks('[Trading Joe] ', blocks)).toEqual([
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '[Trading Joe] Run it now?' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Second.' } },
    ]);
    expect(
      prefixedBlocks('[Trading Joe] ', [
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Decided.' }] },
      ]),
    ).toEqual([
      { type: 'context', elements: [{ type: 'mrkdwn', text: '[Trading Joe] Decided.' }] },
    ]);
  });
});
