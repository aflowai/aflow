'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Column, Icon, Row, Spinner, Text } from '@aflow/design-system';
import type { IconName } from '@aflow/design-system';

interface SectionFold {
  expanded: boolean;
  toggle: () => void;
  /** Records that the section under this fold has held content in the space. */
  markHeld?: () => void;
}

const SectionFoldContext = createContext<SectionFold | null>(null);

interface WorkbenchFolds {
  isExpanded: (title: string) => boolean;
  toggle: (title: string) => void;
}

export const WorkbenchFoldsContext = createContext<WorkbenchFolds | null>(null);

/**
 * Which folded sections the operator opened, per space. The record lives at
 * module level, so it outlives its owner within the page session. The
 * inspector's tab panel unmounts the Workbench on a tab switch, and a move to a
 * space whose detail is not cached unmounts the owner itself. A reload loses
 * the record, and nothing writes it to storage.
 */
const openSectionsBySpace = new Map<string, readonly string[]>();

/**
 * The fold record of one space. Its owner calls this above the tab panel and
 * provides the result through `WorkbenchFoldsContext`, so a return to the tab,
 * or to the space, finds the same sections open.
 */
export function useWorkbenchFolds(spaceId: string): WorkbenchFolds {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const open = openSectionsBySpace.get(spaceId);
  return useMemo<WorkbenchFolds>(
    () => ({
      isExpanded: (title) => open?.includes(title) ?? false,
      toggle: (title) => {
        const current = openSectionsBySpace.get(spaceId) ?? [];
        const next = current.includes(title)
          ? current.filter((t) => t !== title)
          : [...current, title];
        openSectionsBySpace.set(spaceId, next);
        rerender();
      },
    }),
    [open, spaceId],
  );
}

/** Forgets every space's open sections, as a reload does. */
export function __resetForTests(): void {
  openSectionsBySpace.clear();
}

/** Whether the section rendering this sits under a fold — so it renders even while empty. */
export function useWorkbenchSectionFold(): SectionFold | null {
  return useContext(SectionFoldContext);
}

/**
 * Where a section that has held content is recorded. The Workbench provides
 * it, and a section outside the Workbench records nothing.
 */
export const WorkbenchHeldContext = createContext<((title: string) => void) | null>(null);

/**
 * A section under a fold calls this with whether it holds content now. Once
 * it has, the section stands in its place rather than behind More the next
 * time the Workbench mounts. A section open under More therefore does not
 * jump out from under the operator.
 */
export function useWorkbenchSectionHeld(holdsContent: boolean): void {
  const markHeld = useContext(SectionFoldContext)?.markHeld;
  useEffect(() => {
    if (holdsContent) markHeld?.();
  }, [holdsContent, markHeld]);
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
  link,
  children,
}: {
  title: string;
  icon?: IconName;
  /** Shown on the collapsed header. It must come from data already held. */
  meta?: ReactNode;
  /** Section-level status on the collapsed header, as `WorkbenchSection` places it. */
  trailing?: ReactNode;
  /** The full surface behind this section, on the collapsed header. */
  link?: { href: string; label: string };
  children: ReactNode;
}) {
  const folds = useContext(WorkbenchFoldsContext);
  const recordHeld = useContext(WorkbenchHeldContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = folds ? folds.isExpanded(title) : localExpanded;
  const fold = useMemo<SectionFold>(
    () => ({
      expanded,
      toggle: () => {
        if (folds) folds.toggle(title);
        else setLocalExpanded((e) => !e);
      },
      ...(recordHeld
        ? {
            markHeld: () => {
              recordHeld(title);
            },
          }
        : {}),
    }),
    [expanded, folds, recordHeld, title],
  );
  return (
    <SectionFoldContext.Provider value={fold}>
      {expanded ? (
        children
      ) : (
        <WorkbenchSection
          title={title}
          {...(icon ? { icon } : {})}
          meta={meta}
          trailing={trailing}
          {...(link ? { link } : {})}
        >
          {null}
        </WorkbenchSection>
      )}
    </SectionFoldContext.Provider>
  );
}

export const WORKBENCH_MORE = 'More';

/**
 * The one fold at the bottom of the pane that holds every section that has
 * never held content in the space. Its header names them, so the operator
 * can tell what sits behind it without opening it. Open, it shows each one's
 * header as the pane shows a folded section, and each one still mounts, and
 * reads, only when the operator expands it.
 */
export function WorkbenchMoreFold({
  titles,
  children,
}: {
  /** The sections behind the fold, in the order the pane lists them. */
  titles: readonly string[];
  children: ReactNode;
}) {
  const folds = useContext(WorkbenchFoldsContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = folds ? folds.isExpanded(WORKBENCH_MORE) : localExpanded;
  const fold = useMemo<SectionFold>(
    () => ({
      expanded,
      toggle: () => {
        if (folds) folds.toggle(WORKBENCH_MORE);
        else setLocalExpanded((e) => !e);
      },
    }),
    [expanded, folds],
  );
  return (
    <div data-workbench-more>
      <SectionFoldContext.Provider value={fold}>
        <WorkbenchSection
          title={WORKBENCH_MORE}
          meta={
            expanded ? null : (
              <Text size="xs" variant="muted" truncate style={{ minWidth: 0 }}>
                {titles.join(' · ')}
              </Text>
            )
          }
        >
          {null}
        </WorkbenchSection>
      </SectionFoldContext.Provider>
      {expanded && (
        <Column gap="2xl" style={{ marginTop: 'var(--space-4)' }}>
          {children}
        </Column>
      )}
    </div>
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
