import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PEEK_PANEL_SRC = readFileSync(resolve(__dirname, '../cybernetic/PeekPanel.tsx'), 'utf8');
const SHEET_SRC = readFileSync(resolve(__dirname, '../overlays/Sheet.tsx'), 'utf8');
const INDICATOR_SRC = readFileSync(resolve(__dirname, '../feedback/IndicatorButton.tsx'), 'utf8');
const MODAL_A11Y_SRC = readFileSync(resolve(__dirname, '../overlays/useModalA11y.ts'), 'utf8');

describe('PeekPanel — a11y structural contract', () => {
  it('declares role="dialog"', () => {
    expect(PEEK_PANEL_SRC).toMatch(/role="dialog"/);
  });

  it('declares aria-modal="true" (Plan 138 §2.7)', () => {
    expect(PEEK_PANEL_SRC).toMatch(/aria-modal="true"/);
  });

  it('has an escape-to-close handler (Plan 138 §2.7)', () => {
    expect(PEEK_PANEL_SRC).toMatch(/e\.key === 'Escape'/);
    expect(PEEK_PANEL_SRC).toMatch(/onClose\(\)/);
  });

  it('delegates focus trap + sibling-inert to the shared useModalA11y hook', () => {
    expect(PEEK_PANEL_SRC).toMatch(/useModalA11y\(/);
    expect(PEEK_PANEL_SRC).toMatch(/containerRef:\s*panelRef/);
  });

  it('falls back to Sheet on narrow viewports', () => {
    expect(PEEK_PANEL_SRC).toMatch(/import \{ Sheet \} from '\.\.\/overlays\/Sheet\.js'/);
    expect(PEEK_PANEL_SRC).toMatch(/<Sheet[\s\S]*?>/);
    expect(PEEK_PANEL_SRC).toMatch(/peekPanelShouldUseSheet/);
  });

  it('labels the close button + resize handle', () => {
    expect(PEEK_PANEL_SRC).toMatch(/aria-label="Close panel"/);
    expect(PEEK_PANEL_SRC).toMatch(/aria-label="Resize panel"/);
  });
});

describe('Sheet — a11y structural contract', () => {
  it('declares role="dialog" and aria-modal="true"', () => {
    expect(SHEET_SRC).toMatch(/role="dialog"/);
    expect(SHEET_SRC).toMatch(/aria-modal="true"/);
  });

  it('has an escape-to-close handler', () => {
    expect(SHEET_SRC).toMatch(/e\.key === 'Escape'/);
  });

  it('locks body scroll while open', () => {
    expect(SHEET_SRC).toMatch(/document\.body\.style\.overflow = 'hidden'/);
  });

  it('moves initial focus to the close button on open', () => {
    expect(SHEET_SRC).toMatch(/closeBtnRef\.current\?\.focus\(\)/);
  });

  it('uses an accessible label on the close button', () => {
    expect(SHEET_SRC).toMatch(/aria-label="Close"/);
  });

  it('wires the shared focus trap + sibling-inert via useModalA11y (review-round P2)', () => {
    // Previously Sheet had aria-modal + escape + body lock but no focus
    // trap and no sibling-inert. PeekPanel's mobile Sheet fallback now
    // inherits both because both surfaces call the same hook.
    expect(SHEET_SRC).toMatch(/useModalA11y\(/);
    expect(SHEET_SRC).toMatch(/containerRef:\s*dialogRef/);
  });
});

describe('useModalA11y — focus trap + sibling-inert (shared hook)', () => {
  it('uses peekPanelNextFocusOnTab to compute the trap target', () => {
    expect(MODAL_A11Y_SRC).toMatch(/peekPanelNextFocusOnTab/);
  });

  it('attaches a Tab keydown listener', () => {
    expect(MODAL_A11Y_SRC).toMatch(/e\.key !== 'Tab'/);
  });

  it('marks sibling elements inert while open + restores prior state', () => {
    expect(MODAL_A11Y_SRC).toMatch(/setAttribute\('inert', ''\)/);
    expect(MODAL_A11Y_SRC).toMatch(/removeAttribute\('inert'\)/);
  });

  it('captures previously focused element and restores it on cleanup', () => {
    expect(MODAL_A11Y_SRC).toMatch(/document\.activeElement/);
    expect(MODAL_A11Y_SRC).toMatch(/previouslyFocused\?\.focus\(\)/);
  });
});

describe('IndicatorButton — a11y structural contract', () => {
  it('always renders an accessible label', () => {
    expect(INDICATOR_SRC).toMatch(/aria-label=\{label\}/);
  });

  it('exposes count as a visually-hidden assistive announcement', () => {
    // The visible badge sets aria-hidden=true; the screen-reader
    // announcement is a separate span — both must be present.
    expect(INDICATOR_SRC).toMatch(/aria-hidden="true"/);
    expect(INDICATOR_SRC).toMatch(/badgeLabel\} pending/);
  });

  it('respects prefers-reduced-motion in the pulse keyframes', () => {
    expect(INDICATOR_SRC).toMatch(/prefers-reduced-motion: reduce/);
    expect(INDICATOR_SRC).toMatch(/animation: none !important/);
  });

  it('disables click when disabled prop is set', () => {
    expect(INDICATOR_SRC).toMatch(/disabled=\{disabled\}/);
    expect(INDICATOR_SRC).toMatch(/aria-disabled=\{disabled \|\| undefined\}/);
  });
});
