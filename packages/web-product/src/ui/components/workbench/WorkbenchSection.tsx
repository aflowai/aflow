'use client';

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Column, Icon, Row, Spinner, Text } from '@aflow/design-system';
import type { IconName } from '@aflow/design-system';

interface SectionFold {
  expanded: boolean;
  toggle: () => void;
}

const SectionFoldContext = createContext<SectionFold | null>(null);

interface WorkbenchFolds {
  isExpanded: (title: string) => boolean;
  toggle: (title: string) => void;
}

export const WorkbenchFoldsContext = createContext<WorkbenchFolds | null>(null);

/**
 * Which folded sections the operator opened, per space. The inspector's tab
 * panel unmounts the Workbench on a tab switch, so its owner calls this above
 * the panel and provides the result through `WorkbenchFoldsContext`: coming
 * back to the tab finds the same sections open.
 */
export function useWorkbenchFolds(spaceId: string): WorkbenchFolds {
  const [openBySpace, setOpenBySpace] = useState<Readonly<Record<string, readonly string[]>>>({});
  const open = openBySpace[spaceId];
  return useMemo<WorkbenchFolds>(
    () => ({
      isExpanded: (title) => open?.includes(title) ?? false,
      toggle: (title) => {
        setOpenBySpace((prev) => {
          const current = prev[spaceId] ?? [];
          const next = current.includes(title)
            ? current.filter((t) => t !== title)
            : [...current, title];
          return { ...prev, [spaceId]: next };
        });
      },
    }),
    [open, spaceId],
  );
}

/** Whether the section rendering this sits under a fold — so it renders even while empty. */
export function useWorkbenchSectionFold(): SectionFold | null {
  return useContext(SectionFoldContext);
}

/**
 * A section that reads nothing until the operator expands it (Plan 338 D3).
 * Collapsed, it renders its header alone, from what the board already holds.
 * Expanded, it mounts `children`, whose own `WorkbenchSection` header carries
 * the same toggle. Opening the Workbench therefore costs only the sections that
 * are not folded.
 */
export function WorkbenchLazySection({
  title,
  icon,
  meta,
  trailing,
  children,
}: {
  title: string;
  icon?: IconName;
  /** Shown on the collapsed header. It must come from data already held. */
  meta?: ReactNode;
  /** Section-level status on the collapsed header, as `WorkbenchSection` places it. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const folds = useContext(WorkbenchFoldsContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = folds ? folds.isExpanded(title) : localExpanded;
  const fold = useMemo<SectionFold>(
    () => ({
      expanded,
      toggle: () => {
        if (folds) folds.toggle(title);
        else setLocalExpanded((e) => !e);
      },
    }),
    [expanded, folds, title],
  );
  return (
    <SectionFoldContext.Provider value={fold}>
      {expanded ? (
        children
      ) : (
        <WorkbenchSection title={title} {...(icon ? { icon } : {})} meta={meta} trailing={trailing}>
          {null}
        </WorkbenchSection>
      )}
    </SectionFoldContext.Provider>
  );
}

/**
 * What a section renders while its first read is in flight. Outside a fold it
 * renders nothing, as before. Under one it keeps the header the operator just
 * clicked, so the section does not vanish until its read lands.
 */
export function WorkbenchSectionPending({ title, icon }: { title: string; icon?: IconName }) {
  const fold = useWorkbenchSectionFold();
  if (!fold) return null;
  return (
    <WorkbenchSection title={title} {...(icon ? { icon } : {})} trailing={<Spinner size="sm" />}>
      {null}
    </WorkbenchSection>
  );
}

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
  const fold = useContext(SectionFoldContext);
  const heading = (
    <>
      {fold && (
        <Icon
          name="caret-right"
          size="xs"
          style={{
            flexShrink: 0,
            color: 'var(--color-content-muted)',
            transform: fold.expanded ? 'rotate(90deg)' : 'none',
            transition:
              'transform var(--transition-duration-fast) var(--transition-timing-default)',
          }}
        />
      )}
      {icon && <Icon name={icon} size="sm" style={{ color: 'var(--color-content-muted)' }} />}
      <Text
        size="sm"
        weight="semibold"
        style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
      >
        {title}
      </Text>
    </>
  );
  return (
    <Column gap="sm" style={style}>
      <Row gap="xs" align="center" style={{ flexShrink: 0 }}>
        {fold ? (
          <button
            type="button"
            onClick={fold.toggle}
            aria-expanded={fold.expanded}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-primary)',
              padding: 0,
            }}
          >
            {heading}
          </button>
        ) : (
          heading
        )}
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
