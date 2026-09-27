'use client';

import { useCallback, useState, type ReactNode } from 'react';
import {
  Badge,
  CodeBlock,
  Column,
  Icon,
  IconButton,
  Row,
  Text,
  Tooltip,
} from '@aflow/design-system';
import type { ApiBindingSummary, IntegrationCredentialMeta } from '../../hooks/use-integrations.js';

// ============================================================================
// Status helpers
// ============================================================================

export type ApiStatus = 'not_connected' | 'needs_setup' | 'needs_secret' | 'ready';

export function getApiStatus(
  binding: ApiBindingSummary | undefined,
  credentialsByKey: Map<string, IntegrationCredentialMeta>,
  requiredVariables: readonly string[] = [],
  // `oauth2_authorization_code` carries no static credential — the user's token
  // is obtained via sign-in (consent), so readiness reflects the per-user
  // connection, not a stored secret.
  isOAuthConnected?: boolean,
): ApiStatus {
  if (!binding) return 'not_connected';
  // A simulated binding reaches no host, so no credential and no base-URL
  // variable can gate it. Reading its readiness off credentials would report
  // "needs setup" for a connection that is already answering calls.
  if (binding.fulfillment.mode === 'simulated') return 'ready';
  if (binding.authType === 'oauth2_authorization_code') {
    return isOAuthConnected ? 'ready' : 'not_connected';
  }
  if (binding.authType !== 'none' && binding.credentialKeys.length === 0) return 'needs_setup';
  const values = binding.variableValues ?? {};
  for (const name of requiredVariables) {
    const v = values[name];
    if (v === undefined || v === '') return 'needs_setup';
  }
  for (const k of binding.credentialKeys) {
    if (!credentialsByKey.get(k)?.hasValue) return 'needs_secret';
  }
  return 'ready';
}

export function StatusBadge({ status }: { status: ApiStatus }) {
  switch (status) {
    case 'ready':
      return (
        <Badge variant="success">
          <Icon name="check-circle" size="xs" /> Ready
        </Badge>
      );
    case 'needs_setup':
      return (
        <Badge variant="warning">
          <Icon name="warning-circle" size="xs" /> Needs setup
        </Badge>
      );
    case 'needs_secret':
      return (
        <Badge variant="warning">
          <Icon name="key" size="xs" /> Needs secret
        </Badge>
      );
    case 'not_connected':
      return <Badge variant="neutral">Not connected</Badge>;
  }
}

// ============================================================================
// Formatting helpers
// ============================================================================

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const formatted = v >= 100 || Number.isInteger(v) ? Math.round(v).toString() : v.toFixed(1);
  return `${formatted} ${units[i]}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms} ms`;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return s % 1 === 0 ? `${s} s` : `${s.toFixed(1)} s`;
  const m = s / 60;
  return m % 1 === 0 ? `${m} min` : `${m.toFixed(1)} min`;
}

export function methodBadgeVariant(
  method: string,
): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'info';
    case 'POST':
      return 'success';
    case 'PUT':
    case 'PATCH':
      return 'warning';
    case 'DELETE':
      return 'danger';
    default:
      return 'neutral';
  }
}

// ============================================================================
// Detail row helpers
// ============================================================================

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row gap="2" align="start" wrap>
      <Text size="xs" color="secondary" style={{ minWidth: 140, paddingTop: 2, flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </Row>
  );
}

export function ChipList({
  items,
  variant = 'neutral' as const,
}: {
  items: string[];
  variant?: 'neutral' | 'info' | 'success' | 'warning';
}) {
  if (items.length === 0)
    return (
      <Text size="sm" color="secondary">
        —
      </Text>
    );
  return (
    <Row gap="1" align="center" wrap>
      {items.map((item) => (
        <Badge key={item} variant={variant}>
          <Text size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {item}
          </Text>
        </Badge>
      ))}
    </Row>
  );
}

// ============================================================================
// Collapsible Details Section (caret + </> toggle for raw JSON)
// ============================================================================

export function DetailsSection({
  label,
  count,
  rawJson,
  onFirstExpand,
  loading,
  error,
  children,
}: {
  label: string;
  count?: number;
  rawJson: () => string;
  onFirstExpand?: () => void | Promise<void>;
  loading?: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hasExpanded, setHasExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && !hasExpanded) {
      setHasExpanded(true);
      void onFirstExpand?.();
    }
  }, [expanded, hasExpanded, onFirstExpand]);

  return (
    <Column gap="2">
      <Row align="center" justify="between" gap="2">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={expanded}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--color-content-primary)',
            textAlign: 'left',
            flex: 1,
            minWidth: 0,
          }}
        >
          <Icon
            name="caret-right"
            size="xs"
            style={{
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 120ms ease',
            }}
          />
          <Text size="sm" weight="medium">
            {label}
          </Text>
          {count != null && (
            <Text size="xs" color="secondary">
              ({count})
            </Text>
          )}
        </button>
        {expanded && (
          <Tooltip content={showRaw ? 'Show visual view' : 'View raw JSON'}>
            <IconButton
              icon={<Icon name={showRaw ? 'eye' : 'code'} size="xs" />}
              aria-label={showRaw ? 'Show visual view' : 'View raw JSON'}
              variant="ghost"
              onClick={() => {
                setShowRaw((v) => !v);
              }}
            />
          </Tooltip>
        )}
      </Row>

      {expanded && (
        <Column gap="2" style={{ paddingLeft: 'var(--space-4)' }}>
          {loading && (
            <Text size="sm" color="secondary">
              Loading…
            </Text>
          )}
          {error && (
            <Text size="sm" tone="danger">
              {error}
            </Text>
          )}
          {!loading && !error && (
            <>
              {showRaw ? (
                <CodeBlock language="json" copyable maxHeight="400px">
                  {rawJson()}
                </CodeBlock>
              ) : (
                children
              )}
            </>
          )}
        </Column>
      )}
    </Column>
  );
}
