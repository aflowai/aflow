'use client';

import { useCallback, useMemo, useState } from 'react';
import { Column, Row, Text, Divider, Icon, Checkbox, Tooltip } from '@aflow/design-system';
import type { BindingsEditorProps } from './types.js';
import type { SchemaProperty } from './types.js';
import {
  isVariableRef,
  extractConfigRef,
  parseExprToTypedValue,
  toFixedExpr,
  extractFields,
  getRequiredFields,
  fieldTooltip,
  applyDynamicEnums,
} from './helpers.js';
import { AgentToolBanner } from './AgentToolBanner.js';
import { InputBindingRow } from './InputBindingRow.js';
import { OutputBindingRow } from './OutputBindingRow.js';

export function BindingsEditor({
  step,
  variables,
  operationInputSchema,
  operationOutputSchema,
  internalFields,
  onUpdateStep,
  isAgentTool,
  parentAgentName,
  catalogOperations,
}: BindingsEditorProps) {
  const hiddenInputs = new Set(internalFields?.input ?? []);
  const hiddenOutputs = new Set(internalFields?.output ?? []);
  const rawInputFields = extractFields(operationInputSchema).filter(
    ([field]) => !hiddenInputs.has(field),
  );
  const outputFields = extractFields(operationOutputSchema).filter(
    ([field]) => !hiddenOutputs.has(field),
  );
  const requiredInputs = new Set(getRequiredFields(operationInputSchema));

  // Derive dynamic enum hints from the catalog for specific operations
  const inputFields = useMemo(() => {
    if (!catalogOperations?.length) return rawInputFields;
    return rawInputFields.map(
      ([field, prop]) =>
        [field, applyDynamicEnums(step.operation, field, prop, catalogOperations)] as [
          string,
          SchemaProperty,
        ],
    );
  }, [rawInputFields, step.operation, catalogOperations]);

  const handleInputChange = useCallback(
    (field: string, value: unknown) => {
      if (value === '' || value === null || value === undefined) {
        const { [field]: _c, ...restConfig } = step.config ?? {};
        onUpdateStep({ config: restConfig });
        return;
      }

      if (typeof value !== 'string') {
        onUpdateStep({
          config: { ...step.config, [field]: value },
        });
        return;
      }

      if (isVariableRef(value)) {
        onUpdateStep({
          config: { ...step.config, [field]: `\${${value}}` },
        });
        return;
      }

      if (value.includes('${')) {
        onUpdateStep({
          config: { ...step.config, [field]: value },
        });
        return;
      }

      const typedValue = parseExprToTypedValue(value);
      onUpdateStep({
        config: { ...step.config, [field]: typedValue },
      });
    },
    [step.config, onUpdateStep],
  );

  const handleOutputChange = useCallback(
    (field: string, value: string) => {
      onUpdateStep({
        outputMapping: { ...step.outputMapping, [field]: value },
      });
    },
    [step.outputMapping, onUpdateStep],
  );

  const handleDisplayToUserChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const checked = e.target.checked;
      onUpdateStep({
        outputOptions: {
          ...step.outputOptions,
          displayToUser: checked || undefined,
        },
      });
    },
    [step.outputOptions, onUpdateStep],
  );

  const hasAnyInputs = inputFields.length > 0;
  const hasAnyOutputs = outputFields.length > 0;
  const hasNoSchema = !hasAnyInputs && !hasAnyOutputs;

  const configuredInputs = inputFields.filter(([field]) => {
    return step.config?.[field] != null;
  }).length;
  const configuredOutputs = outputFields.filter(([field]) =>
    Boolean(step.outputMapping?.[field]),
  ).length;

  // For ai.agent.turn: split fields into primary (shown) and advanced (collapsed)
  const isAgentTurnOp = step.operation === 'ai.agent.turn';
  const AGENT_TURN_PRIMARY = new Set([
    'model',
    'agentRole',
    'systemPrompt',
    'prompt',
    'context',
    'catalog',
  ]);
  const [primaryInputFields, advancedInputFields] = useMemo(() => {
    if (!isAgentTurnOp) return [inputFields, []] as const;
    const advanced: typeof inputFields = [];
    // Maintain desired order for primary fields
    const ordered: typeof inputFields = [];
    const fieldMap = new Map(inputFields);
    for (const key of AGENT_TURN_PRIMARY) {
      const prop = fieldMap.get(key);
      if (prop) ordered.push([key, prop]);
    }
    for (const [field, prop] of inputFields) {
      if (AGENT_TURN_PRIMARY.has(field)) {
        // Already added in order above
      } else {
        advanced.push([field, prop]);
      }
    }
    return [ordered, advanced] as const;
  }, [inputFields, isAgentTurnOp]);

  const [showAdvancedInputs, setShowAdvancedInputs] = useState(false);
  const advancedConfiguredCount = advancedInputFields.filter(
    ([field]) => step.config?.[field] != null,
  ).length;

  const renderInputRow = ([field, prop]: [string, SchemaProperty]) => {
    const configVal = step.config?.[field];
    const fieldType = prop.type ?? 'string';
    const ref = extractConfigRef(configVal);

    let effectiveValue: string;
    if (ref) {
      effectiveValue = ref;
    } else if (configVal != null) {
      effectiveValue = toFixedExpr(
        typeof configVal === 'object' && configVal !== null
          ? JSON.stringify(configVal)
          : String((configVal ?? '') as string | number | boolean),
        fieldType,
      );
    } else {
      effectiveValue =
        prop.default != null
          ? toFixedExpr(
              typeof prop.default === 'object'
                ? JSON.stringify(prop.default)
                : String(prop.default as string | number | boolean),
              fieldType,
            )
          : '';
    }
    return (
      <InputBindingRow
        key={field}
        field={field}
        required={requiredInputs.has(field)}
        schemaProp={prop}
        value={effectiveValue}
        rawConfigValue={configVal}
        fromConfig={!ref && configVal != null}
        variables={variables}
        onChange={(val) => {
          handleInputChange(field, val);
        }}
        isAgentTool={isAgentTool}
        parentAgentName={parentAgentName}
        operationId={step.operation}
        catalogOperations={catalogOperations}
      />
    );
  };

  return (
    <Column gap="4">
      {isAgentTool && hasAnyInputs && (
        <AgentToolBanner
          step={step}
          inputFields={inputFields}
          requiredInputs={requiredInputs}
          parentAgentName={parentAgentName}
          onUpdateStep={onUpdateStep}
        />
      )}

      <Column gap="2">
        <Row gap="2" align="center" justify="between">
          <Row gap="2" align="center">
            <Icon name="caret-right" size="sm" style={{ color: 'var(--color-info-default)' }} />
            <Text size="sm" style={{ fontWeight: 600 }}>
              This step reads
            </Text>
          </Row>
          {hasAnyInputs && (
            <Text variant="muted" style={{ fontSize: '10px' }}>
              {configuredInputs} / {inputFields.length} set
            </Text>
          )}
        </Row>

        {!hasAnyInputs ? (
          <div
            style={{
              padding: 'var(--space-2)',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Text variant="muted" size="xs">
              {hasNoSchema
                ? 'No schema available for this operation yet.'
                : 'This operation has no input parameters.'}
            </Text>
          </div>
        ) : (
          <Column gap="2">
            {primaryInputFields.map(renderInputRow)}

            {advancedInputFields.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdvancedInputs((v) => !v);
                  }}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-1)',
                    color: 'var(--color-text-muted)',
                    fontSize: 'var(--font-size-xs)',
                    padding: 'var(--space-1) 0',
                  }}
                >
                  <Icon name={showAdvancedInputs ? 'caret-down' : 'caret-right'} size="xs" />
                  Advanced ({String(advancedInputFields.length)} fields
                  {advancedConfiguredCount > 0
                    ? `, ${String(advancedConfiguredCount)} configured`
                    : ''}
                  )
                </button>
                {showAdvancedInputs && (
                  <Column gap="2">{advancedInputFields.map(renderInputRow)}</Column>
                )}
              </>
            )}
          </Column>
        )}
      </Column>

      <Divider />

      <Column gap="2">
        <Row gap="2" align="center" justify="between">
          <Row gap="2" align="center">
            <Icon name="caret-down" size="sm" style={{ color: 'var(--color-success-default)' }} />
            <Text size="sm" style={{ fontWeight: 600 }}>
              This step writes
            </Text>
          </Row>
          {hasAnyOutputs && (
            <Text variant="muted" style={{ fontSize: '10px' }}>
              {configuredOutputs} / {outputFields.length} set
            </Text>
          )}
        </Row>

        {isAgentTool && (
          <div
            style={{
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: step.outputOptions?.displayToUser
                ? 'var(--color-info-subtle)'
                : 'var(--color-surface-1)',
              border: step.outputOptions?.displayToUser
                ? '1px solid var(--color-info-default)'
                : '1px solid var(--color-border-subtle)',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <Row gap="2" align="center">
              <Checkbox
                checked={step.outputOptions?.displayToUser ?? false}
                onChange={handleDisplayToUserChange}
                size="sm"
              >
                <Text size="xs" style={{ fontWeight: 500 }}>
                  Show output to user
                </Text>
              </Checkbox>
              <Tooltip
                content="When enabled, this step's output is shown to the user in the chat as an interim result. When disabled, the output is only consumed by the agent for further processing."
                side="top"
              >
                <Icon
                  name="info"
                  size="xs"
                  style={{ color: 'var(--color-text-muted)', cursor: 'help', flexShrink: 0 }}
                />
              </Tooltip>
            </Row>
          </div>
        )}

        {!hasAnyOutputs ? (
          <div
            style={{
              padding: 'var(--space-2)',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Text variant="muted" size="xs">
              {hasNoSchema
                ? 'No schema available. The step output will be passed to the next step automatically.'
                : 'This operation has no declared outputs.'}
            </Text>
          </div>
        ) : (
          <Column gap="2">
            <Text variant="muted" size="xs">
              Choose which variable to store each output in. Other steps can then read from those
              variables.
            </Text>
            {outputFields.map(([field, prop]) => (
              <OutputBindingRow
                key={field}
                field={field}
                description={fieldTooltip(prop)}
                fieldType={prop.type}
                value={step.outputMapping?.[field] ?? ''}
                variables={variables}
                onChange={(val) => {
                  handleOutputChange(field, val);
                }}
              />
            ))}
          </Column>
        )}
      </Column>
    </Column>
  );
}
