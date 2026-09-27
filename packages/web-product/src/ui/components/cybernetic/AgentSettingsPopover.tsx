'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Column,
  Icon,
  MenuItem,
  Popover,
  Row,
  Text,
  ToggleChip,
  Tooltip,
  type IconName,
} from '@aflow/design-system';
import type { EntityDirectives } from '@aflow/schemas';
import { useSpace } from '../providers.js';
import type {
  AgentDirectivesController,
  DirectivesSaveState,
} from '../../hooks/useAgentDirectives.js';

const PANEL_WIDTH = 360;

/** Where the trigger sits: the composer's action bar, or a row in its overflow menu. */
export type AgentSettingsVariant = 'chip' | 'menu-item';

/**
 * The shell every in-composer agent settings panel shares: the trigger in
 * either presentation, the titled header with its save status, the load states,
 * and the footer that says how far an edit reaches.
 *
 * Each panel owns one subject. A single panel holding models, capabilities and
 * connections at once made the crowd the reason none of them could be found.
 */
export function AgentSettingsPopover({
  open,
  onOpenChange,
  variant,
  icon,
  title,
  controller,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: AgentSettingsVariant;
  icon: IconName;
  title: string;
  controller: AgentDirectivesController;
  children: (directives: EntityDirectives) => ReactNode;
}) {
  const { activeSpace } = useSpace();
  const { directives, loadState, loadError, saveState, saveError } = controller;

  const settingsHref = activeSpace?.slug
    ? `/s/${encodeURIComponent(activeSpace.slug)}/settings/agent`
    : null;

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      placement="top-start"
      width={PANEL_WIDTH}
      aria-label={title}
      trigger={({ ref, open: isOpen, toggle }) =>
        variant === 'menu-item' ? (
          <MenuItem
            ref={ref}
            active={isOpen}
            icon={<Icon name={icon} size="sm" />}
            label={title}
            trailing={<Icon name="caret-right" size="xs" />}
            onClick={toggle}
            aria-expanded={isOpen}
            aria-label={title}
          />
        ) : (
          <div ref={ref} style={{ display: 'inline-flex' }}>
            <Tooltip content={title}>
              <ToggleChip
                active={isOpen}
                icon={<Icon name={icon} size="xs" />}
                onClick={toggle}
                aria-label={title}
              />
            </Tooltip>
          </div>
        )
      }
    >
      {({ close }) => (
        <>
          <Row align="center" justify="between" gap="2" style={{ marginBottom: 'var(--space-2)' }}>
            <Row align="center" gap="2" style={{ minWidth: 0 }}>
              <Icon name={icon} size="sm" />
              <Text size="sm" weight="semibold">
                {title}
              </Text>
            </Row>
            <SaveStatus state={saveState} error={saveError} />
          </Row>

          {/* Scope belongs before the controls, not after them: it changes what
              every row below means, and read at the bottom it arrives once the
              operator has already decided. */}
          <Text
            size="xs"
            variant="muted"
            style={{ display: 'block', marginBottom: 'var(--space-2)' }}
          >
            Applies to this agent across new sessions, not just this chat.
          </Text>

          {loadState === 'loading' && <Text variant="muted">Loading…</Text>}
          {loadState === 'error' && (
            <Text variant="muted">{loadError ?? 'Failed to load settings.'}</Text>
          )}
          {loadState === 'loaded' && directives && children(directives)}

          <Column
            gap="xs"
            style={{
              marginTop: 'var(--space-3)',
              paddingTop: 'var(--space-2)',
              borderTop: '1px solid var(--color-border-subtle)',
            }}
          >
            {settingsHref && (
              <Link
                href={settingsHref}
                onClick={close}
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-interactive-default)',
                  textDecoration: 'none',
                }}
              >
                All agent settings →
              </Link>
            )}
          </Column>
        </>
      )}
    </Popover>
  );
}

function SaveStatus({ state, error }: { state: DirectivesSaveState; error: string | null }) {
  if (state === 'saving') {
    return (
      <Text size="xs" variant="muted">
        Saving…
      </Text>
    );
  }
  if (state === 'saved') {
    return (
      <Row align="center" style={{ gap: 4 }}>
        <Icon name="check" size="xs" color="var(--color-success-default)" />
        <Text size="xs" variant="muted">
          Saved
        </Text>
      </Row>
    );
  }
  if (state === 'error') {
    return (
      <Tooltip content={error ?? 'Save failed'}>
        <Text size="xs" style={{ color: 'var(--color-warning-default)' }}>
          Not saved
        </Text>
      </Tooltip>
    );
  }
  return null;
}
