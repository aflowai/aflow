'use client';

import { Column, Icon, Row, Text } from '@aflow/design-system';

export function ErrorRow({ message }: { message: string }) {
  return (
    <Row gap="sm" align="center">
      <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
      <Text size="xs" style={{ color: 'var(--color-status-failed-fg)' }}>
        {message}
      </Text>
    </Row>
  );
}

export function SectionDivider() {
  return <div style={{ borderTop: '1px solid var(--color-border-subtle)', margin: '4px 0' }} />;
}

export interface ModeOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export function ModeToggle<T extends string>({
  options,
  value,
  disabled,
  onSelect,
}: {
  options: Array<ModeOption<T>>;
  value: T | undefined;
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <Row gap="sm" wrap>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!active) onSelect(option.value);
            }}
            style={{
              flex: 1,
              minWidth: 220,
              textAlign: 'left',
              cursor: disabled ? 'default' : 'pointer',
              background: active ? 'var(--color-surface-raised)' : 'transparent',
              border: `1px solid ${active ? 'var(--color-accent-fg)' : 'var(--color-border-subtle)'}`,
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
            }}
          >
            <Column gap="xs">
              <Row gap="sm" align="center">
                <Text size="sm" weight="semibold">
                  {option.label}
                </Text>
                {active && <Icon name="check" size="xs" color="var(--color-status-success-fg)" />}
              </Row>
              <Text size="xs" variant="muted">
                {option.description}
              </Text>
            </Column>
          </button>
        );
      })}
    </Row>
  );
}
