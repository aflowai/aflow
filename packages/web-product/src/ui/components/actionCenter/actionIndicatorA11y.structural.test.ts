/**
 * The Action Center indicator's accessibility and wiring contract.
 *
 * It reads source because the invariant is about what the tree renders and the
 * indicator mounts the whole realtime stack behind it. It sits here rather than
 * beside the Coach panel it used to share a file with: the indicator is the
 * product's and the panel is still the application's, and a test that reached
 * across that line broke the moment the indicator moved.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, './ActionIndicator.tsx'), 'utf8');

describe('ActionIndicator — a11y contract', () => {
  it('passes a non-empty label to IndicatorButton (drives aria-label + tooltip)', () => {
    expect(SRC).toMatch(/label=\{label\}/);
  });

  it('produces distinct copy for the three Coach lifecycles AND the empty state', () => {
    expect(SRC).toMatch(/Coach is stalled/);
    expect(SRC).toMatch(/Coach (is reviewing|reviewing)/);
    expect(SRC).toMatch(/no pending actions/i);
    expect(SRC).toMatch(/pending/);
  });

  it('reads the open-action count from useActionCenter (not a derived shadow)', () => {
    // The badge count must come from the shared hook so the chat-header
    // indicator and the console page stay in sync.
    expect(SRC).toMatch(/useActionCenter/);
    expect(SRC).toMatch(/count=\{total\}/);
  });

  it('mounts a universal variant when the cybernetic provider is missing', () => {
    // Non-cybernetic spaces still produce HITL items and gate steps, so both
    // variants exist and the universal one requires no Coach hook.
    expect(SRC).toMatch(/useOptionalCybernetic/);
    expect(SRC).toMatch(/ActionIndicatorUniversal/);
    expect(SRC).toMatch(/ActionIndicatorWithCoach/);
  });
});
