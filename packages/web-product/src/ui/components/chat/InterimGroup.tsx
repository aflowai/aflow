'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Text } from '@aflow/design-system';
import type { Message } from '../../lib/types.js';
import { MessageWithCopy } from './MessageWithCopy.js';
import { SubflowClusterHeader } from './SubflowClusterHeader.js';

/** Build a summary string from step sender names + detail, deduplicating and truncating. */
function buildInterimSummary(messages: Message[]): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const name = m.senderName ?? 'step';
    // Include stepDetail to differentiate steps with the same name
    const label = m.stepDetail ? `${name} · ${m.stepDetail}` : name;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  // Truncate to 3 unique labels max
  if (labels.length > 3) {
    return labels.slice(0, 3).join('\n') + '\n…';
  }
  return labels.join('\n');
}

/** Max collapsed height (px) for individual messages inside an interim group. */
const INTERIM_MSG_MAX_HEIGHT = 120;

function TruncatableInterimMessage({
  message,
  userAvatar,
}: {
  message: Message;
  userAvatar: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [msgExpanded, setMsgExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > INTERIM_MSG_MAX_HEIGHT);
  }, [message.content]);

  const truncated = overflows && !msgExpanded;

  return (
    <div className="chat-interim-msg">
      <div
        ref={contentRef}
        className={`chat-interim-msg__content ${truncated ? 'chat-interim-msg__content--truncated' : ''}`}
      >
        <MessageWithCopy message={message} userAvatar={userAvatar} showSubflowHeader={false} />
      </div>
      {overflows && (
        <button
          className="chat-interim-msg__toggle"
          onClick={() => {
            setMsgExpanded((prev) => !prev);
          }}
        >
          <Icon name={msgExpanded ? 'caret-up' : 'caret-down'} size="xs" />
          <Text size="xs">{msgExpanded ? 'less' : 'more'}</Text>
        </button>
      )}
    </div>
  );
}

export function CollapsibleInterimGroup({
  messages,
  userAvatar,
  subflowSource,
  subflowLabel,
  showSubflowHeader,
  continuesFrom,
  continuedBy,
}: {
  messages: Message[];
  userAvatar: ReactNode;
  subflowSource?: string | undefined;
  subflowLabel?: string | undefined;
  showSubflowHeader: boolean;
  continuesFrom?: boolean | undefined;
  continuedBy?: boolean | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  const summary = buildInterimSummary(messages);

  const box = (
    <div
      className={[
        'chat-interim-group',
        expanded ? 'chat-interim-group--expanded' : '',
        continuesFrom ? 'chat-interim-group--continues-from' : '',
        continuedBy ? 'chat-interim-group--continued-by' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showSubflowHeader && subflowSource && (
        <SubflowClusterHeader source={subflowSource} label={subflowLabel} />
      )}
      <button
        className="chat-interim-group__header"
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
        aria-expanded={expanded}
      >
        <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
        <Text
          size="xs"
          style={{
            fontWeight: 'var(--font-weight-medium)',
            whiteSpace: 'nowrap',
            lineHeight: 'var(--font-line-height-tight)',
          }}
        >
          {count} {count === 1 ? 'step' : 'steps'}
        </Text>
        <Text size="xs" className="chat-interim-group__summary">
          {summary}
        </Text>
      </button>
      <div className="chat-interim-group__body">
        <div className="chat-interim-group__content">
          {messages.map((msg) => (
            <TruncatableInterimMessage key={msg.id} message={msg} userAvatar={userAvatar} />
          ))}
        </div>
      </div>
    </div>
  );

  // Subflow interim groups sit indented past the avatar column (intentionally
  // distinct from the subflow chain's left border at `var(--space-4)`). Without
  // a bridge, the chain's decorative left line breaks across the box. Wrap in
  // a positioning container that paints a continuous 2px bridge at the chain's
  // x position, extending slightly above/below to overlap adjacent borders.
  return subflowSource ? <div className="chat-interim-group-bridge">{box}</div> : box;
}
