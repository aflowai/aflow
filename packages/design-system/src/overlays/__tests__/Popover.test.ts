import { describe, it, expect } from 'vitest';
import { computePopoverPanelStyle, type PopoverRect } from '../Popover.js';

const viewport = { width: 1000, height: 800 };
const opts = { minWidth: 180, offset: 6, margin: 8 };

// A trigger sitting near the bottom-left of the viewport.
const rect: PopoverRect = { top: 760, right: 240, bottom: 784, left: 200, width: 40 };

describe('computePopoverPanelStyle', () => {
  it('bottom-start anchors below by top and left-aligns to the trigger', () => {
    const s = computePopoverPanelStyle(rect, viewport, { ...opts, placement: 'bottom-start' });
    expect(s.top).toBe(rect.bottom + opts.offset);
    expect(s.left).toBe(rect.left);
    expect(s.bottom).toBeUndefined();
  });

  it('top-start anchors above via bottom so the panel grows upward', () => {
    const s = computePopoverPanelStyle(rect, viewport, { ...opts, placement: 'top-start' });
    expect(s.bottom).toBe(viewport.height - rect.top + opts.offset);
    expect(s.left).toBe(rect.left);
    expect(s.top).toBeUndefined();
  });

  it('auto-sizes width to max(triggerWidth, minWidth)', () => {
    const s = computePopoverPanelStyle(rect, viewport, { ...opts, placement: 'top-start' });
    expect(s.width).toBe(opts.minWidth);
  });

  it('honors an explicit width', () => {
    const s = computePopoverPanelStyle(rect, viewport, {
      ...opts,
      placement: 'top-start',
      width: 360,
    });
    expect(s.width).toBe(360);
  });

  it('clamps left so a wide panel near the right edge stays inside the viewport', () => {
    const nearRight: PopoverRect = { top: 100, right: 990, bottom: 124, left: 950, width: 40 };
    const s = computePopoverPanelStyle(nearRight, viewport, {
      ...opts,
      placement: 'bottom-start',
      width: 360,
    });
    expect(s.left).toBe(viewport.width - opts.margin - 360);
  });

  it('clamps left to the margin when the trigger sits past the left edge', () => {
    const offscreen: PopoverRect = { top: 100, right: -10, bottom: 124, left: -50, width: 40 };
    const s = computePopoverPanelStyle(offscreen, viewport, {
      ...opts,
      placement: 'bottom-start',
      width: 360,
    });
    expect(s.left).toBe(opts.margin);
  });
});
