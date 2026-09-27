'use client';

import { Text, Button, Icon } from '@aflow/design-system';
import { sanitizeTerminalErrorMessage } from '@aflow/schemas';
import type { UserFacingError, RunErrorDetail } from '../../lib/types.js';

interface RunCompletionBannerProps {
  status: string;
  errorMessage?: string | null;
  errorDetail?: RunErrorDetail | null;
  userError?: UserFacingError | null;
  onStartNewRun: () => void;
  onRetry?: (() => void) | undefined;
  onInspect: () => void;
}

/** Parse a structured error message into a clean display string. */
function formatError(raw: string): string {
  const cleaned = sanitizeTerminalErrorMessage(raw, 2000);
  const braceIdx = cleaned.indexOf('{');
  if (braceIdx >= 0) {
    try {
      const parsed = JSON.parse(cleaned.slice(braceIdx)) as Record<string, unknown>;
      const msg = extractMessage(parsed);
      if (msg) return sanitizeTerminalErrorMessage(msg, 1000);
    } catch {
      // Not valid JSON
    }
  }
  return cleaned.length > 300 ? cleaned.slice(0, 297) + '…' : cleaned;
}

function extractMessage(obj: Record<string, unknown>): string | null {
  if (obj['error'] && typeof obj['error'] === 'object') {
    const e = obj['error'] as Record<string, unknown>;
    return typeof e['message'] === 'string' ? e['message'] : null;
  }
  return typeof obj['message'] === 'string' ? obj['message'] : null;
}

export function RunCompletionBanner({
  status,
  errorMessage,
  errorDetail,
  userError,
  onStartNewRun,
  onRetry,
  onInspect,
}: RunCompletionBannerProps) {
  const isFailed = status === 'FAILED';
  const rawMessage = userError?.message ?? errorMessage;
  const displayMessage = rawMessage ? formatError(rawMessage) : null;
  const stepName = errorDetail?.stepName;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        ...(isFailed
          ? {
              position: 'relative',
              backgroundColor: 'var(--color-accent-bg)',
              margin: '0 10% 10px 10%',
              borderRadius: 'var(--radius-2xl)',
            }
          : {}),
      }}
    >
      {isFailed && (
        <>
          <img src="/frog.svg" alt="" style={{ width: 120, height: 100, opacity: 0.9 }} />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--space-1)',
              maxWidth: 480,
            }}
          >
            {stepName && (
              <Text size="xs" variant="muted">
                Step: {stepName}
              </Text>
            )}
            <Text
              size="sm"
              style={{
                textAlign: 'center',
                color: 'var(--color-text-secondary)',
                wordBreak: 'break-word',
              }}
            >
              {displayMessage ?? 'Something went wrong.'}
            </Text>
          </div>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {isFailed && onRetry && (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="undo" size="sm" />}
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onStartNewRun}>
          New run
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="info" size="sm" />}
          onClick={onInspect}
        >
          Inspect
        </Button>
      </div>
    </div>
  );
}
