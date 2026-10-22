/**
 * The tree guards — `scripts/large-files/cli.ts` and `scripts/context-budget/cli.ts`
 * — run under tsx as a loader (`node --import tsx`), never through tsx's own
 * command line, in every root script: `yarn typecheck`, `yarn large-files:*`,
 * `yarn context:*`. The command line starts the script as a child and opens a
 * socket to talk to it, which the sandbox a coding agent and the check run in
 * refuses (`listen EPERM`); the loader runs it in-process and opens none.
 * `scripts/verify-commit.mjs` runs them the same way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');
const GUARDS = ['scripts/large-files/cli.ts', 'scripts/context-budget/cli.ts'];

const scripts = Object.entries(
  /** @type {{ scripts: Record<string, string> }} */ (
    JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  ).scripts,
);

/** Each place a script names `guard`, as the two words before it and the guard. */
function invocations(command, guard) {
  const tokens = command.split(/\s+/);
  return tokens.flatMap((token, at) =>
    token === guard ? [tokens.slice(Math.max(0, at - 3), at + 1).join(' ')] : [],
  );
}

describe('the tree guards in the root scripts', () => {
  for (const guard of GUARDS) {
    it(`runs ${guard} under tsx as a loader, and never through its command line`, () => {
      const found = scripts.flatMap(([name, command]) =>
        invocations(command, guard).map((invocation) => ({ name, invocation })),
      );
      expect(found.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['typecheck', expect.stringMatching(/:check$/)]),
      );
      for (const { name, invocation } of found) {
        expect({ name, invocation }).toEqual({
          name,
          invocation: `node --import tsx ${guard}`,
        });
      }
    });
  }
});
