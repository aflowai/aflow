/**
 * The compiler bundles source a user typed. Bundling normally means reading the
 * filesystem, which on a request-handling server would make the preview a
 * file-read primitive: import a path, receive its contents back in the returned
 * HTML.
 *
 * What prevents it is `stdin` carrying no `resolveDir`. esbuild then has no base
 * to resolve against and refuses every path — a property of the options rather
 * than of anything visible at the call site, so adding a `resolveDir` to fix some
 * unrelated "could not resolve" would quietly restore the primitive.
 *
 * **Asserted on the options, because the behavioural version does not hold.**
 * Compiling an import of `/etc/hostname` fails with a `resolveDir` too — it is
 * not parseable as a module — and `ioredis` is not resolvable from this package
 * either. Every case a reader would reach for fails for its own reason, so the
 * suite passed with the protection deliberately removed. Watching what is handed
 * to the bundler is the only form of this that can fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const built: Parameters<typeof import('esbuild').build>[0][] = [];

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return {
    ...actual,
    build: (options: Parameters<typeof actual.build>[0]) => {
      built.push(options);
      return actual.build(options);
    },
  };
});

const { compile } = await import('./uiCompiler.js');

afterEach(() => {
  built.length = 0;
});

describe('ui compile isolation', () => {
  it('hands the bundler no directory to resolve against', async () => {
    await compile('export default function A() { return <div>hi</div>; }', 'react_tsx');

    expect(built).toHaveLength(1);
    const stdin = built[0]?.stdin;
    expect(stdin).toBeDefined();
    expect(stdin).not.toHaveProperty('resolveDir');
  });

  it('still compiles source that imports nothing off disk', async () => {
    const { code } = await compile(
      'export default function A() { return <div>hi</div>; }',
      'react_tsx',
    );
    expect(code).toContain('React.createElement');
  });

  // Kept as a smoke test rather than as the guard: each of these also fails when
  // the protection is removed, which is why the assertion above is on the options.
  it.each([
    ['an absolute path', '/etc/hostname'],
    ['a relative traversal', '../../../package.json'],
  ])('refuses to bundle %s', async (_label, specifier) => {
    await expect(
      compile(`import s from ${JSON.stringify(specifier)};\nexport default () => s;`, 'react_tsx'),
    ).rejects.toThrow();
  });
});
