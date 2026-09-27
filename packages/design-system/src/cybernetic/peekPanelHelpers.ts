/**
 * Pure helpers for `PeekPanel` — extracted into a stand-alone module so the
 * a11y bits can be shared with `Sheet` (via `useModalA11y`) without forcing
 * a circular import between the two overlay components.
 */

/**
 * Decide whether the responsive Sheet fallback should render at this
 * viewport width. Extracted as a pure function so the policy is unit-
 * testable without jsdom.
 *
 * - `breakpointPx === 0` disables the fallback entirely.
 * - When viewport width is undefined (SSR / no `window`), returns false so
 *   the desktop variant renders by default.
 */
export function peekPanelShouldUseSheet(
  viewportWidthPx: number | undefined,
  breakpointPx: number,
): boolean {
  if (breakpointPx <= 0) return false;
  if (viewportWidthPx === undefined) return false;
  return viewportWidthPx < breakpointPx;
}

/**
 * Focus-trap key handler — pure function that returns the element that
 * should receive focus next given a Tab / Shift+Tab event in a container
 * with a known set of focusable elements. Lets us test the trap policy
 * without dispatching real keyboard events.
 */
export function peekPanelNextFocusOnTab(
  focusables: readonly HTMLElement[],
  active: HTMLElement | null,
  shiftKey: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (active === null || !focusables.includes(active)) {
    return shiftKey ? last : first;
  }
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null; // let the browser handle the cycle
}
