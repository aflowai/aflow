'use client';

import { Badge, Row, Text } from '@aflow/design-system';
import { sanitizeTerminalErrorMessage } from '@aflow/schemas';
import type { RunSeparatorItem } from '../../lib/types.js';

export function RunSeparatorLine({ item }: { item: RunSeparatorItem }) {
  const isFailed = item.status === 'FAILED';
  const lineColor = isFailed
    ? 'color-mix(in srgb, var(--color-danger-default) 40%, transparent)'
    : 'var(--color-border-subtle)';
  const textColor = isFailed ? 'var(--color-danger-default)' : undefined;

  let label: string;
  if (isFailed) {
    label = 'Failed';
  } else if (item.status === 'CANCELLED') {
    label = 'Cancelled';
  } else if (item.status === 'STALLED') {
    label = 'Stalled';
  } else {
    label = 'Completed';
  }

  const errorBrief = isFailed && item.errorMessage ? extractErrorBrief(item.errorMessage) : null;
  const stepName = item.errorDetail?.stepName;
  const errorCode = item.errorDetail?.errorCode;

  return (
    <div style={{ padding: '0 var(--space-5)' }}>
      {/* Error detail — above the separator line */}
      {isFailed && errorBrief && (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--space-3) 0 var(--space-2)',
          }}
        >
          <Row gap="2" align="center" style={{ justifyContent: 'center' }}>
            {stepName && (
              <Text variant="label" size="xs" style={{ color: 'var(--color-danger-default)' }}>
                {stepName}
              </Text>
            )}
            {errorCode && (
              <Badge variant="danger" style={{ fontSize: '10px' }}>
                {errorCode}
              </Badge>
            )}
          </Row>
          <Text
            size="xs"
            style={{
              color: 'var(--color-text-muted)',
              lineHeight: 1.4,
              marginTop: 'var(--space-1)',
            }}
          >
            {errorBrief}
          </Text>
        </div>
      )}

      {/* Separator line */}
      <div
        role="separator"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) 0 var(--space-4)',
        }}
      >
        <div style={{ flex: 1, height: '1px', backgroundColor: lineColor }} />
        <Text
          size="xs"
          style={{
            color: textColor,
            opacity: isFailed ? 1 : 0.5,
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          {label}
        </Text>
        <div style={{ flex: 1, height: '1px', backgroundColor: lineColor }} />
      </div>
    </div>
  );
}

/**
 * Extract a short, human-readable message from a raw error string.
 * Preserves error type/status context (e.g. "404 not_found_error: model: claude-haiku-4.5").
 * Falls back to the raw text (truncated) if no structure is found.
 */
function extractErrorBrief(raw: string): string {
  const cleaned = sanitizeTerminalErrorMessage(raw, 2000);
  const braceIdx = cleaned.indexOf('{');
  if (braceIdx >= 0) {
    const prefix = cleaned.slice(0, braceIdx).trim();
    // Keep any HTTP status or step prefix (e.g. "404", '[step "ai-1" ...]')
    const statusPrefix = /^\d{3}$/.test(prefix) ? prefix + ' ' : '';
    try {
      const parsed = JSON.parse(cleaned.slice(braceIdx)) as Record<string, unknown>;
      const brief = buildBriefFromJson(parsed);
      if (brief) return statusPrefix + brief;
    } catch {
      // Not valid JSON — fall through
    }
  }
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
}

function buildBriefFromJson(obj: Record<string, unknown>): string | null {
  // Shape: {"error":{"type":"not_found_error","message":"model: ..."}}
  const inner = obj['error'];
  if (inner && typeof inner === 'object') {
    const e = inner as Record<string, unknown>;
    const msg = typeof e['message'] === 'string' ? e['message'] : null;
    const type = typeof e['type'] === 'string' ? e['type'] : null;
    const status = typeof e['status'] === 'string' ? e['status'] : null;
    const label = type ?? status;
    if (msg && label) return `${label}: ${msg}`;
    if (msg) return msg;
    if (label) return label;
  }
  // Shape: {"message":"...","status":"...","code":400}
  const msg = typeof obj['message'] === 'string' ? obj['message'] : null;
  const type = typeof obj['type'] === 'string' ? obj['type'] : null;
  const status = typeof obj['status'] === 'string' ? obj['status'] : null;
  const label = type ?? status;
  if (msg && label && label !== 'error') return `${label}: ${msg}`;
  if (msg) return msg;
  return null;
}
