'use client';

import { type ReactNode } from 'react';
import {
  Button,
  Heading,
  Icon,
  Input,
  Select,
  Text,
  Textarea,
  type IconName,
} from '@aflow/design-system';
import { formatCampaignParamForDisplay, type Outcome, type SkillDiagnostic } from '@aflow/schemas';

import type { SelectOption } from './useModelOptions.js';

export type { SelectOption };

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const MODE_ICON: Record<string, IconName> = {
  optimization: 'bullseye',
  process: 'gears',
  project: 'slalom',
};
export const ACCENT_GOAL = 'var(--color-accent-default)';

export const MODE_OPTIONS: SelectOption[] = [
  { value: 'optimization', label: 'Optimization — chained attempts at one target' },
  { value: 'process', label: 'Process — repeatable mechanism over cases' },
  { value: 'project', label: 'Project — episodes along an ongoing course' },
];
export const OPERATOR_OPTIONS: SelectOption[] = [
  { value: 'lt', label: '< (less than)' },
  { value: 'lte', label: '≤ (at most)' },
  { value: 'gt', label: '> (greater than)' },
  { value: 'gte', label: '≥ (at least)' },
  { value: 'eq', label: '= (equals)' },
  { value: 'between', label: 'between' },
];
export const EVAL_TYPE_OPTIONS: SelectOption[] = [
  { value: 'threshold', label: 'Threshold — metric vs target' },
  { value: 'pattern', label: 'Pattern — metric matches regex' },
  { value: 'manual', label: 'Manual — human check' },
];
export const SEMANTICS_OPTIONS: SelectOption[] = [
  { value: 'data', label: 'data' },
  { value: 'artifact', label: 'artifact' },
  { value: 'metric', label: 'metric' },
  { value: 'status', label: 'status' },
];
export const BINDING_KIND_OPTIONS: SelectOption[] = [
  { value: 'task_output', label: 'Task output' },
  { value: 'task_summary', label: 'Task summary' },
  { value: 'run_input', label: 'Run input' },
  { value: 'campaign_input', label: 'Campaign field' },
];
export const DISPATCH_OPTIONS: SelectOption[] = [
  { value: 'agent', label: 'Agent (ai.agent.turn)' },
  { value: 'operation', label: 'Operation' },
  { value: 'human', label: 'Human' },
];
export const YES_NO: SelectOption[] = [
  { value: 'no', label: 'no' },
  { value: 'yes', label: 'yes' },
];

export function uniqueKey(prefix: string, taken: Set<string>): string {
  let n = taken.size + 1;
  let k = `${prefix}${n}`;
  while (taken.has(k)) {
    n += 1;
    k = `${prefix}${n}`;
  }
  return k;
}

export type Evaluator = Outcome['evaluator'];
export function defaultEvaluator(type: Evaluator['type']): Evaluator {
  switch (type) {
    case 'threshold':
      return { type: 'threshold', metric: 'metric', operator: 'lt', target: 0 };
    case 'pattern':
      return { type: 'pattern', metric: 'metric', pattern: '.*' };
    case 'manual':
    default:
      return { type: 'manual', instruction: 'Describe the pass condition.' };
  }
}

export function evaluatorDetail(ev: Evaluator): ReactNode {
  const OP: Record<string, string> = {
    lt: '<',
    lte: '≤',
    gt: '>',
    gte: '≥',
    eq: '=',
    between: 'between',
  };
  switch (ev.type) {
    case 'threshold': {
      const op = formatCampaignParamForDisplay(ev.operator);
      return (
        <Mono>{`${ev.metric} ${OP[op] ?? op} ${formatCampaignParamForDisplay(ev.target)}`}</Mono>
      );
    }
    case 'pattern':
      return <Mono>{`${ev.metric} ~ /${ev.pattern}/`}</Mono>;
    case 'manual':
      return <Prose>{ev.instruction}</Prose>;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function InspectorHeader({
  icon,
  kind,
  title,
  accent,
  onRemove,
}: {
  icon: IconName;
  kind: string;
  title: string;
  accent: string;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <div style={{ marginBottom: 'var(--space-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-0)' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 'var(--radius-md)',
            background: `${accent}1f`,
            color: accent,
          }}
        >
          <Icon name={icon} size="md" weight="thin" />
        </span>
        <Text
          size="xs"
          weight="normal"
          style={{ textTransform: 'uppercase', letterSpacing: '0.06em', color: accent }}
        >
          {kind}
        </Text>
        {onRemove && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            style={{ marginLeft: 'auto', color: 'var(--color-error-default, #ef4444)' }}
          >
            <Icon name="trash" size="xs" /> Remove
          </Button>
        )}
      </div>
      <Heading level={4} style={{ marginTop: 'var(--space-0)' }}>
        {title}
      </Heading>
    </div>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--space-lg)' }}>
      <Text
        size="xs"
        variant="label"
        color="muted"
        weight="semibold"
        style={{
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          display: 'block',
          marginBottom: 'var(--space-xs)',
        }}
      >
        {label}
      </Text>
      {children}
    </div>
  );
}

export function Prose({ children }: { children: ReactNode }) {
  return (
    <Text size="base" color="secondary" style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
      {children}
    </Text>
  );
}
export function Mono({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" variant="mono">
      {children}
    </Text>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" color="muted" style={{ fontStyle: 'italic' }}>
      {children}
    </Text>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--space-md)',
        padding: '6px 0',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
    >
      <Text size="sm" color="muted">
        {k}
      </Text>
      <span style={{ textAlign: 'right' }}>
        {typeof v === 'string' ? <Text size="sm">{v}</Text> : v}
      </span>
    </div>
  );
}

/** Editable text/number field — input when `onChange` is provided, else read-only prose. */
export function Editable({
  value,
  onChange,
  multiline,
  type = 'text',
  placeholder,
}: {
  value: string;
  onChange?: ((v: string) => void) | undefined;
  multiline?: boolean | undefined;
  type?: 'text' | 'number' | undefined;
  placeholder?: string | undefined;
}) {
  if (!onChange) return value ? <Prose>{value}</Prose> : <Empty>—</Empty>;
  if (multiline)
    return (
      <Textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        rows={4}
        style={{ width: '100%' }}
      />
    );
  return (
    <Input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      style={{ width: '100%' }}
    />
  );
}

/** Enum selector — dropdown when editable, else a read-only label. */
export function Sel({
  value,
  onChange,
  options,
  width,
}: {
  value: string;
  onChange?: ((v: string) => void) | undefined;
  options: SelectOption[];
  width?: number | string | undefined;
}) {
  if (!onChange)
    return <Text size="sm">{options.find((o) => o.value === value)?.label ?? value}</Text>;
  return (
    <Select
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      style={{ width: width ?? '100%' }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

export function FlagSel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Text size="xs" color="muted">
        {label}
      </Text>
      <Sel
        value={value ? 'yes' : 'no'}
        options={YES_NO}
        width={70}
        onChange={(v) => {
          onChange(v === 'yes');
        }}
      />
    </div>
  );
}

export function DiagRow({ d }: { d: SkillDiagnostic }) {
  const isErr = d.severity === 'error';
  const color = isErr ? 'var(--color-error-default, #ef4444)' : 'var(--color-warning-default)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm)',
        marginBottom: 'var(--space-xs)',
        background: `${color}10`,
        borderRadius: 'var(--radius-md)',
      }}
    >
      <Icon
        name={isErr ? 'warning-circle' : 'warning'}
        size="sm"
        style={{ color, flexShrink: 0 }}
      />
      <div>
        <Text size="sm">{d.detail}</Text>
        {d.fixHint && (
          <Text size="sm" color="muted" style={{ display: 'block', marginTop: 2 }}>
            Fix: {d.fixHint}
          </Text>
        )}
        <Text size="xs" variant="mono" color="muted" style={{ display: 'block', marginTop: 2 }}>
          {d.code}
        </Text>
      </div>
    </div>
  );
}

export function bindingSummary(b: unknown): string {
  const r = b as { kind?: string; taskId?: string; path?: string };
  const kind = r.kind ?? '?';
  const taskId = r.taskId ? `:${r.taskId}` : '';
  const path = r.path ? `.${r.path}` : '';
  return `${kind}${taskId}${path}`;
}
