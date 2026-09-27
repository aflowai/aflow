'use client';

import { useState, useMemo } from 'react';
import {
  Column,
  Row,
  Spacer,
  ScrollArea,
  Panel,
  Text,
  Heading,
  Badge,
  Icon,
  Tooltip,
  Divider,
  SearchField,
  Pressable,
  Table,
  Th,
  Td,
  Tr,
  EmptyState,
  type BadgeVariant,
} from '@aflow/design-system';

// ---------------------------------------------------------------------------
// Types — match the API response shapes
// ---------------------------------------------------------------------------

export interface StepType {
  type: string;
  displayName: string;
  description: string;
  category: string;
  operations: string[];
}

export interface JsonSchemaProperty {
  type?: string | string[] | undefined;
  description?: string | undefined;
  enum?: unknown[] | undefined;
  default?: unknown;
  items?: JsonSchemaProperty | undefined;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[] | undefined;
  anyOf?: JsonSchemaProperty[] | undefined;
  oneOf?: JsonSchemaProperty[] | undefined;
  format?: string | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  const?: unknown;
  $ref?: string;
}

export interface Operation {
  operationId: string;
  stepType: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchemaProperty;
  outputSchema?: JsonSchemaProperty | undefined;
  internalFields?: {
    input?: string[] | undefined;
    output?: string[] | undefined;
  };
  agentTool?: boolean | undefined;
}

export interface OperationTreeProps {
  stepTypes: StepType[];
  operations: Operation[];
}

// ---------------------------------------------------------------------------
// Category color mapping
// ---------------------------------------------------------------------------

const categoryColors: Record<string, BadgeVariant> = {
  ai: 'info',
  control: 'neutral',
  integration: 'succeeded',
  data: 'paused',
  user: 'running',
};

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

const toSafeStr = (v: unknown) =>
  typeof v === 'object' && v !== null
    ? JSON.stringify(v)
    : String((v ?? '') as string | number | boolean);

function resolveSchemaType(schema: JsonSchemaProperty): string {
  if (schema.const !== undefined) return `"${toSafeStr(schema.const)}"`;
  if (schema.enum) return schema.enum.map((v) => `"${toSafeStr(v)}"`).join(' | ');
  if (schema.anyOf) {
    const types = schema.anyOf.map(resolveSchemaType).filter((t) => t !== 'null');
    const hasNull = schema.anyOf.some((s) => s.type === 'null');
    const base = types.join(' | ');
    return hasNull ? `${base} | null` : base;
  }
  if (schema.oneOf) return schema.oneOf.map(resolveSchemaType).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (schema.type === 'array' && schema.items) return `${resolveSchemaType(schema.items)}[]`;
  return schema.type ?? 'unknown';
}

function getConstraints(schema: JsonSchemaProperty): string[] {
  const c: string[] = [];
  if (schema.minimum !== undefined) c.push(`min: ${String(schema.minimum)}`);
  if (schema.maximum !== undefined) c.push(`max: ${String(schema.maximum)}`);
  if (schema.minLength !== undefined) c.push(`minLen: ${String(schema.minLength)}`);
  if (schema.maxLength !== undefined) c.push(`maxLen: ${String(schema.maxLength)}`);
  if (schema.minItems !== undefined) c.push(`minItems: ${String(schema.minItems)}`);
  if (schema.maxItems !== undefined) c.push(`maxItems: ${String(schema.maxItems)}`);
  if (schema.format) c.push(schema.format);
  if (schema.default !== undefined) c.push(`default: ${JSON.stringify(schema.default)}`);
  return c;
}

function hasNestedProperties(schema: JsonSchemaProperty): boolean {
  if (schema.properties && Object.keys(schema.properties).length > 0) return true;
  if (schema.type === 'array' && schema.items?.properties) return true;
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants?.some((v) => v.properties && Object.keys(v.properties).length > 0)) return true;
  return false;
}

function getObjectVariants(schema: JsonSchemaProperty): JsonSchemaProperty[] {
  if (schema.properties) return [schema];
  if (schema.type === 'array' && schema.items?.properties) return [schema.items];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return variants.filter((v) => v.properties && Object.keys(v.properties).length > 0);
  return [];
}

function getVariantLabel(variant: JsonSchemaProperty): string | null {
  if (!variant.properties) return null;
  for (const [key, prop] of Object.entries(variant.properties)) {
    if (prop.const !== undefined) return `${key}="${toSafeStr(prop.const)}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema rendering sub-components
// ---------------------------------------------------------------------------

function TypeBadge({ schema, hasNested }: { schema: JsonSchemaProperty; hasNested?: boolean }) {
  const typeStr = resolveSchemaType(schema);
  const isComplex = typeStr === 'object' || typeStr.endsWith('[]');
  return (
    <Row gap="sm" align="center">
      <Text
        variant="mono"
        size="xs"
        style={{
          color: isComplex ? 'var(--color-info-default)' : 'var(--color-content-secondary)',
        }}
      >
        {typeStr}
      </Text>
      {hasNested && (
        <Text variant="muted" size="xs">
          {'{...}'}
        </Text>
      )}
    </Row>
  );
}

const NEST_COLORS = [
  'var(--color-border-subtle)',
  'var(--color-info-default)',
  'var(--color-warning-default)',
] as const;

function SchemaTable({
  entries,
  required,
  internal,
  depth,
}: {
  entries: Array<[string, JsonSchemaProperty]>;
  required: Set<string>;
  internal: Set<string>;
  depth: number;
}) {
  return (
    <Table>
      <thead>
        <Tr>
          <Th>Field</Th>
          <Th>Type</Th>
          <Th>Req</Th>
          <Th style={{ minWidth: 100 }}>Description</Th>
        </Tr>
      </thead>
      <tbody>
        {entries.map(([name, prop]) => (
          <PropertyRow
            key={name}
            name={name}
            prop={prop}
            isRequired={required.has(name)}
            isInternal={internal.has(name)}
            depth={depth}
          />
        ))}
      </tbody>
    </Table>
  );
}

function PropertyRow({
  name,
  prop,
  isRequired,
  isInternal,
  depth,
}: {
  name: string;
  prop: JsonSchemaProperty;
  isRequired: boolean;
  isInternal: boolean;
  depth: number;
}) {
  const [nestedOpen, setNestedOpen] = useState(false);
  const nested = hasNestedProperties(prop);
  const constraints = getConstraints(prop);

  return (
    <>
      <Tr muted={isInternal}>
        <Td>
          <Row gap="sm" align="center">
            {nested && (
              <Pressable
                onClick={() => {
                  setNestedOpen((v) => !v);
                }}
                style={{ width: 'auto' }}
              >
                <Icon
                  name={nestedOpen ? 'caret-down' : 'caret-right'}
                  size={10}
                  color="var(--color-content-secondary)"
                />
              </Pressable>
            )}
            <Text variant="mono" size="xs">
              {name}
            </Text>
            {isInternal && (
              <Tooltip content="Orchestrator-managed field">
                <Icon name="gear" size={10} />
              </Tooltip>
            )}
          </Row>
        </Td>
        <Td>
          <TypeBadge schema={prop} hasNested={nested} />
        </Td>
        <Td>
          {isRequired ? (
            <Text variant="label" size="xs" weight="semibold" color="secondary">
              Yes
            </Text>
          ) : (
            <Text variant="muted" size="xs">
              No
            </Text>
          )}
        </Td>
        <Td>
          <Column gap="sm">
            {prop.description && (
              <Text variant="muted" size="xs">
                {prop.description}
              </Text>
            )}
            {constraints.length > 0 && (
              <Row gap="sm" wrap>
                {constraints.map((c) => (
                  <Badge key={c} variant="neutral">
                    <Text size="xs">{c}</Text>
                  </Badge>
                ))}
              </Row>
            )}
          </Column>
        </Td>
      </Tr>
      {nested && nestedOpen && (
        <tr>
          <Td colSpan={4} style={{ paddingLeft: 'var(--space-lg)' }}>
            <NestedSchemaBlock schema={prop} depth={depth} />
          </Td>
        </tr>
      )}
    </>
  );
}

function NestedSchemaBlock({ schema, depth }: { schema: JsonSchemaProperty; depth: number }) {
  const variants = getObjectVariants(schema);
  if (variants.length === 0) return null;
  const isUnion = variants.length > 1;

  return (
    <Column gap="md">
      {variants.map((variant, idx) => {
        const label = getVariantLabel(variant);
        const properties = variant.properties;
        if (!properties) return null;
        const required = new Set(variant.required ?? []);
        const entries = Object.entries(properties);
        const nestColor = NEST_COLORS[Math.min(depth, NEST_COLORS.length - 1)];

        return (
          <Column
            key={label ?? idx}
            gap="sm"
            padding="lg"
            style={{ borderLeft: `2px solid ${nestColor}`, marginLeft: 'var(--space-sm)' }}
          >
            {isUnion && label && (
              <Row gap="sm">
                <Badge variant="info">
                  <Text variant="mono" size="xs">
                    {label}
                  </Text>
                </Badge>
              </Row>
            )}
            <SchemaTable
              entries={entries}
              required={required}
              internal={new Set()}
              depth={depth + 1}
            />
          </Column>
        );
      })}
    </Column>
  );
}

function SchemaPropertyTable({
  schema,
  internalFields,
}: {
  schema: JsonSchemaProperty;
  internalFields?: string[] | undefined;
}) {
  const properties = schema.properties;
  if (!properties) {
    return (
      <Text variant="muted" size="xs">
        No properties
      </Text>
    );
  }
  const required = new Set(schema.required ?? []);
  const internal = new Set(internalFields ?? []);
  const entries = Object.entries(properties);

  return (
    <ScrollArea direction="horizontal">
      <SchemaTable entries={entries} required={required} internal={internal} depth={0} />
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// OperationTree component
// ---------------------------------------------------------------------------

export function OperationTree({ stepTypes, operations }: OperationTreeProps) {
  const [search, setSearch] = useState('');
  const [expandedStepTypes, setExpandedStepTypes] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());

  // Index operations by stepType
  const opsByStepType = useMemo(() => {
    const map = new Map<string, Operation[]>();
    for (const op of operations) {
      const list = map.get(op.stepType) ?? [];
      list.push(op);
      map.set(op.stepType, list);
    }
    return map;
  }, [operations]);

  // Filter operations by search
  const lowerSearch = search.toLowerCase().trim();
  const matchingOps = useMemo(() => {
    if (!lowerSearch) return new Set<string>();
    const matched = new Set<string>();
    for (const op of operations) {
      if (
        op.operationId.toLowerCase().includes(lowerSearch) ||
        op.displayName.toLowerCase().includes(lowerSearch) ||
        op.description.toLowerCase().includes(lowerSearch)
      ) {
        matched.add(op.operationId);
      }
    }
    return matched;
  }, [operations, lowerSearch]);

  const isSearching = lowerSearch.length > 0;

  // Build visible step types (sorted alphabetically)
  const visibleStepTypes = useMemo(() => {
    const sorted = [...stepTypes].sort((a, b) => a.type.localeCompare(b.type));
    if (!isSearching) return sorted;
    return sorted.filter((st) => {
      const ops = opsByStepType.get(st.type) ?? [];
      return ops.some((op) => matchingOps.has(op.operationId));
    });
  }, [stepTypes, isSearching, opsByStepType, matchingOps]);

  // Count visible operations
  const visibleOpCount = isSearching ? matchingOps.size : operations.length;

  const toggleStepType = (type: string) => {
    setExpandedStepTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleOp = (opId: string) => {
    setExpandedOps((prev) => {
      const next = new Set(prev);
      if (next.has(opId)) next.delete(opId);
      else next.add(opId);
      return next;
    });
  };

  return (
    <Column gap="md">
      <SearchField
        value={search}
        onValueChange={setSearch}
        placeholder="Search operations by ID, name, or description..."
      />
      <Text variant="muted" size="xs">
        {visibleOpCount} operation{visibleOpCount !== 1 ? 's' : ''} in {visibleStepTypes.length}{' '}
        step type{visibleStepTypes.length !== 1 ? 's' : ''}
      </Text>

      {visibleStepTypes.length === 0 && isSearching && (
        <EmptyState
          title="No matching operations"
          description={`No operations match "${search}".`}
        />
      )}

      <Column gap="sm">
        {visibleStepTypes.map((st) => (
          <StepTypeNode
            key={st.type}
            stepType={st}
            operations={opsByStepType.get(st.type) ?? []}
            isExpanded={isSearching || expandedStepTypes.has(st.type)}
            onToggle={() => {
              toggleStepType(st.type);
            }}
            expandedGroups={expandedGroups}
            onToggleGroup={toggleGroup}
            expandedOps={expandedOps}
            onToggleOp={toggleOp}
            matchingOps={matchingOps}
            isSearching={isSearching}
          />
        ))}
      </Column>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// StepTypeNode
// ---------------------------------------------------------------------------

function StepTypeNode({
  stepType,
  operations: allOps,
  isExpanded,
  onToggle,
  expandedGroups,
  onToggleGroup,
  expandedOps,
  onToggleOp,
  matchingOps,
  isSearching,
}: {
  stepType: StepType;
  operations: Operation[];
  isExpanded: boolean;
  onToggle: () => void;
  expandedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  expandedOps: Set<string>;
  onToggleOp: (opId: string) => void;
  matchingOps: Set<string>;
  isSearching: boolean;
}) {
  const visibleOps = isSearching ? allOps.filter((op) => matchingOps.has(op.operationId)) : allOps;
  const colorVariant = categoryColors[stepType.category] ?? 'neutral';

  // Group operations by their group segment
  const groups = useMemo(() => {
    const map = new Map<string, Operation[]>();
    for (const op of visibleOps) {
      const parts = op.operationId.split('.');
      const group = parts.length >= 3 ? parts[1] : '_default';
      const key = group ?? '';
      const list = map.get(key) ?? [];
      list.push(op);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleOps]);

  return (
    <Column gap="xs">
      <Pressable
        onClick={onToggle}
        style={{ gap: 'var(--space-sm)', padding: 'var(--space-sm) 0' }}
      >
        <Icon
          name={isExpanded ? 'caret-down' : 'caret-right'}
          size={12}
          color="var(--color-content-secondary)"
        />
        <Heading level={4} size="sm">
          {stepType.displayName}
        </Heading>
        <Spacer />
        <Badge variant={colorVariant}>{stepType.category}</Badge>
        <Badge variant="neutral">{visibleOps.length}</Badge>
      </Pressable>
      <Text variant="muted" size="xs" style={{ paddingLeft: 'var(--space-xl)' }}>
        {stepType.description}
      </Text>

      {isExpanded && (
        <Column gap="xs" style={{ paddingLeft: 'var(--space-xl)' }}>
          {groups.map(([group, ops]) => {
            const groupKey = `${stepType.type}.${group}`;
            const groupExpanded = isSearching || expandedGroups.has(groupKey);

            return (
              <GroupNode
                key={groupKey}
                groupName={group}
                operations={ops}
                isExpanded={groupExpanded}
                onToggle={() => {
                  onToggleGroup(groupKey);
                }}
                expandedOps={expandedOps}
                onToggleOp={onToggleOp}
              />
            );
          })}
        </Column>
      )}
    </Column>
  );
}

// ---------------------------------------------------------------------------
// GroupNode
// ---------------------------------------------------------------------------

function GroupNode({
  groupName,
  operations: ops,
  isExpanded,
  onToggle,
  expandedOps,
  onToggleOp,
}: {
  groupName: string;
  operations: Operation[];
  isExpanded: boolean;
  onToggle: () => void;
  expandedOps: Set<string>;
  onToggleOp: (opId: string) => void;
}) {
  return (
    <Column gap="xs">
      <Pressable
        onClick={onToggle}
        style={{ gap: 'var(--space-sm)', padding: 'var(--space-xs) 0' }}
      >
        <Icon
          name={isExpanded ? 'caret-down' : 'caret-right'}
          size={10}
          color="var(--color-content-secondary)"
        />
        <Text variant="mono" size="sm">
          {groupName === '_default' ? '(ungrouped)' : groupName}
        </Text>
        <Badge variant="neutral">{ops.length}</Badge>
      </Pressable>

      {isExpanded && (
        <Column gap="sm" style={{ paddingLeft: 'var(--space-lg)' }}>
          {ops.map((op) => (
            <OperationNode
              key={op.operationId}
              operation={op}
              isExpanded={expandedOps.has(op.operationId)}
              onToggle={() => {
                onToggleOp(op.operationId);
              }}
            />
          ))}
        </Column>
      )}
    </Column>
  );
}

// ---------------------------------------------------------------------------
// OperationNode
// ---------------------------------------------------------------------------

function OperationNode({
  operation: op,
  isExpanded,
  onToggle,
}: {
  operation: Operation;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Panel variant="outline" padding="sm">
      <Pressable onClick={onToggle} style={{ gap: 'var(--space-sm)' }}>
        <Icon
          name={isExpanded ? 'caret-down' : 'caret-right'}
          size={10}
          color="var(--color-content-secondary)"
        />
        <Text variant="mono" size="xs">
          {op.operationId}
        </Text>
        {op.agentTool === false && (
          <Tooltip content="Internal operation (not exposed as agent tool)">
            <Icon name="gear" size={12} color="var(--color-content-muted)" />
          </Tooltip>
        )}
        <Spacer />
        <Text variant="muted" size="xs" truncate>
          {op.displayName}
        </Text>
      </Pressable>

      {isExpanded && (
        <Column gap="md" style={{ paddingTop: 'var(--space-md)' }}>
          {op.description && (
            <Text variant="muted" size="sm">
              {op.description}
            </Text>
          )}

          <Divider />

          <Column gap="sm">
            <Text variant="label" size="xs" weight="semibold">
              Input Schema
            </Text>
            <SchemaPropertyTable
              schema={op.inputSchema}
              internalFields={op.internalFields?.input}
            />
          </Column>

          {op.outputSchema && (
            <>
              <Divider />
              <Column gap="sm">
                <Text variant="label" size="xs" weight="semibold">
                  Output Schema
                </Text>
                <SchemaPropertyTable
                  schema={op.outputSchema}
                  internalFields={op.internalFields?.output}
                />
              </Column>
            </>
          )}

          {op.internalFields &&
            ((op.internalFields.input?.length ?? 0) > 0 ||
              (op.internalFields.output?.length ?? 0) > 0) && (
              <Text variant="muted" size="xs" style={{ fontStyle: 'italic' }}>
                Dimmed fields are managed by the orchestrator and not set by agents.
              </Text>
            )}
        </Column>
      )}
    </Panel>
  );
}
