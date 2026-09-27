'use client';

import { useMemo, useState } from 'react';
import { Badge, Column, Field, Input, Label, Row, Text, Tooltip } from '@aflow/design-system';

/**
 * Editor for a single list-of-tool-names rule on a server definition's
 * `toolFilter` (e.g. `include`, `exclude`, or `opTaskOnly`). Stores
 * text-input state internally so the operator can type half-finished
 * names; the parsed list is published on blur and on every comma.
 *
 * Available tools (from binding `cachedTools`) render as suggestion chips
 * below the input — clicking a chip appends/removes it from the list.
 * Custom names not in the cache stay verbatim and surface a "not in cache"
 * hint so the operator can spot typos.
 */
function ToolListField({
  label,
  description,
  value,
  onChange,
  availableTools,
  placeholder,
}: {
  label: string;
  description?: string;
  value: string[];
  onChange: (next: string[]) => void;
  availableTools: string[];
  placeholder?: string;
}) {
  const [text, setText] = useState(value.join(', '));

  const parse = (raw: string): string[] => {
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set(list));
  };

  const commit = (next: string[]) => {
    onChange(next);
    setText(next.join(', '));
  };

  const valueSet = useMemo(() => new Set(value), [value]);
  const availableSet = useMemo(() => new Set(availableTools), [availableTools]);

  const toggle = (tool: string) => {
    const next = valueSet.has(tool) ? value.filter((t) => t !== tool) : [...value, tool];
    commit(next);
  };

  const unmatched = useMemo(() => value.filter((v) => !availableSet.has(v)), [value, availableSet]);

  return (
    <Field>
      <Label>{label}</Label>
      {description && (
        <Text size="xs" color="muted">
          {description}
        </Text>
      )}
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={() => {
          commit(parse(text));
        }}
        placeholder={placeholder}
      />
      {availableTools.length > 0 && (
        <Row gap="1" wrap style={{ marginTop: 'var(--space-1)' }}>
          {availableTools.map((tool) => (
            <Tooltip key={tool} content={valueSet.has(tool) ? 'Click to remove' : 'Click to add'}>
              <Badge
                variant={valueSet.has(tool) ? 'info' : 'neutral'}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  toggle(tool);
                }}
              >
                {tool}
              </Badge>
            </Tooltip>
          ))}
        </Row>
      )}
      {unmatched.length > 0 && (
        <Text size="xs" tone="warning">
          Not in cached tools: {unmatched.join(', ')}. Run a Test on any connection to refresh the
          cache.
        </Text>
      )}
    </Field>
  );
}

// ============================================================================
// Definition-side: toolFilter.include / toolFilter.exclude / opTaskOnly
// ============================================================================

export interface ToolFilterState {
  include: string[];
  exclude: string[];
  opTaskOnly: string[];
}

export function toolFilterToState(
  filter: { include?: string[]; exclude?: string[]; opTaskOnly?: string[] } | null | undefined,
): ToolFilterState {
  return {
    include: filter?.include ?? [],
    exclude: filter?.exclude ?? [],
    opTaskOnly: filter?.opTaskOnly ?? [],
  };
}

export function stateToToolFilter(
  s: ToolFilterState,
): { include?: string[]; exclude?: string[]; opTaskOnly?: string[] } | undefined {
  const out: { include?: string[]; exclude?: string[]; opTaskOnly?: string[] } = {};
  if (s.include.length > 0) out.include = s.include;
  if (s.exclude.length > 0) out.exclude = s.exclude;
  if (s.opTaskOnly.length > 0) out.opTaskOnly = s.opTaskOnly;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function McpToolFilterFields({
  state,
  onChange,
  availableTools,
}: {
  state: ToolFilterState;
  onChange: (next: ToolFilterState) => void;
  availableTools: string[];
}) {
  return (
    <Column gap="3">
      <Text size="sm" weight="medium">
        Tool permissions
      </Text>
      <Text size="xs" color="secondary">
        Pick the tools the agent can use. Tools are opt-in: the agent sees nothing until you list at
        least one here. Applies to every connection that uses this server.
      </Text>
      <ToolListField
        label="Allow these tools"
        description="The agent sees only the tools listed here. Leaving this blank exposes nothing — the agent sees zero tools from this server (opt-in default)."
        value={state.include}
        onChange={(include) => {
          onChange({ ...state, include });
        }}
        availableTools={availableTools}
        placeholder="e.g. search_datasets, list_competitions"
      />
      <ToolListField
        label="Block these tools"
        description="Always hidden, even if listed above."
        value={state.exclude}
        onChange={(exclude) => {
          onChange({ ...state, exclude });
        }}
        availableTools={availableTools}
        placeholder="e.g. delete_dataset"
      />
      <ToolListField
        label="Operation-task only"
        description="Agents cannot call these tools directly — use explicit workflow operation tasks instead."
        value={state.opTaskOnly}
        onChange={(opTaskOnly) => {
          onChange({ ...state, opTaskOnly });
        }}
        availableTools={availableTools}
        placeholder="e.g. submit_competition, delete_kernel"
      />
    </Column>
  );
}
