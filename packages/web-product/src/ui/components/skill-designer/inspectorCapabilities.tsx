'use client';

import { useState, type ReactNode } from 'react';
import { Badge, Icon, Input, Text, type IconName } from '@aflow/design-system';
import type { GrantBindingRef, WorkflowTask } from '@aflow/schemas';

import type { SkillDraftActions } from './useSkillDraft.js';
import { useSpaceOperationGrants } from '../../hooks/use-space-operation-grants.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import {
  OperationSelectTree,
  TreeHint,
  TreeLeaf,
  TreeSubGroup,
  treeRowStyle,
} from '../catalog/OperationSelectTree.js';
import { useIntegrations } from '../../hooks/use-integrations.js';

interface ToolGrant {
  toolName: string;
  schemaHash?: string | undefined;
  revision?: string | undefined;
}
interface IntegrationGrant {
  capabilityId: string;
  binding: GrantBindingRef;
  sourceKind: 'api' | 'mcp';
  integrationId: string;
  grantKind?: 'endpoint_tools' | 'direct_url' | undefined;
  toolNames?: ToolGrant[] | undefined;
  allTools?: boolean | undefined;
}

/**
 * One unified capability tree per task: native operations and integration
 * bindings are the two arms of `TaskCapabilityGrant`, so the operator grants
 * both from the same searchable tree — "what can this task do?".
 */
export function CapabilitiesEditor({
  task,
  actions,
  spaceId,
}: {
  task: WorkflowTask;
  actions: SkillDraftActions;
  spaceId: string;
}) {
  const { bindings, definitions } = useIntegrations(spaceId);
  const { blockedById } = useSpaceOperationGrants(spaceId);

  const caps = task.context?.capabilities;
  const ops = caps?.operations ?? [];
  const integrations = (caps?.integrations ?? []) as IntegrationGrant[];

  const setCaps = (nextOps: string[], nextInts: IntegrationGrant[]) => {
    actions.patchTask(task.taskId, {
      context: {
        ...(task.context ?? {}),
        capabilities: { operations: nextOps, integrations: nextInts },
      } as unknown as WorkflowTask['context'],
    });
  };

  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const searching = q.trim().length > 0;
  // Auto-expand branches while searching, but NOT binding subtrees — their
  // endpoints aren't part of the filter and each open one fires a lazy
  // definition fetch, so keep them collapsed until clicked.
  const isOpen = (id: string) => (searching && !id.startsWith('bind:')) || open.has(id);
  const toggleOpen = (id: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const ql = q.trim().toLowerCase();

  const grantedSet = new Set(ops);
  const grantedBlocked = ops.filter((id) => blockedById.has(id));
  const toggleOp = (id: string) => {
    setCaps(grantedSet.has(id) ? ops.filter((x) => x !== id) : [...ops, id], integrations);
  };

  const visibleBindings = bindings.filter(
    (b) =>
      b.enabled && (!ql || b.name.toLowerCase().includes(ql) || b.apiId.toLowerCase().includes(ql)),
  );
  const grantByBinding = new Map(
    integrations.flatMap((g) =>
      g.binding.kind === 'binding' ? ([[g.binding.bindingId, g]] as const) : [],
    ),
  );
  const endpointCountByApi = new Map(definitions.map((d) => [d.apiId, d.endpointCount]));
  const setGrant = (bindingId: string, grant: IntegrationGrant | null) => {
    const rest = integrations.filter(
      (g) => !(g.binding.kind === 'binding' && g.binding.bindingId === bindingId),
    );
    setCaps(ops, grant ? [...rest, grant] : rest);
  };
  // Grants deferred to the run's connection carry no fixed binding to edit —
  // surfaced read-only below.
  const connectionGrants = integrations.filter((g) => g.binding.kind === 'connection');
  // Grants with no matching API binding (e.g. MCP) — keep visible + removable.
  const apiBindingIds = new Set(bindings.map((b) => b.bindingId));
  const otherGrants = integrations.filter(
    (g) => g.binding.kind === 'binding' && !apiBindingIds.has(g.binding.bindingId),
  );

  return (
    <div>
      <Input
        value={q}
        placeholder="Search capabilities…"
        onChange={(e) => {
          setQ(e.target.value);
        }}
        style={{ width: '100%', marginBottom: 6 }}
      />
      {grantedBlocked.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
            padding: '6px 8px',
            marginBottom: 6,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-warning-bg)',
            border: '1px solid var(--color-warning-default)',
          }}
        >
          <Icon name="warning" size="xs" color="var(--color-warning-default)" />
          <Text size="xs" color="muted">
            {grantedBlocked.length} granted operation{grantedBlocked.length === 1 ? '' : 's'} are
            not enabled by this space’s capability profile and will be denied at run time. Ask an
            admin to enable them, or remove them here.
          </Text>
        </div>
      )}
      <div
        style={{
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-md)',
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {/* Integrations branch */}
        <Branch
          icon="plugs"
          label="Integrations"
          count={integrations.length}
          expanded={isOpen('ints')}
          onToggle={() => {
            toggleOpen('ints');
          }}
        >
          {visibleBindings.length === 0 &&
            otherGrants.length === 0 &&
            connectionGrants.length === 0 && <TreeHint>No integrations.</TreeHint>}
          {visibleBindings.map((b) => {
            const grant = grantByBinding.get(b.bindingId);
            const total = endpointCountByApi.get(b.apiId) ?? 0;
            const sel = grant ? (grant.allTools ? total : (grant.toolNames?.length ?? 0)) : 0;
            const count = sel > 0 ? `${sel}/${total}` : String(total);
            return (
              <TreeSubGroup
                key={b.bindingId}
                id={`bind:${b.bindingId}`}
                label={b.bindingId}
                count={count}
                expanded={isOpen(`bind:${b.bindingId}`)}
                onToggle={() => {
                  toggleOpen(`bind:${b.bindingId}`);
                }}
              >
                <EndpointList
                  apiId={b.apiId}
                  bindingId={b.bindingId}
                  grant={grant}
                  spaceId={spaceId}
                  onGrant={(g) => {
                    setGrant(b.bindingId, g);
                  }}
                />
              </TreeSubGroup>
            );
          })}
          {otherGrants.map((g, i) => (
            <TreeLeaf
              key={`other-${i}`}
              checked
              onToggle={() => {
                setGrant(g.binding.kind === 'binding' ? g.binding.bindingId : '', null);
              }}
              label={
                <Text size="sm">
                  {g.integrationId} ({g.sourceKind})
                </Text>
              }
            />
          ))}
          {connectionGrants.map((g, i) => (
            <div key={`conn-${i}`} style={{ ...treeRowStyle, paddingLeft: 22, cursor: 'default' }}>
              <Icon name="plugs" size="xs" color="var(--color-text-muted)" />
              <Text size="sm" truncate>
                {g.integrationId} ({g.sourceKind})
              </Text>
              <Text size="xs" color="muted" style={{ marginLeft: 'auto' }}>
                resolved from the run’s connection
              </Text>
            </div>
          ))}
        </Branch>

        {/* Operations branch */}
        <Branch
          icon="lightning"
          label="Operations"
          count={ops.length}
          expanded={isOpen('ops')}
          onToggle={() => {
            toggleOpen('ops');
          }}
          last
        >
          <OperationSelectTree
            query={q}
            selected={ops}
            onToggle={toggleOp}
            blockedById={blockedById}
          />
        </Branch>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capability arm header
// ---------------------------------------------------------------------------

function Branch({
  icon,
  label,
  count,
  expanded,
  onToggle,
  last,
  children,
}: {
  icon: IconName;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  last?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--color-border-subtle)' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ ...treeRowStyle, background: 'var(--color-surface-1)' }}
      >
        <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
        <Icon name={icon} size="xs" />
        <Text size="sm" weight="semibold">
          {label}
        </Text>
        <Text size="xs" color="muted" style={{ marginLeft: 'auto' }}>
          {count} granted
        </Text>
      </button>
      {expanded && <div>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Endpoint sub-picker (lazy — fires only when a binding is expanded)
// ---------------------------------------------------------------------------

interface ApiDefResponse {
  definition?: { endpoints?: Array<{ endpointId: string; name: string; method: string }> };
}

function EndpointList({
  apiId,
  bindingId,
  grant,
  spaceId,
  onGrant,
}: {
  apiId: string;
  bindingId: string;
  grant: IntegrationGrant | undefined;
  spaceId: string;
  onGrant: (g: IntegrationGrant | null) => void;
}) {
  const q = useApiQuery<ApiDefResponse>({
    key: ['space', spaceId, 'integrations', 'definition', apiId],
    path: `/integrations/definitions/${apiId}`,
    spaceId,
    staleTime: 60_000,
  });
  const endpoints = q.data?.definition?.endpoints ?? [];
  const base: IntegrationGrant = grant ?? {
    capabilityId: apiId,
    binding: { kind: 'binding', bindingId },
    sourceKind: 'api',
    integrationId: apiId,
    grantKind: 'endpoint_tools',
    toolNames: [],
    allTools: false,
  };
  const all = grant?.allTools === true;
  const current = grant?.toolNames ?? [];
  const selected = new Set(current.map((t) => t.toolName));

  // Granting an endpoint (or "all") creates the grant; clearing the last one
  // removes it, so a binding is granted iff at least one tool is selected.
  const setAll = (on: boolean) => {
    if (on) {
      onGrant({ ...base, allTools: true, toolNames: [] });
    } else if (current.length) {
      onGrant({ ...base, allTools: false, toolNames: current });
    } else {
      onGrant(null);
    }
  };
  const toggleEp = (id: string) => {
    const next = selected.has(id)
      ? current.filter((t) => t.toolName !== id)
      : [...current, { toolName: id }];
    onGrant(next.length === 0 ? null : { ...base, allTools: false, toolNames: next });
  };

  return (
    <>
      <TreeLeaf
        checked={all}
        onToggle={() => {
          setAll(!all);
        }}
        label={<Text size="sm">All endpoints</Text>}
      />
      {!all && q.isLoading && (
        <div style={{ paddingLeft: 40 }}>
          <Text size="xs" color="muted">
            Loading endpoints…
          </Text>
        </div>
      )}
      {!all && !q.isLoading && endpoints.length === 0 && (
        <div style={{ paddingLeft: 40 }}>
          <Text size="xs" color="muted">
            No endpoints.
          </Text>
        </div>
      )}
      {!all &&
        endpoints.map((ep) => (
          <TreeLeaf
            key={ep.endpointId}
            checked={selected.has(ep.endpointId)}
            onToggle={() => {
              toggleEp(ep.endpointId);
            }}
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Badge variant="neutral">{ep.method}</Badge>
                <Text size="sm">{ep.name}</Text>
              </span>
            }
          />
        ))}
    </>
  );
}
