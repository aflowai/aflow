import { forwardRef, type ReactNode, type HTMLAttributes } from 'react';
import { Logo } from './Logo.js';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessageProps extends HTMLAttributes<HTMLDivElement> {
  /** Message role */
  role: ChatRole;
  /** Message content */
  children: ReactNode;
  /** Avatar content (letter, icon, or image) */
  avatar?: ReactNode;
  /** Timestamp */
  timestamp?: string;
  /** Tool name (for tool role) */
  toolName?: string;
  /**
   * Override the sender label shown above the message.
   * When set, replaces the generic role label (e.g. "Phoenix") with a
   * context-specific name (e.g. the flow name or step name).
   */
  senderName?: string;
  /**
   * Soft entrance animation for non-user bubbles. Callers must latch this
   * at mount time (NOT derive it per-render): a streaming placeholder that
   * is later promoted in place must never start animating mid-life —
   * adding the class to a mounted node restarts the CSS animation.
   * User bubbles ignore this (they always animate via the role class).
   */
  animateIn?: boolean;
}

const roleLabels: Record<ChatRole, string> = {
  user: 'You',
  assistant: 'Phoenix',
  system: 'System',
  tool: 'Tool',
};

export function ChatMessage({
  role,
  children,
  avatar,
  timestamp,
  toolName,
  senderName,
  animateIn = false,
  className = '',
  ...props
}: ChatMessageProps) {
  const classNames = [
    'ds-chat-message',
    `ds-chat-message--${role}`,
    animateIn ? 'ds-chat-message--animate-in' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const displayLabel = senderName ?? (role === 'tool' && toolName ? toolName : roleLabels[role]);

  return (
    <div className={classNames} {...props}>
      <div className="ds-chat-message__avatar">{avatar ?? <DefaultAvatar role={role} />}</div>
      <div className="ds-chat-message__content">
        <div className="ds-chat-message__role">
          <span>{displayLabel}</span>
          {timestamp && (
            <span
              style={{
                marginLeft: 'var(--space-2)',
                fontWeight: 'var(--font-weight-normal)',
                textTransform: 'none',
                letterSpacing: '0',
              }}
            >
              {timestamp}
            </span>
          )}
        </div>
        <div className="ds-chat-message__body">{children}</div>
      </div>
    </div>
  );
}

function DefaultAvatar({ role }: { role: ChatRole }) {
  if (role === 'assistant') {
    return <Logo variant="mono" size={14} />;
  }
  const letter = role === 'user' ? 'U' : role === 'tool' ? 'T' : 'S';
  return <span>{letter}</span>;
}

// =============================================================================
// ChatMessageList - Container for chat messages
// =============================================================================

export interface ChatMessageListProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export const ChatMessageList = forwardRef<HTMLDivElement, ChatMessageListProps>(
  function ChatMessageList({ children, className = '', style, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`ds-scroll-subtle ${className}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          ...style,
        }}
        {...props}
      >
        {children}
      </div>
    );
  },
);
