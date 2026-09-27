/**
 * The real decision, not a copy of it.
 *
 * An earlier version of this file restated the rule and asserted against its own
 * restatement, so the implementation could have started accepting every string
 * while the suite stayed green.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { THEMES, storedTheme } from './themeStorage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDER_SRC = readFileSync(resolve(__dirname, './theme.tsx'), 'utf8');

describe('a theme read back from storage', () => {
  it('accepts the ones the document has selectors for', () => {
    for (const theme of THEMES) expect(storedTheme(theme)).toBe(theme);
  });

  it('refuses one the document could not style', () => {
    expect(storedTheme('sepia')).toBeNull();
    expect(storedTheme('')).toBeNull();
    expect(storedTheme('DARK')).toBeNull();
    expect(storedTheme(null)).toBeNull();
  });

  it('is what the provider reads through, rather than a cast', () => {
    expect(PROVIDER_SRC).toContain('storedTheme(localStorage.getItem(THEME_STORAGE_KEY))');
    expect(PROVIDER_SRC, 'the stored value is cast straight to Theme').not.toContain(
      'as Theme | null',
    );
  });
});
