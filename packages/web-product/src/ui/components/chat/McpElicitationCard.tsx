'use client';

import { useState, useEffect, useRef } from 'react';
import { Text, Column, Button, Row, Icon } from '@aflow/design-system';
import type { McpElicitationEntry } from '@aflow/run-view';
import { useApi } from '../providers.js';
import { McpElicitationForm, type ElicitationContent } from './McpElicitationForm.js';

interface Props {
  entry: McpElicitationEntry;
  sessionId: string;
  /** Called on successful submit so the parent can hide the card optimistically. */
  onDismiss: (elicitationId: string) => void;
}

interface AjvIssue {
  path?: string;
  message?: string;
}

export function McpElicitationCard({ entry, sessionId, onDismiss }: Props) {
  const { apiUrl, headers } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<AjvIssue[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Move focus into the card when it mounts. role="region" + aria-label
  // alerts screen readers; the auto-focus also flags it visually for
  // sighted users who didn't notice the form appear mid-conversation.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>('input, select, textarea, button');
    focusable?.focus();
  }, []);

  const respond = async (
    action: 'accept' | 'decline' | 'cancel',
    content?: ElicitationContent,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setDetails(null);
    try {
      const res = await fetch(
        `${apiUrl}/sessions/${sessionId}/elicitations/${entry.elicitationId}/respond`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ action, ...(content ? { content } : {}) }),
        },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          message?: string;
          details?: AjvIssue[];
        } | null;
        // 410 GONE = expired/missing elicitation; 400 = schema validation
        // failure (server reran AJV). Both are user-actionable.
        setError(detail?.message ?? `Request failed (${String(res.status)})`);
        if (Array.isArray(detail?.details) && detail.details.length > 0) {
          setDetails(detail.details);
        }
        setBusy(false);
        return;
      }
      // Success — optimistically dismiss so the user gets immediate
      // feedback even if the `McpElicitationResolved` SSE event is
      // delayed or dropped (best-effort emit on the server). The
      // reducer will eventually reach the same state when the event
      // does arrive (or the step's terminal event clears the entry).
      onDismiss(entry.elicitationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={`${entry.serverId} requests input`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        margin: 'var(--space-3) 0',
        backgroundColor: 'var(--color-accent-bg)',
        borderRadius: 'var(--radius-2xl)',
        border: '1px solid var(--color-border-default)',
      }}
    >
      <Header
        serverId={entry.serverId}
        bindingId={entry.bindingId}
        leaseExpiresAt={entry.leaseExpiresAt}
      />

      <Text size="sm">{entry.message}</Text>

      {entry.mode === 'form' && entry.requestedSchema ? (
        <McpElicitationForm
          schema={entry.requestedSchema}
          busy={busy}
          onAccept={(content) => void respond('accept', content)}
          onDecline={() => void respond('decline')}
          onCancel={() => void respond('cancel')}
        />
      ) : entry.mode === 'url' && entry.url ? (
        <UrlModeBody
          url={entry.url}
          busy={busy}
          onAccept={() => void respond('accept')}
          onDecline={() => void respond('decline')}
          onCancel={() => void respond('cancel')}
        />
      ) : (
        <MalformedBody busy={busy} onCancel={() => void respond('cancel')} />
      )}

      {error ? (
        <Column gap="1">
          <Text size="sm" tone="danger">
            {error}
          </Text>
          {details && details.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
              {details.map((d, i) => (
                <li key={i}>
                  <Text size="xs" tone="danger">
                    {d.path ? `${d.path}: ` : ''}
                    {d.message ?? 'invalid'}
                  </Text>
                </li>
              ))}
            </ul>
          ) : null}
        </Column>
      ) : null}
    </div>
  );
}

function Header({
  serverId,
  bindingId,
  leaseExpiresAt,
}: {
  serverId: string;
  bindingId: string;
  leaseExpiresAt: string;
}) {
  // Show an absolute clock time rather than a relative countdown. The
  // entry's `leaseExpiresAt` is fixed for its lifetime, so a relative
  // "~14 min remaining" rendered once would stay frozen at 14 minutes
  // even as the lease drains. An absolute "Expires 15:42" stays
  // accurate without a per-second timer or re-renders.
  const expiresAt = new Date(leaseExpiresAt);
  const hh = String(expiresAt.getHours()).padStart(2, '0');
  const mm = String(expiresAt.getMinutes()).padStart(2, '0');

  return (
    <Row gap="2" align="center" justify="between">
      <Row gap="2" align="center">
        <Icon name="chat-dots" size="sm" />
        <Text size="sm" weight="medium">
          {serverId} requests input
        </Text>
        <Text size="xs" variant="muted">
          via {bindingId}
        </Text>
      </Row>
      <Text size="xs" variant="muted">
        Expires {hh}:{mm}
      </Text>
    </Row>
  );
}

function UrlModeBody({
  url,
  busy,
  onAccept,
  onDecline,
  onCancel,
}: {
  url: string;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
}) {
  return (
    <Column gap="3">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: 'var(--color-accent-default)',
          fontSize: 'var(--font-size-sm)',
          wordBreak: 'break-all',
        }}
      >
        {url} ↗
      </a>
      <Text size="xs" variant="muted">
        Open this link in your browser, complete the flow there, then return and confirm below.
      </Text>
      <Row gap="2" wrap>
        <Button variant="primary" disabled={busy} onClick={onAccept}>
          {busy ? 'Submitting…' : "I've finished"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDecline}>
          Decline
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </Row>
    </Column>
  );
}

/**
 * Renders when the server sent a malformed payload (e.g. form mode with no
 * requestedSchema, or url mode with no url). Without an explicit cancel the
 * lease would sit until TTL (~15 min) blocking the executor's warm session
 * for other calls. The cancel button POSTs `{action: 'cancel'}` so the
 * suspend path settles immediately.
 */
function MalformedBody({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <Column gap="2">
      <Text size="sm" tone="danger">
        Malformed elicitation — the server didn't supply a usable form schema or URL.
      </Text>
      <Row gap="2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {busy ? 'Cancelling…' : 'Cancel'}
        </Button>
      </Row>
    </Column>
  );
}
