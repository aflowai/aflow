'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { ChatMessage, Icon, IconButton, Text } from '@aflow/design-system';
import { formatTime } from '../run-timeline/displayHelpers.js';
import { ContentRenderer } from '../content-renderer.js';
import { useApi } from '../providers.js';
import { useTranscriptSettled } from './TranscriptEntranceContext.js';
import { ParticipantBadge } from '../room/ParticipantBadge.js';
import { fetchPayload } from '../../lib/fetch-payload.js';
import type { Message } from '../../lib/types.js';
import type { InlineHitlPayload, InlineProposalFocusPayload } from '@aflow/run-view';
import { HitlInline } from './HitlInline.js';
import { InlineFocusedProposal } from './InlineFocusedProposal.js';
import { SubflowClusterHeader } from './SubflowClusterHeader.js';
import { useMessageAuthor } from './MessageAuthorContext.js';
import { ThinkingBody } from './ThinkingBody.js';

/** Resolve the best copyable text for a message. */
function getCopyText(msg: Message): string {
  // Rich content (structured JSON) — stringify it
  if (msg.richContent != null) {
    return typeof msg.richContent === 'string'
      ? msg.richContent
      : JSON.stringify(msg.richContent, null, 2);
  }
  return msg.content;
}

function DeliveryIndicator({
  deliveryState,
  onCancel,
}: {
  deliveryState: NonNullable<Message['deliveryState']>;
  onCancel?: (() => void) | undefined;
}) {
  return (
    <div className="chat-delivery-indicator" data-state={deliveryState}>
      {deliveryState === 'queued' && (
        <>
          <Icon name="clock" size="xs" />
          <Text variant="muted" size="xs">
            Queued — pausing the run
          </Text>
          {onCancel && (
            <button type="button" className="chat-delivery-cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
        </>
      )}
      {deliveryState === 'delivering' && (
        <>
          <Icon name="check" size="xs" />
          <Text variant="muted" size="xs">
            Sending…
          </Text>
        </>
      )}
    </div>
  );
}

export function MessageWithCopy({
  message: msg,
  userAvatar,
  showSubflowHeader,
  onCancelQueuedSend,
}: {
  message: Message;
  userAvatar: ReactNode;
  showSubflowHeader: boolean;
  onCancelQueuedSend?: () => void;
}) {
  const { personFor, currentUserId } = useMessageAuthor();
  // Your own messages stay right-aligned and unlabelled — you know who you
  // are, and a name on every line is noise in the solo case, which is most of
  // the time. Someone else's message mirrors to the left with their name and
  // their own avatar, the way every group messenger draws it.
  const isPeer = msg.role === 'user' && !!msg.authorUserId && msg.authorUserId !== currentUserId;
  const authorName = isPeer
    ? (msg.authorDisplayName ??
      (msg.authorUserId ? personFor(msg.authorUserId)?.displayName : undefined) ??
      'Someone')
    : undefined;
  const peerAvatar = isPeer ? (
    <ParticipantBadge
      name={authorName ?? 'Someone'}
      avatarUrl={(msg.authorUserId ? personFor(msg.authorUserId)?.avatarUrl : null) ?? null}
      role={undefined}
      driving={false}
      overlapping={false}
      size={28}
    />
  ) : null;

  const [copied, setCopied] = useState(false);
  // Latched at mount: a bubble that mounts as a streaming placeholder must
  // never animate (it grows in place and is promoted in place — same id,
  // same node). Bubbles that mount as final content get the soft entrance.
  // Deriving this per-render would restart the CSS animation the moment the
  // echo strips the streaming semanticType.
  // Also latched: a bubble that mounts while the transcript is still being shown
  // for the first time is history, not arrival. Two hundred of those animating
  // at once was the page's largest layout-shift cluster.
  const settled = useTranscriptSettled();
  const [animateIn] = useState(
    () =>
      settled && msg.semanticType !== 'streaming_text' && msg.semanticType !== 'streaming_thinking',
  );
  const { apiUrl, headers } = useApi();

  const handleCopy = useCallback(async () => {
    try {
      let text = getCopyText(msg);

      // If content is a placeholder and there's a payload ref, fetch the real content
      if (
        msg.payloadRef &&
        (text === 'Output' || text === 'Output available' || text === 'Generated media')
      ) {
        try {
          const payload = await fetchPayload(apiUrl, headers, msg.payloadRef);
          text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        } catch {
          // Fall back to whatever we have
        }
      }

      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS)
    }
  }, [msg, apiUrl, headers]);

  const isSubflow = Boolean(msg.subflowSource);

  if (msg.semanticType === 'inline_hitl' && msg.richContent) {
    return (
      <div
        className={`chat-message-wrapper ${isSubflow ? 'chat-message-wrapper--subflow' : ''}`}
        data-chat-message
      >
        {showSubflowHeader && msg.subflowSource && (
          <SubflowClusterHeader source={msg.subflowSource} label={msg.subflowLabel} />
        )}
        <ChatMessage
          animateIn={animateIn}
          role="assistant"
          timestamp={formatTime(msg.timestamp)}
          senderName={msg.senderName ?? 'System'}
        >
          <HitlInline payload={msg.richContent as InlineHitlPayload} />
        </ChatMessage>
      </div>
    );
  }

  if (msg.semanticType === 'inline_proposal_focus' && msg.richContent) {
    const focusPayload = msg.richContent as InlineProposalFocusPayload;
    if (!focusPayload.itemId.startsWith('proposal:')) {
      // Legacy/non-proposal focus items have no inline renderer anymore.
      // Fall through to the default text-rendering path below.
      return (
        <div
          className={`chat-message-wrapper ${isSubflow ? 'chat-message-wrapper--subflow' : ''}`}
          data-chat-message
        >
          {showSubflowHeader && msg.subflowSource && (
            <SubflowClusterHeader source={msg.subflowSource} label={msg.subflowLabel} />
          )}
          <ChatMessage
            animateIn={animateIn}
            role="assistant"
            timestamp={formatTime(msg.timestamp)}
            senderName={msg.senderName ?? 'System'}
          >
            <ContentRenderer
              content={msg.content}
              richContent={null}
              mediaItems={msg.mediaItems}
              payloadRef={msg.payloadRef}
              semanticType={msg.semanticType}
              stepExecutionId={msg.stepExecutionId}
            />
          </ChatMessage>
        </div>
      );
    }
    return (
      <div
        className={`chat-message-wrapper ${isSubflow ? 'chat-message-wrapper--subflow' : ''}`}
        data-chat-message
      >
        {showSubflowHeader && msg.subflowSource && (
          <SubflowClusterHeader source={msg.subflowSource} label={msg.subflowLabel} />
        )}
        <ChatMessage
          animateIn={animateIn}
          role="assistant"
          timestamp={formatTime(msg.timestamp)}
          senderName={msg.senderName ?? 'Approval'}
        >
          <InlineFocusedProposal
            itemId={focusPayload.itemId}
            {...(focusPayload.reason ? { reason: focusPayload.reason } : {})}
          />
        </ChatMessage>
      </div>
    );
  }

  return (
    <div
      className={`chat-message-wrapper ${isSubflow ? 'chat-message-wrapper--subflow' : ''}`}
      data-chat-message
    >
      {showSubflowHeader && msg.subflowSource && (
        <SubflowClusterHeader source={msg.subflowSource} label={msg.subflowLabel} />
      )}
      <ChatMessage
        animateIn={animateIn}
        role={msg.role}
        timestamp={formatTime(msg.timestamp)}
        {...((authorName ?? msg.senderName) ? { senderName: authorName ?? msg.senderName } : {})}
        avatar={msg.role === 'user' ? (isPeer ? peerAvatar : userAvatar) : undefined}
        className={
          msg.semanticType === 'streaming_thinking'
            ? 'chat-message-thinking'
            : msg.semanticType === 'streaming_text'
              ? 'chat-message-streaming'
              : isPeer
                ? 'ds-chat-message--peer'
                : undefined
        }
      >
        {msg.semanticType === 'streaming_thinking' ? (
          <ThinkingBody>
            <ContentRenderer
              content={msg.content}
              richContent={msg.richContent}
              mediaItems={msg.mediaItems}
              payloadRef={msg.payloadRef}
              semanticType={msg.semanticType}
              stepExecutionId={msg.stepExecutionId}
            />
          </ThinkingBody>
        ) : (
          <ContentRenderer
            content={msg.content}
            richContent={msg.richContent}
            mediaItems={msg.mediaItems}
            payloadRef={msg.payloadRef}
            semanticType={msg.semanticType}
            stepExecutionId={msg.stepExecutionId}
          />
        )}
      </ChatMessage>
      {msg.role === 'user' && msg.deliveryState && (
        <DeliveryIndicator deliveryState={msg.deliveryState} onCancel={onCancelQueuedSend} />
      )}
      <IconButton
        icon={copied ? <Icon name="check" size="sm" /> : <Icon name="copy" size="sm" />}
        variant="ghost"
        size="sm"
        aria-label={copied ? 'Copied!' : 'Copy message'}
        onClick={() => {
          void handleCopy();
        }}
        className="chat-message-copy-btn"
      />
    </div>
  );
}
