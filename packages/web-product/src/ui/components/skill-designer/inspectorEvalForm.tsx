'use client';

import { useState } from 'react';
import { Button, Icon, Input, Text } from '@aflow/design-system';
import { EvalCriterionSchema, type EvalCriterion } from '@aflow/schemas';

import { Sel } from './inspectorShared.js';
import type { SelectOption } from './useModelOptions.js';

const TYPE_OPTIONS: SelectOption[] = [
  { value: 'threshold', label: 'Threshold — metric vs target' },
  { value: 'contains', label: 'Contains — field matches pattern' },
  { value: 'trace_bound', label: 'Trace bound — steps / cost / …' },
  { value: 'judge', label: 'Judge — LLM rubric' },
];
const OPERATOR_OPTIONS: SelectOption[] = [
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'eq', label: '=' },
  { value: 'between', label: 'between' },
];
const TRACE_METRIC_OPTIONS: SelectOption[] = [
  'step_count',
  'duration_ms',
  'cost_cents',
  'token_count',
  'tool_call_count',
].map((v) => ({ value: v, label: v }));
interface RubricEntry {
  criterion: string;
  scale: 'binary';
  description: string;
}

/** Inline form for authoring one eval criterion (all four types). Add-only;
 *  client-validates against the schema before handing back a typed criterion. */
export function CriterionForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (c: EvalCriterion) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<EvalCriterion['type']>('threshold');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // threshold
  const [metric, setMetric] = useState('');
  const [operator, setOperator] = useState('lte');
  const [target, setTarget] = useState('');
  const [targetHigh, setTargetHigh] = useState('');
  // contains
  const [pattern, setPattern] = useState('');
  const [inField, setInField] = useState('');
  // trace_bound
  const [traceMetric, setTraceMetric] = useState('step_count');
  const [maxValue, setMaxValue] = useState('');
  // judge
  const [rubric, setRubric] = useState<RubricEntry[]>([
    { criterion: '', scale: 'binary', description: '' },
  ]);
  const [referenceAnswer, setReferenceAnswer] = useState('');

  const build = (): unknown => {
    const base = { name: name.trim() };
    switch (type) {
      case 'threshold':
        return {
          ...base,
          type,
          metric: metric.trim(),
          operator,
          target: Number(target),
          ...(operator === 'between' && targetHigh.trim() !== ''
            ? { targetHigh: Number(targetHigh) }
            : {}),
        };
      case 'contains':
        return { ...base, type, pattern, inField: inField.trim() };
      case 'trace_bound':
        return { ...base, type, metric: traceMetric, maxValue: Number(maxValue) };
      case 'judge':
        return {
          ...base,
          type,
          rubric: rubric
            .filter((r) => r.criterion.trim() !== '')
            .map((r) => ({
              criterion: r.criterion.trim(),
              scale: r.scale,
              description: r.description.trim(),
            })),
          ...(referenceAnswer.trim() !== '' ? { referenceAnswer: referenceAnswer.trim() } : {}),
        };
    }
  };

  const submit = () => {
    const parsed = EvalCriterionSchema.safeParse(build());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid criterion');
      return;
    }
    onSubmit(parsed.data);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 'var(--space-sm)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Field label="Type">
        <Sel
          value={type}
          options={TYPE_OPTIONS}
          onChange={(v) => {
            setType(v as typeof type);
          }}
        />
      </Field>
      <Field label="Name">
        <Input
          value={name}
          placeholder="short identifier"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </Field>

      {type === 'threshold' && (
        <>
          <Field label="Metric">
            <Input
              value={metric}
              placeholder="e.g. lbValue"
              onChange={(e) => {
                setMetric(e.target.value);
              }}
            />
          </Field>
          <Field label="Operator">
            <Sel value={operator} options={OPERATOR_OPTIONS} onChange={setOperator} />
          </Field>
          <Field label="Target">
            <Input
              value={target}
              type="number"
              onChange={(e) => {
                setTarget(e.target.value);
              }}
            />
          </Field>
          {operator === 'between' && (
            <Field label="Upper bound">
              <Input
                value={targetHigh}
                type="number"
                onChange={(e) => {
                  setTargetHigh(e.target.value);
                }}
              />
            </Field>
          )}
        </>
      )}

      {type === 'contains' && (
        <>
          <Field label="Field">
            <Input
              value={inField}
              placeholder="output field to check"
              onChange={(e) => {
                setInField(e.target.value);
              }}
            />
          </Field>
          <Field label="Pattern">
            <Input
              value={pattern}
              placeholder="regex or exact string"
              onChange={(e) => {
                setPattern(e.target.value);
              }}
            />
          </Field>
        </>
      )}

      {type === 'trace_bound' && (
        <>
          <Field label="Metric">
            <Sel value={traceMetric} options={TRACE_METRIC_OPTIONS} onChange={setTraceMetric} />
          </Field>
          <Field label="Max value">
            <Input
              value={maxValue}
              type="number"
              onChange={(e) => {
                setMaxValue(e.target.value);
              }}
            />
          </Field>
        </>
      )}

      {type === 'judge' && (
        <>
          <Text size="xs" color="muted">
            Rubric — what should the judge check? (1–5 lines)
          </Text>
          {rubric.map((r, i) => (
            <div
              key={i}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 4 }}
            >
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <Input
                  value={r.criterion}
                  placeholder="criterion"
                  onChange={(e) => {
                    setRubricAt(setRubric, i, { criterion: e.target.value });
                  }}
                />
                {rubric.length > 1 && (
                  <button
                    type="button"
                    title="Remove line"
                    onClick={() => {
                      setRubric((rs) => rs.filter((_, j) => j !== i));
                    }}
                    style={iconBtn}
                  >
                    <Icon name="x" size="xs" />
                  </button>
                )}
              </div>
              <Input
                value={r.description}
                placeholder="what good / bad looks like"
                onChange={(e) => {
                  setRubricAt(setRubric, i, { description: e.target.value });
                }}
              />
            </div>
          ))}
          {rubric.length < 5 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRubric((rs) => [...rs, { criterion: '', scale: 'binary', description: '' }]);
              }}
            >
              <Icon name="plus" size="xs" /> Add rubric line
            </Button>
          )}
          <Field label="Reference (optional)">
            <Input
              value={referenceAnswer}
              placeholder="ideal answer, if any"
              onChange={(e) => {
                setReferenceAnswer(e.target.value);
              }}
            />
          </Field>
        </>
      )}

      {error && (
        <Text size="xs" tone="danger">
          {error}
        </Text>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-xs)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={submit}>
          Add check
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text size="xs" color="muted">
        {label}
      </Text>
      {children}
    </label>
  );
}

function setRubricAt(
  setRubric: React.Dispatch<React.SetStateAction<RubricEntry[]>>,
  i: number,
  patch: Partial<RubricEntry>,
): void {
  setRubric((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
}

const iconBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--color-text-muted)',
  display: 'inline-flex',
  padding: 2,
};
