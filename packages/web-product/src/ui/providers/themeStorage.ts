/**
 * A theme read back from storage.
 *
 * The key is shared with every other script on the origin and outlives every
 * version of this application, so what comes back is a string — a value this
 * build no longer recognises is ordinary, not exceptional. One that reached
 * `data-theme` verbatim left the document matching neither the light nor the dark
 * selectors, styled by whatever the reset happened to leave behind.
 *
 * Plain module rather than part of the provider: the decision is the part worth
 * testing, and it should not need React rendered around it to be checked.
 */
export type Theme = 'light' | 'dark' | 'system';

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

/** Every writer of the preference has to name the same key, so it lives beside
 *  the values it stores rather than inside the provider that happens to read it.
 *  Reachable as `@aflow/web-product/ui/theme` for the same reason `./ui/server`
 *  exists: a surface outside the client graph — a pre-paint script rendered by a
 *  server component — needs the key and nothing else this package holds. */
export const THEME_STORAGE_KEY = 'theme';

export function storedTheme(value: string | null): Theme | null {
  return THEMES.includes(value as Theme) ? (value as Theme) : null;
}
