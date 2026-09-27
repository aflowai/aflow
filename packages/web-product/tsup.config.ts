import { defineConfig } from 'tsup';

/**
 * Two builds, because the package has two kinds of consumer and one bundling
 * mode cannot serve both.
 *
 * The server entries are bundled: one file each, nothing to preserve.
 *
 * The UI is **not** bundled, and that is load-bearing rather than a preference.
 * A React client component carries a `'use client'` directive that marks the
 * boundary Next splits the graph at, and bundling a barrel that re-exports both a
 * client component and a server module emits one chunk with the directive
 * dropped — measured, not assumed. Nothing reports it: the package builds, the
 * applications build, and the boundary is simply gone, surfacing later as a
 * hydration or server/client mismatch that names neither this package nor the
 * import. `transpilePackages` cannot restore a directive already removed here.
 *
 * Preserving modules keeps each component's own file, so the directive stays at
 * the boundary it describes and no server module inherits it.
 */
export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/uiCompiler.ts',
      'src/nextSecurity.ts',
      // Bundled into the entries above, and emitted on its own as well: the UI
      // tree below is not bundled, so a module there that imports this by a
      // relative path needs the file to exist in `dist`.
      'src/preferredSpaceCookie.ts',
    ],
    format: ['esm', 'cjs'],
    dts: false,
    clean: false,
    sourcemap: true,
    external: [/^[^./]/],
  },
  {
    entry: [
      'src/ui/**/*.ts',
      'src/ui/**/*.tsx',
      // A component that imports a stylesheet needs it beside the emitted file.
      // Preserving modules skips whatever it cannot compile, so without this the
      // built component asks for a `.css` the package never shipped — and the
      // consumer's build is where that surfaces, not this one.
      'src/ui/**/*.css',
      // Tests are not published, and an emitted one would be a module a consumer
      // could resolve.
      '!src/ui/**/*.test.ts',
      '!src/ui/**/*.test.tsx',
    ],
    loader: { '.css': 'copy' },
    outDir: 'dist/ui',
    format: ['esm'],
    bundle: false,
    dts: false,
    // Cleaned, unlike the bundled entries above: preserving modules means one
    // output per source file, so a component that leaves `src` leaves an
    // importable file behind. A consumer resolves it and gets a component the
    // source no longer has.
    clean: true,
    sourcemap: true,
  },
]);
