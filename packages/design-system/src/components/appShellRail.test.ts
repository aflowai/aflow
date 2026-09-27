/**
 * Hover and pin are two states, and the whole point of separating them is that
 * only one of them moves the content. A rail that reflowed the page every time
 * a pointer crossed its edge would be worse than one that names nothing.
 */
import { describe, expect, it } from 'vitest';

import { RAIL_HOVER_EXPAND_DELAY_MS, railLayout } from './appShellRail.js';

const DESKTOP = {
  hoverSuppressedUntilLeave: false,
  hoverCapable: true,
  isMobile: false,
  railWidth: 56,
  expandedWidth: 220,
} as const;

describe('the collapsed rail', () => {
  it('shows no names and takes only its own width', () => {
    const rail = railLayout({ ...DESKTOP, pinnedOpen: false, hovering: false });
    expect(rail).toEqual({
      expanded: false,
      overlay: false,
      occupiedWidth: 56,
      renderedWidth: 56,
    });
  });
});

describe('hovering the collapsed rail', () => {
  it('names everything without moving the content', () => {
    const rail = railLayout({ ...DESKTOP, pinnedOpen: false, hovering: true });
    expect(rail.expanded).toBe(true);
    expect(rail.overlay).toBe(true);
    expect(rail.renderedWidth).toBe(220);
    // The footprint is what the content is laid out against, and it is the
    // collapsed width either way — nothing beside the rail reflows.
    expect(rail.occupiedWidth).toBe(56);
  });

  it('does nothing where a pointer cannot hover, so a tap reaches the link', () => {
    const rail = railLayout({ ...DESKTOP, hoverCapable: false, pinnedOpen: false, hovering: true });
    expect(rail.expanded).toBe(false);
    expect(rail.overlay).toBe(false);
  });

  it('does nothing below the desktop breakpoint, where the drawer is the rail', () => {
    const rail = railLayout({ ...DESKTOP, isMobile: true, pinnedOpen: false, hovering: true });
    expect(rail.expanded).toBe(false);
    expect(rail.overlay).toBe(false);
  });
});

describe('collapsing while the pointer is still on the rail', () => {
  // Without this the rail stayed painted wide under the pointer that had just
  // clicked Collapse, and a control that appears to do nothing is worse than one
  // that is not there.
  it('collapses at once, although the pointer has not moved', () => {
    const rail = railLayout({
      ...DESKTOP,
      pinnedOpen: false,
      hovering: true,
      hoverSuppressedUntilLeave: true,
    });
    expect(rail.expanded).toBe(false);
    expect(rail.overlay).toBe(false);
    expect(rail.renderedWidth).toBe(56);
    expect(rail.occupiedWidth).toBe(56);
  });

  it('reads exactly as a rail no pointer is on, so nothing else has to know', () => {
    expect(
      railLayout({
        ...DESKTOP,
        pinnedOpen: false,
        hovering: true,
        hoverSuppressedUntilLeave: true,
      }),
    ).toEqual(railLayout({ ...DESKTOP, pinnedOpen: false, hovering: false }));
  });

  // The flag is cleared when the pointer leaves, so this is the state the next
  // arrival is in: the rule is resumed, not switched off.
  it('lets the next arrival open it again', () => {
    const rail = railLayout({
      ...DESKTOP,
      pinnedOpen: false,
      hovering: true,
      hoverSuppressedUntilLeave: false,
    });
    expect(rail.expanded).toBe(true);
    expect(rail.overlay).toBe(true);
  });
});

describe('the pinned rail', () => {
  it('pushes the content, as a rail the operator asked to keep open should', () => {
    const rail = railLayout({ ...DESKTOP, pinnedOpen: true, hovering: false });
    expect(rail.expanded).toBe(true);
    expect(rail.overlay).toBe(false);
    expect(rail.occupiedWidth).toBe(220);
    expect(rail.renderedWidth).toBe(220);
  });

  it('is unchanged by a pointer arriving on it — nothing to slide over', () => {
    expect(railLayout({ ...DESKTOP, pinnedOpen: true, hovering: true })).toEqual(
      railLayout({ ...DESKTOP, pinnedOpen: true, hovering: false }),
    );
  });
});

describe('the hover delay', () => {
  it('outlasts a pointer passing through and not a pointer arriving', () => {
    expect(RAIL_HOVER_EXPAND_DELAY_MS).toBeGreaterThan(100);
    expect(RAIL_HOVER_EXPAND_DELAY_MS).toBeLessThan(400);
  });
});
