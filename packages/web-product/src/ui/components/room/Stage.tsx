'use client';

/**
 * The stage — the object the room is gathered around, held still while the
 * conversation scrolls. Desktop renders it as the room's second column;
 * mobile renders the peek strip. Both mount the same live AppletInstanceView
 * the inline cards use, so the stage is directly playable.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CollapsibleSide, Icon, Row, Text } from '@aflow/design-system';
import { AppletInstanceView } from '../applet-instance-view.js';

/**
 * The conversation's own card geometry, from `ChatLayout`'s message surface —
 * same inset, same corner.
 *
 * The stage holds the object the room is gathered around and the transcript
 * holds what was said about it. They are two panels of one surface, and the
 * desktop stage was rendering as neither: square corners, flush to the top of
 * the row while the conversation beside it sat 58px lower behind a 32px corner.
 *
 * No fill, unlike the conversation's card. An applet is a document with its own
 * surface: where it paints, a tint behind it is never seen, and where it does
 * not, the tint mixes into a background the applet did not choose. The
 * conversation's own messages are ours to tint; a guest document is not.
 */
const stageCard: React.CSSProperties = {
  margin: 'var(--space-2-5)',
  borderRadius: 'var(--space-2xl)',
};

/**
 * Mobile: the same geometry, floating OVER the conversation rather than beside
 * it — so this one is filled, because the messages it covers would otherwise
 * read straight through the board.
 */
const stagePeekSurface: React.CSSProperties = {
  ...stageCard,
  margin: 0,
  background: 'var(--surface-overlay-alpha)',
  border: '1px solid var(--color-border-subtle)',
  backdropFilter: 'blur(14px) saturate(1.05)',
};

/** Desktop: the room splits — conversation as `main`, the stage beside it with
 *  the same chrome, rail, and container-relative sizing as the Workbench dock.
 *  Owning the row lets the stage measure it, so drag can grow well past the
 *  default (up to most of the room) instead of hitting a fixed cap. */
export function StageSplit({
  main,
  spaceId,
  instanceId,
}: {
  main: ReactNode;
  spaceId: string | undefined;
  instanceId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  // User drag overrides the default width.
  const [override, setOverride] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // Measured synchronously, before the first paint. ResizeObserver reports a
    // frame later, so starting from zero opened the stage at its floor width
    // and then stepped it up as the measurements arrived — and the column it
    // sits beside re-wrapped every message on each step. Measured at five
    // layouts in 200 ms: 1356px, 990, 981, 868, 852, 850.
    setContainerW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
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
    <div ref={ref} style={{ height: '100%', display: 'flex', minHeight: 0 }}>
      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {main}
      </div>
      {/* Not rendered until the row has been measured — one synchronous layout
          effect away, so still before the first paint. Mounting it at the floor
          width and correcting afterwards opened the panel in two steps, and the
          conversation beside it re-centred on each. */}
      {containerW > 0 && (
        <div className="chat-stage-enter" style={{ display: 'flex', minHeight: 0, flexShrink: 0 }}>
          <CollapsibleSide
            side="right"
            defaultWidth={width}
            width={width}
            onWidthChange={setOverride}
            minWidth={340}
            maxWidth={maxWidth}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            icon="squares-four"
            label="Board"
          >
            <div
              className="ds-scroll-subtle"
              style={{
                ...stageCard,
                // Inset from the panel on every side rather than sized by its
                // content: `CollapsibleSide` gives its children a relative,
                // full-height box, so this is what makes the card end on the
                // same line as the conversation's instead of stopping wherever
                // the board happens to.
                margin: 0,
                position: 'absolute',
                inset: 'var(--space-2-5)',
                overflowY: 'auto',
                padding: 'var(--space-3)',
              }}
            >
              <AppletInstanceView key={instanceId} spaceId={spaceId} instanceId={instanceId} />
            </div>
          </CollapsibleSide>
        </div>
      )}
    </div>
  );
}

/** Mobile: the stage rides directly above the composer rather than scrolling
 *  with the conversation — the object the room is gathered around should never
 *  be something you have to scroll back up to find. It opens with the board
 *  showing, as the desktop split does, and yields at half the viewport so the
 *  conversation it belongs to stays in sight. */
export function StagePeek({
  spaceId,
  instanceId,
}: {
  spaceId: string | undefined;
  instanceId: string;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      style={{
        ...stagePeekSurface,
        // It floats over the conversation now, not in it — the composer's own
        // backing, so messages don't read through the board.
        background: 'var(--surface-raised-alpha)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        marginBottom: 'var(--space-2)',
        padding: expanded ? 'var(--space-2) var(--space-3) var(--space-3)' : '2px var(--space-3)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: '50dvh',
      }}
    >
      <Row gap="sm" align="center" justify="between">
        <Row gap="sm" align="center">
          <Icon name="squares-four" size="sm" />
          <Text size="sm" weight="medium">
            Live board
          </Text>
        </Row>
        <button
          type="button"
          onClick={() => {
            setExpanded((value) => !value);
          }}
          aria-label={expanded ? 'Collapse the board' : 'Expand the board'}
          aria-expanded={expanded}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--color-content-muted)',
            cursor: 'pointer',
            padding: 4,
            lineHeight: 0,
          }}
        >
          <Icon name={expanded ? 'caret-down' : 'caret-up'} size="sm" />
        </button>
      </Row>
      {expanded ? (
        <div
          className="ds-scroll-subtle"
          style={{ marginTop: 'var(--space-2)', minHeight: 0, overflowY: 'auto' }}
        >
          <AppletInstanceView spaceId={spaceId} instanceId={instanceId} />
        </div>
      ) : null}
    </div>
  );
}
