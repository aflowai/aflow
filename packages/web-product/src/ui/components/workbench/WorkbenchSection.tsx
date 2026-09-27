'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Column, Icon, Row, Text } from '@aflow/design-system';
import type { IconName } from '@aflow/design-system';

/**
 * The chrome every Workbench section wears. The board is read by scanning one
 * narrow column top to bottom, so the section titles have to be the thing the
 * eye catches — one type treatment, stated once.
 */
export function WorkbenchSection({
  title,
  icon,
  meta,
  trailing,
  link,
  style,
  children,
}: {
  title: string;
  icon?: IconName;
  /** Counts and status pills, sitting with the title. */
  meta?: ReactNode;
  /** Section-level status, right-aligned before the link. */
  trailing?: ReactNode;
  /** The full surface behind this section. */
  link?: { href: string; label: string };
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Column gap="sm" style={style}>
      <Row gap="xs" align="center" style={{ flexShrink: 0 }}>
        {icon && <Icon name={icon} size="sm" style={{ color: 'var(--color-content-muted)' }} />}
        <Text
          size="sm"
          weight="semibold"
          style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          {title}
        </Text>
        {meta}
        <div style={{ flex: 1 }} />
        {trailing}
        {link && <WorkbenchLink href={link.href} label={link.label} />}
      </Row>
      {children}
    </Column>
  );
}

/**
 * The body of a section the space hasn't filled yet. Dormant sections still
 * render — an absent section reads as a missing feature, and the operator can't
 * tell "this space has no applets" from "this board doesn't do applets".
 *
 * Just the line: the section keeps its ordinary header, so a dormant slot is the
 * same shape as a live one with less in it, rather than a different kind of
 * thing. The header's `link` is the door to filling it (the store, or the
 * integrations surface) — which is why it's the only affordance here.
 */
export function WorkbenchEmptyRow({ label }: { label: string }) {
  return (
    <Text size="sm" variant="muted">
      {label}
    </Text>
  );
}

/**
 * A side trip out of the board. Every one of these opens a new tab: the chat
 * and its live run are the operator's anchor, and looking something up should
 * not cost them their place (Plan 228 §3.4). Resuming a conversation is the one
 * navigation that happens in place — it *is* switching your main context — so it
 * is deliberately not one of these.
 */
export function WorkbenchLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-accent-default)',
        flexShrink: 0,
      }}
    >
      {label} ↗
    </a>
  );
}
