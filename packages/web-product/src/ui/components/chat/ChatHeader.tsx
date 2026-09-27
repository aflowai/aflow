'use client';

import {
  Icon,
  IconButton,
  Logo,
  SegmentedSwitch,
  Tooltip,
  useBreakpoint,
} from '@aflow/design-system';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppPageHeader } from '../app-page-header.js';
import { SpaceSelector } from '../space-selector.js';

interface ChatHeaderProps {
  /** Whether the console mode/dock is currently open. */
  consoleOpen?: boolean;
  /** Mode switch handler; absent hides the segmented toggle. */
  onConsoleOpenChange?: (open: boolean) => void;
  /** Whether the console segment is offered. */
  consoleAvailable?: boolean;
  /** Attention count shown on the console segment. */
  consoleBadge?: number;
  /** Who else is in this room. Absent or alone renders nothing. */
  presence?: ReactNode;
  /** Clear the conversation and start fresh. Absent on an already-empty chat. */
  onNewChat?: () => void;
  /** What this conversation is called. Absent before one exists. */
  title?: ReactNode;
}

const CHAT_VIEW = 'chat';
const CONSOLE_VIEW = 'workbench';

export function ChatHeader({
  consoleOpen = false,
  onConsoleOpenChange,
  consoleAvailable = false,
  consoleBadge = 0,
  presence,
  onNewChat,
  title,
}: ChatHeaderProps) {
  const { isMobile } = useBreakpoint();

  // Phones only — desktop uses the dock's collapse rail instead of a header
  // segment. One control owns the companion's visibility, so there is no
  // separate bell/rail/sheet affordance to keep in sync.
  const modeToggle =
    isMobile && consoleAvailable && onConsoleOpenChange ? (
      <SegmentedSwitch
        label="View"
        value={consoleOpen ? CONSOLE_VIEW : CHAT_VIEW}
        onChange={(next) => {
          onConsoleOpenChange(next === CONSOLE_VIEW);
        }}
        items={[
          {
            value: CHAT_VIEW,
            label: 'Chat',
            icon: <Icon name="chat" size="sm" weight={consoleOpen ? 'regular' : 'fill'} />,
          },
          {
            value: CONSOLE_VIEW,
            label: 'Workbench',
            icon: <Icon name="squares-four" size="sm" weight={consoleOpen ? 'fill' : 'regular'} />,
            badge: consoleBadge,
          },
        ]}
      />
    ) : null;

  // Starting over is a move between conversations, not part of writing one, so
  // it sits with the room's chrome rather than inside the composer — which on a
  // phone is the row that can least afford another button.
  const newChatButton = onNewChat ? (
    <Tooltip content="New chat">
      <IconButton
        icon={<Icon name="plus" size="sm" />}
        aria-label="New chat"
        variant="ghost"
        size="sm"
        onClick={onNewChat}
      />
    </Tooltip>
  ) : null;

  const actionButtons =
    presence || modeToggle || newChatButton ? (
      <>
        {presence}
        {newChatButton}
        {modeToggle}
      </>
    ) : undefined;

  // Below the shell's desktop breakpoint the header row teleports into the
  // AppShell top bar, which drops PageHeader's space prefix — so the mark and
  // the space chip ride the title slot there instead. `ds-hide-desktop` cuts at
  // the same 1024px the portal does, so exactly one of the two ever shows, and
  // it does so in CSS: a JS breakpoint would flash the wrong one on first paint.
  const mobileIdentity = (
    <span
      className="ds-hide-desktop"
      style={{ alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}
    >
      <Link href="/" aria-label="Home" style={{ display: 'inline-flex', lineHeight: 0 }}>
        <Logo size={16} />
      </Link>
      <SpaceSelector variant="inline" />
    </span>
  );

  // Chat is always with the Helmsman — no agent selector; Runner sessions open
  // from the workflow-run surface, Coach from the Workbench. The title is the
  // conversation's own name, and it is absent until there is one: an untitled
  // header keeps the space prefix from trailing a separator into nothing.
  return (
    <AppPageHeader
      actions={actionButtons}
      bordered={false}
      showActionBell={false}
      {...(title ? { title } : {})}
    >
      {mobileIdentity}
    </AppPageHeader>
  );
}
