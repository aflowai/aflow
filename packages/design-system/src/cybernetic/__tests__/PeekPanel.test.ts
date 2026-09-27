import { describe, it, expect } from 'vitest';
import { peekPanelShouldUseSheet, peekPanelNextFocusOnTab } from '../PeekPanel.js';

// ============================================================================
// Responsive collapse
// ============================================================================

describe('peekPanelShouldUseSheet', () => {
  it('returns false during SSR when viewport width is unknown', () => {
    expect(peekPanelShouldUseSheet(undefined, 640)).toBe(false);
  });

  it('returns false when the breakpoint is disabled (0)', () => {
    expect(peekPanelShouldUseSheet(320, 0)).toBe(false);
    expect(peekPanelShouldUseSheet(1024, 0)).toBe(false);
  });

  it('returns true when viewport is strictly narrower than the breakpoint', () => {
    expect(peekPanelShouldUseSheet(320, 640)).toBe(true);
    expect(peekPanelShouldUseSheet(639, 640)).toBe(true);
  });

  it('returns false at the breakpoint boundary itself (>=, not >)', () => {
    // The boundary belongs to the desktop variant — easier to think about
    // breakpoints in `min-width` terms even though we render the inverse.
    expect(peekPanelShouldUseSheet(640, 640)).toBe(false);
  });

  it('returns false when viewport is wider than the breakpoint', () => {
    expect(peekPanelShouldUseSheet(1280, 640)).toBe(false);
  });

  it('treats negative breakpoints as disabled', () => {
    expect(peekPanelShouldUseSheet(100, -5)).toBe(false);
  });
});

// ============================================================================
// Focus-trap key logic
// ============================================================================

/**
 * Minimal HTMLElement stand-in. We use a class so `instanceof` works in
 * case future helpers need to type-check; for the current pure-fn tests
 * any object with identity equality is sufficient.
 */
class FakeElement {
  constructor(public readonly name: string) {}
}

function fakes(...names: string[]): FakeElement[] {
  return names.map((n) => new FakeElement(n));
}

describe('peekPanelNextFocusOnTab', () => {
  it('returns null when there are no focusables (nothing to trap)', () => {
    const next = peekPanelNextFocusOnTab([] as unknown as HTMLElement[], null, false);
    expect(next).toBeNull();
  });

  it('jumps to the first focusable when focus is outside the panel (Tab)', () => {
    const [a, b, c] = fakes('a', 'b', 'c');
    const next = peekPanelNextFocusOnTab([a, b, c] as unknown as HTMLElement[], null, false);
    expect(next).toBe(a as unknown);
  });

  it('jumps to the last focusable when focus is outside the panel (Shift+Tab)', () => {
    const [a, b, c] = fakes('a', 'b', 'c');
    const next = peekPanelNextFocusOnTab([a, b, c] as unknown as HTMLElement[], null, true);
    expect(next).toBe(c as unknown);
  });

  it('wraps Tab from the last element back to the first', () => {
    const [a, b, c] = fakes('a', 'b', 'c');
    const next = peekPanelNextFocusOnTab(
      [a, b, c] as unknown as HTMLElement[],
      c as unknown as HTMLElement,
      false,
    );
    expect(next).toBe(a as unknown);
  });

  it('wraps Shift+Tab from the first element back to the last', () => {
    const [a, b, c] = fakes('a', 'b', 'c');
    const next = peekPanelNextFocusOnTab(
      [a, b, c] as unknown as HTMLElement[],
      a as unknown as HTMLElement,
      true,
    );
    expect(next).toBe(c as unknown);
  });

  it('returns null for intermediate Tab presses — browser handles the normal flow', () => {
    const [a, b, c] = fakes('a', 'b', 'c');
    const next = peekPanelNextFocusOnTab(
      [a, b, c] as unknown as HTMLElement[],
      b as unknown as HTMLElement,
      false,
    );
    expect(next).toBeNull();
  });

  it('returns null for intermediate Shift+Tab presses too', () => {
    const [a, b, c] = fakes('a', 'b', 'c');
    const next = peekPanelNextFocusOnTab(
      [a, b, c] as unknown as HTMLElement[],
      b as unknown as HTMLElement,
      true,
    );
    expect(next).toBeNull();
  });

  it('jumps to first when active is an element not in the focusable list', () => {
    // Defensive: if focus has somehow leaked outside the tracked
    // focusables (e.g. a Portal'd menu), Tab should bring it back to
    // the panel rather than silently doing nothing.
    const [a, b, c] = fakes('a', 'b', 'c');
    const stranger = new FakeElement('stranger');
    const next = peekPanelNextFocusOnTab(
      [a, b, c] as unknown as HTMLElement[],
      stranger as unknown as HTMLElement,
      false,
    );
    expect(next).toBe(a as unknown);
  });
});
