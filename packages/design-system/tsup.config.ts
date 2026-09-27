import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.tsx',
    layout: 'src/layout/index.ts',
    content: 'src/content/index.ts',
    actions: 'src/actions/index.ts',
    forms: 'src/forms/index.ts',
    feedback: 'src/feedback/index.ts',
    overlays: 'src/overlays/index.ts',
    'data-display': 'src/data-display/index.ts',
    navigation: 'src/navigation/index.ts',
    icons: 'src/icons/index.ts',
    media: 'src/media/index.ts',
    aflow: 'src/aflow/index.ts',
    tokens: 'src/tokens.ts',
  },
  format: ['esm', 'cjs'],
  dts: false, // DTS generation has issues with multi-file, use tsc instead
  clean: true,
  sourcemap: true,
  external: ['react', 'react-dom', '@phosphor-icons/react', 'framer-motion'],
  splitting: true,
  // Prepend `"use client"` to every output. The design-system is almost entirely
  // client-side (hooks, interactive primitives, motion) and Next.js 16's stricter
  // Turbopack rejects chunks that consume React hooks without the directive.
  // esbuild strips directive prologues during bundling; a banner is the most
  // reliable way to restore them on every emitted chunk and entry file. Pure
  // constant modules like `tokens.ts` pick up the marker too — harmless, since
  // Next allows server components to import client modules transparently.
  banner: {
    js: `'use client';`,
  },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
