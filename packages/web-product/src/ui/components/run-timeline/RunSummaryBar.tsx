'use client';

import { Text } from '@aflow/design-system';

export interface RunSummary {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  totalDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  models: Set<string>;
  totalCacheReadTokens: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCostUsd(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function SummaryPill({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-1)' }}>
      <Text variant="muted" size="xs">
        {label}
      </Text>
      <Text size="xs" weight="medium">
        {value}
      </Text>
      {detail ? (
        <Text variant="muted" size="xs">
          ({detail})
        </Text>
      ) : null}
    </div>
  );
}

export function RunSummaryBar({ summary }: { summary: RunSummary }) {
  const hasTokens = summary.totalTokens > 0;
  const hasCost = summary.totalCostUsd > 0;
  const hasModels = summary.models.size > 0;
  const showBar = hasTokens || hasCost || summary.totalSteps > 0;
  if (!showBar) return null;

  return (
    <div
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        backgroundColor: 'var(--color-surface-2)',
        border: '1px solid var(--color-border-subtle)',
        marginBottom: 'var(--space-1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2) var(--space-4)',
          alignItems: 'center',
        }}
      >
        <SummaryPill label="Steps" value={`${summary.completedSteps}/${summary.totalSteps}`} />
        {summary.totalDurationMs > 0 ? (
          <SummaryPill label="Total Time" value={formatDuration(summary.totalDurationMs)} />
        ) : null}
        {hasTokens ? (
          <SummaryPill
            label="Tokens"
            value={formatNumber(summary.totalTokens)}
            detail={`${formatNumber(summary.totalPromptTokens)} in / ${formatNumber(summary.totalCompletionTokens)} out`}
          />
        ) : null}
        {hasCost ? <SummaryPill label="Cost" value={formatCostUsd(summary.totalCostUsd)} /> : null}
        {summary.totalCacheReadTokens > 0 && summary.totalPromptTokens > 0 ? (
          <SummaryPill
            label="Cache"
            value={`${Math.round((summary.totalCacheReadTokens / summary.totalPromptTokens) * 100)}%`}
            detail={`${formatNumber(summary.totalCacheReadTokens)} cached`}
          />
        ) : null}
        {hasModels ? (
          <SummaryPill
            label={summary.models.size === 1 ? 'Model' : 'Models'}
            value={Array.from(summary.models).join(', ')}
          />
        ) : null}
      </div>
    </div>
  );
}
