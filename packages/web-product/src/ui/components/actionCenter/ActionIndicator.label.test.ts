/**
 * @vitest-environment jsdom
 */
/**
 * The bell's label. Its count leaves Coach proposals out, so the label must
 * not say nothing is pending while Coach proposals wait.
 */
import { describe, it, expect, vi } from 'vitest';
import { indicatorLabel } from './ActionIndicator.js';

// The label is pure. The component's imports mount the realtime stack and the
// design system, which this test does not render.
vi.mock('@aflow/design-system', () => ({ IndicatorButton: () => null }));
vi.mock('../cybernetic-provider.js', () => ({ useOptionalCybernetic: () => null }));
vi.mock('../../hooks/use-active-surface.js', () => ({ useActiveSurface: () => ({}) }));
vi.mock('../../hooks/use-action-center.js', () => ({ useActionCenter: () => null }));

describe('indicatorLabel — the empty state while Coach proposals wait', () => {
  it('names Coach proposals instead of claiming nothing is pending', () => {
    for (const lifecycle of ['idle', 'reviewing', 'stalled', null] as const) {
      const label = indicatorLabel(0, 2, lifecycle);
      expect(label).not.toMatch(/no pending actions/);
      expect(label).toMatch(/Coach proposals wait in Coach review/);
      expect(label).not.toMatch(/\d/);
    }
  });

  it('keeps the empty state where no Coach proposal waits', () => {
    expect(indicatorLabel(0, 0, null)).toBe('Action Center — no pending actions');
    expect(indicatorLabel(0, 0, 'idle')).toBe('Action Center — no pending actions');
    expect(indicatorLabel(0, 0, 'reviewing')).toBe('Coach is reviewing — no pending actions');
    expect(indicatorLabel(0, 0, 'stalled')).toBe(
      'Coach is stalled — investigate (no pending actions)',
    );
  });

  it('keeps the counted label when items wait on the operator', () => {
    expect(indicatorLabel(3, 2, null)).toBe('Action Center — 3 pending');
    expect(indicatorLabel(3, 2, 'reviewing')).toBe('Action Center — 3 pending · Coach reviewing');
    expect(indicatorLabel(3, 2, 'stalled')).toBe('Action Center — 3 pending · Coach stalled');
  });
});
