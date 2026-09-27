'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CollapsibleSide } from '@aflow/design-system';
import './chat-entrance.css';

/**
 * The cybernetic chat's right dock (Plan 228 §5.6): one persistent pane that
 * holds the Workbench + session tabs. Fixed side width in both new-chat and
 * active-chat modes (drag-resizable, collapses to a rail with an attention
 * badge). Replaces the old show/hide inspector toggle.
 */
export function WorkbenchDock({
  main,
  dock,
  collapsed,
  onCollapsedChange,
  badge,
}: {
  main: ReactNode;
  dock: ReactNode;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  badge?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  // User drag overrides the default width.
  const [override, setOverride] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setContainerW(w);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const side = Math.max(360, Math.min(500, Math.round(containerW * 0.42)));
  const width = override ?? side;
  const maxWidth = Math.max(560, Math.round(containerW * 0.75));

  return (
    <div
      ref={ref}
      style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', margin: '0 10px' }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {main}
      </div>
      <div className="wb-dock-enter">
        <CollapsibleSide
          side="right"
          defaultWidth={width}
          width={width}
          onWidthChange={setOverride}
          minWidth={320}
          maxWidth={maxWidth}
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          icon="squares-four"
          label="Workbench"
          {...(badge !== undefined ? { badge } : {})}
        >
          <div
            style={{
              height: '100%',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              // Left gutter clears the collapse chevron; keep the rest tight so
              // an expanded run surface isn't starved of width.
              padding: '10px 6px 8px 6px',
            }}
          >
            {dock}
          </div>
        </CollapsibleSide>
      </div>
    </div>
  );
}
