'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Tooltip } from '../primitives/Tooltip.js';
import { formatBadgeCount } from '../feedback/IndicatorButton.js';

export interface SegmentedSwitchItem {
  /** Stable id for this segment. */
  value: string;
  /** Icon element (typically <Icon name="..." size="sm" />). */
  icon: ReactNode;
  /** Accessible name and tooltip for this segment. */
  label: string;
  /** Attention count, drawn out of flow so segments keep equal width. */
  badge?: number;
}

export interface SegmentedSwitchProps {
  /** Two or more mutually exclusive views. Order is the travel order. */
  items: SegmentedSwitchItem[];
  /** Currently selected item's `value`. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the group (e.g. "View"). */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * SegmentedSwitch — icon-only mode switch where the selection is a thumb that
 * travels, so the segments read as one control with a position rather than as
 * separate actions.
 *
 * @example
 * ```tsx
 * <SegmentedSwitch
 *   label="View"
 *   value={open ? 'workbench' : 'chat'}
 *   onChange={(v) => setOpen(v === 'workbench')}
 *   items={[
 *     { value: 'chat', icon: <Icon name="chat" size="sm" />, label: 'Chat' },
 *     { value: 'workbench', icon: <Icon name="squares-four" size="sm" />, label: 'Workbench', badge: 2 },
 *   ]}
 * />
 * ```
 */
export function SegmentedSwitch({
  items,
  value,
  onChange,
  label,
  size = 'md',
  className = '',
}: SegmentedSwitchProps) {
  const selected = items.findIndex((item) => item.value === value);
  const classes = ['ds-segmented-switch', size === 'sm' && 'ds-segmented-switch--sm', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      role="group"
      aria-label={label}
      className={classes}
      style={{ '--ds-segment-index': Math.max(0, selected) } as CSSProperties}
    >
      {/* Hidden while nothing matches, rather than parked on the first
          segment claiming a selection that is not in effect. */}
      {selected >= 0 && <span aria-hidden className="ds-segmented-switch__thumb" />}
      {items.map((item) => {
        const badge = formatBadgeCount(item.badge);
        return (
          <Tooltip key={item.value} content={item.label} side="bottom">
            <button
              type="button"
              aria-pressed={item.value === value}
              aria-label={item.label}
              className="ds-segmented-switch__segment"
              onClick={() => {
                onChange(item.value);
              }}
            >
              {item.icon}
              {badge && (
                <span
                  aria-label={`${badge} items need attention`}
                  className="ds-segmented-switch__badge"
                >
                  {badge}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
