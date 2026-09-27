/**
 * Aflow Semantic Components
 *
 * Higher-level components specifically designed for the Aflow platform.
 * These are LLM-friendly with clear semantic names and intent.
 */

// Layout — app-level shells and page structure
export {
  AppShell,
  useSidebar,
  useMobileHeaderSlot,
  SidebarHeader,
  SidebarNav,
  SidebarNavItem,
  SidebarFooter,
  SidebarAction,
  type AppShellProps,
  type SidebarHeaderProps,
  type SidebarNavProps,
  type SidebarNavItemProps,
  type SidebarFooterProps,
  type SidebarActionProps,
} from './AppShell.js';
export { PageHeader, type PageHeaderProps } from './PageHeader.js';
export { PageContainer, type PageContainerProps } from './PageContainer.js';
export {
  ChatLayout,
  useChatScroll,
  type ChatLayoutProps,
  type ChatScrollState,
} from './ChatLayout.js';
export { SplitPane, type SplitPaneProps } from './SplitPane.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';

// Status indicators
export {
  RunStatusBadge,
  type RunStatusBadgeProps,
  type RunStatus,
  type PauseType,
} from './RunStatusBadge.js';
export { StepStatusPill, type StepStatusPillProps, type StepStatus } from './StepStatusPill.js';
export { EventTypeBadge, type EventTypeBadgeProps, type EventType } from './EventTypeBadge.js';

// Timeline
export {
  Timeline,
  TimelineItem,
  type TimelineProps,
  type TimelineItemProps,
  type TimelineItemStatus,
} from './Timeline.js';

// Animated text
export { ShimmerText, type ShimmerTextProps } from './ShimmerText.js';

// Motion
export { Swap, type SwapProps } from './Swap.js';
export { AnimatedHeight, type AnimatedHeightProps } from './AnimatedHeight.js';

// Data display
export { KeyValueTable, type KeyValueTableProps, type KeyValuePair } from './KeyValueTable.js';
export { CodeBlock, type CodeBlockProps } from './CodeBlock.js';
export { JsonViewer, type JsonViewerProps } from './JsonViewer.js';

// Brand
export { Logo, type LogoProps, type LogoVariant } from './Logo.js';

// Chat
export {
  ChatMessage,
  ChatMessageList,
  type ChatMessageProps,
  type ChatMessageListProps,
  type ChatRole,
} from './ChatMessage.js';
export { ChatComposer, type ChatComposerProps } from './ChatComposer.js';
