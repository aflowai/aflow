'use client';

import { useState } from 'react';
import { Column, Row, Text, Select, Input, Badge, Tooltip, Icon } from '@aflow/design-system';
import type { StateVariable } from '../../../lib/flow-to-graph.js';
import type { SchemaProperty } from './types.js';
import {
  isVariableRef,
  varRefLabel,
  getEnumValues,
  allowsCustom,
  parseFixedValue,
  toFixedExpr,
  fieldTooltip,
  humanizeField,
} from './helpers.js';
import { ObjectValueEditor } from './ObjectValueEditor.js';
import { ArrayValueEditor } from './ArrayValueEditor.js';
import { CatalogToolSelector } from './CatalogToolSelector.js';
import type { CatalogOperation } from '../../../hooks/use-operation-catalog.js';

interface InputBindingRowProps {
  field: string;
  required: boolean;
  schemaProp: SchemaProperty;
  value: string;
  rawConfigValue?: unknown;
  fromConfig?: boolean | undefined;
  variables: StateVariable[];
  onChange: (value: unknown) => void;
  isAgentTool?: boolean | undefined;
  parentAgentName?: string | undefined;
  /** Operation ID of the parent step (for specialized editors) */
  operationId?: string | undefined;
  /** Catalog operations (for specialized editors like CatalogToolSelector) */
  catalogOperations?: CatalogOperation[] | undefined;
}

export function InputBindingRow({
  field,
  required,
  schemaProp,
  value,
  rawConfigValue,
  fromConfig: _fromConfig,
  variables,
  onChange,
  isAgentTool,
  parentAgentName,
  operationId,
  catalogOperations,
}: InputBindingRowProps) {
  const fieldType = schemaProp.type ?? 'string';
  const enumValues = getEnumValues(schemaProp);
  const hasCustomOption = allowsCustom(schemaProp);
  const parsedVal = parseFixedValue(value);

  const isLinked = isVariableRef(value);
  const isAgentProvided = isAgentTool && value === `input.${field}`;

  const [showVarPicker, setShowVarPicker] = useState(false);
  const [showCustomEnum, setShowCustomEnum] = useState(
    () =>
      enumValues != null &&
      parsedVal.raw !== '' &&
      !enumValues.includes(parsedVal.raw) &&
      !isLinked,
  );

  const isSet = Boolean(value);
  const hasDefault = schemaProp.default != null;
  const displayDefault = hasDefault ? String(schemaProp.default) : null;
  const hasVars = variables.length > 0;

  const inputVarOptions = variables.filter((v) => v.lifecycle.isInput);
  const allVarOptions = variables;

  const handleLinkClick = () => {
    if (isLinked) {
      onChange('');
      setShowVarPicker(false);
    } else {
      setShowVarPicker(true);
    }
  };

  const handleVarSelect = (varExpr: string) => {
    onChange(varExpr);
    setShowVarPicker(false);
  };

  const renderLinkButton = () => (
    <Tooltip content="Use a variable" side="top">
      <button
        onClick={handleLinkClick}
        style={{
          background: 'none',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          color: 'var(--color-text-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4px',
          flexShrink: 0,
          transition: 'color 0.15s, border-color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--color-info-default)';
          e.currentTarget.style.borderColor = 'var(--color-info-default)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--color-text-muted)';
          e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
        }}
      >
        <Icon name="link" size="xs" weight="bold" />
      </button>
    </Tooltip>
  );

  const renderAgentButton = () => {
    if (!isAgentTool) return null;
    return (
      <Tooltip content={`Let ${parentAgentName ?? 'the agent'} provide this value`} side="top">
        <button
          onClick={() => {
            onChange(`input.${field}`);
          }}
          style={{
            background: 'none',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            color: 'var(--color-text-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4px',
            flexShrink: 0,
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--color-warning-default)';
            e.currentTarget.style.borderColor = 'var(--color-warning-default)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--color-text-muted)';
            e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
          }}
        >
          <Icon name="robot" size="xs" weight="bold" />
        </button>
      </Tooltip>
    );
  };

  const renderValueInput = () => {
    if (isAgentProvided && !showVarPicker) {
      return (
        <Row gap="2" align="center">
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '2px 8px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-warning-muted)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 500,
              color: 'var(--color-warning-default)',
            }}
          >
            <Icon name="robot" size="xs" weight="bold" />
            Agent provides
          </span>
          <Tooltip content="Switch to fixed value" side="top">
            <button
              onClick={() => {
                onChange('');
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-muted)',
                display: 'flex',
                padding: 2,
              }}
            >
              <Icon name="x" size="xs" />
            </button>
          </Tooltip>
        </Row>
      );
    }

    if (isLinked && !showVarPicker) {
      const label = varRefLabel(value, variables);
      const prefix = value.startsWith('input.') ? 'input' : 'var';
      return (
        <Row gap="2" align="center">
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '2px 8px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-info-muted)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 500,
              color: 'var(--color-info-default)',
            }}
          >
            <Icon name="link" size="xs" weight="bold" />
            {prefix}: {label}
          </span>
          <Tooltip content="Unlink variable" side="top">
            <button
              onClick={handleLinkClick}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-muted)',
                display: 'flex',
                padding: 2,
              }}
            >
              <Icon name="x" size="xs" />
            </button>
          </Tooltip>
        </Row>
      );
    }

    if (showVarPicker) {
      return (
        <Row gap="2" align="center">
          <Select
            value=""
            onChange={(e) => {
              if (e.target.value) handleVarSelect(e.target.value);
            }}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
            autoFocus
          >
            <option value="">— pick a variable —</option>
            {inputVarOptions.length > 0 && (
              <optgroup label="Flow inputs">
                {inputVarOptions.map((v) => (
                  <option key={`in-${v.variableId}`} value={`input.${v.variableId}`}>
                    {v.name || v.variableId}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Variables">
              {allVarOptions.map((v) => (
                <option key={v.variableId} value={`state.${v.variableId}`}>
                  {v.name || v.variableId}
                </option>
              ))}
            </optgroup>
          </Select>
          <button
            onClick={() => {
              setShowVarPicker(false);
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-muted)',
              display: 'flex',
              padding: 2,
            }}
          >
            <Icon name="x" size="xs" />
          </button>
        </Row>
      );
    }

    if (enumValues && !showCustomEnum) {
      return (
        <Row gap="2" align="center">
          <Select
            value={parsedVal.raw}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__custom__') {
                setShowCustomEnum(true);
                onChange('""');
              } else {
                onChange(toFixedExpr(v, fieldType));
              }
            }}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          >
            <option value="">— choose —</option>
            {enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            {hasCustomOption && <option value="__custom__">Other…</option>}
          </Select>
          {hasVars && renderLinkButton()}
          {renderAgentButton()}
        </Row>
      );
    }

    if (enumValues && showCustomEnum) {
      return (
        <Row gap="2" align="center">
          <Input
            value={parsedVal.raw}
            onChange={(e) => {
              onChange(toFixedExpr(e.target.value, fieldType));
            }}
            placeholder="Custom value…"
            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          />
          <button
            onClick={() => {
              setShowCustomEnum(false);
              onChange(enumValues[0] ? toFixedExpr(enumValues[0], fieldType) : '""');
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-info-default)',
              cursor: 'pointer',
              fontSize: 'var(--font-size-xs)',
              whiteSpace: 'nowrap',
            }}
          >
            ← list
          </button>
          {hasVars && renderLinkButton()}
          {renderAgentButton()}
        </Row>
      );
    }

    if (fieldType === 'boolean') {
      return (
        <Row gap="2" align="center">
          <Select
            value={value || 'false'}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </Select>
          {hasVars && renderLinkButton()}
          {renderAgentButton()}
        </Row>
      );
    }

    if (fieldType === 'number' || fieldType === 'integer') {
      return (
        <Row gap="2" align="center">
          <Input
            type="number"
            value={parsedVal.raw}
            onChange={(e) => {
              onChange(e.target.value || '0');
            }}
            placeholder={displayDefault ? `Default: ${displayDefault}` : '0'}
            min={schemaProp.minimum}
            max={schemaProp.maximum}
            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          />
          {hasVars && renderLinkButton()}
          {renderAgentButton()}
        </Row>
      );
    }

    if (fieldType === 'object' && !isLinked && !showVarPicker) {
      let objValue: Record<string, unknown> = {};
      if (
        rawConfigValue !== null &&
        rawConfigValue !== undefined &&
        typeof rawConfigValue === 'object' &&
        !Array.isArray(rawConfigValue)
      ) {
        objValue = rawConfigValue as Record<string, unknown>;
      } else if (typeof rawConfigValue === 'string') {
        try {
          const parsed = JSON.parse(rawConfigValue) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            objValue = parsed as Record<string, unknown>;
          }
        } catch {
          /* not valid JSON */
        }
      }

      // Specialized editor: CatalogToolSelector for ai.agent.turn's catalog field
      if (
        field === 'catalog' &&
        operationId === 'ai.agent.turn' &&
        catalogOperations &&
        catalogOperations.length > 0
      ) {
        return (
          <CatalogToolSelector
            value={objValue}
            onChange={(obj) => {
              if (Object.keys(obj).length === 0) {
                onChange('');
              } else {
                onChange(obj);
              }
            }}
            operations={catalogOperations}
          />
        );
      }

      return (
        <Column gap="2">
          <ObjectValueEditor
            schemaProp={schemaProp}
            value={objValue}
            variables={variables}
            onChangeObject={(obj) => {
              if (Object.keys(obj).length === 0) {
                onChange('');
              } else {
                onChange(obj);
              }
            }}
          />
          {hasVars && renderLinkButton()}
          {renderAgentButton()}
        </Column>
      );
    }

    if (fieldType === 'array' && !isLinked && !showVarPicker) {
      let arrValue: unknown[] = [];
      if (Array.isArray(rawConfigValue)) {
        arrValue = rawConfigValue as unknown[];
      } else if (typeof rawConfigValue === 'string') {
        try {
          const parsed = JSON.parse(rawConfigValue) as unknown;
          if (Array.isArray(parsed)) {
            arrValue = parsed as unknown[];
          }
        } catch {
          /* not valid JSON */
        }
      }
      return (
        <Column gap="2">
          <ArrayValueEditor schemaProp={schemaProp} value={arrValue} onChange={onChange} />
          {hasVars && renderLinkButton()}
          {renderAgentButton()}
        </Column>
      );
    }

    return (
      <Row gap="2" align="center">
        <Input
          value={parsedVal.raw}
          onChange={(e) => {
            onChange(toFixedExpr(e.target.value, 'string'));
          }}
          placeholder={displayDefault ? `Default: ${displayDefault}` : 'Type a value…'}
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
        />
        {hasVars && renderLinkButton()}
        {renderAgentButton()}
      </Row>
    );
  };

  return (
    <div
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: isAgentProvided
          ? '1px solid var(--color-warning-subtle)'
          : isSet
            ? '1px solid var(--color-border-default)'
            : '1px solid var(--color-border-subtle)',
        background: isAgentProvided ? 'var(--color-warning-bg)' : 'var(--color-surface-raised)',
        opacity: isSet || isAgentProvided ? 1 : 0.85,
        transition: 'border-color 0.15s, background 0.15s, opacity 0.15s',
      }}
    >
      <Column gap="2">
        <Row justify="between" align="center">
          <Row gap="2" align="center">
            <Text size="sm" style={{ fontWeight: 700, color: 'var(--color-content-primary)' }}>
              {humanizeField(field)}
            </Text>
            {fieldType && (
              <Badge variant="neutral" style={{ fontSize: '9px' }}>
                {fieldType}
              </Badge>
            )}
            {required && (
              <span
                style={{ color: 'var(--color-danger-default)', fontSize: '10px', fontWeight: 600 }}
              >
                *
              </span>
            )}
            <Tooltip content={fieldTooltip(schemaProp)} side="top" delayMs={200}>
              <Icon
                name="info"
                size="xs"
                style={{ color: 'var(--color-content-muted)', cursor: 'help', flexShrink: 0 }}
              />
            </Tooltip>
          </Row>
          <Row gap="1" align="center">
            {isAgentProvided && (
              <Badge variant="paused" style={{ fontSize: '9px' }}>
                agent
              </Badge>
            )}
            {isSet && !isAgentProvided && (
              <Icon
                name="check-circle"
                size="sm"
                weight="fill"
                style={{ color: 'var(--color-success-default)' }}
              />
            )}
            {!isSet && required && (
              <Badge variant="paused" style={{ fontSize: '9px' }}>
                required
              </Badge>
            )}
            {!isSet && !required && hasDefault && (
              <Text variant="muted" style={{ fontSize: '9px' }}>
                default: {displayDefault}
              </Text>
            )}
          </Row>
        </Row>

        {renderValueInput()}
      </Column>
    </div>
  );
}
