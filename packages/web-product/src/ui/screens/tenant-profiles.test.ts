/**
 * Settings → Profiles offers Add profile (Plan 335 §12, lifted in P3).
 *
 * P2 disabled it, because a second profile locked every browser out until a
 * picker could issue a session. The picker now issues one, so nothing about
 * the profiles may hold the button back. Read from the source, because this
 * package renders no component in its tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), './tenant-profiles.tsx'),
  'utf8',
);

/**
 * The props of the page's own Add profile button, the one with the plus icon.
 * The dialog's confirm button carries the same label and is disabled until a
 * name and an avatar are chosen.
 */
function addButtonProps(src: string): string {
  const start = src.indexOf('leftIcon={<Icon name="plus"');
  const end = src.indexOf('Add profile', start);
  expect(start, 'the page has an Add profile button').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Add profile on Settings → Profiles', () => {
  it('is not disabled by the profiles the install has', () => {
    expect(addButtonProps(SOURCE)).not.toMatch(/disabled=/);
  });

  it('opens its dialog whenever it is pressed', () => {
    expect(SOURCE).toMatch(/<AddProfileDialog\s+open=\{adding\}/);
  });

  it('no longer says the add waits for the picker', () => {
    expect(SOURCE).not.toMatch(/waits for the profile picker/);
  });
});
