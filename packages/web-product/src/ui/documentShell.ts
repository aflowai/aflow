/**
 * The document every application serving this product renders.
 *
 * Next requires `html` and `body` to be written in the root layout file, and
 * `next/font` and the metadata exports are its own APIs — so the layout stays an
 * application file and what it says comes from here. The alternative was what the
 * two applications actually had: the hosted one declared fonts, a stylesheet, a
 * viewport and metadata, and the local one declared `<html lang="en">` and a body.
 * Nothing failed; it would simply have rendered unstyled the day something served
 * it.
 *
 * Stated as data rather than as components, because none of it can be one: the
 * metadata exports are read off the module by the framework.
 *
 * Fonts are **not** here, and the reason is narrower than "fonts cannot be
 * shared". `next/font` is transformed at build time and the transform reads the
 * options from the call itself, so passing an imported options object resolves to
 * nothing and the build fails on `next/font/google/target.css`. Sharing the
 * *loaded fonts* is supported — a module that calls the loader with literal
 * options and exports the results — and would work here if the duplication ever
 * cost anything. Two short literal calls do not, so each application writes its
 * own and this comment is what keeps them equal.
 */

/** Attributes the document element carries in every edition. */
export const DOCUMENT_ATTRIBUTES = {
  lang: 'en',
  /**
   * Themes are applied by a client effect after hydration, so the server's markup
   * and the client's first render legitimately disagree about `data-theme`.
   */
  suppressHydrationWarning: true,
  'data-scroll-behavior': 'smooth',
} as const;

/**
 * Pinch-zoom stays enabled (WCAG 1.4.4). iOS focus auto-zoom is prevented by
 * 16px input text on phones rather than by locking the scale.
 */
export const VIEWPORT = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
} as const;
