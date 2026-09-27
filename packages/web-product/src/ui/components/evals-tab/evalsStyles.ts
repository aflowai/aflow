/**
 * Shared presentation constants for the Evals tab.
 */
import type { BadgeVariant } from '@aflow/design-system';
import type { EvalBatchStatus } from '@aflow/schemas';

export const STATUS_BADGE: Record<EvalBatchStatus, BadgeVariant> = {
  queued: 'queued',
  running: 'running',
  cancelling: 'paused',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const NON_TERMINAL: ReadonlySet<EvalBatchStatus> = new Set([
  'queued',
  'running',
  'cancelling',
]);

/**
 * One height knob for every inspector body — the wrapped `<pre>` and the JSON
 * tree that can replace it. Two knobs would let a row change height purely by
 * flipping renderer.
 */
const INSPECTOR_MAX_HEIGHT = 220;
export const INSPECTOR_MAX_HEIGHT_PX = INSPECTOR_MAX_HEIGHT;
export const INSPECTOR_MAX_HEIGHT_CSS = `${String(INSPECTOR_MAX_HEIGHT)}px`;

/** Monospace evidence panel: wraps, caps its own height, never truncates silently. */
export const evidencePreStyle = {
  margin: 0,
  padding: 'var(--space-2)',
  maxHeight: INSPECTOR_MAX_HEIGHT_PX,
  overflow: 'auto',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--color-surface-1)',
  color: 'var(--color-text-primary)',
  fontFamily: 'var(--font-family-mono)',
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const;

/**
 * Every tab panel is a bounded scroll region: the status line and the tab bar
 * stay put while the panel scrolls inside itself, so the page never grows into
 * one column. The subtracted band is the chrome standing above a panel — the
 * app header, the skill toolbar, the status line and the tab bar.
 */
const PANEL_CHROME_PX = 280;
const PANEL_MIN_HEIGHT_PX = 460;

export const evalsPanelStyle = {
  height: `calc(100vh - ${String(PANEL_CHROME_PX)}px)`,
  minHeight: PANEL_MIN_HEIGHT_PX,
} as const;

/** Both tabs put their list in a rail of the same width, so the two read as one surface. */
export const RAIL_WIDTH = 'auto';

export const REVIEW_CRITERION_WIDTH = 360;

/**
 * Below this the criterion cannot hold its own column, so it moves above the
 * material: it is short, the material scrolls under it, and the reading order
 * becomes what is being asked, then the material, then the decision.
 */
export const REVIEW_CRITERION_QUERY = '(max-width: 1199px)';

/** Dense table cell — the trials table and the scenario breakdown share it. */
export const cellStyle = { padding: 'var(--space-1) var(--space-3)' } as const;

/**
 * Sticky header for a table inside a bounded scroll. Every surface token in
 * this system is translucent, so the blur is what keeps the header legible
 * over the rows passing under it.
 */
export const headerCellStyle = {
  ...cellStyle,
  textAlign: 'left',
  color: 'var(--color-text-muted)',
  fontWeight: 500,
  position: 'sticky',
  top: 0,
  background: 'var(--color-surface-1)',
  backdropFilter: 'blur(8px)',
  zIndex: 1,
} as const;
