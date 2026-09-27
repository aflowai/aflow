/**
 * The Coach panel's accessibility contract.
 *
 * The indicator's half of this moved with the indicator, to
 * `packages/web-product/src/ui/components/actionCenter` — it is the product's
 * now, and this file reached across that line by reading its source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PANEL_SRC =
  readFileSync(resolve(__dirname, '../CoachSurfacePanel.tsx'), 'utf8') +
  '\n' +
  readFileSync(resolve(__dirname, '../ProposalCard.tsx'), 'utf8');
// The panel renders Button children across multiple lines in JSX
// (`<Button …>\n            Text\n          </Button>`), so the assertions
// look for the text label preceded by a `>` somewhere on a prior line
// rather than the strict `>Text<` form.
function hasButtonLabel(src: string, label: string): boolean {
  // Accept any of:
  //   • `>Label<` on a single line.
  //   • Label on its own line inside `<Button …>\n  Label\n</Button>`.
  //   • Label as a quoted string literal inside a JSX expression (e.g.
  //     ternary fallback like `{expanded ? 'Collapse' : 'Details'}`).
  const own = new RegExp(`\\n\\s+${label}\\s*\\n\\s*<\\/Button`);
  if (own.test(src)) return true;
  if (src.includes(`>${label}<`)) return true;
  if (src.includes(`'${label}'`)) return true;
  if (src.includes(`"${label}"`)) return true;
  return false;
}

describe('CoachSurfacePanel — Phase 4 a11y contract', () => {
  it('error banner has a Dismiss button + Retry control', () => {
    expect(hasButtonLabel(PANEL_SRC, 'Dismiss')).toBe(true);
    expect(hasButtonLabel(PANEL_SRC, 'Retry')).toBe(true);
  });

  it('Active review section renders a Watch Coach link', () => {
    expect(PANEL_SRC).toMatch(/Watch Coach/);
  });

  it('proposal row exposes Details + Ratify + Reject buttons', () => {
    expect(hasButtonLabel(PANEL_SRC, 'Details')).toBe(true);
    expect(hasButtonLabel(PANEL_SRC, 'Ratify')).toBe(true);
    expect(hasButtonLabel(PANEL_SRC, 'Reject')).toBe(true);
  });

  it('proposal row exposes a Retry button when the previous apply was transient', () => {
    expect(hasButtonLabel(PANEL_SRC, 'Retry')).toBe(true);
  });

  it('Plan 141 stale-rebase row exposes Regenerate + Apply anyway + Cancel', () => {
    expect(hasButtonLabel(PANEL_SRC, 'Regenerate')).toBe(true);
    expect(PANEL_SRC).toMatch(/Apply anyway/);
    expect(hasButtonLabel(PANEL_SRC, 'Cancel')).toBe(true);
  });

  it('platform-issue row exposes a Details toggle + Dismiss action', () => {
    // Phase 4.7 — platform-issue rows now delegate to the shared
    // <ProposalCard>, which uses generic Details/Dismiss controls
    // instead of the bespoke "View diagnosis" label.
    expect(hasButtonLabel(PANEL_SRC, 'Details')).toBe(true);
    expect(hasButtonLabel(PANEL_SRC, 'Dismiss')).toBe(true);
  });

  it('anomaly row exposes an Acknowledge button', () => {
    expect(hasButtonLabel(PANEL_SRC, 'Acknowledge')).toBe(true);
  });
});

describe('CoachSurface — performance contract', () => {
  it('does not poll with setInterval (Plan 138 §9 Phase 4)', () => {
    // Performance acceptance: the panel refreshes via the entity-event
    // pubsub fanout and imperative refresh calls only. No timer loops.
    expect(PANEL_SRC).not.toMatch(/setInterval\s*\(/);
  });
});
