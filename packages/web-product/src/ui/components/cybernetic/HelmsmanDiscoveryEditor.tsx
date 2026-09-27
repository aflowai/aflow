'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, Column, HelperText, Icon, Input, Row, Text } from '@aflow/design-system';
import { DirectiveCapabilityDiscoverySchema, type EntityDirectives } from '@aflow/schemas';

import { OperationSelectTree, useAgentOperations } from '../catalog/OperationSelectTree.js';
import { useSpaceOperationGrants } from '../../hooks/use-space-operation-grants.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';

/**
 * `undefined` and `[]` mean opposite things — the platform preset vs discovery
 * off — so the reset path has to remove the key, not write an empty value.
 */
export function withHelmsmanOperations(
  directives: EntityDirectives,
  next: string[] | undefined,
): EntityDirectives {
  const capabilityDiscovery = { ...directives.capabilityDiscovery };
  if (next === undefined) delete capabilityDiscovery.helmsmanOperations;
  else capabilityDiscovery.helmsmanOperations = next;
  return { ...directives, capabilityDiscovery };
}

export interface HelmsmanDiscoveryEditorProps {
  /** `undefined` = platform default; an array = the operator's explicit ceiling. */
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  spaceId: string;
}

/**
 * The operator's ceiling on what the Helmsman may discover during a session.
 * Leaving a custom list is an explicit reset action, never an emptied
 * selection — see `withHelmsmanOperations`.
 */
export function HelmsmanDiscoveryEditor({
  value,
  onChange,
  spaceId,
}: HelmsmanDiscoveryEditorProps) {
  const { operations, isLoading, error: catalogError } = useAgentOperations();
  // The set a custom list replaces. Entering custom mode seeds from it, so the
  // operator edits the default rather than rebuilding it from nothing.
  const presetQuery = useApiQuery<{ allowedOperationIds: string[] }>({
    key: ['catalog', 'agents', 'helmsman', 'discovery'],
    path: '/catalog/agents/helmsman/discovery',
    staleTime: 5 * 60_000,
  });
  const preset = presetQuery.data?.allowedOperationIds ?? [];
  const { blockedById } = useSpaceOperationGrants(spaceId);
  const [query, setQuery] = useState('');
  const [rejected, setRejected] = useState<string | null>(null);

  const isCustom = value !== undefined;
  const selected = useMemo(() => value ?? [], [value]);

  const catalogIds = useMemo(
    () => new Set<string>(operations.map((o) => o.operationId)),
    [operations],
  );
  // An unreadable catalog is indistinguishable from an empty one, and calling a
  // saved list "unknown" on that basis would invite the operator to delete a
  // correct list one chip at a time.
  const catalogUsable = !isLoading && !catalogError && catalogIds.size > 0;
  // Ids that no longer resolve (renamed op, typo from the raw-JSON tab). The
  // save path accepts any string, so these only fail once the agent tries.
  const unknown = useMemo(
    () => (catalogUsable ? selected.filter((id) => !catalogIds.has(id)) : []),
    [catalogUsable, selected, catalogIds],
  );
  const blockedSelected = useMemo(
    () => selected.filter((id) => blockedById.has(id)),
    [selected, blockedById],
  );

  // The array bounds live on the schema; parse the candidate rather than
  // restating them here, and surface the schema's own message on refusal.
  const commit = (next: string[]) => {
    const parsed = DirectiveCapabilityDiscoverySchema.safeParse({ helmsmanOperations: next });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? 'the directives schema refused the list';
      setRejected(`Not applied — ${issue}.`);
      return;
    }
    setRejected(null);
    onChange(next);
  };

  const toggle = (operationId: string) => {
    commit(
      selected.includes(operationId)
        ? selected.filter((id) => id !== operationId)
        : [...selected, operationId],
    );
  };

  return (
    <Column gap="sm">
      <Row gap="sm" align="center" wrap>
        {isCustom ? (
          <Badge variant={selected.length === 0 ? 'warning' : 'info'}>
            {selected.length === 0 ? 'Discovery off' : `Custom · ${selected.length} selected`}
          </Badge>
        ) : (
          <Badge variant="neutral">Platform default</Badge>
        )}
        {isCustom ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setRejected(null);
              onChange(undefined);
            }}
          >
            Reset to platform default
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={presetQuery.isLoading || preset.length === 0}
            onClick={() => {
              commit([...preset]);
            }}
          >
            {presetQuery.isLoading ? 'Loading default…' : `Customise (${preset.length} ops)`}
          </Button>
        )}
      </Row>

      <Text size="xs" variant="muted">
        {!isCustom
          ? 'No custom set — the platform’s curated discovery set applies. The Helmsman searches the catalog and adds tools from that set to its own toolbox as a session needs them.'
          : selected.length === 0
            ? 'Nothing selected. Saving this turns discovery off: the Helmsman keeps its pinned core tools and bound integrations, but can add no platform operation to its toolbox. Reset to platform default to restore it.'
            : catalogUsable
              ? `${selected.length} of ${operations.length} catalog operations. This list replaces the platform default — the two are not merged.`
              : `${selected.length} selected. This list replaces the platform default — the two are not merged.`}
      </Text>

      {isCustom && (
        <>
          <Input
            type="search"
            placeholder="Search operations…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />

          {rejected && <Notice tone="danger">{rejected}</Notice>}

          {blockedSelected.length > 0 && (
            <Notice tone="warning">
              {blockedSelected.length} selected operation{blockedSelected.length === 1 ? '' : 's'}{' '}
              {blockedSelected.length === 1 ? 'is' : 'are'} not enabled by this space’s capability
              profile and will be denied at run time.
            </Notice>
          )}

          {unknown.length > 0 && (
            <Column gap="xs">
              <Notice tone="warning">
                {unknown.length} selected id{unknown.length === 1 ? '' : 's'} not in the catalog —
                the agent can never resolve {unknown.length === 1 ? 'it' : 'them'}.
              </Notice>
              <Row gap="xs" wrap>
                {unknown.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-label={`Remove ${id}`}
                    onClick={() => {
                      commit(selected.filter((s) => s !== id));
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      display: 'inline-flex',
                    }}
                  >
                    <Badge variant="warning">{id} ×</Badge>
                  </button>
                ))}
              </Row>
            </Column>
          )}

          <div
            style={{
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-md)',
              maxHeight: 360,
              overflow: 'auto',
            }}
          >
            {isLoading ? (
              <div style={{ padding: 'var(--space-3)' }}>
                <Text size="xs" variant="muted">
                  Loading catalog…
                </Text>
              </div>
            ) : (
              <OperationSelectTree
                query={query}
                selected={selected}
                onToggle={toggle}
                blockedById={blockedById}
                variant="page"
              />
            )}
          </div>

          <HelperText>
            Applies to the Helmsman only. Its pinned core tools and this space’s bound integrations
            are separate and stay available either way.
          </HelperText>
        </>
      )}
    </Column>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'danger'; children: React.ReactNode }) {
  const color = tone === 'danger' ? 'var(--color-danger-default)' : 'var(--color-warning-default)';
  const background = tone === 'danger' ? 'var(--color-danger-bg)' : 'var(--color-warning-bg)';
  return (
    <Row
      gap="xs"
      align="center"
      style={{
        padding: '6px 8px',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${color}`,
        background,
      }}
    >
      <Icon name="warning" size="xs" color={color} />
      <Text size="xs" variant="muted">
        {children}
      </Text>
    </Row>
  );
}
