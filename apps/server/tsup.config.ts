import { defineConfig } from 'tsup';

export default defineConfig({
  // The core composition root, plus two one-shots the appliance runs before
  // anything serves — neither of them a module the server imports.
  // `instanceInit` comes first of all: it writes the Redis ACL, which Redis
  // needs before it accepts a connection.
  //
  // One entry, not a glob: the hosted root is `apps/server-hosted` now, so this
  // application builds one edition and no longer has to discover which.
  entry: ['src/index.ts', 'src/bootstrapLocal.ts', 'src/instanceInit.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: false, // Disable for now due to tsup DTS issues with multi-file
  clean: true,
  sourcemap: true,
  splitting: false,
  // Don't bundle dependencies — resolve them from node_modules at runtime.
  // Bundling causes issues with CJS-only packages (e.g. whatwg-url → punycode).
  noExternal: [],
  external: [/^[^./]/],
});
