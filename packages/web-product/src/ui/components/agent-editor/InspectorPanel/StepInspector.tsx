'use client';

import { useMemo, useState } from 'react';
import {
  Column,
  Row,
  Text,
  Heading,
  Input,
  Textarea,
  Select,
  Button,
  Badge,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Field,
  Label,
  Divider,
  Checkbox,
  Icon,
  IconButton,
} from '@aflow/design-system';
import { BindingsEditor } from '../BindingsEditor/index.js';
import type { AgentDefinition, StepDefinition, NextStepEdge } from '../../../lib/flow-to-graph.js';
import type { StepId } from '@aflow/schemas';
import type { CatalogOperation, CatalogStepType } from '../../../hooks/use-operation-catalog.js';
import type { ConfigSchemaProperty } from './types.js';
import {
  buildOperationGroups,
  deriveGroupIdFromOp,
  formatRetryAttempts,
  formatTimeoutSeconds,
  getEnumValues,
  resolveType,
  humanize,
  isAgentToolStep,
  getParentAgentName,
} from './helpers.js';
import { validateStepConfig } from '../../../lib/operation-validation.js';

interface StepInspectorProps {
  step: StepDefinition;
  flow: AgentDefinition;
  operations: CatalogOperation[];
  stepTypes: CatalogStepType[];
  onUpdate: (patch: Partial<StepDefinition>) => void;
  onRemove: () => void;
  onSetAsStart: () => void;
  isStartStep: boolean;
}

export function StepInspector({
  step,
  flow,
  operations,
  stepTypes,
  onUpdate,
  onRemove,
  onSetAsStart,
  isStartStep,
}: StepInspectorProps) {
  const selectedOp = operations.find((o) => o.operationId === step.operation);
  const groups = useMemo(
    () => buildOperationGroups(operations, stepTypes),
    [operations, stepTypes],
  );
  const currentGroupId = selectedOp ? deriveGroupIdFromOp(selectedOp) : step.stepType;
  const currentGroup = groups.find((g) => g.groupId === currentGroupId);
  const filteredOps = currentGroup?.ops ?? operations.filter((o) => o.stepType === step.stepType);
  const [showConfigJson, setShowConfigJson] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        style={{ padding: 'var(--space-3)', borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        <Row justify="between" align="center">
          <Column gap="0">
            <Heading level={6}>{step.name ?? step.stepId}</Heading>
            <Text variant="muted" size="xs">
              {selectedOp?.displayName ?? step.operation}
            </Text>
          </Column>
          <Row gap="1">
            {!isStartStep && (
              <IconButton
                icon={<Icon name="flag" size="sm" />}
                size="sm"
                variant="ghost"
                aria-label="Set as start step"
                onClick={onSetAsStart}
                title="Make this the first step"
              />
            )}
            <IconButton
              icon={<Icon name="trash" size="sm" />}
              size="sm"
              variant="ghost"
              aria-label="Delete step"
              onClick={onRemove}
            />
          </Row>
        </Row>
        {isStartStep && (
          <Badge variant="succeeded" style={{ marginTop: 'var(--space-1)', fontSize: '9px' }}>
            First step
          </Badge>
        )}
      </div>

      <Tabs defaultTab="configure">
        <TabList>
          <Tab id="configure">Configure</Tab>
          <Tab id="next">Next Steps</Tab>
          <Tab id="details">Details</Tab>
        </TabList>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <TabPanel id="configure">
            <Column gap="3">
              <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
                What does this step do?
              </Text>
              <Field>
                <Label>Type</Label>
                <Select
                  value={currentGroupId}
                  onChange={(e) => {
                    const newGroupId = e.target.value;
                    const group = groups.find((g) => g.groupId === newGroupId);
                    if (group) {
                      const firstOp = group.ops[0];
                      onUpdate({
                        stepType: group.stepType,
                        operation:
                          firstOp?.operationId ??
                          (`${group.stepType}.default` as StepDefinition['operation']),
                      });
                    }
                  }}
                >
                  {groups.map((g) => (
                    <option key={g.groupId} value={g.groupId}>
                      {g.label}
                    </option>
                  ))}
                  {!groups.find((g) => g.groupId === currentGroupId) && (
                    <option value={currentGroupId}>{currentGroupId}</option>
                  )}
                </Select>
              </Field>
              <Field>
                <Label>Action</Label>
                <Select
                  value={step.operation}
                  onChange={(e) => {
                    onUpdate({ operation: e.target.value as StepDefinition['operation'] }); // DOM value is string
                  }}
                >
                  {filteredOps.map((op) => (
                    <option key={op.operationId} value={op.operationId}>
                      {op.displayName}
                    </option>
                  ))}
                  {!filteredOps.find((o) => o.operationId === step.operation) && (
                    <option value={step.operation}>{step.operation}</option>
                  )}
                </Select>
              </Field>
              <Divider />

              <BindingsEditor
                step={step}
                variables={flow.stateVariables ?? []}
                operationInputSchema={selectedOp?.stepConfigSchema ?? selectedOp?.inputSchema}
                operationOutputSchema={selectedOp?.outputSchema}
                internalFields={selectedOp?.internalFields}
                onUpdateStep={onUpdate}
                isAgentTool={isAgentToolStep(flow, step.stepId)}
                parentAgentName={getParentAgentName(flow, step.stepId)}
                catalogOperations={operations}
              />

              {Object.keys(step.config ?? {}).length > 0 && (
                <>
                  <Divider />
                  <ConfigEditor
                    config={step.config ?? {}}
                    schema={selectedOp?.stepConfigSchema ?? selectedOp?.inputSchema}
                    internalFields={selectedOp?.internalFields?.input}
                    onUpdate={(newConfig) => {
                      onUpdate({ config: newConfig });
                    }}
                    showJson={showConfigJson}
                    onToggleJson={() => {
                      setShowConfigJson((v) => !v);
                    }}
                    hideSchemaFields
                    operationId={step.operation}
                  />
                </>
              )}
            </Column>
          </TabPanel>

          <TabPanel id="next">
            <NextStepsEditor step={step} flow={flow} onUpdate={onUpdate} />
          </TabPanel>

          <TabPanel id="details">
            <Column gap="3">
              {selectedOp && (
                <div
                  style={{
                    padding: 'var(--space-2)',
                    background: 'var(--color-surface-raised)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <Text variant="muted" size="xs">
                    {selectedOp.description}
                  </Text>
                </div>
              )}
              <Field>
                <Label>Step ID</Label>
                <Input value={step.stepId} disabled />
              </Field>
              <Field>
                <Label>Name</Label>
                <Input
                  value={step.name ?? ''}
                  onChange={(e) => {
                    onUpdate({ name: e.target.value });
                  }}
                  placeholder="Give this step a clear name"
                />
              </Field>
              <Field>
                <Label>Description</Label>
                <Textarea
                  value={step.description ?? ''}
                  onChange={(e) => {
                    onUpdate({ description: e.target.value });
                  }}
                  placeholder="What this step does and why"
                  rows={2}
                />
              </Field>
              <Row gap="3">
                <Checkbox
                  checked={step.optional}
                  onChange={(e) => {
                    onUpdate({ optional: e.target.checked });
                  }}
                >
                  Optional (skip if it fails)
                </Checkbox>
              </Row>

              <Divider />

              <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
                Error handling
              </Text>
              <Field>
                <Label>Retry attempts</Label>
                <Input
                  type="number"
                  value={formatRetryAttempts(step.retryPolicy)}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    onUpdate({
                      retryPolicy: {
                        ...step.retryPolicy,
                        maxAttempts: isNaN(val) ? undefined : val,
                      } as StepDefinition['retryPolicy'],
                    });
                  }}
                  placeholder="Default (no retry)"
                />
              </Field>
              <Field>
                <Label>Time limit (seconds)</Label>
                <Input
                  type="number"
                  value={formatTimeoutSeconds(step.timeout)}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    onUpdate({
                      timeout: {
                        ...step.timeout,
                        executionTimeoutMs: isNaN(val) ? undefined : val * 1000,
                      } as StepDefinition['timeout'],
                    });
                  }}
                  placeholder="No limit"
                />
              </Field>
            </Column>
          </TabPanel>
        </div>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config editor — schema-driven form + JSON toggle
// ---------------------------------------------------------------------------

function ConfigEditor({
  config,
  schema,
  internalFields,
  onUpdate,
  showJson,
  onToggleJson,
  hideSchemaFields,
  operationId,
}: {
  config: Record<string, unknown>;
  schema?: Record<string, unknown> | undefined;
  internalFields?: string[] | undefined;
  onUpdate: (config: Record<string, unknown>) => void;
  showJson: boolean;
  onToggleJson: () => void;
  hideSchemaFields?: boolean | undefined;
  operationId?: string | undefined;
}) {
  const [newKey, setNewKey] = useState('');

  const validationErrors = useMemo(() => {
    if (!operationId) return null;
    return validateStepConfig(operationId, config);
  }, [operationId, config]);

  const schemaObj = schema as
    | { type?: string; properties?: Record<string, ConfigSchemaProperty>; required?: string[] }
    | undefined;
  const schemaProps: Record<string, ConfigSchemaProperty> = schemaObj?.properties ?? {};
  const requiredSet = new Set(schemaObj?.required ?? []);
  const hiddenSet = new Set(internalFields ?? []);

  const schemaKeys = hideSchemaFields
    ? []
    : Object.keys(schemaProps).filter((k) => !hiddenSet.has(k));
  const extraKeys = Object.keys(config).filter((k) => !schemaProps[k] && !hiddenSet.has(k));
  const allKeys = [...schemaKeys, ...extraKeys];

  if (showJson) {
    return (
      <Column gap="2">
        <Textarea
          value={JSON.stringify(config, null, 2)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value) as Record<string, unknown>;
              onUpdate(parsed);
            } catch {
              /* noop */
            }
          }}
          rows={8}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
        />
        <Button size="sm" variant="ghost" onClick={onToggleJson}>
          Switch to form view
        </Button>
      </Column>
    );
  }

  if (hideSchemaFields && extraKeys.length === 0) return null;

  return (
    <Column gap="2">
      {hideSchemaFields && (
        <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
          Extra settings
        </Text>
      )}
      {allKeys.length === 0 ? (
        <Text variant="muted" size="xs" style={{ fontStyle: 'italic' }}>
          No settings available for this operation.
        </Text>
      ) : (
        allKeys.map((key) => (
          <ConfigField
            key={key}
            label={key}
            value={config[key]}
            schemaProp={schemaProps[key]}
            required={requiredSet.has(key)}
            onChange={(newVal) => {
              onUpdate({ ...config, [key]: newVal });
            }}
            onRemove={() => {
              const rest = Object.fromEntries(
                Object.entries(config).filter(([k]) => k !== key),
              ) as Record<string, unknown>;
              onUpdate(rest);
            }}
            isFromSchema={!!schemaProps[key]}
            validationError={validationErrors?.[key]}
          />
        ))
      )}
      <Row gap="2" align="center">
        <Input
          value={newKey}
          onChange={(e) => {
            setNewKey(e.target.value);
          }}
          placeholder="Add a custom setting..."
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newKey.trim() && !(newKey.trim() in config)) {
              onUpdate({ ...config, [newKey.trim()]: '' });
              setNewKey('');
            }
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!newKey.trim() || newKey.trim() in config}
          onClick={() => {
            if (newKey.trim() && !(newKey.trim() in config)) {
              onUpdate({ ...config, [newKey.trim()]: '' });
              setNewKey('');
            }
          }}
        >
          + Add
        </Button>
      </Row>
      <Button size="sm" variant="ghost" onClick={onToggleJson} style={{ alignSelf: 'start' }}>
        Edit as JSON
      </Button>
    </Column>
  );
}

function ConfigField({
  label,
  value,
  schemaProp,
  required,
  onChange,
  onRemove,
  isFromSchema,
  validationError,
}: {
  label: string;
  value: unknown;
  schemaProp?: ConfigSchemaProperty | undefined;
  required?: boolean | undefined;
  onChange: (val: unknown) => void;
  onRemove: () => void;
  isFromSchema: boolean;
  validationError?: string | undefined;
}) {
  const enumValues = schemaProp ? getEnumValues(schemaProp) : null;
  const hasCustomOption = schemaProp?.anyOf != null;
  const effectiveType = schemaProp ? resolveType(schemaProp) : typeof value;
  const isConfigured = value !== undefined && value !== null && value !== '';
  const toSafeStr = (v: unknown) =>
    typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String((v ?? '') as string | number | boolean);
  const [showCustom, setShowCustom] = useState(
    () =>
      enumValues != null && value != null && value !== '' && !enumValues.includes(toSafeStr(value)),
  );

  const isLongText = typeof value === 'string' && value.length > 80;
  const isObject = typeof value === 'object' && value !== null;

  const renderInput = () => {
    if (enumValues && !showCustom) {
      return (
        <Column gap="1">
          <Select
            value={value != null ? toSafeStr(value) : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__custom__') {
                setShowCustom(true);
                onChange('');
              } else {
                onChange(v);
              }
            }}
            style={{ fontSize: 'var(--font-size-xs)' }}
          >
            <option value="">— choose —</option>
            {enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            {hasCustomOption && <option value="__custom__">Other (custom value)…</option>}
          </Select>
        </Column>
      );
    }

    if (enumValues && showCustom) {
      return (
        <Column gap="1">
          <Row gap="2" align="center">
            <Input
              value={typeof value === 'string' ? value : value != null ? toSafeStr(value) : ''}
              onChange={(e) => {
                onChange(e.target.value);
              }}
              placeholder="Type a custom value…"
              style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowCustom(false);
                onChange('');
              }}
            >
              List
            </Button>
          </Row>
        </Column>
      );
    }

    if (effectiveType === 'boolean' || typeof value === 'boolean') {
      return (
        <Checkbox
          checked={value === true}
          onChange={(e) => {
            onChange(e.target.checked);
          }}
          size="sm"
        >
          {value === true ? 'Yes' : 'No'}
        </Checkbox>
      );
    }

    if (effectiveType === 'number' || effectiveType === 'integer' || typeof value === 'number') {
      return (
        <Input
          type="number"
          value={value != null ? toSafeStr(value) : ''}
          onChange={(e) => {
            const num = parseFloat(e.target.value);
            onChange(isNaN(num) ? (e.target.value === '' ? undefined : e.target.value) : num);
          }}
          placeholder={
            schemaProp?.default != null
              ? `Default: ${typeof schemaProp.default === 'object' ? JSON.stringify(schemaProp.default) : String(schemaProp.default as string | number | boolean)}`
              : undefined
          }
          min={schemaProp?.minimum}
          max={schemaProp?.maximum}
          style={{ fontSize: 'var(--font-size-xs)' }}
        />
      );
    }

    if (isObject) {
      return (
        <Textarea
          value={JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              /* noop */
            }
          }}
          rows={3}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
        />
      );
    }

    if (isLongText) {
      return (
        <Textarea
          value={value ?? ''}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          rows={3}
          placeholder={schemaProp?.description ?? undefined}
          style={{ fontSize: 'var(--font-size-xs)' }}
        />
      );
    }

    return (
      <Input
        value={typeof value === 'string' ? value : value != null ? toSafeStr(value) : ''}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={
          schemaProp?.default != null
            ? `Default: ${typeof schemaProp.default === 'object' ? JSON.stringify(schemaProp.default) : String(schemaProp.default as string | number | boolean)}`
            : undefined
        }
        style={{ fontSize: 'var(--font-size-xs)' }}
      />
    );
  };

  return (
    <div
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${validationError ? 'var(--color-border-danger)' : 'var(--color-border-subtle)'}`,
        background: 'var(--color-surface-0)',
      }}
    >
      <Column gap="1">
        <Row justify="between" align="center">
          <Row gap="2" align="center">
            <Text size="xs" style={{ fontWeight: 600 }}>
              {humanize(label)}
            </Text>
            {required && !isConfigured && (
              <Badge variant="paused" style={{ fontSize: '9px' }}>
                required
              </Badge>
            )}
          </Row>
          {!isFromSchema && (
            <IconButton
              icon={<Icon name="trash" size="xs" />}
              size="sm"
              variant="ghost"
              aria-label={`Remove ${label}`}
              onClick={onRemove}
            />
          )}
        </Row>
        {schemaProp?.description && (
          <Text variant="muted" style={{ fontSize: '10px' }}>
            {schemaProp.description}
          </Text>
        )}
        {renderInput()}
        {validationError && (
          <Text
            size="xs"
            style={{
              color: 'var(--color-text-danger)',
              marginTop: 'var(--space-1)',
            }}
          >
            {validationError}
          </Text>
        )}
      </Column>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next steps editor
// ---------------------------------------------------------------------------

function NextStepsEditor({
  step,
  flow,
  onUpdate,
}: {
  step: StepDefinition;
  flow: AgentDefinition;
  onUpdate: (patch: Partial<StepDefinition>) => void;
}) {
  const otherSteps = flow.steps.filter((s) => s.stepId !== step.stepId);
  const isTerminal = step.onSuccess.next.length === 0;

  return (
    <Column gap="4">
      <Column gap="2">
        <Row justify="between" align="center">
          <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-success-default)' }}>
            When this step succeeds
          </Text>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const target = otherSteps[0]?.stepId ?? null;
              onUpdate({
                onSuccess: { next: [...step.onSuccess.next, { stepId: target, priority: 50 }] },
              });
            }}
            disabled={otherSteps.length === 0}
          >
            + Add path
          </Button>
        </Row>

        {isTerminal ? (
          <div
            style={{
              padding: 'var(--space-2)',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Text variant="muted" size="xs">
              This is the last step — the flow will finish here.
            </Text>
          </div>
        ) : (
          <Column gap="1">
            {step.onSuccess.next.map((edge, idx) => (
              <NextStepRow
                key={idx}
                edge={edge}
                otherSteps={otherSteps}
                label="then go to"
                onChange={(newEdge) => {
                  const next = [...step.onSuccess.next];
                  next[idx] = newEdge;
                  onUpdate({ onSuccess: { next } });
                }}
                onRemove={() => {
                  onUpdate({
                    onSuccess: { next: step.onSuccess.next.filter((_, i) => i !== idx) },
                  });
                }}
              />
            ))}
          </Column>
        )}
      </Column>

      <Divider />

      <Column gap="2">
        <Row justify="between" align="center">
          <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-danger-default)' }}>
            If this step fails
          </Text>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const target = otherSteps[0]?.stepId ?? null;
              onUpdate({
                onFailure: { next: [...step.onFailure.next, { stepId: target, priority: 50 }] },
              });
            }}
            disabled={otherSteps.length === 0}
          >
            + Add path
          </Button>
        </Row>

        {step.onFailure.next.length === 0 ? (
          <div
            style={{
              padding: 'var(--space-2)',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Text variant="muted" size="xs">
              The whole flow will fail. Add a path to handle errors gracefully.
            </Text>
          </div>
        ) : (
          <Column gap="1">
            {step.onFailure.next.map((edge, idx) => (
              <NextStepRow
                key={idx}
                edge={edge}
                otherSteps={otherSteps}
                label="instead go to"
                onChange={(newEdge) => {
                  const next = [...step.onFailure.next];
                  next[idx] = newEdge;
                  onUpdate({ onFailure: { next } });
                }}
                onRemove={() => {
                  onUpdate({
                    onFailure: { next: step.onFailure.next.filter((_, i) => i !== idx) },
                  });
                }}
              />
            ))}
          </Column>
        )}
      </Column>

      <Divider />

      <Column gap="2">
        <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
          When resumed after a pause
        </Text>
        <Field>
          <Label>Continue to</Label>
          <Select
            value={step.onResume?.continueToStepId ?? ''}
            onChange={(e) => {
              onUpdate({
                onResume: e.target.value
                  ? { continueToStepId: e.target.value as StepId }
                  : undefined,
              });
            }}
          >
            <option value="">Re-evaluate the success paths above</option>
            {otherSteps.map((s) => (
              <option key={s.stepId} value={s.stepId}>
                {s.name ?? s.stepId}
              </option>
            ))}
          </Select>
        </Field>
      </Column>
    </Column>
  );
}

function NextStepRow({
  edge,
  otherSteps,
  label,
  onChange,
  onRemove,
}: {
  edge: NextStepEdge;
  otherSteps: StepDefinition[];
  label: string;
  onChange: (edge: NextStepEdge) => void;
  onRemove: () => void;
}) {
  const [showCondition, setShowCondition] = useState(!!edge.when);

  return (
    <div
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-0)',
      }}
    >
      <Column gap="2">
        <Row gap="2" align="center">
          <Text variant="muted" size="xs" style={{ whiteSpace: 'nowrap' }}>
            {label}
          </Text>
          <Select
            value={edge.stepId ?? ''}
            onChange={(e) => {
              onChange({ ...edge, stepId: (e.target.value || null) as StepId | null });
            }}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          >
            <option value="">-- end flow --</option>
            {otherSteps.map((s) => (
              <option key={s.stepId} value={s.stepId}>
                {s.name ?? s.stepId}
              </option>
            ))}
          </Select>
          <IconButton
            icon={<Icon name="trash" size="xs" />}
            size="sm"
            variant="ghost"
            aria-label="Remove this path"
            onClick={onRemove}
          />
        </Row>

        {!showCondition ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowCondition(true);
            }}
            style={{ alignSelf: 'start', fontSize: 'var(--font-size-xs)' }}
          >
            + Add condition
          </Button>
        ) : (
          <Column gap="1">
            <Text variant="muted" size="xs">
              Only take this path when:
            </Text>
            <Input
              value={edge.when ?? ''}
              onChange={(e) => {
                onChange({ ...edge, when: e.target.value || undefined });
              }}
              placeholder="e.g. output.approved === true"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
            />
          </Column>
        )}
      </Column>
    </div>
  );
}
