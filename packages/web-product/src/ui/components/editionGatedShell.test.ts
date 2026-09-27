/**
 * The shell's sign-out is served by a route only the enterprise edition
 * composes (`/auth/logout`). A community-local process registers none, so
 * rendering the action there produces a control that deterministically 404s —
 * worse than a control that was never offered.
 *
 * The guard matters more here than it did in the application it came from: this
 * shell is now rendered by both editions from one source, so the gate is the
 * only thing standing between a local visitor and that dead control.
 *
 * It reads source because the invariant is about what the tree renders and
 * there is no renderable test surface: the shell pulls the whole provider stack
 * in behind it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SHELL_SRC = readFileSync(resolve(__dirname, './app-shell.tsx'), 'utf8');

/**
 * The braced expression that starts at `marker`, matched by depth so the guard
 * survives reformatting rather than pinning line breaks.
 */
function blockFrom(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `gate marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces from gate marker: ${marker}`);
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('sign out — app shell', () => {
  // Positively hosted, not merely "not local": the edition is null until the
  // server answers, and a negative test would show the action in that window.
  it('tests the edition, not a surface: a local process has no session to end', () => {
    expect(APP_SHELL_SRC).toContain('useEdition()');
    expect(APP_SHELL_SRC).toContain("isHostedEdition = edition.id === 'enterprise'");
    expect(APP_SHELL_SRC).not.toContain("!== 'community-local'");
  });

  it('renders the sign-out action only where a logout route exists', () => {
    const gate = blockFrom(APP_SHELL_SRC, '{isHostedEdition && (');
    const navigation = "window.location.href = '/auth/logout'";
    expect(gate).toContain('label="Sign out"');
    expect(gate).toContain(navigation);
    expect(
      countOf(APP_SHELL_SRC, navigation),
      'the shell navigates to the logout route outside the edition gate',
    ).toBe(countOf(gate, navigation));
    expect(countOf(APP_SHELL_SRC, 'label="Sign out"')).toBe(1);
  });
});
