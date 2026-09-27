import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every streaming provider must tick `onStreamProgress` inside its chunk loop.
 *
 * The executor arms a fixed idle window and slides it only when a provider
 * reports progress, so a stream loop that stops reporting does not degrade —
 * it becomes a hard timeout on any generation longer than the window, and the
 * failure looks like a slow model rather than missing wiring. Nothing else in
 * the suite covers this: the call can be deleted and every other test passes.
 */
const PROVIDERS_DIR = join(import.meta.dirname, '..');

function streamingProviderFiles(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => {
      const src = readFileSync(join(PROVIDERS_DIR, f), 'utf8');
      // Both, and for different reasons: `generateTextStream` is the surface
      // the agent turn calls, and `for await` is the chunk loop that is the
      // only place progress can be reported from. A media provider that polls
      // a job has neither and has nothing to tick.
      return src.includes('generateTextStream') && src.includes('for await');
    });
}

function reportsFromInsideLoop(src: string): boolean {
  const sf = ts.createSourceFile('p.ts', src, ts.ScriptTarget.Latest, true);
  let found = false;

  const callsProgress = (node: ts.Node): boolean => {
    let hit = false;
    const scan = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n)) {
        // `request.onStreamProgress?.()` parses as a call whose expression is
        // an optional property access ending in the callback name.
        const text = n.expression.getText(sf);
        if (text.endsWith('onStreamProgress')) hit = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
    return hit;
  };

  const walk = (node: ts.Node): void => {
    if (found) return;
    // A chunk loop is `for await (… of stream)`. Only its BODY counts: a call
    // after the loop closes satisfies any offset comparison while never
    // running per chunk.
    if (ts.isForOfStatement(node) && node.awaitModifier && callsProgress(node.statement)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

describe('a streaming provider reports progress from its chunk loop', () => {
  const files = streamingProviderFiles();

  it('finds the streaming providers to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} calls onStreamProgress from inside its chunk loop`, () => {
      const src = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
      // Structural, not textual: the identifier also appears in request types
      // and forwarding, and a call placed just after the loop closes satisfies
      // any offset comparison while never running per chunk. Only a call in the
      // body of a `for await` ticks the deadline.
      expect(
        reportsFromInsideLoop(src),
        'onStreamProgress is not invoked inside a `for await` body',
      ).toBe(true);
    });
  }
});
