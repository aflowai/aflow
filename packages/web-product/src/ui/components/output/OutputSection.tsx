'use client';

/**
 * Output a machine produced, shown the way a machine produced it.
 *
 * Extracted from `ComputeResultCard`, where it was written for a sandboxed
 * command, so the host lane can show a command run on the operator's own
 * computer the same way. The two are the same idea run in different places and
 * they should not read differently — a reader should not have to work out which
 * kind of machine answered before they can read what it said.
 *
 * Collapsed by default: a screenful of stdout in a chat buries whatever came
 * after it, and the interesting line is usually the first or the last.
 */

import { useState } from 'react';
import { CodeBlock, Icon, Inline, Stack, Text } from '@aflow/design-system';

const COLLAPSED_MAX_LINES = 3;

function shouldCollapse(text: string): boolean {
  return text.split('\n').length > COLLAPSED_MAX_LINES;
}

function previewText(text: string): string {
  return text.split('\n').slice(0, COLLAPSED_MAX_LINES).join('\n');
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

export function SectionLabel({
  label,
  detail,
  variant,
}: {
  label: string;
  detail: string | null;
  variant?: 'default' | 'danger' | undefined;
}) {
  return (
    <Inline gap="2" align="center">
      <Text
        variant="label"
        size="xs"
        style={variant === 'danger' ? { color: 'var(--color-danger-default)' } : undefined}
      >
        {label}
      </Text>
      {detail && (
        <Text variant="muted" size="xs">
          {detail}
        </Text>
      )}
    </Inline>
  );
}

/** Collapsible output section — always renders as CodeBlock for reliability */
export function OutputSection({
  label,
  content,
  variant,
}: {
  label: string;
  content: string;
  variant?: 'default' | 'danger';
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = shouldCollapse(content);
  const displayContent = collapsible && !expanded ? previewText(content) : content;

  return (
    <Stack gap="1">
      {label && (
        <SectionLabel
          label={label}
          detail={`${String(content.split('\n').length)} lines`}
          variant={variant}
        />
      )}
      <div
        style={{
          position: 'relative',
          maxHeight: expanded ? 'none' : '80px',
          overflow: 'hidden',
          fontSize: 'var(--font-size-xs)',
        }}
      >
        <CodeBlock copyable>{displayContent}</CodeBlock>
        {collapsible && !expanded && (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: '24px',
              background: 'linear-gradient(transparent, var(--color-bg-default))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      {collapsible && (
        <button
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontSize: '10px',
            color: 'var(--color-text-muted)',
            alignSelf: 'flex-start',
          }}
        >
          <Icon name={expanded ? 'caret-up' : 'caret-down'} size="xs" />
          {expanded
            ? 'collapse'
            : `${String(content.split('\n').length - COLLAPSED_MAX_LINES)} more lines`}
        </button>
      )}
    </Stack>
  );
}
